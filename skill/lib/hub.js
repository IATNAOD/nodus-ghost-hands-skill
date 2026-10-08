/**
 * Connections of PCs: handshake by the personal key, PC registration,
 * configuration and state sync, commands with replies, heartbeat.
 * Everything here runs in the shared skills process: every callback catches
 * its errors, every socket has an 'error' listener.
 */
"use strict";

const P = require("./protocol");
const { hashKey, newDeviceId } = require("./keys");
const { isReserved } = require("./parse");
const { wordsOf } = require("./text");

const AUTH_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 30_000;
const FAIL_WINDOW_MS = 10 * 60_000;
const FAIL_LIMIT = 5;
const MAX_SOCKETS = 64;
const CLOSE_GRACE_MS = 1000;

const OPEN = 1;

const sameName = (a, b) => wordsOf(a).join(" ") === wordsOf(b).join(" ");
const normalizeIp = (ip) => String(ip ?? "").replace(/^::ffff:/, "");

/** Alias problems the client shows next to the alias. */
const aliasWarnings = (config) => {
  const warnings = [];
  const owners = new Map();

  for (const app of config.apps) {
    for (const alias of app.aliases) {
      const words = wordsOf(alias);
      const key = words.join(" ");

      if (key.replace(/\s/g, "").length < 2) warnings.push({ appId: app.id, alias, code: "alias-too-short" });
      else if (isReserved(words)) warnings.push({ appId: app.id, alias, code: "alias-reserved" });

      if (owners.has(key) && owners.get(key) !== app.id) warnings.push({ appId: app.id, alias, code: "alias-duplicate" });
      else owners.set(key, app.id);
    }
  }

  return warnings.slice(0, 50);
};

class Hub {
  /**
   * @param {object} deps
   * @param {ReturnType<import("./store").createStore>} deps.store
   * @param {import("./name-index").NameIndex} deps.index
   * @param {(type: string, data: object) => void} [deps.onEvent] "online", "offline", "config", "app-started", "app-stopped"
   * @param {(message: string) => void} [deps.log]
   * @param {string} [deps.version] skill version for `welcome`
   * @param {number} [deps.authTimeoutMs] time for the first message
   * @param {number} [deps.pingIntervalMs] heartbeat period
   */
  constructor({ store, index, onEvent = () => {}, log = () => {}, version = "", parental = () => ({ enabled: false, rev: 0 }), authTimeoutMs = AUTH_TIMEOUT_MS, pingIntervalMs = PING_INTERVAL_MS }) {
    this.store = store;
    this.index = index;
    /** deviceId → the `parental` message for that PC (lib/parental.js) */
    this.parental = parental;
    this.onEvent = onEvent;
    this.log = log;
    this.version = version;
    this.authTimeoutMs = authTimeoutMs;
    /** every socket */
    this.connections = new Set();
    /** deviceId → authenticated connection */
    this.active = new Map();
    /** command id → { resolve, timer, deviceId } */
    this.pending = new Map();
    /** ip → times of failed keys */
    this.fails = new Map();
    this.sequence = 0;
    this.disposed = false;
    this.heartbeat = setInterval(() => this.beat(), pingIntervalMs);
    this.heartbeat.unref?.();
  }

  /** A socket after the WebSocket upgrade. */
  attach(ws, req) {
    const ip = normalizeIp(req?.socket?.remoteAddress);

    ws.on("error", (error) => this.log(`socket ${ip}: ${error.message}`));

    if (this.disposed) return ws.close(P.CLOSE.GOING_AWAY, "going-away");
    if (this.connections.size >= MAX_SOCKETS) return ws.close(P.CLOSE.SERVER_ERROR, "busy");
    if (this.isBlocked(ip)) return ws.close(P.CLOSE.RATE_LIMITED, "rate-limited");

    const conn = {
      ws,
      ip,
      alive: true,
      deviceId: null,
      userId: null,
      dropping: false,
      closed: false,
      configured: false,
      baseline: false,
      runningApps: new Map(),
      queue: Promise.resolve(),
      authTimer: null,
      byeReason: null,
    };

    this.connections.add(conn);
    conn.authTimer = setTimeout(() => this.drop(conn, P.CLOSE.BAD_REQUEST, "hello-timeout"), this.authTimeoutMs);
    conn.authTimer.unref?.();

    ws.on("pong", () => {
      conn.alive = true;
    });
    ws.on("message", (data, isBinary) => {
      if (conn.dropping) return;
      if (isBinary) return this.drop(conn, P.CLOSE.BAD_REQUEST, "binary");

      const message = P.decode(data);

      if (!message) return this.drop(conn, P.CLOSE.BAD_REQUEST, "bad-json");

      // one message at a time per PC: a config never overtakes the hello
      conn.queue = conn.queue
        .then(() => this.handle(conn, message))
        .catch((error) => {
          this.log(`${message.t} failed: ${error.message}`);
          this.drop(conn, P.CLOSE.SERVER_ERROR, "server-error");
        });
    });
    ws.on("close", () => {
      try {
        this.closed(conn);
      } catch (error) {
        this.log(`close failed: ${error.message}`);
      }
    });

    return undefined;
  }

