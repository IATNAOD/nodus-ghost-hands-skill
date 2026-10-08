const test = require("node:test");
const assert = require("node:assert/strict");

const { classify } = require("../lib/parse.js");
const { NameIndex } = require("../lib/name-index.js");
const report = require("../../tools/routing-report.js");

const index = report.demoIndex();
const parse = (text, userId = "u1") => classify(text, { index, userId, now: new Date(2026, 9, 8, 21, 0, 0) });

test("routing: every phrase goes where it should, with a margin over built-in intents", () => {
  const failed = report.run().filter((row) => row.problems.length).map((row) => `${row.phrase}: ${row.problems.join("; ")}`);

  assert.deepEqual(failed, []);
});

test("launch: objects, PC mention, several apps", () => {
  assert.deepEqual(parse("Запусти доту.").params.objects, ["доту"]);

  const onPc = parse("запусти доту на игровом компьютере");

  assert.equal(onPc.score, 32);
  assert.deepEqual(onPc.params.pc.ids, ["d1"]);
  assert.deepEqual(parse("запусти стим и дискорд").params.objects, ["стим", "дискорд"]);
  assert.equal(parse("запусти игру ведьмак").params.marked, true);
  assert.equal(parse("запусти игру").params.generic, "game");
  assert.equal(parse("пожалуйста, запусти доту").intent, "launch_app");
  assert.equal(parse("можешь запустить стим").intent, "launch_app");
});

test("launch: an unknown name after a strong verb is a weak claim", () => {
  const result = parse("запусти ракету");

  assert.equal(result.intent, "launch_app");
  assert.equal(result.score, 8);
  assert.equal(parse("открой ракету"), null, "a soft verb with an unknown object is not ours");
  assert.equal(parse("запусти игровой режим").score, 8, "a scenario phrase (13-15) wins");
});

test("close: generic game, running apps, window only with a PC", () => {
  assert.equal(parse("выключи игру").params.generic, "game");
  assert.equal(parse("закрой доту").intent, "close_app");
  assert.equal(parse("закрой окно"), null);
  assert.equal(parse("закрой окно на компьютере").params.generic, "active");
});

test("close: the active program, window or game - without naming the PC", () => {
  for (const phrase of ["закрой активную программу", "закрой текущее приложение", "закрой активное окно", "закрой эту программу", "закрой программу", "close the active window", "close the current app"]) {
    const parsed = parse(phrase);

    assert.equal(parsed?.intent, "close_app", phrase);
    assert.equal(parsed.params.generic, "active", phrase);
  }
  assert.equal(parse("закрой текущую игру").params.generic, "game");
  // an adjective alone is not a program
  assert.equal(parse("закрой активную вкладку")?.params?.generic ?? null, null);
});

test("power: operations, delays and clock times", () => {
  assert.equal(parse("выключи компьютер").params.op, "shutdown");
  assert.equal(parse("перезагрузи ноутбук через полчаса").params.delaySec, 1800);
  assert.deepEqual(parse("перезагрузи ноутбук через полчаса").params.pc.ids, ["d2"]);

  const clock = parse("выключи компьютер в 23:00");

  assert.equal(clock.params.at, "23:00");
  assert.equal(clock.params.delaySec, 7200);
  assert.equal(parse("отмени выключение").params.op, "cancel");
  assert.equal(parse("переведи компьютер в спящий режим").params.op, "sleep");
  assert.equal(parse("выключи монитор").params.op, "display_off");
  assert.equal(parse("выключи все компьютеры").params.pc.all, true);
  assert.equal(parse("выключи телевизор"), null);
});

test("wake needs Wake-on-LAN or an online PC", () => {
  assert.equal(parse("включи компьютер").intent, "pc_wake");

  const plain = new NameIndex();

  plain.upsert({ deviceId: "x", userId: "u1", online: false, config: { name: "Игровой", apps: [] } });
  assert.equal(classify("включи компьютер", { index: plain, userId: "u1" }), null, "a smart plug may be meant");
});

test("volume: operations and values", () => {
  const params = (text) => parse(text).params;

  assert.deepEqual([params("сделай громче на компьютере").op, params("сделай громче на компьютере").value], ["up", null]);
  assert.deepEqual([params("громкость ноутбука 30").op, params("громкость ноутбука 30").value], ["set", 30]);
  assert.equal(params("громкость на компьютере на максимум").value, 100);
  assert.deepEqual([params("убавь звук на компьютере до 20").op, params("убавь звук на компьютере до 20").value], ["set", 20]);
  assert.deepEqual([params("прибавь громкость на компьютере на 20").op, params("прибавь громкость на компьютере на 20").value], ["up", 20]);
  assert.equal(params("выключи звук на компьютере").op, "mute");
  assert.equal(params("включи звук на ноутбуке").op, "unmute");
  assert.equal(params("какая громкость на компьютере").op, "get");
  assert.equal(params("сделай намного тише на игровом").factor, 2);
  assert.equal(parse("громче"), null);
});

test("search: query and engine", () => {
  assert.deepEqual(parse("найди в интернете рецепт борща").params, { op: "search", query: "рецепт борща", engine: "default", pc: null });
  assert.equal(parse("загугли погоду в сочи").params.engine, "google");
  assert.equal(parse("найди на ютубе обзор айфона").params.engine, "youtube");
  assert.equal(parse("включи на ютубе котиков").params.query, "котиков");
  assert.equal(parse("найди рецепт"), null, "without a marker it may be a question to the AI");
});

test("nobody's PCs: launch and close are not taken", () => {
  assert.equal(classify("запусти доту", { index: new NameIndex(), userId: "u1" }), null);
  assert.equal(parse("запусти доту", "someone-else"), null, "another person's PCs are not in the pool");
});

test("conditions belong to base/conditional", () => {
  assert.equal(parse("если игра запустится выключи свет"), null);
  assert.equal(parse("когда компьютер включится запусти стим"), null);
});

test("parental: the operation and how long", () => {
  const params = (text) => {
    const parsed = parse(text);

    return parsed?.intent === "pc_parental" ? [parsed.params.op, parsed.params.minutes ?? null] : null;
  };

  assert.deepEqual(params("сними ограничения на детском компьютере на час"), ["grant", 60]);
  assert.deepEqual(params("отключи родительский контроль на компьютере на 2 часа"), ["grant", 120]);
  assert.deepEqual(params("сними лимиты до конца дня"), ["grant", "day"]);
  assert.deepEqual(params("разреши еще поиграть на детском компьютере"), ["grant", null]);
  assert.deepEqual(params("lift the limits on the kids computer for an hour"), ["grant", 60]);
  assert.deepEqual(params("верни ограничения на детском компьютере"), ["revoke", null]);
  assert.deepEqual(params("включи родительский контроль снова"), ["revoke", null]);
  assert.deepEqual(params("bring back the limits on the pc"), ["revoke", null]);
  assert.deepEqual(params("сбрось лимиты на детском компьютере"), ["reset", null]);
});
