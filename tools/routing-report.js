// routing-report.js - how phrases route between Ghost Hands and the built-in intents of NODUS.
//   node tools/routing-report.js            table
//   node tools/routing-report.js --assert   exit code 1 when a phrase goes wrong
// Built-in intents are scored by their triggers (lib/nodus-builtin.js); their example
// phrases are unknown, so the worst case adds 15 (one example fully in the phrase).
"use strict";

const path = require("path");
const skill = path.join(__dirname, "../skill");
const { NameIndex } = require(path.join(skill, "lib/name-index.js"));
const { classify } = require(path.join(skill, "lib/parse.js"));
const { score, decide } = require(path.join(skill, "lib/nodus-routing.js"));
const BUILTIN = require(path.join(skill, "lib/nodus-builtin.js"));
const pcStatus = require(path.join(skill, "intents/pc_status/index.js"));

const PHRASE_BONUS = 15;
const SCENARIO_PHRASE_SCORE = 13;

/** Two PCs of one person with typical apps. */
const demoIndex = () => {
  const index = new NameIndex();
  const apps = (list) => list.map(([id, name, aliases = [], kind = "app"]) => ({ id, name, aliases, kind }));

  index.upsert({
    deviceId: "d1",
    userId: "u1",
    online: true,
    config: {
      name: "Игровой",
      wol: { mac: "aa:bb:cc:dd:ee:ff", broadcast: "192.168.0.255", adapter: "ethernet" },
      apps: apps([
        ["steam:570", "Dota 2", [], "game"],
        ["steam:730", "Counter-Strike 2", ["кс", "контра"], "game"],
        ["gog:1", "The Witcher 3: Wild Hunt", ["ведьмак"], "game"],
        ["epic:Calluna", "Control", [], "game"],
        ["start:minecraft", "Minecraft Launcher", ["майнкрафт"], "game"],
        ["start:steam", "Steam"],
        ["start:discord", "Discord"],
        ["start:chrome", "Google Chrome", ["хром"]],
        ["start:telegram", "Telegram"],
        ["virtual:browser", "Браузер"],
      ]),
    },
  });
  index.upsert({
    deviceId: "d2",
    userId: "u1",
    online: true,
    config: { name: "Ноутбук", aliases: ["рабочий"], apps: apps([["start:chrome", "Google Chrome", ["хром"]], ["start:word", "Microsoft Word", ["ворд"]]]) },
  });
  index.setState("d1", { running: [{ key: "exe:dota2", name: "Dota 2", appId: "steam:570", game: true, fg: true }] });

  return index;
};

/** [phrase, expected intent of ours or null (NODUS keeps it), note] */
const CASES = [
  ["запусти доту", "launch_app"],
  ["запусти доту на игровом компьютере", "launch_app"],
  ["открой стим", "launch_app"],
  ["включи стим", "launch_app"],
  ["давай поиграем в контру", "launch_app"],
  ["запусти стим и дискорд", "launch_app"],
  ["открой хром на ноутбуке", "launch_app"],
  ["запусти ведьмака", "launch_app"],
  ["запусти игру ведьмак", "launch_app"],
  ["launch steam", "launch_app"],
  ["open chrome on the laptop", "launch_app"],
  ["start discord", "launch_app"],
  ["закрой доту", "close_app"],
  ["выключи игру", "close_app"],
  ["закрой хром на ноутбуке", "close_app"],
  ["выйди из доты", "close_app"],
  ["close discord", "close_app"],
  ["quit the game", "close_app"],
  ["выключи компьютер", "pc_power"],
  ["выключи игровой", "pc_power"],
  ["перезагрузи ноутбук через полчаса", "pc_power"],
  ["выключи компьютер через час", "pc_power"],
  ["отмени выключение компьютера", "pc_power"],
  ["заблокируй компьютер", "pc_power"],
  ["усыпи компьютер", "pc_power"],
  ["переведи компьютер в спящий режим", "pc_power"],
  ["выключи монитор", "pc_power"],
  ["shut down the computer", "pc_power"],
  ["restart the pc", "pc_power"],
  ["lock the computer", "pc_power"],
  ["включи компьютер", "pc_wake"],
  ["разбуди игровой", "pc_wake"],
  ["turn on the computer", "pc_wake"],
  ["сделай громче на компьютере", "pc_volume"],
  ["убавь громкость на компьютере", "pc_volume"],
  ["громкость на компьютере тридцать", "pc_volume"],
  ["выключи звук на компьютере", "pc_volume"],
  ["включи звук на ноутбуке", "pc_volume"],
  ["turn up the volume on the computer", "pc_volume"],
  ["mute the pc", "pc_volume"],
  ["пауза на компьютере", "pc_media"],
  ["следующий трек на компьютере", "pc_media"],
  ["next track on the pc", "pc_media"],
  ["найди в интернете рецепт борща", "pc_search"],
  ["загугли погоду в сочи", "pc_search"],
  ["найди на ютубе обзор айфона", "pc_search"],
  ["search the web for cheap flights", "pc_search"],
  ["какие компьютеры в сети", "pc_status"],
  ["что запущено на компьютере", "pc_status"],
  ["which computers are online", "pc_status"],
  // NODUS keeps these
  ["включи свет", null],
  ["выключи свет на кухне", null],
  ["открой шторы", null],
  ["закрой шторы", null],
  ["сделай громче", null],
  ["выключи звук", null],
  ["пауза", null],
  ["следующий трек", null],
  ["включи музыку", null],
  ["запусти таймер на пять минут", null],
  ["отмени таймер", null],
  ["запусти сценарий уборка", null],
  ["разбуди меня в семь", null],
  ["найди мой телефон", null],
  ["какая погода", null],
  ["если игра запустится выключи свет", null],
  ["расскажи про компьютеры", null],
  ["сколько стоит компьютер", null],
];

