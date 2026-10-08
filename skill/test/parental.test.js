// Parental control, the skill's part: rules and PIN from the owner only, the payload for the
// client, unlocks by the owner's voice, usage, alerts and "vanished without shutting down".
const test = require("node:test");
const assert = require("node:assert/strict");

const GhostHands = require("../index.js");
const routes = require("../routes/index.js");
const { createMemoryStore } = require("../lib/store.js");
const { ParentalService, pinProblem, VANISH_MS } = require("../lib/parental.js");
const { NameIndex } = require("../lib/name-index.js");
const { classify } = require("../lib/parse.js");
const { runCommand } = require("../lib/command.js");
const { captureRoutes, reply, fakeCtx, configs } = require("./fakes.js");

const OWNER = "64b000000000000000000001";
const KID = "64b000000000000000000002";

const request = (userId, { params = {}, body } = {}) => ({
  params,
  body,
  url: "/skills/ghost_hands/test",
  headers: { "x-nod-user-id": userId, "x-nod-user-role": "user", "x-nod-user-name": "" },
});

/** A loaded skill with the owner's PC "Детский" (one game). */
async function loadSkill(t) {
  const ctx = fakeCtx();
  const skill = new GhostHands(ctx, { port: 0 });

  skill.store = createMemoryStore();
  await skill.init(ctx);
  await skill.serverStarted;
  t.after(() => skill.destroy());

  const config = { name: "Детский", aliases: [], shared: false, apps: [{ id: "steam:570", name: "Dota 2", aliases: [], kind: "game", source: "steam" }, { id: "start:mc", name: "Minecraft", aliases: [], kind: "app", source: "start" }] };

  await skill.store.devices.create({ deviceId: "kids-pc-01", userId: OWNER, name: "Детский", config });
  skill.index.upsert({ deviceId: "kids-pc-01", userId: OWNER, config, online: true });

  return skill;
}

test("PIN: 6-12 digits, not one digit repeated, not a run", () => {
  assert.equal(pinProblem("12345"), "pin-format");
  assert.equal(pinProblem("12a456"), "pin-format");
  assert.equal(pinProblem("111111"), "pin-weak");
  assert.equal(pinProblem("123456"), "pin-weak");
  assert.equal(pinProblem("987654"), "pin-weak");
  assert.equal(pinProblem("583920"), null);
  assert.equal(pinProblem("1234567890"), "pin-weak");
});

test("routes: only the owner sees and changes parental control; the PIN never comes back", async (t) => {
  const skill = await loadSkill(t);
  const handlers = await captureRoutes(routes);
  const sent = [];

  skill.hub.sendParental = (deviceId, payload) => sent.push({ deviceId, payload });

  const list = (await handlers["GET /parental"](request(OWNER), reply())).body.result.devices;

  assert.equal(list.length, 1);
  assert.equal(list[0].enabled, false);
  assert.deepEqual(list[0].apps.map((app) => [app.id, app.game]), [["steam:570", true], ["start:mc", false]]);
  assert.deepEqual((await handlers["GET /parental"](request(KID), reply())).body.result.devices, []);

  // somebody else's PC does not exist for them
  assert.equal((await handlers["PUT /parental/:id"](request(KID, { params: { id: "kids-pc-01" }, body: { enabled: true } }), reply())).statusCode, 404);

  const on = (await handlers["PUT /parental/:id"](request(OWNER, { params: { id: "kids-pc-01" }, body: { enabled: true } }), reply())).body.result;

  assert.equal(on.enabled, true);
  assert.equal(on.rules.limits.weekday.gamesMin, 60, "defaults on the first switch-on");
  assert.equal(skill.index.get("kids-pc-01").parental, true);
  assert.equal(sent.at(-1).payload.enabled, true);

  const rules = { ...on.rules, limits: { weekday: { pcMin: 120, gamesMin: null }, weekend: { pcMin: 240, gamesMin: 90 } }, games: { add: ["start:mc"], remove: [] } };
  const saved = (await handlers["PUT /parental/:id"](request(OWNER, { params: { id: "kids-pc-01" }, body: { rules } }), reply())).body.result;

  assert.equal(saved.rules.limits.weekday.gamesMin, null);
  assert.deepEqual(saved.rules.games.add, ["start:mc"]);

  assert.equal((await handlers["PUT /parental/:id/pin"](request(OWNER, { params: { id: "kids-pc-01" }, body: { pin: "123456" } }), reply())).body.message, "pin-weak");

  const pinned = await handlers["PUT /parental/:id/pin"](request(OWNER, { params: { id: "kids-pc-01" }, body: { pin: "583920" } }), reply());

  assert.equal(pinned.body.result.pinSet, true);
  assert.ok(!JSON.stringify(pinned.body).includes("583920"));
  assert.ok(!JSON.stringify(pinned.body).includes(sent.at(-1).payload.pin.hash), "the hash goes only to the PC");
  assert.equal(sent.at(-1).payload.pin.salt.length, 32);

  assert.equal((await handlers["POST /parental/:id/grant"](request(OWNER, { params: { id: "kids-pc-01" }, body: { minutes: 0 } }), reply())).statusCode, 400);

  const granted = (await handlers["POST /parental/:id/grant"](request(OWNER, { params: { id: "kids-pc-01" }, body: { minutes: 60 } }), reply())).body.result;

  assert.ok(Math.abs(granted.grantUntil - (Date.now() + 3600_000)) < 5000);
  assert.equal((await handlers["POST /parental/:id/revoke"](request(OWNER, { params: { id: "kids-pc-01" } }), reply())).body.result.grantUntil, null);

  await handlers["POST /parental/:id/reset-today"](request(OWNER, { params: { id: "kids-pc-01" } }), reply());
  assert.ok(sent.at(-1).payload.resetAt > Date.now() - 5000);

  // unpairing forgets parental control
  await handlers["DELETE /devices/:id"](request(OWNER, { params: { id: "kids-pc-01" } }), reply());
  assert.equal(await skill.store.parental.byDevice("kids-pc-01"), null);
});

