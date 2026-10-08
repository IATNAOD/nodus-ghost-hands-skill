const test = require("node:test");
const assert = require("node:assert/strict");

const T = require("../lib/text.js");
const { normalizeKey, sanitizeConfig, sanitizeState } = require("../lib/protocol.js");
const { generateKey, hashKey, maskKey } = require("../lib/keys.js");

test("words: punctuation, ё, decimal comma, time and percent survive", () => {
  assert.deepEqual(T.wordsOf("Запусти доту на игровом компьютере."), ["запусти", "доту", "на", "игровом", "компьютере"]);
  assert.deepEqual(T.wordsOf("Выключи компьютер через 1,5 часа!"), ["выключи", "компьютер", "через", "1.5", "часа"]);
  assert.deepEqual(T.wordsOf("громкость 30% в 23:00"), ["громкость", "30%", "в", "23:00"]);
  assert.deepEqual(T.wordsOf("стим, дискорд и телеграм"), ["стим", ",", "дискорд", "и", "телеграм"]);
  assert.deepEqual(T.wordsOf("Ещё"), ["еще"]);
});

test("numbers in words and digits", () => {
  const at = (text) => T.numberAt(T.wordsOf(text), 0)?.value;

  assert.equal(at("тридцать пять"), 35);
  assert.equal(at("сто"), 100);
  assert.equal(at("двадцать"), 20);
  assert.equal(at("40%"), 40);
  assert.equal(at("twenty one"), 21);
  assert.equal(at("a hundred"), 100);
  assert.equal(at("компьютер"), undefined);
});

test("delays", () => {
  const sec = (text) => T.findDelay(T.wordsOf(text))?.sec;

  assert.equal(sec("выключи компьютер через полчаса"), 1800);
  assert.equal(sec("через полтора часа"), 5400);
  assert.equal(sec("через час и 10 минут"), 4200);
  assert.equal(sec("через пару минут"), 120);
  assert.equal(sec("через минуту"), 60);
  assert.equal(sec("через двадцать пять минут"), 1500);
  assert.equal(sec("in half an hour"), 1800);
  assert.equal(sec("in 5 minutes"), 300);
  assert.equal(sec("in an hour"), 3600);
  assert.equal(sec("выключи компьютер"), undefined);
});

test("clock times count from now", () => {
  const now = new Date(2026, 9, 8, 21, 0, 0);
  const clock = (text) => T.findClock(T.wordsOf(text), now);

  assert.equal(clock("выключи компьютер в 23:00").sec, 7200);
  assert.equal(clock("в 11 вечера").sec, 7200);
  assert.equal(clock("в семь утра").sec, 10 * 3600);
  assert.equal(clock("at 11 pm").sec, 7200);
  assert.equal(clock("в 5"), null, "a bare number is not a time");
});

test("ordinals in answers", () => {
  assert.equal(T.ordinalOf("Второй."), 2);
  assert.equal(T.ordinalOf("the first one"), 1);
  assert.equal(T.ordinalOf("3"), 3);
  assert.equal(T.ordinalOf("игровой"), null);
});

test("keys: format, canonical form, hash, mask", () => {
  const key = generateKey();

  assert.match(key, /^GH(-[0-9A-HJKMNP-TV-Z]{4}){6}$/);
  assert.equal(normalizeKey(key.toLowerCase().replace(/-/g, " ")), key);
  assert.equal(normalizeKey(key.replace(/1/g, "l")), key, "l is read as 1");
  assert.equal(normalizeKey("GH-1234"), null);
  assert.equal(hashKey(key), hashKey(key.toLowerCase()));
  assert.equal(hashKey("nonsense"), "");
  assert.match(maskKey(key), /^GH-[0-9A-Z]{4}-••••-••••-••••-••••-[0-9A-Z]{4}$/);
  assert.notEqual(generateKey(), key);
});

test("config from a client is sanitized", () => {
  const { ok, config } = sanitizeConfig({
    name: "  Игровой\n",
    shared: "yes",
    apps: [
      { id: "steam:570", name: "Dota 2", aliases: ["дота", "дота", 42], kind: "game" },
      { id: "steam:570", name: "duplicate" },
      { id: "../etc", name: "bad id" },
      { id: "custom:1", name: "" },
    ],
    features: { power: false, unknown: true },
    prefs: { volumeStep: 500, searchEngine: "evil", forceCloseSec: "7" },
    wol: { mac: "AA-BB-CC-DD-EE-FF", broadcast: "192.168.0.255", adapter: "ethernet" },
  });

  assert.equal(ok, true);
  assert.equal(config.name, "Игровой");
  assert.equal(config.shared, false);
  assert.deepEqual(config.apps.map((app) => app.id), ["steam:570"]);
  assert.deepEqual(config.apps[0].aliases, ["дота"]);
  assert.equal(config.features.power, false);
  assert.equal(config.features.launch, true);
  assert.equal("unknown" in config.features, false);
  assert.equal(config.prefs.volumeStep, 50);
  assert.equal(config.prefs.searchEngine, "google");
  assert.equal(config.prefs.forceCloseSec, 7);
  assert.equal(config.wol.mac, "aa:bb:cc:dd:ee:ff");
  assert.equal(sanitizeConfig({ name: " " }).ok, false);
  assert.equal(sanitizeConfig(null).ok, false);
});

test("state from a client is sanitized", () => {
  const state = sanitizeState({ running: [{ key: "exe:a", name: "A", appId: "steam:1", game: 1 }, { key: "", name: "B" }], volume: "40", muted: "no" });

  assert.deepEqual(state.running, [{ key: "exe:a", name: "A", appId: "steam:1", game: false, fg: false }]);
  assert.equal(state.volume, 40);
  assert.equal(state.muted, null);
});