  async handle(conn, message) {
    if (conn.dropping) return;

    if (!conn.deviceId) {
      if (message.t !== P.MSG.HELLO) return this.drop(conn, P.CLOSE.BAD_REQUEST, "hello-expected");

      return this.hello(conn, message);
    }

    switch (message.t) {
      case P.MSG.CONFIG:
        return this.config(conn, message);
      case P.MSG.STATE:
        return this.state(conn, message);
      case P.MSG.RESULT:
        return this.result(conn, message);
      case P.MSG.BYE:
        return this.bye(conn, message);
      case P.MSG.ALERT:
        return this.alert(conn, message);
      default:
        return undefined;
    }
  }

  async hello(conn, message) {
    clearTimeout(conn.authTimer);

    const proto = Number(message.proto);

    if (!Number.isInteger(proto) || proto < P.PROTO_MIN || proto > P.PROTO_MAX) {
      return this.drop(conn, P.CLOSE.PROTO_UNSUPPORTED, `proto ${P.PROTO_MIN}-${P.PROTO_MAX}`);
    }

    const keyHash = hashKey(message.key);
    const key = keyHash ? await this.store.keys.byHash(keyHash) : null;

    if (!key) {
      this.fail(conn.ip);
      return this.drop(conn, P.CLOSE.AUTH_FAILED, "auth-failed");
    }

    const device = P.sanitizeHelloDevice(message.device);
    const userId = String(key.userId);
    let record;

    if (typeof message.deviceId === "string" && message.deviceId) {
      record = await this.store.devices.byId(message.deviceId);
      // removed on the personal page, or paired by another person
      if (!record || record.userId !== userId) return this.drop(conn, P.CLOSE.UNPAIRED, "unpaired");
    } else {
      if (!device.name) return this.drop(conn, P.CLOSE.BAD_REQUEST, "name-required");

      const same = await this.store.devices.byMachine(userId, device.machineHash);
      const others = (await this.store.devices.byUser(userId)).filter((item) => item.deviceId !== same?.deviceId);

      if (others.some((item) => sameName(item.name, device.name))) return this.drop(conn, P.CLOSE.NAME_TAKEN, "name-taken");

      if (same) {
        // the same PC paired again (reinstall, new key): it keeps its record
        await this.store.devices.update(same.deviceId, { name: device.name, userName: key.userName ?? "" });
        record = { ...same, name: device.name };
      } else {
        record = await this.store.devices.create({
          deviceId: newDeviceId(),
          userId,
          userName: key.userName ?? "",
          name: device.name,
          machineHash: device.machineHash,
          config: null,
          configRev: 0,
        });
      }
    }

    if (conn.dropping) return undefined;

    const previous = this.active.get(record.deviceId);

    if (previous && previous !== conn) this.drop(previous, P.CLOSE.REPLACED, "replaced");

    conn.deviceId = record.deviceId;
    conn.userId = userId;
    conn.caps = new Set(device.caps);
    this.active.set(record.deviceId, conn);

    const lastSeenAt = record.lastSeenAt ? new Date(record.lastSeenAt).getTime() : 0;

    this.index.upsert({
      deviceId: record.deviceId,
      userId,
      userName: key.userName ?? "",
      config: record.config ?? { name: record.name },
      online: true,
      lastSeenAt,
    });
    this.index.setOnline(record.deviceId, true);

    await Promise.all([this.store.keys.touch(userId), this.store.devices.update(record.deviceId, { lastSeenAt: new Date(), lastIp: conn.ip })]);

    this.send(conn, P.MSG.WELCOME, {
      deviceId: record.deviceId,
      name: record.name,
      owner: { name: key.userName ?? "", id: userId },
      server: { version: this.version, protoMin: P.PROTO_MIN, protoMax: P.PROTO_MAX, caps: P.CAPS },
      settings: this.clientSettings(),
      created: !message.deviceId,
    });
    if (conn.caps.has("parental")) this.send(conn, P.MSG.PARENTAL, this.parental(record.deviceId));
    this.onEvent("online", { device: this.index.get(record.deviceId), lastSeenAt });

    return undefined;
  }

