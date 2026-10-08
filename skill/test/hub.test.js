const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const WebSocket = require("ws");

const P = require("../lib/protocol.js");
const { Hub } = require("../lib/hub.js");
const { Server } = require("../lib/server.js");
const { NameIndex } = require("../lib/name-index.js");
const { createMemoryStore } = require("../lib/store.js");
const { generateKey, hashKey } = require("../lib/keys.js");

const U1 = "64b000000000000000000001";
const U2 = "64b000000000000000000002";

/** Store with keys of two people, a hub and a server on a free port. */
async function stack({ authTimeoutMs = 2000 } = {}) {
  const store = createMemoryStore();
  const keys = { [U1]: generateKey(), [U2]: generateKey() };

  for (const [userId, key] of Object.entries(keys)) await store.keys.put(userId, { userName: userId === U1 ? "Маша" : "Петя", keyHash: hashKey(key), keyEnc: key });

  const index = new NameIndex();
  const events = [];
  const hub = new Hub({ store, index, version: "test", authTimeoutMs, onEvent: (type, data) => events.push({ type, ...data }) });
  const server = new Server({ hub });

  await server.start(0);

  return { store, keys, index, hub, server, events, url: `ws://127.0.0.1:${server.address()}${P.WS_PATH}`, port: server.address() };
}

/** A PC client: messages by type, replies to commands with `handler`. */
function client(url, { headers, handler } = {}) {
  const ws = new WebSocket(url, { headers });
  const inbox = [];
  const waiters = [];
  const closed = new Promise((resolve) => ws.on("close", (code, reason) => resolve({ code, reason: String(reason) })));

  ws.on("error", () => {});
  ws.on("message", (raw) => {
    const message = JSON.parse(String(raw));

    if (message.t === P.MSG.CMD && handler) {
      Promise.resolve(handler(message)).then((reply) => reply && ws.send(P.encode(P.MSG.RESULT, { id: message.id, ...reply })));
      return;
    }

    const index = waiters.findIndex((waiter) => waiter.type === message.t);

    if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
    else inbox.push(message);
  });

  return {
    ws,
    closed,
    opened: new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("unexpected-response", (req, res) => reject(Object.assign(new Error(`http ${res.statusCode}`), { status: res.statusCode })));
    }),
    send: (type, fields) => ws.send(P.encode(type, fields)),
    next: (type) => {
      const index = inbox.findIndex((message) => message.t === type);

      if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
      return new Promise((resolve) => waiters.push({ type, resolve }));
    },
  };
}

const hello = (pc, key, deviceId = null, device = {}) =>
  pc.send(P.MSG.HELLO, { proto: P.PROTO, key, deviceId, device: { name: "Игровой", machineHash: "a".repeat(64), os: "Windows 10", host: "PC", client: "1.0.0", ...device } });

const shutdown = async (s) => {
  await s.hub.dispose();
  await s.server.stop();
};

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

test("pairing: a new PC gets an id, the same machine keeps it", async (t) => {
  const s = await stack();

  t.after(() => shutdown(s));

  const first = client(s.url);

  await first.opened;
  hello(first, s.keys[U1]);

  const welcome = await first.next(P.MSG.WELCOME);

  assert.equal(welcome.created, true);
  assert.equal(welcome.owner.name, "Маша");
  assert.match(welcome.deviceId, /^[A-Za-z0-9_-]{12}$/);
  assert.equal(s.hub.isOnline(welcome.deviceId), true);
  assert.equal(s.index.get(welcome.deviceId).userId, U1);
  assert.equal((await s.store.devices.byUser(U1)).length, 1);

  first.ws.close();
  await first.closed;
  await settle();
  assert.equal(s.hub.isOnline(welcome.deviceId), false);

  // reinstalled client: no deviceId, same machine
  const again = client(s.url);

  await again.opened;
  hello(again, s.keys[U1], null, { name: "Игровой ПК" });
  assert.equal((await again.next(P.MSG.WELCOME)).deviceId, welcome.deviceId);
  assert.equal((await s.store.devices.byUser(U1)).length, 1);
  again.ws.close();
});

