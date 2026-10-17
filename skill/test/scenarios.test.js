// Scenarios of the PC: waiting for runs, the NODUS event, the voice, the block.
const test = require("node:test");
const assert = require("node:assert/strict");

const P = require("../lib/protocol.js");
const state = require("../lib/state.js");
const { ScenarioWaiters, newRunId } = require("../lib/scenarios.js");
const { ScenarioEvents } = require("../lib/events.js");
const { NameIndex } = require("../lib/name-index.js");
const { RecentChoices } = require("../lib/select.js");
const { Deferred } = require("../lib/deferred.js");
const { createMemoryStore } = require("../lib/store.js");
const { readSettings } = require("../lib/settings.js");
const { runCommand } = require("../lib/command.js");
const { classify } = require("../lib/parse.js");
const GhostHands = require("../index.js");
const runScenario = require("../nodes/pc_run_scenario/index.js");
const { fakeCtx, configs } = require("./fakes.js");

const U1 = "64b000000000000000000001";
const STREAM = "scnstream001";
const MORNING = "scnmorning01";
const SECRET = "scnsecret001";
const CHROME = "scnchrome001";

const scenario = (id, name, { aliases = [], voice = true } = {}) => ({ id, name, aliases, spoken: "", voice });
const GAMING = {
  name: "Игровой",
  apps: [{ id: "steam:570", name: "Dota 2", aliases: [], kind: "game" }, { id: "start:chrome", name: "Google Chrome", aliases: ["хром"], kind: "app" }],
  scenarios: [scenario(STREAM, "Режим стрима"), scenario(MORNING, "Утро"), scenario(SECRET, "Тайный", { voice: false }), scenario(CHROME, "Хром")],
  prefs: {},
  features: {},
};
const LAPTOP = { name: "Ноутбук", apps: [], scenarios: [scenario("scnlaptop001", "Работа")], prefs: {}, features: {} };

const finished = (runId, id, fields = {}) => ({ runId, id, name: "Режим стрима", status: "finished", result: "success", output: "", error: "", trigger: "nodus", ms: 5, ...fields });

/* ── waiting for runs ── */

test("waiters: the finished run answers, also when it came first; other PCs and timeouts", async () => {
  const waiters = new ScenarioWaiters();
  const runId = newRunId();

  assert.match(runId, P.RUN_ID_RE);

  const waiting = waiters.wait("d1", runId, { timeoutMs: 5000 });

  waiters.handle("d2", finished(runId, STREAM));
  waiters.handle("d1", { ...finished(runId, STREAM), status: "started" });
  waiters.handle("d1", finished(runId, STREAM, { output: "42" }));
  assert.equal((await waiting).output, "42");

  // a short run may report before anybody waits
  waiters.handle("d1", finished("early-run", STREAM));
  assert.equal((await waiters.wait("d1", "early-run", { timeoutMs: 5000 })).runId, "early-run");

  await assert.rejects(waiters.wait("d1", "late-run", { timeoutMs: 100 }), /timeout/);

  const gone = waiters.wait("d1", "gone-run", { timeoutMs: 5000 });

  waiters.offline("d1");
  await assert.rejects(gone, /disconnected/);

  const controller = new AbortController();
  const stopped = waiters.wait("d1", "stop-run", { timeoutMs: 5000, signal: controller.signal });

  controller.abort();
  await assert.rejects(stopped, /aborted/);
  assert.equal(waiters.waiting.size, 0);
});

/* ── the NODUS event ── */

test("pc_scenario_finished: the run's result for the owner's scenarios, a flood is cut", () => {
  const fired = [];
  const ctx = { skillId: "ghost_hands", scenarioEngine: { fireSkillEvent: async (...args) => (fired.push(args), 1) } };
  const events = new ScenarioEvents({ ctx, startedAt: Date.now() - 3600_000 });
  const device = { deviceId: "d1", userId: U1, name: "Игровой", shared: false };

  events.scenario(device, finished("run-0001", STREAM, { result: "error", error: "focus-lost" }));
  assert.deepEqual(fired[0], [
    "ghost_hands",
    "pc_scenario_finished",
    { from: U1, computer: "Игровой", text: "Режим стрима", scenario: "Режим стрима", scenarioId: STREAM, status: "error", output: "", error: "focus-lost", trigger: "nodus" },
    { ownerId: U1 },
  ]);

  for (let i = 0; i < 30; i++) events.scenario(device, finished(`run-${i}x`, STREAM));
  assert.equal(fired.length, 20);
  events.dispose();
});

