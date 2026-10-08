// Voice scenarios of the task: which PC gets a command (2.1-2.4), who speaks (3),
// confirmations, closing, Wake-on-LAN, the AI pick. The hub is a fake that records commands.
const test = require("node:test");
const assert = require("node:assert/strict");

const state = require("../lib/state.js");
const { NameIndex } = require("../lib/name-index.js");
const { RecentChoices } = require("../lib/select.js");
const { Deferred } = require("../lib/deferred.js");
const { createMemoryStore } = require("../lib/store.js");
const { readSettings } = require("../lib/settings.js");
const { runCommand } = require("../lib/command.js");
const { classify } = require("../lib/parse.js");
const { fakeCtx, configs } = require("./fakes.js");
const pcControl = require("../intents/pc_control/index.js");

const U1 = "64b000000000000000000001";
const U2 = "64b000000000000000000002";

const app = (id, name, aliases = [], kind = "app") => ({ id, name, aliases, kind });
const GAMING = {
  name: "Игровой",
  wol: { mac: "aa:bb:cc:dd:ee:ff", broadcast: "192.168.0.255", adapter: "ethernet" },
  apps: [app("steam:570", "Dota 2", [], "game"), app("start:chrome", "Google Chrome", ["хром"]), app("gog:1", "The Witcher 3: Wild Hunt", [], "game")],
  prefs: { confirmPower: true, volumeStep: 10, searchEngine: "yandex" },
  features: {},
};
const LAPTOP = { name: "Ноутбук", apps: [app("start:chrome", "Google Chrome", ["хром"]), app("start:word", "Microsoft Word", ["ворд"])], prefs: {}, features: {} };

/**
 * A loaded skill with PCs; the hub answers commands with `replies[action]`.
 * @param {{ devices?: object[], replies?: object, settings?: object }} options
 */
function setup({ devices = [], replies = {}, settings = {} } = {}) {
  const index = new NameIndex();

  for (const device of devices) index.upsert({ deviceId: device.id, userId: device.userId ?? U1, userName: "Маша", online: device.online ?? true, config: device.config });

  const calls = [];
  const hub = {
    command: async (deviceId, action, args) => {
      calls.push({ deviceId, action, args });

      const reply = typeof replies[action] === "function" ? replies[action](args, deviceId) : replies[action];

      return reply ?? { ok: true, code: null, data: {} };
    },
    learn: (deviceId, appId, alias) => calls.push({ deviceId, learn: { appId, alias } }),
    isOnline: (deviceId) => Boolean(index.get(deviceId)?.online),
  };
  const notes = [];
  const woken = [];
  const skill = {
    store: createMemoryStore(),
    recent: new RecentChoices(),
    deferred: new Deferred(),
    configs: configs(settings),
    settings: readSettings(configs(settings)),
    ctx: fakeCtx(),
    wake: async (mac) => woken.push(mac),
    notify: async (userId, text) => notes.push({ userId, text }),
    backgroundCtx() {
      return this.ctx;
    },
  };

  state.set({ skill, index, hub });

  return { index, hub, calls, skill, notes, woken };
}

/** Say a phrase: our classifier, then the command pipeline (like match() + handler). */
async function say(phrase, ctxOptions = {}, settings = {}) {
  const ctx = fakeCtx({ text: phrase, ...ctxOptions });
  const { index } = state.get();
  const parsed = classify(phrase, { index, userId: ctx.user.id });

  assert.ok(parsed, `the phrase is ours: ${phrase}`);

  return { answer: await runCommand(ctx, configs(settings), parsed.intent, parsed.params), ctx };
}

test.afterEach(() => state.set(null));

test("2.1: no PCs at all, or none online", async () => {
  setup({ devices: [{ id: "d1", config: GAMING, online: false }, { id: "d2", config: LAPTOP, online: false }] });
  assert.equal((await say("выключи компьютер")).answer, "Ни один твой компьютер сейчас не в сети.");

  setup({ devices: [{ id: "d1", config: GAMING, userId: U2 }] });
  assert.equal((await say("выключи компьютер")).answer, "У тебя нет подключённых компьютеров. Ключ для подключения — в «Моих настройках» навыка Ghost Hands.");
});

test("2.2: the only PC online gets the command without questions", async () => {
  const { calls } = setup({ devices: [{ id: "d1", config: GAMING }, { id: "d2", config: LAPTOP, online: false }] });
  const { answer, ctx } = await say("запусти доту");

  assert.equal(answer, "Запускаю Dota 2 на компьютере «Игровой».");
  assert.deepEqual(calls, [{ deviceId: "d1", action: "app.launch", args: { appId: "steam:570" } }]);
  assert.deepEqual(ctx.calls.asked, []);
});

