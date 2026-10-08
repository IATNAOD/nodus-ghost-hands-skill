/**
 * Routes for the personal page ("Мои настройки"): /api/v1/skills/ghost_hands/routes/*.
 * Any logged-in user reaches them through the panel proxy: every route checks
 * the user itself (x-nod-user-id) and touches only that user's data,
 * except the admin routes.
 */
"use strict";

const os = require("os");
const GhostHands = require("../index");
const { generateKey, hashKey, maskKey } = require("../lib/keys");
const { classify } = require("../lib/parse");
const { lines } = require("../lib/trace");
const { DEFAULT_HOST } = require("../lib/protocol");
const manifest = require("../skill.json");

const DOWNLOAD_URL = "https://github.com/IATNAOD/nodus-ghost-hands-skill/releases/latest";

const ok = (result = {}) => ({ success: true, message: null, result });
const fail = (message) => ({ success: false, message, result: {} });
const isUserId = (value) => /^[a-f\d]{24}$/i.test(String(value ?? ""));
const header = (req, name) => {
  try {
    return decodeURIComponent(String(req.headers[name] ?? ""));
  } catch {
    return String(req.headers[name] ?? "");
  }
};

/** IPv4 addresses of NODUS in the home network, for clients that cannot resolve project-nod.local. */
const addresses = () =>
  Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => item.address)
    .slice(0, 4);

/** Each route: a loaded skill, a known user, error codes instead of exceptions. */
const route = (handler) => async (req, res) => {
  const skill = GhostHands.getInstance();
  const user = {
    id: String(req.headers["x-nod-user-id"] ?? ""),
    role: req.headers["x-nod-user-role"] === "admin" ? "admin" : "user",
    name: header(req, "x-nod-user-name") || header(req, "x-nod-username"),
  };

  if (!skill || !skill.hub) return res.code(503).send(fail("skill-not-loaded"));
  if (!isUserId(user.id)) return res.code(401).send(fail("not-auth"));

  try {
    return await handler({ skill, user, req, res });
  } catch (error) {
    console.error(`[ghost_hands] route ${req.url}: ${error.message}`);
    return res.code(500).send(fail("internal-error"));
  }
};

const deviceView = (skill, record) => {
  const live = skill.index.get(record.deviceId);
  const config = live ?? record.config ?? {};

  return {
    id: record.deviceId,
    name: live?.name || record.name,
    online: skill.hub.isOnline(record.deviceId),
    lastSeenAt: record.lastSeenAt ?? null,
    client: config.client?.version ?? "",
    os: config.client?.os ?? "",
    apps: (live?.apps ?? config.apps ?? []).length,
    shared: Boolean(live?.shared ?? config.shared),
    wol: Boolean(live?.wol ?? config.wol),
    wolWifi: (live?.wol ?? config.wol)?.adapter === "wifi",
    paused: Boolean((live?.prefs ?? config.prefs)?.paused),
  };
};

/** A new key: shown on the page, sha256 for lookup, the key itself encrypted. */
const putKey = async (skill, user) => {
  const key = generateKey();
  const secrets = skill.ctx.secrets;

  await skill.store.keys.put(user.id, {
    userName: user.name,
    keyHash: hashKey(key),
    keyEnc: typeof secrets?.encrypt === "function" ? secrets.encrypt(key) : "",
  });

  return key;
};

const keyView = async (skill, user) => {
  const record = await skill.store.keys.byUser(user.id);

  if (!record) return { exists: false };

  const secret = await skill.store.keys.secretOf(user.id);
  const key = secret && typeof skill.ctx.secrets?.decrypt === "function" ? skill.ctx.secrets.decrypt(secret) : "";

  return {
    exists: true,
    masked: key ? maskKey(key) : "",
    readable: Boolean(key),
    createdAt: record.createdAt ?? null,
    lastUsedAt: record.lastUsedAt ?? null,
  };
};