/* ── the voice ── */

function setup({ devices = [], replies = {} } = {}) {
  const index = new NameIndex();

  for (const device of devices) index.upsert({ deviceId: device.id, userId: U1, userName: "Маша", online: device.online ?? true, config: device.config });

  const calls = [];
  const hub = {
    command: async (deviceId, action, args) => {
      calls.push({ deviceId, action, args });
      return replies[action] ?? { ok: true, code: null, data: {} };
    },
    learn: () => undefined,
    supports: (deviceId, cap) => cap === "scenarios",
    isOnline: (deviceId) => Boolean(index.get(deviceId)?.online),
  };
  const skill = { store: createMemoryStore(), recent: new RecentChoices(), deferred: new Deferred(), configs: [], settings: readSettings([]), ctx: fakeCtx(), notify: async () => undefined, backgroundCtx() { return this.ctx; } };

  state.set({ skill, index, hub });
  return { index, calls };
}

async function say(phrase, ctxOptions = {}) {
  const ctx = fakeCtx({ text: phrase, ...ctxOptions });
  const { index } = state.get();
  const parsed = classify(phrase, { index, userId: ctx.user.id });

  assert.ok(parsed, `the phrase is ours: ${phrase}`);
  return { answer: await runCommand(ctx, configs({}), parsed.intent, parsed.params), ctx, intent: parsed.intent };
}

test.afterEach(() => state.set(null));

test("voice: a scenario's name runs it like an app; «сценарий … на компьютере» too", async () => {
  const { calls } = setup({ devices: [{ id: "d1", config: GAMING }] });
  const stream = await say("запусти режим стрима");

  assert.equal(stream.intent, "launch_app");
  assert.equal(stream.answer, "Запускаю сценарий «Режим стрима».");
  assert.equal(calls[0].action, "scenario.run");
  assert.equal(calls[0].args.id, STREAM);
  assert.equal(calls[0].args.via, "voice");
  assert.match(calls[0].args.runId, P.RUN_ID_RE);

  const morning = await say("запусти сценарий утро на компьютере");

  assert.equal(morning.intent, "pc_scenario");
  assert.equal(morning.answer, "Запускаю сценарий «Утро».");
  assert.equal(calls[1].args.id, MORNING);

  // a scenario without a voice name is only for the client and NODUS blocks
  assert.equal((await say("запусти сценарий тайный на компьютере")).answer, "Не нашёл сценарий «тайный» на твоих компьютерах.");
  assert.equal(calls.length, 2);
});

test("voice: a running scenario, an invalid one; two PCs say where", async () => {
  setup({ devices: [{ id: "d1", config: GAMING }], replies: { "scenario.run": { ok: true, code: null, data: { already: true } } } });
  assert.equal((await say("запусти режим стрима")).answer, "Сценарий «Режим стрима» уже выполняется.");

  setup({ devices: [{ id: "d1", config: GAMING }], replies: { "scenario.run": { ok: false, code: "scenario-invalid", data: {} } } });
  assert.equal((await say("запусти режим стрима")).answer, "В сценарии Режим стрима есть ошибки. Открой его в Ghost Hands на компьютере «Игровой».");

  const { calls } = setup({ devices: [{ id: "d1", config: GAMING }, { id: "d2", config: LAPTOP }] });

  assert.equal((await say("запусти сценарий работа на компьютере")).answer, "Запускаю сценарий «Работа» на компьютере «Ноутбук».");
  assert.equal(calls[0].deviceId, "d2");
});

test("voice: a scenario named like an app - NODUS asks, «сценарий» picks it", async () => {
  const { calls } = setup({ devices: [{ id: "d1", config: GAMING }] });
  const { answer, ctx } = await say("запусти хром", { answers: ["сценарий"] });

  assert.equal(ctx.calls.asked.length, 1);
  assert.match(ctx.calls.asked[0], /Google Chrome/);
  assert.match(ctx.calls.asked[0], /сценарий «Хром»/);
  assert.equal(answer, "Запускаю сценарий «Хром».");
  assert.deepEqual(calls.map((call) => call.args.id), [CHROME]);
});