  async config(conn, message) {
    const rev = Number(message.rev);

    if (!Number.isFinite(rev) || rev < 0) return this.send(conn, P.MSG.CONFIG_ACK, { rev: null, error: "invalid-rev", warnings: [] });

    const result = P.sanitizeConfig(message.data);

    if (!result.ok) return this.send(conn, P.MSG.CONFIG_ACK, { rev, error: result.error, warnings: [] });

    const { config } = result;
    const stored = await this.store.devices.byId(conn.deviceId);

    if (!stored) return this.drop(conn, P.CLOSE.UNPAIRED, "unpaired");

    const others = (await this.store.devices.byUser(conn.userId)).filter((item) => item.deviceId !== conn.deviceId);
    let error = null;

    if (others.some((item) => sameName(item.name, config.name))) {
      error = "name-taken";
      config.name = stored.name;
    }

    // the first config of a connection is the current truth even with a smaller rev (reinstalled client)
    if (!conn.configured) {
      await this.store.devices.update(conn.deviceId, { config, configRev: rev, name: config.name });
      conn.configured = true;
    } else {
      await this.store.devices.saveConfig(conn.deviceId, rev, config);
    }

    if (conn.dropping) return undefined;

    this.index.upsert({ deviceId: conn.deviceId, userId: conn.userId, userName: stored.userName, config, online: true });
    this.send(conn, P.MSG.CONFIG_ACK, { rev, error, warnings: aliasWarnings(config) });
    this.onEvent("config", { device: this.index.get(conn.deviceId) });

    return undefined;
  }

  state(conn, message) {
    const device = this.index.get(conn.deviceId);

    if (!device) return;

    const state = P.sanitizeState(message.data);

    this.index.setState(conn.deviceId, state);

    // start and stop of configured apps; the first snapshot after connecting is the baseline
    const running = new Map(state.running.filter((item) => item.appId).map((item) => [item.appId, item]));

    if (conn.baseline) {
      for (const [appId, item] of running) {
        if (!conn.runningApps.has(appId)) this.onEvent("app-started", { device, appId, item, app: device.appById.get(appId) ?? null });
      }
      for (const [appId, item] of conn.runningApps) {
        if (!running.has(appId)) this.onEvent("app-stopped", { device, appId, item, app: device.appById.get(appId) ?? null });
      }
    }
    conn.runningApps = running;
    conn.baseline = true;
    if (state.parental) this.onEvent("parental-usage", { device, usage: state.parental });
  }

  /** Something the owner should know about a PC under parental control. */
  alert(conn, message) {
    const device = this.index.get(conn.deviceId);

    const until = Number(message.until);

    if (device && P.ALERT_KINDS.includes(message.kind)) {
      this.onEvent("parental-alert", { device, kind: message.kind, until: Number.isFinite(until) ? until : null });
    }
  }

  /** New parental rules, unlocks, resets reach the PC at once (only a client that knows them). */
  sendParental(deviceId, payload) {
    const conn = this.active.get(deviceId);

    if (conn && !conn.dropping && conn.caps?.has("parental")) this.send(conn, P.MSG.PARENTAL, payload);
  }

  result(conn, message) {
    const pending = this.pending.get(message.id);

    if (!pending || pending.deviceId !== conn.deviceId) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    pending.resolve({
      ok: message.ok === true,
      code: message.ok === true ? null : typeof message.code === "string" ? message.code.slice(0, 40) : "internal",
      data: message.data && typeof message.data === "object" && !Array.isArray(message.data) ? message.data : {},
    });
  }

  async bye(conn, message) {
    conn.byeReason = typeof message.reason === "string" ? message.reason.slice(0, 20) : null;

    if (conn.byeReason === "unpair") {
      await this.store.devices.remove(conn.deviceId);
      this.index.remove(conn.deviceId);
      this.onEvent("removed", { deviceId: conn.deviceId });
      this.drop(conn, 1000, "unpaired");
    }
  }