test("2.3: the named PC gets it", async () => {
  const { calls } = setup({ devices: [{ id: "d1", config: GAMING }, { id: "d2", config: LAPTOP }] });

  assert.equal((await say("открой хром на ноутбуке")).answer, "Запускаю Google Chrome на компьютере «Ноутбук».");
  assert.equal(calls[0].deviceId, "d2");
});

test("2.4: several PCs can do it and none is named - ask which", async () => {
  const { calls } = setup({ devices: [{ id: "d1", config: GAMING }, { id: "d2", config: LAPTOP }] });
  const { answer, ctx } = await say("открой хром", { answers: ["на ноутбуке"] });

  assert.deepEqual(ctx.calls.asked, ["На каком компьютере: «Игровой» или «Ноутбук»?"]);
  assert.equal(answer, "Запускаю Google Chrome на компьютере «Ноутбук».");
  assert.equal(calls[0].deviceId, "d2");

  // the PC chosen a moment ago is used again
  const next = await say("закрой хром", {}, {});

  assert.deepEqual(next.ctx.calls.asked, []);
  assert.equal(calls[1].deviceId, "d2");
});

test("questions wait 10 s, not the 20 s of NODUS: game sounds keep the microphone open", async () => {
  setup({ devices: [{ id: "d1", config: GAMING }, { id: "d2", config: LAPTOP }] });

  const { ctx } = await say("открой хром", { answers: ["первый"] });

  assert.deepEqual(ctx.calls.askOptions, [{ timeoutMs: 10_000 }]);
});

test("the answer is always a string: anything else keeps NODUS silent and deaf", async () => {
  setup({ devices: [{ id: "d1", config: GAMING }] });

  for (const intent of ["constructor", "toString", "nope"]) {
    assert.equal(await runCommand(fakeCtx(), configs({}), intent, {}), "Не получилось. Попробуй ещё раз.");
  }
});

test("app_confidence: a lower threshold runs a close name without asking", async () => {
  const aoe = { name: "Игровой", apps: [app("steam:813780", "Age of Empires II: Definitive Edition", [], "game")], prefs: {}, features: {} };

  setup({ devices: [{ id: "d1", config: aoe }] });

  const asked = await say("запусти эйдж оф эмпайрс два", { answers: ["да"] });

  assert.deepEqual(asked.ctx.calls.asked, ["Запустить Age of Empires II?"]);

  const { index } = state.get();
  const direct = await say("запусти эйдж оф эмпайрс два", {}, { app_confidence: 80 });

  assert.equal(index.accept, 0.8);
  assert.deepEqual(direct.ctx.calls.asked, []);
  assert.equal(direct.answer, "Запускаю Age of Empires II.");
});

test("2.4: answers - an ordinal, silence, cancel", async () => {
  setup({ devices: [{ id: "d1", config: GAMING }, { id: "d2", config: LAPTOP }] });
  assert.equal((await say("открой хром", { answers: ["второй"] }, { ask_pc_every_time: true })).answer, "Запускаю Google Chrome на компьютере «Ноутбук».");
  assert.equal((await say("открой хром", { answers: [null] }, { ask_pc_every_time: true })).answer, "Не расслышал, отменяю.");
  assert.equal((await say("открой хром", { answers: ["отмена"], female: true }, { ask_pc_every_time: true })).answer, "Хорошо, отменяю.");
});

test("smart choice: an app that only one PC has needs no question", async () => {
  const { calls } = setup({ devices: [{ id: "d1", config: GAMING }, { id: "d2", config: LAPTOP }] });
  const { ctx } = await say("запусти доту");

  assert.deepEqual(ctx.calls.asked, []);
  assert.equal(calls[0].deviceId, "d1");
});

test("3: an unknown voice is asked who it is; PCs belong to their owner", async () => {
  const { calls } = setup({ devices: [{ id: "d1", config: GAMING }] });
  const { answer, ctx } = await say("запусти доту", { userId: null, requireAnswer: U1 });

  assert.equal(ctx.calls.require, 1);
  assert.equal(answer, "Запускаю Dota 2.");
  assert.equal(calls.length, 1);

  setup({ devices: [{ id: "d1", config: GAMING }] });
  assert.equal((await say("запусти доту", { userId: null, requireAnswer: null })).answer, "Не понял, кто говорит, поэтому ничего не делаю.");
  setup({ devices: [{ id: "d1", config: GAMING }] });
  assert.equal((await say("запусти доту", { userId: null }, { unknown_voice: "deny" })).answer, "Не узнал голос, поэтому компьютером управлять не буду.");
});