test("voice: stop by name while it runs, stop all, nothing to stop", async () => {
  const { index, calls } = setup({ devices: [{ id: "d1", config: GAMING }] });

  index.setState("d1", { running: [], scenarios: [{ id: STREAM, runId: "run-0001" }] });

  const byName = await say("останови режим стрима");

  assert.equal(byName.intent, "pc_scenario");
  assert.equal(byName.answer, "Остановил сценарий «Режим стрима».");
  assert.deepEqual(calls.at(-1), { deviceId: "d1", action: "scenario.stop", args: { id: STREAM } });

  assert.equal((await say("останови все сценарии на компьютере", { female: true })).answer, "Остановила сценарии.");
  assert.deepEqual(calls.at(-1).args, { all: true });

  index.setState("d1", { running: [], scenarios: [] });
  assert.equal((await say("останови сценарий на компьютере")).answer, "На компьютере «Игровой» сейчас не выполняется ни один сценарий.");
  assert.equal(calls.length, 2);
});

/* ── the block ── */

async function loadSkill(t) {
  const ctx = fakeCtx();
  const skill = new GhostHands(ctx, { port: 0 });
  const calls = [];

  skill.store = createMemoryStore();
  await skill.init(ctx);
  await skill.serverStarted;
  t.after(() => skill.destroy());

  skill.index.upsert({ deviceId: "d1", userId: U1, online: true, config: GAMING });
  skill.hub.supports = (deviceId, cap) => cap === "scenarios";

  return { skill, calls };
}

test("block: runs a scenario of the PC and waits for its result", async (t) => {
  const { skill, calls } = await loadSkill(t);
  const device = skill.index.get("d1");

  skill.hub.command = async (deviceId, action, args) => {
    calls.push({ deviceId, action, args });
    // a short scenario: "finished" comes before the answer to the command
    skill.onHubEvent("scenario", { device, event: finished(args.runId, args.id, { output: "42" }) });
    return { ok: true, code: null, data: { runId: args.runId, name: "Тайный" } };
  };

  // any scenario, also without a voice name
  assert.deepEqual(await runScenario.execute({ scenario: "тайный", text: "привет" }, { ownerId: U1 }), { scenario: "Тайный", computer: "Игровой", status: "success", output: "42" });
  assert.deepEqual({ ...calls[0].args, runId: "*" }, { id: SECRET, runId: "*", text: "привет", via: "nodus" });

  assert.deepEqual(await runScenario.execute({ scenario: "утро", wait: false }, { ownerId: U1 }), { scenario: "Утро", computer: "Игровой", status: "started", output: "" });

  skill.hub.command = async (deviceId, action, args) => {
    skill.onHubEvent("scenario", { device, event: finished(args.runId, args.id, { result: "error", error: "focus-lost" }) });
    return { ok: true, code: null, data: { runId: args.runId } };
  };
  await assert.rejects(runScenario.execute({ scenario: "утро" }, { ownerId: U1 }), /scenario-failed: focus-lost/);
  await assert.rejects(runScenario.execute({ scenario: "ракета" }, { ownerId: U1 }), /scenario-not-found/);

  skill.hub.supports = () => false;
  await assert.rejects(runScenario.execute({ scenario: "утро" }, { ownerId: U1 }), /unknown-action/);
});

test("block: waits for the run already going; stopping NODUS stops it on the PC", async (t) => {
  const { skill, calls } = await loadSkill(t);
  const device = skill.index.get("d1");

  skill.hub.command = async (deviceId, action, args) => {
    calls.push({ deviceId, action, args });
    return action === "scenario.run" ? { ok: true, code: null, data: { runId: "run-going", already: true } } : { ok: true, code: null, data: { stopped: 1 } };
  };

  const waiting = runScenario.execute({ scenario: "утро" }, { ownerId: U1 });

  await new Promise((resolve) => setTimeout(resolve, 20));
  skill.onHubEvent("scenario", { device, event: finished("run-going", MORNING, { output: "ok" }) });
  assert.equal((await waiting).output, "ok");

  const controller = new AbortController();
  const stopped = runScenario.execute({ scenario: "утро" }, { ownerId: U1, signal: controller.signal });

  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(stopped, /aborted/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls.at(-1), { deviceId: "d1", action: "scenario.stop", args: { runId: "run-going" } });
});

test("a step's text is said to the PC's owner", async (t) => {
  const { skill } = await loadSkill(t);

  skill.onHubEvent("say", { device: skill.index.get("d1"), text: "Стрим запущен", runId: "run-0001" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(skill.ctx.calls.notify.at(-1).to, U1);
  assert.equal(skill.ctx.calls.notify.at(-1).text, "Компьютер «Игровой»: Стрим запущен");
});