module.exports = async (app) => {
  // GET .../routes/me - everything the personal page shows
  app.get("/me", route(async ({ skill, user, res }) => {
    const own = await skill.store.devices.byUser(user.id);
    const shared = skill.index
      .all()
      .filter((device) => device.shared && device.userId !== user.id)
      .map((device) => ({ id: device.deviceId, name: device.name, owner: device.userName, online: device.online }));

    return res.send(ok({
      user: { id: user.id, name: user.name, role: user.role },
      isAdmin: user.role === "admin",
      key: await keyView(skill, user),
      server: { ...skill.server.status(), host: DEFAULT_HOST, addresses: addresses() },
      devices: own.map((record) => deviceView(skill, record)).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)),
      shared,
      downloadUrl: DOWNLOAD_URL,
      version: manifest.version,
    }));
  }));

  // POST .../routes/key/ensure - the key is created on the first visit
  app.post("/key/ensure", route(async ({ skill, user, res }) => {
    if (!(await skill.store.keys.byUser(user.id))) await putKey(skill, user);

    return res.send(ok({ key: await keyView(skill, user) }));
  }));

  // POST .../routes/key/reveal - the key itself, only to its owner
  app.post("/key/reveal", route(async ({ skill, user, res }) => {
    const secret = await skill.store.keys.secretOf(user.id);
    const key = secret && typeof skill.ctx.secrets?.decrypt === "function" ? skill.ctx.secrets.decrypt(secret) : "";

    return key ? res.send(ok({ key })) : res.code(409).send(fail("key-unreadable"));
  }));

  // POST .../routes/key/rotate - a new key; every PC of the person has to get it
  app.post("/key/rotate", route(async ({ skill, user, res }) => {
    const key = await putKey(skill, user);

    skill.hub.kickUser(user.id, 4003, "key-rotated");

    return res.send(ok({ key }));
  }));

  // GET .../routes/history - the person's last commands
  app.get("/history", route(async ({ skill, user, res }) => {
    const names = new Map(skill.index.all().map((device) => [device.deviceId, device.name]));
    const items = await skill.store.history.recent(user.id, 30);

    return res.send(ok({
      items: items.map((item) => ({ at: item.at, pc: names.get(item.deviceId) ?? "", action: item.action, target: item.target, ok: item.ok, code: item.code, via: item.via })),
    }));
  }));

  // POST .../routes/test-phrase {text} - how the skill would understand a phrase (no side effects)
  app.post("/test-phrase", route(async ({ skill, user, req, res }) => {
    const text = typeof req.body?.text === "string" ? req.body.text.slice(0, 300) : "";

    if (!text.trim()) return res.code(400).send(fail("text-required"));

    const result = classify(text, { index: skill.index, userId: user.id });

    return res.send(ok({ result: result ? { intent: result.intent, score: result.score, params: result.params } : null }));
  }));

  // DELETE .../routes/devices/:id - unpair a PC (own; admin - any)
  app.delete("/devices/:id", route(async ({ skill, user, req, res }) => {
    const record = /^[A-Za-z0-9_-]{6,32}$/.test(req.params.id) ? await skill.store.devices.byId(req.params.id) : null;

    if (!record) return res.code(404).send(fail("not-found"));
    if (record.userId !== user.id && user.role !== "admin") return res.code(403).send(fail("forbidden"));

    await skill.store.devices.remove(record.deviceId);
    await skill.parental?.remove(record.deviceId);
    skill.index.remove(record.deviceId);
    skill.hub.kick(record.deviceId, 4004, "unpaired");

    return res.send(ok());
  }));

  /* ── parental control: only the owner of a PC sees and changes it ── */

  const ownPc = async (skill, user, id) => {
    const record = /^[A-Za-z0-9_-]{6,32}$/.test(String(id)) ? await skill.store.devices.byId(String(id)) : null;

    return record && record.userId === user.id ? record : null;
  };

  const parentalView = (skill, record) => ({
    id: record.deviceId,
    name: record.name,
    online: skill.hub.isOnline(record.deviceId),
    // an older client online does not know parental control
    outdated: skill.hub.isOnline(record.deviceId) && !skill.hub.supports(record.deviceId, "parental"),
    ...skill.parental.view(record.deviceId),
    // what may count as a game: the PC's apps, Steam/Epic/GOG games marked already
    apps: (record.config?.apps ?? []).map((app) => ({ id: app.id, name: app.name, game: app.kind === "game" })),
  });

  const logParental = (skill, user, record, action, target = "") =>
    skill.store.history
      .add({ userId: user.id, deviceId: record.deviceId, action, target: String(target), ok: true, code: "", via: "panel" })
      .catch(() => undefined);

  // GET .../routes/parental - parental control of the person's own PCs
  app.get("/parental", route(async ({ skill, user, res }) => {
    const records = await skill.store.devices.byUser(user.id);

    return res.send(ok({ devices: records.map((record) => parentalView(skill, record)) }));
  }));

  // PUT .../routes/parental/:id  { enabled?, rules? }
  app.put("/parental/:id", route(async ({ skill, user, req, res }) => {
    const record = await ownPc(skill, user, req.params.id);

    if (!record) return res.code(404).send(fail("not-found"));

    const body = req.body && typeof req.body === "object" ? req.body : {};

    if (typeof body.enabled === "boolean" && body.enabled !== skill.parental.isEnabled(record.deviceId)) {
      await skill.parental.setEnabled(record, body.enabled);
      logParental(skill, user, record, body.enabled ? "parental.on" : "parental.off");
    }
    if (body.rules && typeof body.rules === "object") await skill.parental.setRules(record, body.rules);

    return res.send(ok(parentalView(skill, record)));
  }));

  // PUT .../routes/parental/:id/pin  { pin } - 6-12 digits, not 111111 or 123456; never returned
  app.put("/parental/:id/pin", route(async ({ skill, user, req, res }) => {
    const record = await ownPc(skill, user, req.params.id);

    if (!record) return res.code(404).send(fail("not-found"));

    const problem = await skill.parental.setPin(record, typeof req.body?.pin === "string" ? req.body.pin.trim() : "");

    if (problem) return res.code(400).send(fail(problem));
    logParental(skill, user, record, "parental.pin");

    return res.send(ok(parentalView(skill, record)));
  }));

  // POST .../routes/parental/:id/grant  { minutes: 1..720 | "day" } - lift the limits for a while
  app.post("/parental/:id/grant", route(async ({ skill, user, req, res }) => {
    const record = await ownPc(skill, user, req.params.id);

    if (!record) return res.code(404).send(fail("not-found"));

    const minutes = req.body?.minutes === "day" ? "day" : Number(req.body?.minutes);

    if (minutes !== "day" && !(Number.isInteger(minutes) && minutes >= 1 && minutes <= 720)) return res.code(400).send(fail("minutes-invalid"));
    await skill.parental.grant(record, minutes);
    logParental(skill, user, record, "parental.grant", minutes);

    return res.send(ok(parentalView(skill, record)));
  }));

  // POST .../routes/parental/:id/revoke - the limits are back
  app.post("/parental/:id/revoke", route(async ({ skill, user, req, res }) => {
    const record = await ownPc(skill, user, req.params.id);

    if (!record) return res.code(404).send(fail("not-found"));
    await skill.parental.revoke(record);
    logParental(skill, user, record, "parental.revoke");

    return res.send(ok(parentalView(skill, record)));
  }));

  // POST .../routes/parental/:id/reset-today - today's counters to zero
  app.post("/parental/:id/reset-today", route(async ({ skill, user, req, res }) => {
    const record = await ownPc(skill, user, req.params.id);

    if (!record) return res.code(404).send(fail("not-found"));
    await skill.parental.resetToday(record);
    logParental(skill, user, record, "parental.reset");

    return res.send(ok(parentalView(skill, record)));
  }));

  // GET .../routes/admin/overview - every PC of the house (admin)
  app.get("/admin/overview", route(async ({ skill, user, res }) => {
    if (user.role !== "admin") return res.code(403).send(fail("forbidden"));

    const records = await skill.store.devices.all();

    return res.send(ok({
      server: { ...skill.server.status(), host: DEFAULT_HOST, addresses: addresses() },
      devices: records.map((record) => ({ ...deviceView(skill, record), owner: record.userName, ownerId: record.userId })),
    }));
  }));

  // GET .../routes/debug - last log lines of the skill (admin)
  app.get("/debug", route(async ({ user, res }) =>
    user.role === "admin" ? res.send(ok({ lines })) : res.code(403).send(fail("forbidden"))));
};