test("3: shared PCs work for everyone; guests only with the setting", async () => {
  const shared = { ...GAMING, shared: true };

  setup({ devices: [{ id: "d1", config: shared, userId: U2 }] });
  assert.equal((await say("запусти доту")).answer, "Запускаю Dota 2.");

  setup({ devices: [{ id: "d1", config: shared, userId: U2 }] });
  assert.equal((await say("запусти доту", { audience: "guest" })).answer, "В гостевом режиме управлять компьютерами нельзя.");

  setup({ devices: [{ id: "d1", config: shared, userId: U2 }] });
  assert.equal((await say("запусти доту", { audience: "guest" }, { guests_shared: true })).answer, "Запускаю Dota 2.");
});

test("children may not shut down by default; a voice check can be required", async () => {
  setup({ devices: [{ id: "d1", config: GAMING }] });
  assert.equal((await say("выключи компьютер", { audience: "child" })).answer, "Это может сделать только взрослый.");

  setup({ devices: [{ id: "d1", config: GAMING }] });
  assert.equal((await say("запусти доту", { audience: "child" })).answer, "Запускаю Dota 2.");

  const { calls } = setup({ devices: [{ id: "d1", config: GAMING }] });
  const failed = await say("выключи компьютер", { verified: false }, { voice_check: "power" });

  assert.equal(failed.answer, "", "NODUS has already said why");
  assert.equal(failed.ctx.calls.requireVerified, 1);
  assert.equal(calls.length, 0);
});

test("power: a confirmation mentions open apps; no - nothing happens", async () => {
  const { calls, index } = setup({ devices: [{ id: "d1", config: GAMING }] });

  index.setState("d1", { running: [{ key: "exe:ps", name: "Photoshop", appId: null, game: false, fg: true }] });

  const refused = await say("выключи компьютер", { answers: ["нет, не надо"] });

  assert.deepEqual(refused.ctx.calls.asked, ["Выключить «Игровой»? Там ещё работает Photoshop."]);
  assert.equal(refused.answer, "Хорошо, не трогаю.");
  assert.equal(calls.length, 0);

  const agreed = await say("выключи компьютер", { answers: ["да"] });

  assert.equal(agreed.answer, "Выключаю компьютер.");
  assert.deepEqual(calls[0], { deviceId: "d1", action: "power.shutdown", args: { delaySec: 0 } });
});

test("power: a delay needs no confirmation; cancel and lock", async () => {
  const { calls } = setup({ devices: [{ id: "d1", config: GAMING }, { id: "d2", config: LAPTOP, online: false }] });

  assert.equal((await say("выключи компьютер через полчаса")).answer, "Компьютер «Игровой» выключится через 30 минут.");
  assert.deepEqual(calls[0].args, { delaySec: 1800 });
  assert.equal((await say("выключи компьютер через час и 21 минуту")).answer, "Компьютер «Игровой» выключится через 1 час 21 минуту.");
  assert.equal((await say("отмени выключение", { female: true })).answer, "Отменила выключение.");
  assert.equal((await say("заблокируй компьютер")).answer, "Блокирую компьютер «Игровой».");
});

test("volume: steps, values, answers from the PC", async () => {
  const { calls } = setup({
    devices: [{ id: "d1", config: GAMING }],
    replies: { "volume.change": (args) => ({ ok: true, data: { level: 40 + args.delta, muted: false } }), "volume.set": (args) => ({ ok: true, data: { level: args.level } }) },
  });

  assert.equal((await say("сделай громче на компьютере")).answer, "Громкость 50%.");
  assert.deepEqual(calls[0].args, { delta: 10 });
  assert.equal((await say("сделай намного тише на компьютере")).answer, "Громкость 20%.");
  assert.equal((await say("громкость на компьютере тридцать")).answer, "Громкость 30%.");
  assert.equal((await say("выключи звук на компьютере", { female: true })).answer, "Выключила звук.");
});

test("close: a stuck app is force-closed after a yes; a generic game", async () => {
  const { calls, index } = setup({
    devices: [{ id: "d1", config: GAMING }],
    replies: {
      "app.close": (args) => (args.force ? { ok: true, data: { closed: [1] } } : args.target === "game" ? { ok: true, data: { name: "Dota 2", closed: [1] } } : { ok: true, data: { closed: [], pending: [1] } }),
    },
  });

  index.setState("d1", { running: [{ key: "exe:dota", name: "Dota 2", appId: "steam:570", game: true, fg: true }] });

  const stuck = await say("закрой доту", { answers: ["да"] });

  assert.deepEqual(stuck.ctx.calls.asked, ["Dota 2 не закрывается. Закрыть принудительно?"]);
  assert.equal(stuck.answer, "Закрыл Dota 2 принудительно.");
  assert.deepEqual(calls.map((call) => call.args), [{ appId: "steam:570" }, { appId: "steam:570", force: true }]);
  assert.equal((await say("выключи игру", { female: true })).answer, "Закрыла Dota 2.");
});

