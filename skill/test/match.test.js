// The "run without asking" threshold (setting app_confidence) and the time limit of the AI pick.
const test = require("node:test");
const assert = require("node:assert/strict");

const names = require("../lib/names.js");
const { NameIndex } = require("../lib/name-index.js");
const { readSettings } = require("../lib/settings.js");
const { classify, SCORES } = require("../lib/parse.js");
const { pickApp, LOCAL_CHOICES } = require("../lib/llm-pick.js");
const { fakeCtx } = require("./fakes.js");

const AOE = "Age of Empires II: Definitive Edition";
// "эйдж оф эмпайрс два" scores 0.82 against it: weak by default, certain at 80 %
const SPOKEN = "эйдж оф эмпайрс два";

const pc = (apps) => ({ name: "Игровой", aliases: [], shared: false, apps: apps.map((name, i) => ({ id: `steam:${i + 1}`, name, aliases: [], kind: "game", source: "steam" })) });

test("decide: the accept score is a parameter; close names stay a question", () => {
  const one = [{ key: "a", name: "A", score: 0.82, coverage: 1 }];

  assert.equal(names.decide(one).status, "weak");
  assert.equal(names.decide(one, { accept: 0.8 }).status, "match");
  assert.equal(names.decide([...one, { key: "b", name: "B", score: 0.8, coverage: 1 }], { accept: 0.8 }).status, "ambiguous");
  // below the confirmation band nothing is offered; an accept under it moves the band down
  assert.equal(names.decide([{ key: "a", score: 0.7 }]).status, "none");
  assert.equal(names.decide([{ key: "a", score: 0.7 }], { accept: 0.65 }).status, "match");
});

test("app_confidence: percent from the panel, 60-100, 86 by default", () => {
  assert.equal(readSettings([]).acceptScore, 0.86);
  assert.equal(readSettings([{ key: "app_confidence", value: 80 }]).acceptScore, 0.8);
  assert.equal(readSettings([{ key: "app_confidence", value: "75" }]).acceptScore, 0.75);
  assert.equal(readSettings([{ key: "app_confidence", value: 30 }]).acceptScore, 0.86);
  assert.equal(readSettings([{ key: "app_confidence", value: 101 }]).acceptScore, 0.86);
});

test("the index: routing and matching follow the setting", () => {
  const index = new NameIndex();

  index.upsert({ deviceId: "a", userId: "u", online: true, config: pc([AOE]) });

  assert.equal(index.matchApps(SPOKEN, index.all()).status, "weak");
  assert.equal(classify(`запусти ${SPOKEN}`, { index, userId: "u" }).score, SCORES.appWeak);

  const version = index.version;

  assert.equal(index.setAccept(0.8), true);
  assert.ok(index.version > version, "the phrase memo is dropped");
  assert.equal(index.setAccept(0.8), false);
  assert.equal(index.matchApps(SPOKEN, index.all()).status, "match");
  assert.equal(classify(`запусти ${SPOKEN}`, { index, userId: "u" }).score, SCORES.appMatch);

  index.setAccept(0.2);
  assert.equal(index.accept, 0.6);
});

test("the AI pick never holds a command past its deadline", async () => {
  const hanging = { isLocal: false, isPrivate: true, structured: () => new Promise(() => {}) };
  const choices = [{ key: "witcher", name: "The Witcher 3", app: names.prepareApp({ id: "x:1", name: "The Witcher 3" }) }];
  const started = Date.now();

  assert.equal(await pickApp(fakeCtx({ llm: hanging }), "ведьмака", choices, { deadlineMs: 50 }), null);
  assert.ok(Date.now() - started < 1000);

  const throwing = { isLocal: false, isPrivate: true, structured: () => { throw new Error("down"); } };

  assert.equal(await pickApp(fakeCtx({ llm: throwing }), "ведьмака", choices, { deadlineMs: 50 }), null);
});

test("the built-in model gets a short list and a 'one moment' first", async () => {
  let offered = 0;
  const llm = {
    isLocal: true,
    isPrivate: true,
    structured: async (prompt, schema) => {
      offered = schema.properties.app.enum.length;
      return { app: "Game 7" };
    },
  };
  const choices = Array.from({ length: 50 }, (_, i) => ({ key: `game ${i}`, name: `Game ${i}`, app: names.prepareApp({ id: `x:${i}`, name: `Game ${i}` }) }));
  const ctx = fakeCtx({ llm });
  const picked = await pickApp(ctx, "гейм семь", choices);

  assert.equal(offered, LOCAL_CHOICES + 1, "the names and 'none'");
  assert.equal(picked?.name, "Game 7");
  assert.deepEqual(ctx.calls.spoken, ["Секунду"]);
});