const OURS = new Set(["launch_app", "close_app", "pc_power", "pc_wake", "pc_volume", "pc_media", "pc_search", "pc_status"]);

/** Route one phrase like the NODUS router does. */
const evaluate = (phrase, index, { scenarioPhrase = false } = {}) => {
  const results = [];
  const builtin = [];

  for (const intent of BUILTIN) {
    const value = score({ triggers: intent.triggers }, phrase);

    if (value !== null) builtin.push({ id: intent.id, score: value });
    if (value !== null && value >= 3) results.push({ id: intent.id, score: value });
  }

  const status = score(pcStatus, phrase);

  if (status !== null && status >= 3) results.push({ id: "pc_status", score: status, priority: pcStatus.priority });

  const ours = classify(phrase, { index, userId: "u1" });

  if (ours) results.push({ id: ours.intent, score: ours.score });
  if (scenarioPhrase) results.push({ id: "base/__scenario_engine__", score: SCENARIO_PHRASE_SCORE });

  const bestBuiltin = builtin.sort((a, b) => b.score - a.score)[0] ?? { id: "-", score: 0 };
  const decision = decide(results);

  return { phrase, ours, status, bestBuiltin, decision };
};

/** Problems of a case: wrong winner, or too little margin over the worst built-in case. */
const check = ([phrase, expected], index) => {
  const row = evaluate(phrase, index);
  const problems = [];
  const winner = row.decision.action === "run" ? row.decision.id : null;

  if (expected) {
    if (winner !== expected) problems.push(`expected ${expected}, got ${row.decision.action} ${winner ?? row.decision.options?.join("/") ?? ""}`);

    // a wildcard intent must win even if a built-in example phrase fully matches;
    // a regular intent (pc_status) gets such bonuses too, so only the triggers count
    const ours = expected === "pc_status" ? row.status : row.ours?.score;
    const bonus = expected === "pc_status" ? 0 : PHRASE_BONUS;

    if (ours && ours > 8 && row.bestBuiltin.score + bonus >= 0.7 * ours) {
      problems.push(`margin: ${row.bestBuiltin.id} ${row.bestBuiltin.score}+${bonus} vs 0.7×${ours}`);
    }
  } else if (winner && OURS.has(winner)) {
    problems.push(`taken by ${winner}`);
  }

  return { ...row, expected, problems };
};

const run = () => {
  const index = demoIndex();

  return CASES.map((entry) => check(entry, index));
};

if (require.main === module) {
  const rows = run();
  const pad = (text, size) => String(text).padEnd(size);

  for (const row of rows) {
    const ours = row.ours ? `${row.ours.intent} ${row.ours.score}` : row.status >= 3 ? `pc_status ${row.status}` : "-";
    const decision = row.decision.action === "run" ? row.decision.id : row.decision.action;

    console.log(`${row.problems.length ? "✗" : "✓"} ${pad(row.phrase, 40)} ours: ${pad(ours, 16)} built-in: ${pad(`${row.bestBuiltin.id} ${row.bestBuiltin.score}`, 34)} → ${decision}${row.problems.length ? `  ! ${row.problems.join("; ")}` : ""}`);
  }

  const failed = rows.filter((row) => row.problems.length);

  console.log(`\n${rows.length - failed.length}/${rows.length} ok`);
  if (process.argv.includes("--assert") && failed.length) process.exitCode = 1;
}

module.exports = { CASES, demoIndex, evaluate, check, run };