test("close: an app without a window (in the tray) is offered a forced close", async () => {
  setup({
    devices: [{ id: "d1", config: GAMING }],
    replies: { "app.close": (args) => (args.force ? { ok: true, data: { closed: [1] } } : { ok: true, data: { name: "Google Chrome", closed: [], pending: [1], background: true } }) },
  });

  const { ctx, answer } = await say("закрой хром", { answers: ["нет"] });

  assert.deepEqual(ctx.calls.asked, ["Google Chrome работает в фоне без окна. Закрыть принудительно?"]);
  assert.equal(answer, "Хорошо, оставляю.");
});

test("errors of the PC become words", async () => {
  setup({ devices: [{ id: "d1", config: GAMING }], replies: { "app.launch": { ok: false, code: "launcher-missing", data: {} } } });
  assert.equal((await say("запусти доту")).answer, "Для Dota 2 нужен лаунчер, а на компьютере «Игровой» его нет.");

  setup({ devices: [{ id: "d1", config: GAMING }], replies: { "app.launch": { ok: false, code: "timeout", data: {} } } });
  assert.equal((await say("запусти доту")).answer, "Компьютер «Игровой» не ответил.");
});

test("search uses the engine of the PC", async () => {
  const { calls } = setup({ devices: [{ id: "d1", config: GAMING }] });

  assert.equal((await say("найди в интернете рецепт борща")).answer, "Ищу «рецепт борща».");
  assert.deepEqual(calls[0].args, { query: "рецепт борща", engine: "yandex" });
});

test("Wake-on-LAN: wake an offline PC, launch after it comes", async () => {
  const { calls, woken, skill, notes } = setup({ devices: [{ id: "d1", config: GAMING, online: false }] });

  assert.equal((await say("включи компьютер")).answer, "Включаю «Игровой». Он появится в сети примерно через минуту.");
  assert.deepEqual(woken, ["aa:bb:cc:dd:ee:ff"]);

  const { answer, ctx } = await say("запусти доту", { answers: ["да"] });

  assert.deepEqual(ctx.calls.asked, ["Компьютер «Игровой» выключен. Включить его?"]);
  assert.equal(answer, "Включаю «Игровой». Запущу Dota 2, когда он загрузится.");
  assert.equal(skill.deferred.has("d1"), true);

  state.get().index.setOnline("d1", true);
  skill.deferred.ready("d1");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls.at(-1), { deviceId: "d1", action: "app.launch", args: { appId: "steam:570" } });
  assert.deepEqual(notes, [{ userId: U1, text: "Запускаю Dota 2." }]);
});

test("the AI picks a name nobody matched; the pick is confirmed and learned", async () => {
  const { calls } = setup({ devices: [{ id: "d1", config: GAMING }] });
  const llm = { isLocal: false, isPrivate: true, structured: async () => ({ app: "The Witcher 3" }) };
  const { answer, ctx } = await say("запусти ведьмака", { llm, answers: ["да"] });

  assert.deepEqual(ctx.calls.asked, ["Запустить The Witcher 3?"]);
  assert.equal(answer, "Запускаю The Witcher 3.");
  assert.deepEqual(calls.find((call) => call.learn), { deviceId: "d1", learn: { appId: "gog:1", alias: "ведьмака" } });
});

test("status: which PCs are online", async () => {
  setup({ devices: [{ id: "d1", config: GAMING }, { id: "d2", config: LAPTOP }] });

  const ctx = fakeCtx({ text: "какие компьютеры в сети" });

  assert.equal(await runCommand(ctx, [], "pc_status", {}), "В сети: «Игровой» и «Ноутбук».");
});

test("the AI agent tool runs the same pipeline", async () => {
  const { calls } = setup({ devices: [{ id: "d1", config: GAMING }, { id: "d2", config: LAPTOP }] });
  const ctx = fakeCtx({ text: "запусти дотку на игровом" });

  assert.equal(await pcControl.handler({ action: "launch", target: "Dota 2", computer: "игровой" }, ctx, []), "Запускаю Dota 2 на компьютере «Игровой».");
  assert.equal(calls[0].deviceId, "d1");
  assert.equal(await pcControl.handler({ action: "volume_set", value: "35", computer: "ноутбук" }, ctx, []), "Громкость на «Ноутбук» — 0%.");
  assert.deepEqual(calls[1], { deviceId: "d2", action: "volume.set", args: { level: 35 } });
  assert.equal(await pcControl.handler({ action: "nope" }, ctx, []), "Такой команды для компьютера нет.");
});

test("English answers", async () => {
  setup({ devices: [{ id: "d1", config: GAMING }] });
  assert.equal((await say("launch dota", { language: "en" })).answer, "Starting Dota 2.");
});
