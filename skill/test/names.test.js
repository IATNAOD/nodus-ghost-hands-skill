// node --test "skill/test/**/*.test.js"
const test = require("node:test");
const assert = require("node:assert/strict");

const names = require("../lib/names.js");
const corpus = require("./names.vectors.json");

const apps = corpus.apps.map((app, i) => names.prepareApp({ id: `x:${i}`, name: app.name, aliases: app.aliases ?? [] }));

const resolve = (spoken) => {
  const tokens = names.prepare(spoken);
  const candidates = apps
    .map((app) => ({ key: names.appKey(app.name), name: app.name, ...names.scoreApp(tokens, app) }))
    .filter((candidate) => candidate.score >= 0.6);

  return names.decide(candidates);
};

test("corpus: spoken names find the right app", () => {
  const wrong = [];

  for (const [spoken, expected] of corpus.vectors) {
    const result = resolve(spoken);
    const got = result.best?.name ?? null;

    if (expected === null) {
      if (result.status !== "none") wrong.push(`${spoken}: expected nothing, got ${result.status} ${got}`);
    } else if (expected === "?") {
      if (result.status !== "ambiguous") wrong.push(`${spoken}: expected a question, got ${result.status} ${got}`);
    } else if (expected.startsWith("~")) {
      if (!["match", "weak"].includes(result.status) || got !== expected.slice(1)) wrong.push(`${spoken}: expected ${expected}, got ${result.status} ${got}`);
    } else if (result.status !== "match" || got !== expected) {
      wrong.push(`${spoken}: expected ${expected}, got ${result.status} ${got}`);
    }
  }

  assert.deepEqual(wrong, []);
});

test("normalization: trademarks, letters with dots, numbers in words, roman numerals", () => {
  assert.deepEqual(names.nameWords("Spiritfarer®: Farewell Edition"), ["spiritfarer", "farewell"]);
  assert.deepEqual(names.nameWords("R.E.P.O."), ["repo"]);
  assert.deepEqual(names.nameWords("Age of Empires II"), ["age", "of", "empires", "2"]);
  assert.deepEqual(names.nameWords("Grand Theft Auto V"), ["grand", "theft", "auto", "5"]);
  assert.deepEqual(names.nameWords("киберпанк две тысячи семьдесят семь"), ["киберпанк", "2077"]);
  assert.deepEqual(names.nameWords("Dota two"), ["dota", "2"]);
});

test("phonetic forms: Russian readings meet English spellings", () => {
  const lat = (word) => names.makeToken(word).forms.map((form) => form.lat);

  assert.ok(lat("эдж").some((form) => lat("edge").includes(form)));
  assert.ok(lat("дискорд").some((form) => lat("discord").includes(form)));
  assert.ok(lat("юнити").some((form) => lat("unity").includes(form)));
  assert.ok(lat("телеграм").includes("telegram"), "the whole word is kept: the stemmer cuts loanwords");
});

test("decide: the only name said in full wins a close race", () => {
  const result = names.decide([
    { key: "control", score: 0.97, coverage: 1 },
    { key: "nvidia control panel", score: 0.93, coverage: 0.58 },
  ]);

  assert.equal(result.status, "match");
  assert.equal(result.best.key, "control");
  assert.equal(names.decide([{ key: "a", score: 0.88, coverage: 0.5 }, { key: "b", score: 0.87, coverage: 0.33 }]).status, "ambiguous");
  assert.equal(names.decide([{ key: "a", score: 0.8, coverage: 1 }]).status, "weak");
  assert.equal(names.decide([{ key: "a", score: 0.7, coverage: 1 }]).status, "none");
});

test("spoken name: the one set in the client, else the name without trademark and subtitle", () => {
  assert.equal(names.spokenName({ name: "The Witcher 3: Wild Hunt", aliases: ["ведьмак"] }), "The Witcher 3");
  assert.equal(names.spokenName({ name: "Spiritfarer®: Farewell Edition", aliases: [] }), "Spiritfarer");
  assert.equal(names.spokenName({ name: "Dota 2", aliases: ["dota"], spoken: "Дота" }), "Дота");
});

test("auto aliases: without vendor and subtitle", () => {
  assert.deepEqual(names.autoAliases("Google Chrome"), ["chrome"]);
  assert.deepEqual(names.autoAliases("The Witcher 3: Wild Hunt"), ["The Witcher 3"]);
  assert.deepEqual(names.autoAliases("Steam"), []);
});
