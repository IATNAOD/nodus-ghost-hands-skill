const test = require("node:test");
const assert = require("node:assert/strict");

const GhostHands = require("../index.js");
const routes = require("../routes/index.js");
const { createMemoryStore } = require("../lib/store.js");
const { captureRoutes, reply, fakeCtx } = require("./fakes.js");

const U1 = "64b000000000000000000001";
const U2 = "64b000000000000000000002";

const request = (userId, { role = "user", params = {}, body } = {}) => ({
  params,
  body,
  url: "/skills/ghost_hands/test",
  headers: { "x-nod-user-id": userId, "x-nod-user-role": role, "x-nod-user-name": encodeURIComponent("Маша") },
});

/** A loaded skill with a memory store; its server listens on a free port. */
async function loadSkill(t) {
  const ctx = fakeCtx();
  const skill = new GhostHands(ctx, { port: 0 });

  skill.store = createMemoryStore();
  await skill.init(ctx);
  await skill.serverStarted;
  t.after(() => skill.destroy());

  return skill;
}

test("routes answer 503 before init and 401 without a user", async () => {
  const handlers = await captureRoutes(routes);

  assert.equal((await handlers["GET /me"](request(U1), reply())).statusCode, 503);
});

test("key: created on the first visit, revealed only to its owner, rotation kicks the PCs", async (t) => {
  const skill = await loadSkill(t);
  const handlers = await captureRoutes(routes);

  assert.equal((await handlers["GET /me"](request("not-an-id"), reply())).statusCode, 401);

  const before = (await handlers["GET /me"](request(U1), reply())).body.result;

  assert.equal(before.key.exists, false);

  const ensured = (await handlers["POST /key/ensure"](request(U1), reply())).body.result.key;

  assert.equal(ensured.exists, true);
  assert.match(ensured.masked, /^GH-[0-9A-Z]{4}-••••/);

  const revealed = (await handlers["POST /key/reveal"](request(U1), reply())).body.result.key;

  assert.match(revealed, /^GH(-[0-9A-Z]{4}){6}$/);
  assert.equal((await skill.store.keys.byHash(require("../lib/keys.js").hashKey(revealed))).userId, U1);
  assert.equal((await handlers["POST /key/reveal"](request(U2), reply())).statusCode, 409, "another person has no key yet");

  const kicked = [];

  skill.hub.kickUser = (userId, code) => kicked.push([userId, code]);

  const rotated = (await handlers["POST /key/rotate"](request(U1), reply())).body.result.key;

  assert.notEqual(rotated, revealed);
  assert.deepEqual(kicked, [[U1, 4003]]);
  assert.equal(await skill.store.keys.byHash(require("../lib/keys.js").hashKey(revealed)), null, "the old key no longer works");
});

test("PCs: own list, unpairing own only, admin may unpair any", async (t) => {
  const skill = await loadSkill(t);
  const handlers = await captureRoutes(routes);

  await skill.store.devices.create({ deviceId: "pc-of-masha", userId: U1, name: "Игровой", config: { name: "Игровой", apps: [{ id: "steam:570", name: "Dota 2" }], shared: false } });
  await skill.store.devices.create({ deviceId: "pc-of-petya", userId: U2, name: "Петин", config: { name: "Петин", apps: [], shared: true } });
  skill.index.upsert({ deviceId: "pc-of-petya", userId: U2, userName: "Петя", config: { name: "Петин", shared: true, apps: [] } });

  const me = (await handlers["GET /me"](request(U1), reply())).body.result;

  assert.deepEqual(me.devices.map((device) => [device.id, device.name, device.apps, device.online]), [["pc-of-masha", "Игровой", 1, false]]);
  assert.deepEqual(me.shared.map((device) => device.name), ["Петин"]);
  assert.equal(me.server.port, skill.server.address());

  assert.equal((await handlers["DELETE /devices/:id"](request(U1, { params: { id: "pc-of-petya" } }), reply())).statusCode, 403);
  assert.equal((await handlers["DELETE /devices/:id"](request(U1, { params: { id: "pc-of-masha" } }), reply())).body.success, true);
  assert.equal(await skill.store.devices.byId("pc-of-masha"), null);
  assert.equal((await handlers["DELETE /devices/:id"](request(U1, { role: "admin", params: { id: "pc-of-petya" } }), reply())).body.success, true);
  assert.equal((await handlers["DELETE /devices/:id"](request(U1, { params: { id: "../x" } }), reply())).statusCode, 404);
});

test("test-phrase, history, admin-only routes", async (t) => {
  const skill = await loadSkill(t);
  const handlers = await captureRoutes(routes);

  skill.index.upsert({ deviceId: "d1", userId: U1, config: { name: "Игровой", apps: [{ id: "steam:570", name: "Dota 2", aliases: [] }] }, online: true });

  const phrase = (await handlers["POST /test-phrase"](request(U1, { body: { text: "запусти доту" } }), reply())).body.result.result;

  assert.equal(phrase.intent, "launch_app");
  assert.equal((await handlers["POST /test-phrase"](request(U1, { body: {} }), reply())).statusCode, 400);

  await skill.store.history.add({ userId: U1, deviceId: "d1", action: "app.launch", target: "Dota 2", ok: true, code: "", via: "voice" });
  await skill.store.history.add({ userId: U2, deviceId: "x", action: "app.launch", target: "secret", ok: true, code: "", via: "voice" });

  const history = (await handlers["GET /history"](request(U1), reply())).body.result.items;

  assert.deepEqual(history.map((item) => [item.pc, item.target]), [["Игровой", "Dota 2"]]);
  assert.equal((await handlers["GET /admin/overview"](request(U1), reply())).statusCode, 403);
  assert.equal((await handlers["GET /admin/overview"](request(U1, { role: "admin" }), reply())).body.success, true);
  assert.equal((await handlers["GET /debug"](request(U1), reply())).statusCode, 403);
});