test("auth: a wrong key closes with 4003, five failures block the address", async (t) => {
  const s = await stack();

  t.after(() => shutdown(s));

  for (let i = 0; i < 5; i++) {
    const pc = client(s.url);

    await pc.opened;
    hello(pc, generateKey());
    assert.equal((await pc.closed).code, P.CLOSE.AUTH_FAILED);
  }

  const blocked = client(s.url);

  assert.equal((await blocked.closed).code, P.CLOSE.RATE_LIMITED);
});

test("auth: no hello in time, bad JSON, unsupported protocol", async (t) => {
  const s = await stack({ authTimeoutMs: 100 });

  t.after(() => shutdown(s));

  const silent = client(s.url);

  assert.equal((await silent.closed).code, P.CLOSE.BAD_REQUEST);

  const garbage = client(s.url);

  await garbage.opened;
  garbage.ws.send("{not json");
  assert.equal((await garbage.closed).code, P.CLOSE.BAD_REQUEST);

  const future = client(s.url);

  await future.opened;
  future.send(P.MSG.HELLO, { proto: 99, key: s.keys[U1], deviceId: null, device: { name: "X" } });
  assert.equal((await future.closed).code, P.CLOSE.PROTO_UNSUPPORTED);
});

test("names are unique per person; an unknown PC id means it was unpaired", async (t) => {
  const s = await stack();

  t.after(() => shutdown(s));

  const first = client(s.url);

  await first.opened;
  hello(first, s.keys[U1]);
  await first.next(P.MSG.WELCOME);

  const twin = client(s.url);

  await twin.opened;
  hello(twin, s.keys[U1], null, { name: "игровой", machineHash: "b".repeat(64) });
  assert.equal((await twin.closed).code, P.CLOSE.NAME_TAKEN);

  // another person may use the same name
  const other = client(s.url);

  await other.opened;
  hello(other, s.keys[U2], null, { machineHash: "c".repeat(64) });
  assert.ok((await other.next(P.MSG.WELCOME)).deviceId);

  const ghost = client(s.url);

  await ghost.opened;
  hello(ghost, s.keys[U1], "nonexistent00");
  assert.equal((await ghost.closed).code, P.CLOSE.UNPAIRED);

  first.ws.close();
  other.ws.close();
});

test("config: saved, indexed, warnings for aliases, a taken name is refused", async (t) => {
  const s = await stack();

  t.after(() => shutdown(s));

  const laptop = client(s.url);

  await laptop.opened;
  hello(laptop, s.keys[U1], null, { name: "Ноутбук", machineHash: "d".repeat(64) });
  await laptop.next(P.MSG.WELCOME);

  const pc = client(s.url);

  await pc.opened;
  hello(pc, s.keys[U1]);

  const { deviceId } = await pc.next(P.MSG.WELCOME);

  pc.send(P.MSG.CONFIG, {
    rev: 3,
    data: {
      name: "Игровой",
      apps: [
        { id: "steam:570", name: "Dota 2", aliases: ["дота", "музыка"], kind: "game" },
        { id: "steam:730", name: "Counter-Strike 2", aliases: ["дота"], kind: "game" },
      ],
      features: { power: false },
      prefs: { confirmPower: false },
    },
  });

  const ack = await pc.next(P.MSG.CONFIG_ACK);

  assert.equal(ack.rev, 3);
  assert.equal(ack.error, null);
  assert.deepEqual(ack.warnings.map((warning) => `${warning.appId} ${warning.code}`).sort(), ["steam:570 alias-reserved", "steam:730 alias-duplicate"]);
  assert.equal(s.index.get(deviceId).apps.length, 2);
  assert.equal((await s.store.devices.byId(deviceId)).configRev, 3);
  assert.equal((await s.hub.command(deviceId, "power.shutdown", {})).code, "feature-disabled");

  // every config is a full snapshot: rev 4 also turns power back on
  pc.send(P.MSG.CONFIG, { rev: 4, data: { name: "Ноутбук", apps: [] } });

  const taken = await pc.next(P.MSG.CONFIG_ACK);

  assert.equal(taken.error, "name-taken");
  assert.equal((await s.store.devices.byId(deviceId)).name, "Игровой");
  assert.equal(s.index.get(deviceId).name, "Игровой");

  pc.ws.close();
  laptop.ws.close();
});