test("voice: the owner, confirmed by voice, lifts the limits; others are refused", async (t) => {
  const skill = await loadSkill(t);
  const say = (phrase, ctxOptions) => {
    const ctx = fakeCtx({ text: phrase, ...ctxOptions });
    const parsed = classify(phrase, { index: skill.index, userId: ctx.user.id });

    return parsed ? runCommand(ctx, configs({}), parsed.intent, parsed.params) : null;
  };

  // no PC under control: the phrase is not ours
  assert.equal(classify("сними ограничения на детском компьютере", { index: skill.index, userId: OWNER }), null);

  await skill.parental.setEnabled({ deviceId: "kids-pc-01", userId: OWNER }, true);

  const parsed = classify("сними ограничения на детском компьютере на час", { index: skill.index, userId: OWNER });

  assert.deepEqual([parsed.intent, parsed.params.op, parsed.params.minutes, parsed.params.pc.ids], ["pc_parental", "grant", 60, ["kids-pc-01"]]);
  assert.equal(classify("отключи родительский контроль на компьютере до конца дня", { index: skill.index, userId: OWNER }).params.minutes, "day");
  assert.equal(classify("верни ограничения на детском компьютере", { index: skill.index, userId: OWNER }).params.op, "revoke");
  assert.equal(classify("сбрось лимиты на детском компьютере", { index: skill.index, userId: OWNER }).params.op, "reset");
  assert.equal(classify("разреши еще поиграть на детском компьютере", { index: skill.index, userId: OWNER }).params.op, "grant");
  // still a shutdown and a launch
  assert.equal(classify("выключи компьютер", { index: skill.index, userId: OWNER }).intent, "pc_power");

  assert.match(await say("сними ограничения на детском компьютере на час", { userId: OWNER }), /^Снял ограничения на компьютере «Детский» до \d{1,2}:\d{2}\.$/);
  assert.ok(skill.parental.view("kids-pc-01").grantUntil > Date.now());
  assert.equal(await say("верни ограничения на детском компьютере", { userId: OWNER, female: true }), "Вернула ограничения на компьютере «Детский».");
  assert.equal(await say("сними ограничения на детском компьютере", { userId: KID }), "Это может сделать только владелец компьютера «Детский».");
  assert.equal(await say("сними ограничения на детском компьютере", { userId: OWNER, verified: false }), "", "NODUS has said why");
});

test("service: usage is kept, alerts reach the owner, a PC that vanishes without bye is reported", async (t) => {
  const store = createMemoryStore();
  const index = new NameIndex();
  const sent = [];
  const notes = [];
  const events = [];
  let online = false;
  const hub = { sendParental: (deviceId, payload) => sent.push(payload), isOnline: () => online };
  const service = new ParentalService({
    store,
    hub,
    index,
    notify: async (userId, text) => notes.push([userId, text]),
    events: { fire: (event, device, payload, options) => events.push([event, payload, options]) },
    t: (key, vars) => `${key} ${vars.pc}`,
  });
  const device = { deviceId: "kids-pc-01", userId: OWNER, name: "Детский", shared: true };

  index.upsert({ deviceId: device.deviceId, userId: OWNER, config: { name: "Детский" }, online: true });
  await service.setEnabled(device, true);

  service.usage(device, { day: "2026-10-08", pcSec: 3600, gameSec: 600, extended: { pc: 0, games: 1 }, locked: "games" });
  assert.equal((await store.parental.byDevice(device.deviceId)).usage.gameSec, 600);
  assert.deepEqual(events.at(-1), ["parental_limit", { text: "Детский", limit: "games" }, { ownerId: OWNER }], "the owner's scenarios even for a shared PC");

  service.alert(device, "killed");
  assert.deepEqual(notes.at(-1), [OWNER, "parental.killed Детский"]);

  t.mock.timers.enable({ apis: ["setTimeout"] });
  service.offline(device, "shutdown");
  t.mock.timers.tick(VANISH_MS + 1000);
  assert.equal(notes.length, 1, "a shutdown is fine");

  service.offline(device, null);
  service.online(device);
  t.mock.timers.tick(VANISH_MS + 1000);
  assert.equal(notes.length, 1, "it came back");

  service.offline(device, null);
  t.mock.timers.tick(VANISH_MS + 1000);
  assert.deepEqual(notes.at(-1), [OWNER, "parental.vanished Детский"]);

  // voice alerts off: NODUS keeps quiet, the scenarios still get the event
  await service.setRules(device, { voice: false });
  service.alert(device, "pin-failed");
  assert.equal(notes.length, 2);
  assert.deepEqual(events.at(-1), ["parental_alert", { text: "Детский", alert: "pin-failed" }, { ownerId: OWNER }]);
  service.offline(device, null);
  t.mock.timers.tick(VANISH_MS + 1000);
  assert.equal(notes.length, 2);
  assert.equal(events.at(-1)[1].alert, "vanished");
  service.dispose();
});