  /** The socket is gone: the PC is offline unless a newer connection replaced it. */
  closed(conn) {
    if (conn.closed) return;
    conn.closed = true;
    conn.dropping = true;
    clearTimeout(conn.authTimer);
    clearTimeout(conn.killTimer);
    this.connections.delete(conn);

    if (!conn.deviceId || this.active.get(conn.deviceId) !== conn) return;
    this.active.delete(conn.deviceId);

    for (const [id, pending] of this.pending) {
      if (pending.deviceId !== conn.deviceId) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, code: "disconnected", data: {} });
    }

    const device = this.index.get(conn.deviceId);

    this.index.setOnline(conn.deviceId, false);
    this.store.devices.update(conn.deviceId, { lastSeenAt: new Date() }).catch((error) => this.log(`lastSeenAt: ${error.message}`));
    if (device) this.onEvent("offline", { device, reason: conn.byeReason });
  }

  /**
   * Send a command to a PC and wait for its reply.
   * @returns {Promise<{ ok: boolean, code: string|null, data: object }>}
   */
  command(deviceId, action, args = {}, timeoutMs = 8000) {
    const conn = this.active.get(deviceId);
    const device = this.index.get(deviceId);

    if (!conn || conn.dropping) return Promise.resolve({ ok: false, code: "offline", data: {} });
    if (!P.ACTIONS[action]) return Promise.resolve({ ok: false, code: "unknown-action", data: {} });
    if (device && !P.isFeatureEnabled(device.features, action)) return Promise.resolve({ ok: false, code: "feature-disabled", data: {} });
    if (device?.prefs?.paused) return Promise.resolve({ ok: false, code: "paused", data: {} });

    const id = `c${++this.sequence}`;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, code: "timeout", data: {} });
      }, timeoutMs);

      timer.unref?.();
      this.pending.set(id, { resolve, timer, deviceId });

      if (!this.send(conn, P.MSG.CMD, { id, action, args, timeoutMs })) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, code: "offline", data: {} });
      }
    });
  }

  /** A spoken name learned by the AI pick: the client adds it to the app. */
  learn(deviceId, appId, alias) {
    const conn = this.active.get(deviceId);

    return conn ? this.send(conn, P.MSG.LEARN, { appId, alias }) : false;
  }

  isOnline(deviceId) {
    const conn = this.active.get(deviceId);

    return Boolean(conn && !conn.dropping);
  }

  kick(deviceId, code, reason = "") {
    const conn = this.active.get(deviceId);

    if (conn) this.drop(conn, code, reason);
  }

  kickUser(userId, code, reason = "") {
    for (const conn of [...this.active.values()]) if (conn.userId === String(userId)) this.drop(conn, code, reason);
  }

  /** Does the connected client of a PC know a newer action or message (protocol CAPS). */
  supports(deviceId, cap) {
    return Boolean(this.active.get(deviceId)?.caps?.has(cap));
  }

  /** Skill settings the PCs show: from which match NODUS runs an app without asking. */
  clientSettings() {
    return { match: { accept: this.index.accept } };
  }

  /** After a settings change: every connected PC gets them at once. */
  broadcastSettings() {
    const settings = this.clientSettings();

    for (const conn of this.active.values()) if (!conn.dropping) this.send(conn, P.MSG.SETTINGS, settings);
  }

  send(conn, type, fields) {
    if (conn.ws.readyState !== OPEN) return false;

    try {
      conn.ws.send(P.encode(type, fields), (error) => {
        if (error) this.log(`send ${type}: ${error.message}`);
      });
      return true;
    } catch (error) {
      this.log(`send ${type}: ${error.message}`);
      return false;
    }
  }

  /** Close with a code; a peer that does not answer is terminated. */
  drop(conn, code, reason) {
    if (conn.dropping && conn.killTimer) return;
    conn.dropping = true;
    clearTimeout(conn.authTimer);

    try {
      conn.ws.close(code, String(reason ?? "").slice(0, 120));
    } catch (error) {
      this.log(`close: ${error.message}`);
    }

    conn.killTimer = setTimeout(() => {
      try {
        conn.ws.terminate();
      } catch {
        // already gone
      }
    }, CLOSE_GRACE_MS);
    conn.killTimer.unref?.();
  }

  beat() {
    try {
      for (const conn of this.connections) {
        if (!conn.alive) {
          conn.ws.terminate();
          continue;
        }
        conn.alive = false;
        if (conn.ws.readyState === OPEN) conn.ws.ping();
      }

      const since = Date.now() - FAIL_WINDOW_MS;

      for (const [ip, times] of this.fails) {
        const fresh = times.filter((time) => time > since);

        if (fresh.length) this.fails.set(ip, fresh);
        else this.fails.delete(ip);
      }
    } catch (error) {
      this.log(`heartbeat: ${error.message}`);
    }
  }

  fail(ip) {
    const times = (this.fails.get(ip) ?? []).filter((time) => time > Date.now() - FAIL_WINDOW_MS);

    times.push(Date.now());
    this.fails.set(ip, times);
  }

  isBlocked(ip) {
    return (this.fails.get(ip) ?? []).filter((time) => time > Date.now() - FAIL_WINDOW_MS).length >= FAIL_LIMIT;
  }

  /** Close everything; safe to call twice. */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.heartbeat);

    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, code: "disconnected", data: {} });
      this.pending.delete(id);
    }

    for (const conn of [...this.connections]) this.drop(conn, P.CLOSE.GOING_AWAY, "going-away");

    const deadline = Date.now() + CLOSE_GRACE_MS + 200;

    while (this.connections.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    for (const conn of [...this.connections]) {
      try {
        conn.ws.terminate();
      } catch {
        // already gone
      }
      this.closed(conn);
    }
  }
}

module.exports = { Hub, aliasWarnings, sameName, AUTH_TIMEOUT_MS, PING_INTERVAL_MS, FAIL_LIMIT };