test("commands: reply, timeout, offline; a newer connection replaces the old one", async (t) => {
  const s = await stack();

  t.after(() => shutdown(s));

  const pc = client(s.url, { handler: (message) => (message.action === "volume.get" ? { ok: true, data: { level: 42, muted: false } } : null) });

  await pc.opened;
  hello(pc, s.keys[U1]);

  const { deviceId } = await pc.next(P.MSG.WELCOME);

  assert.deepEqual(await s.hub.command(deviceId, "volume.get", {}), { ok: true, code: null, data: { level: 42, muted: false } });
  assert.equal((await s.hub.command(deviceId, "media.key", { key: "next" }, 100)).code, "timeout");
  assert.equal((await s.hub.command("nobody", "volume.get", {})).code, "offline");
  assert.equal((await s.hub.command(deviceId, "rm -rf", {})).code, "unknown-action");

  const second = client(s.url);

  await second.opened;
  hello(second, s.keys[U1], deviceId);
  await second.next(P.MSG.WELCOME);
  assert.equal((await pc.closed).code, P.CLOSE.REPLACED);
  await settle();
  assert.equal(s.hub.isOnline(deviceId), true, "the newer connection keeps the PC online");
  second.ws.close();
});

test("key rotation and unpairing close the connections with their codes", async (t) => {
  const s = await stack();

  t.after(() => shutdown(s));

  const pc = client(s.url);

  await pc.opened;
  hello(pc, s.keys[U1]);
  await pc.next(P.MSG.WELCOME);
  s.hub.kickUser(U1, P.CLOSE.AUTH_FAILED, "key-rotated");
  assert.equal((await pc.closed).code, P.CLOSE.AUTH_FAILED);

  const again = client(s.url);

  await again.opened;
  hello(again, s.keys[U1], null, { machineHash: "e".repeat(64), name: "Другой" });

  const { deviceId } = await again.next(P.MSG.WELCOME);

  again.send(P.MSG.BYE, { reason: "unpair" });
  await again.closed;
  await settle();
  assert.equal(await s.store.devices.byId(deviceId), null);
  assert.equal(s.index.get(deviceId), null);
});

test("state: apps that start and stop become events after the first snapshot", async (t) => {
  const s = await stack();

  t.after(() => shutdown(s));

  const pc = client(s.url);

  await pc.opened;
  hello(pc, s.keys[U1]);
  await pc.next(P.MSG.WELCOME);
  pc.send(P.MSG.CONFIG, { rev: 1, data: { name: "Игровой", apps: [{ id: "steam:570", name: "Dota 2", kind: "game" }] } });
  await pc.next(P.MSG.CONFIG_ACK);
  pc.send(P.MSG.STATE, { data: { running: [{ key: "exe:chrome", name: "Chrome" }] } });
  pc.send(P.MSG.STATE, { data: { running: [{ key: "exe:dota2", name: "Dota 2", appId: "steam:570", game: true }] } });
  pc.send(P.MSG.STATE, { data: { running: [] } });
  await settle(80);

  assert.deepEqual(s.events.filter((event) => event.type.startsWith("app-")).map((event) => `${event.type} ${event.appId}`), ["app-started steam:570", "app-stopped steam:570"]);
  pc.ws.close();
});

test("the server refuses browsers, wrong paths and plain HTTP", async (t) => {
  const s = await stack();

  t.after(() => shutdown(s));

  const browser = client(s.url, { headers: { Origin: "https://evil.example" } });

  await assert.rejects(browser.opened, { status: 403 });

  const wrong = client(s.url.replace("/gh", "/other"));

  await assert.rejects(wrong.opened, { status: 404 });

  const status = await new Promise((resolve) => http.get(`http://127.0.0.1:${s.port}/gh`, (res) => resolve(res.statusCode)).on("error", () => resolve(0)));

  assert.equal(status, 426);
});

test("dispose closes the PCs with going-away", async () => {
  const s = await stack();
  const pc = client(s.url);

  await pc.opened;
  hello(pc, s.keys[U1]);
  await pc.next(P.MSG.WELCOME);
  await shutdown(s);
  assert.equal((await pc.closed).code, P.CLOSE.GOING_AWAY);
});
