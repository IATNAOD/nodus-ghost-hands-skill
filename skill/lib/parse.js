/**
 * One classifier for every wildcard intent of the skill. A phrase is parsed
 * once (memoized) and each intent's match() only checks whether the phrase
 * went to it, so the intents never compete with each other and match() stays
 * cheap. Scores are chosen against the built-in intents of NODUS (see
 * tools/routing-report.js): a built-in rival plus 15 for an example phrase
 * stays below 0.7 of ours.
 * Shared by the skill and the client ("check a phrase"): pure CommonJS.
 */
"use strict";

const T = require("./text");
const { stemWord } = require("./nodus-routing");
const BUILTIN = require("./nodus-builtin");

const SCORES = Object.freeze({
  parental: 36,
  volume: 36,
  media: 36,
  power: 34,
  display: 30,
  // explicit verb + PC or marker: as certain as power commands
  wake: 34,
  search: 34,
  appMatch: 30,
  appMatchOnPc: 32,
  closeGeneric: 30,
  appWeak: 24,
  appUnknownOnPc: 26,
  launchGeneric: 24,
  // strong verb + unknown object: a scenario phrase (13-15) wins without a question,
  // and below 10 the phrase is never split into a compound command because of it
  launchUnknown: 8,
});

const split = (list) => list.map((phrase) => phrase.split(" "));

const LAUNCH_STRONG = [
  "запусти", "запустить", "запускай", "запустите", "стартуй", "стартани",
  "давай поиграем в", "давай поиграем", "давай сыграем в", "поиграем в", "сыграем в", "хочу поиграть в", "хочу поиграть", "хочу сыграть в",
  "launch", "start", "run", "let s play", "lets play",
];
const LAUNCH_SOFT = ["открой", "открыть", "откройте", "включи", "включить", "включите", "вруби", "врубай", "врубить", "open", "play", "turn on", "fire up"];
const LAUNCH_VERBS = split([...LAUNCH_STRONG, ...LAUNCH_SOFT]);
const STRONG = new Set(LAUNCH_STRONG);

const CLOSE_VERBS = split([
  "закрой", "закрыть", "закройте", "заверши", "завершить", "выйди из", "выйти из", "выключи", "выключить",
  "выруби", "вырубить", "убей", "убить", "close", "quit", "exit", "kill", "turn off", "shut down",
]);

const POWER = [
  { op: "shutdown", verbs: split(["выключи", "выключить", "отключи", "отключить", "выруби", "вырубить", "заверши работу", "завершить работу", "shut down", "shutdown", "turn off", "switch off", "power off", "power down"]) },
  { op: "restart", verbs: split(["перезагрузи", "перезагрузить", "перезагрузите", "перезапусти", "перезапустить", "ребутни", "рестартни", "restart", "reboot"]) },
  { op: "sleep", verbs: split(["усыпи", "усыпить", "sleep", "suspend"]) },
  { op: "lock", verbs: split(["заблокируй", "заблокировать", "блокируй", "lock"]) },
];
const SLEEP_MOVERS = split(["переведи", "перевести", "отправь", "отправить", "уложи", "put", "send"]);
const SLEEP_MARKERS = split(["в спящий режим", "в режим сна", "в сон", "спать", "to sleep", "in sleep mode", "into sleep mode", "into sleep"]);
const DISPLAY_VERBS = split(["выключи", "выключить", "отключи", "отключить", "погаси", "погасить", "turn off", "switch off"]);
const DISPLAY_WORDS = new Set(["монитор", "монитора", "мониторы", "экран", "экрана", "экраны", "дисплей", "дисплея", "screen", "screens", "monitor", "monitors", "display"]);
const CANCEL = split([
  "отмени выключение", "отмени перезагрузку", "отмени отключение", "отмени сон", "отменить выключение",
  "отмена выключения", "отмена перезагрузки", "не выключай", "не перезагружай",
  "cancel shutdown", "cancel the shutdown", "cancel restart", "cancel the restart", "abort shutdown", "don t shut down", "dont shut down",
]);
const WAKE_VERBS = split(["включи", "включить", "разбуди", "разбудить", "запусти", "запустить", "turn on", "switch on", "power on", "wake up", "wake", "boot"]);

const VOLUME_HINTS = new Set([
  "громкость", "громкости", "громкостью", "звук", "звука", "звуком", "громче", "погромче", "тише", "потише",
  "volume", "louder", "quieter", "sound", "mute", "unmute",
]);
const MUTE = split(["выключи звук", "отключи звук", "выруби звук", "убери звук", "без звука", "заглуши звук", "заглуши", "mute", "turn off the sound", "turn off sound", "turn the sound off"]);
const UNMUTE = split(["включи звук", "верни звук", "unmute", "turn on the sound", "turn on sound", "turn the sound on"]);
const UP = new Set(["громче", "погромче", "прибавь", "прибавить", "увеличь", "увеличить", "добавь", "повысь", "подними", "louder", "increase", "raise"]);
const DOWN = new Set(["тише", "потише", "убавь", "убавить", "уменьши", "уменьшить", "снизь", "понизь", "опусти", "quieter", "decrease", "lower"]);
const UP_PHRASES = split(["turn up", "turn it up", "volume up"]);
const DOWN_PHRASES = split(["turn down", "turn it down", "volume down"]);
const ASK = new Set(["какая", "какой", "сколько", "what", "whats"]);
const MORE = new Set(["намного", "сильно", "гораздо", "much", "lot"]);
const LESS = new Set(["чуть", "немного", "слегка", "чуточку", "капельку", "bit", "little", "slightly"]);
const MAX = new Set(["максимум", "максимальную", "максимальная", "максималку", "max", "maximum", "full", "полную"]);
const MIN = new Set(["минимум", "минимальную", "минимальная", "min", "minimum"]);
const HALF = new Set(["половину", "половина", "половины", "half"]);
const PERCENT = new Set(["%", "процент", "процента", "процентов", "percent"]);

// op - what the client does through Windows media sessions; key - the media key for older clients
const MEDIA = [
  { op: "pause", key: "play_pause", words: new Set(["пауза", "паузу", "паузе", "останови", "приостанови", "pause"]) },
  { op: "play", key: "play_pause", words: new Set(["продолжи", "продолжай", "возобнови", "resume", "unpause"]) },
  { op: "next", key: "next", words: new Set(["следующий", "следующую", "следующее", "следующая", "дальше", "next", "skip"]) },
  { op: "prev", key: "prev", words: new Set(["предыдущий", "предыдущую", "предыдущее", "предыдущая", "previous", "prev"]) },
];
const RESUME_PHRASES = split(["сними с паузы", "снять с паузы", "сними паузу", "убери паузу", "continue playing"]);
// "включи музыку на компьютере", "play on the pc", "stop the music on the pc": the verb and
// media words only - "play minecraft on the pc" is a launch
const PLAY_VERBS = new Map([["включи", "play"], ["поставь", "play"], ["play", "play"], ["continue", "play"], ["stop", "pause"]]);
const MEDIA_OBJECTS = new Set(["музыку", "музыка", "видео", "трек", "песню", "воспроизведение", "фильм", "ролик", "music", "video", "track", "song", "playback", "it", "the"]);

const SEARCH_VERBS = split(["найди", "найти", "поищи", "поискать", "ищи", "загугли", "погугли", "гугли", "search for", "search", "google", "look up", "look for", "find"]);
const GOOGLE_VERBS = new Set(["загугли", "погугли", "гугли", "google"]);
const PLAY_ON_VERBS = split(["включи", "поставь", "открой", "play", "open", "put on"]);
const SEARCH_MARKERS = [
  ...["в интернете", "в инете", "в интернет", "в сети", "в поисковике", "в браузере", "on the internet", "on the web", "the internet", "the web", "online", "in the browser"].map((text) => ({ words: text.split(" "), engine: null })),
  ...["в гугле", "в гугл", "в google", "через гугл", "on google"].map((text) => ({ words: text.split(" "), engine: "google" })),
  ...["в яндексе", "в яндекс", "через яндекс"].map((text) => ({ words: text.split(" "), engine: "yandex" })),
  ...["на ютубе", "в ютубе", "на ютуб", "на youtube", "в youtube", "on youtube"].map((text) => ({ words: text.split(" "), engine: "youtube" })),
];
const QUERY_NOISE = new Set(["мне", "нам", "про", "for", "me", "us", "about"]);

const ALL_WORDS = new Set(["все", "всех", "всем", "оба", "обоих", "обе", "all", "both", "every"]);

// object words that belong to NODUS itself and the smart home: they are an app
// only when the PC is named ("включи музыку на компьютере")
const RESERVED = new Set(
  [
    ...BUILTIN.flatMap((intent) => intent.triggers),
    "свет", "света", "лампу", "лампа", "люстру", "люстра", "телевизор", "телек", "тв", "шторы", "штору", "жалюзи",
    "кондиционер", "кондей", "чайник", "пылесос", "розетку", "розетка", "отопление", "вентилятор", "обогреватель",
    "увлажнитель", "дверь", "замок", "ворота", "музыку", "музыка", "радио", "будильник", "таймер", "секундомер",
    "сценарий", "сцену", "режим", "гостевой", "звук", "громкость", "погоду", "новости", "сводку", "список",
  ].map(stemWord),
);

/* ── helpers ── */

const phraseAtStart = (words, phrases) => T.longestPhraseAt(words, 0, phrases);

const findPhrase = (words, phrases) => {
  for (let i = 0; i < words.length; i++) {
    const found = T.longestPhraseAt(words, i, phrases);

    if (found) return { start: i, end: found.end, phrase: found.phrase };
  }

  return null;
};

const removeRange = (words, start, end) => [...words.slice(0, start), ...words.slice(end)];

/**
 * PC mentions: "на игровом", "на компьютере", "ноутбука", "все компьютеры".
 * @returns {{ from: number, to: number, ids: string[], generic: boolean, all: boolean, prep: boolean }[]}
 */
const pcMentions = (words, index, pool) => {
  const out = [];

  for (let i = 0; i < words.length; i++) {
    let j = i;
    const prep = T.LOCATIVE_PREPS.has(words[j]);

    if (prep) j++;
    while (j < words.length && T.DETERMINERS.has(words[j])) j++;

    const all = ALL_WORDS.has(words[j]);

    if (all) j++;

    const named = index && pool.length ? index.deviceNameAt(words, j, pool) : null;
    let end = named ? named.end : j;
    let generic = false;

    while (end < words.length && T.PC_WORDS.has(words[end])) {
      generic = true;
      end++;
    }
    if (!named && !generic) continue;

    out.push({ from: i, to: end, ids: named ? named.ids : [], generic: !named, all, prep });
    i = end - 1;
  }

  return out;
};

/** What goes to params and logs about a PC mention. */
const pcSummary = (mention, words) =>
  mention ? { ids: mention.ids, generic: mention.generic, all: mention.all, words: words.slice(mention.from, mention.to).join(" ") } : null;

/** A specific mention is better than "компьютер", one with a preposition better than one without. */
const bestMention = (mentions) =>
  [...mentions].sort((a, b) => Number(b.ids.length > 0) - Number(a.ids.length > 0) || Number(b.prep) - Number(a.prep))[0] ?? null;

/** Words split into objects by "и", "and", ",": "стим и дискорд" → ["стим", "дискорд"]. */
const splitObjects = (words) => {
  const objects = [];
  let current = [];

  for (const word of words) {
    if (T.AND_WORDS.has(word)) {
      if (current.length) objects.push(current);
      current = [];
    } else current.push(word);
  }
  if (current.length) objects.push(current);

  return objects;
};

/** Object of NODUS itself: all its words are reserved, or it starts with one ("сценарий уборка"). */
const isReserved = (words) =>
  words.length > 0 && (RESERVED.has(stemWord(words[0])) || words.every((word) => RESERVED.has(stemWord(word)) || T.DETERMINERS.has(word)));
const onlyPcWords = (words) => words.length > 0 && words.every((word) => T.PC_WORDS.has(word) || ALL_WORDS.has(word));

/**
 * Object of a launch/close command: locative PC mentions removed, determiners dropped.
 * @returns {{ rest: string[], pc: object|null }}
 */
const objectWords = (words, index, pool) => {
  const mentions = pcMentions(words, index, pool).filter((mention) => mention.prep);
  let rest = words;

  for (const mention of [...mentions].sort((a, b) => b.from - a.from)) rest = removeRange(rest, mention.from, mention.to);

  return { rest: rest.filter((word) => !T.DETERMINERS.has(word)), pc: bestMention(mentions), mentions };
};

/** Devices to look at: the named PC or the whole pool. */
const devicesFor = (pc, pool) => (pc && pc.ids.length ? pool.filter((device) => pc.ids.includes(device.deviceId)) : pool);

/* ── rules ── */

function volumeRule({ words, index, pool }) {
  if (!words.some((word) => VOLUME_HINTS.has(word))) return null;

  const mentions = pcMentions(words, index, pool);

  if (!mentions.length) return null;

  const pc = bestMention(mentions);
  let rest = words;

  for (const mention of [...mentions].sort((a, b) => b.from - a.from)) rest = removeRange(rest, mention.from, mention.to);

  const params = { op: null, value: null, factor: 1, pc: pcSummary(pc, words) };

  if (findPhrase(rest, MUTE)) params.op = "mute";
  else if (findPhrase(rest, UNMUTE)) params.op = "unmute";
  else {
    const up = rest.some((word) => UP.has(word)) || Boolean(findPhrase(rest, UP_PHRASES));
    const down = rest.some((word) => DOWN.has(word)) || Boolean(findPhrase(rest, DOWN_PHRASES));
    const toIndex = rest.findIndex((word) => word === "до" || word === "to");
    const number = T.findNumber(rest);
    const absolute = rest.some((word) => MAX.has(word)) ? 100 : rest.some((word) => MIN.has(word)) ? 0 : rest.some((word) => HALF.has(word)) ? 50 : null;

    if (rest.some((word) => MORE.has(word))) params.factor = 2;
    if (rest.some((word) => LESS.has(word))) params.factor = 0.5;

    if (absolute !== null) {
      params.op = "set";
      params.value = absolute;
    } else if ((up || down) && number && !(toIndex >= 0 && toIndex < number.start)) {
      params.op = up ? "up" : "down";
      params.value = Math.min(100, Math.round(number.value));
    } else if (number && number.value <= 100) {
      params.op = "set";
      params.value = Math.round(number.value);
    } else if (up || down) {
      params.op = up ? "up" : "down";
    } else if (rest.some((word) => ASK.has(word)) || rest.some((word) => word === "громкость" || word === "volume")) {
      params.op = "get";
    }
  }

  return params.op ? { intent: "pc_volume", score: SCORES.volume, params } : null;
}

function mediaRule({ words, index, pool }) {
  const mentions = pcMentions(words, index, pool);

  if (!mentions.length) return null;

  let rest = words;

  for (const mention of [...mentions].sort((a, b) => b.from - a.from)) rest = removeRange(rest, mention.from, mention.to);

  const verbOnly = PLAY_VERBS.has(rest[0]) && rest.slice(1).every((word) => MEDIA_OBJECTS.has(word) || T.LOCATIVE_PREPS.has(word));
  // "включи на компьютере" with no media word is a launch or a wake
  const op = findPhrase(words, RESUME_PHRASES)
    ? "play"
    : MEDIA.find((entry) => words.some((word) => entry.words.has(word)))?.op ?? (verbOnly && (rest.length > 1 || /^[a-z]/.test(rest[0])) ? PLAY_VERBS.get(rest[0]) : null);

  if (!op) return null;

  const key = op === "next" || op === "prev" ? op : "play_pause";

  return { intent: "pc_media", score: SCORES.media, params: { op, key, pc: pcSummary(bestMention(mentions), words) } };
}

function searchRule({ words, index, pool }) {
  let verb = phraseAtStart(words, SEARCH_VERBS);
  let playOn = false;

  if (!verb) {
    verb = phraseAtStart(words, PLAY_ON_VERBS);
    playOn = Boolean(verb);
  }
  if (!verb) return null;

  let rest = words.slice(verb.end);
  let engine = GOOGLE_VERBS.has(verb.phrase.join(" ")) ? "google" : null;
  let marked = false;

  for (;;) {
    const found = findPhraseOf(rest, SEARCH_MARKERS);

    if (!found) break;
    marked = true;
    engine = found.marker.engine ?? engine;
    rest = removeRange(rest, found.start, found.end);
  }

  const mentions = pcMentions(rest, index, pool).filter((mention) => mention.prep);

  for (const mention of [...mentions].sort((a, b) => b.from - a.from)) rest = removeRange(rest, mention.from, mention.to);

  if (playOn && engine !== "youtube") return null;
  if (!marked && !engine && !mentions.length) return null;

  while (rest.length && QUERY_NOISE.has(rest[0])) rest = rest.slice(1);
  rest = rest.filter((word) => word !== ",");
  if (!rest.length) return null;

  const pc = bestMention(mentions);

  // with no PC online the AI of NODUS answers the question better than "the PC is offline"
  if (!devicesFor(pc, pool).some((device) => device.online)) return null;

  return { intent: "pc_search", score: SCORES.search, params: { op: "search", query: rest.join(" "), engine: engine ?? "default", pc: pcSummary(pc, rest) } };
}

function findPhraseOf(words, markers) {
  for (let i = 0; i < words.length; i++) {
    for (const marker of markers) {
      const end = T.phraseAt(words, i, marker.words);

      if (end > 0) return { start: i, end, marker };
    }
  }

  return null;
}

/** Remaining words are exactly one PC mention: "выключи (игровой) компьютер". */
const pcObject = (rest, index, pool) => {
  const words = rest.filter((word) => !T.DETERMINERS.has(word));
  const mentions = pcMentions(words, index, pool);

  if (mentions.length !== 1 || mentions[0].from !== 0 || mentions[0].to !== words.length) return null;

  return { mention: mentions[0], words };
};

function powerRule({ words, index, pool, now }) {
  const cancel = phraseAtStart(words, CANCEL);

  if (cancel) {
    const mentions = pcMentions(words.slice(cancel.end), index, pool);

    return { intent: "pc_power", score: SCORES.power, params: { op: "cancel", delaySec: 0, pc: pcSummary(bestMention(mentions), words.slice(cancel.end)) } };
  }

  const display = phraseAtStart(words, DISPLAY_VERBS);

  if (display) {
    const rest = words.slice(display.end).filter((word) => !T.DETERMINERS.has(word));

    if (rest.length && DISPLAY_WORDS.has(rest[0])) {
      const mentions = pcMentions(rest.slice(1), index, pool);
      const pc = bestMention(mentions);

      if (rest.length === 1 || (pc && mentions[0].to === rest.length - 1)) {
        return { intent: "pc_power", score: pc ? SCORES.power : SCORES.display, params: { op: "display_off", delaySec: 0, pc: pcSummary(pc, rest.slice(1)) } };
      }
    }
  }

  const timing = (rest) => {
    const delay = T.findDelay(rest);
    const clock = delay ? null : T.findClock(rest, now);
    const found = delay ?? clock;

    return found ? { rest: removeRange(rest, found.start, found.end), delaySec: found.sec, at: clock ? `${String(clock.hh).padStart(2, "0")}:${String(clock.mm).padStart(2, "0")}` : null } : { rest, delaySec: 0, at: null };
  };

  const mover = phraseAtStart(words, SLEEP_MOVERS);

  if (mover) {
    const marker = findPhrase(words.slice(mover.end), SLEEP_MARKERS);

    if (marker) {
      const { rest, delaySec, at } = timing(removeRange(words.slice(mover.end), marker.start, marker.end));
      const object = pcObject(rest, index, pool);

      if (object) return { intent: "pc_power", score: SCORES.power, params: { op: "sleep", delaySec, at, pc: pcSummary(object.mention, object.words) } };
    }
  }

  for (const { op, verbs } of POWER) {
    const verb = phraseAtStart(words, verbs);

    if (!verb) continue;

    const { rest, delaySec, at } = timing(words.slice(verb.end));
    const object = pcObject(rest, index, pool);

    if (object) return { intent: "pc_power", score: SCORES.power, params: { op, delaySec, at, pc: pcSummary(object.mention, object.words) } };
  }

  return null;
}

function wakeRule({ words, index, pool }) {
  const verb = phraseAtStart(words, WAKE_VERBS);

  if (!verb) return null;

  const object = pcObject(words.slice(verb.end), index, pool);

  if (!object) return null;

  const targets = devicesFor(object.mention, pool);

  // without Wake-on-LAN "включи компьютер" is left to the smart home (a smart plug)
  if (!targets.some((device) => device.online || device.wol)) return null;

  return { intent: "pc_wake", score: SCORES.wake, params: { op: "wake", pc: pcSummary(object.mention, object.words) } };
}

/**
 * Generic object: "игру" → game, "программу" → app, "окно" → window;
 * "активную программу", "текущее окно", "active window" → active (the window in front),
 * "активную игру" → game (the game in front goes first anyway).
 */
const genericOf = (object) => {
  if (object.length === 2 && T.ACTIVE_WORDS.has(object[0])) {
    if (T.GAME_WORDS.has(object[1])) return "game";
    if (T.APP_WORDS.has(object[1]) || T.WINDOW_WORDS.has(object[1])) return "active";

    return null;
  }
  if (object.length !== 1) return null;
  if (T.GAME_WORDS.has(object[0])) return "game";
  if (T.APP_WORDS.has(object[0])) return "app";
  if (T.WINDOW_WORDS.has(object[0])) return "window";

  return null;
};

function closeRule({ words, index, pool }) {
  const verb = phraseAtStart(words, CLOSE_VERBS);

  if (!verb || !pool.length) return null;

  const { rest, pc } = objectWords(words.slice(verb.end), index, pool);
  const objects = splitObjects(rest);

  if (!objects.length || objects.some(onlyPcWords)) return null;

  const params = { op: "close", objects: objects.map((object) => object.join(" ")), generic: null, pc: pcSummary(pc, words.slice(verb.end)) };
  const generic = objects.length === 1 ? genericOf(objects[0]) : null;

  if (generic) {
    // a bare "окно" is the smart home's (a window, blinds) unless a PC is named
    if (generic === "window" && !pc) return null;
    // "программу", "окно на компьютере", "активное приложение": the window in front
    params.generic = generic === "game" ? "game" : "active";
    params.objects = [];

    return { intent: "close_app", score: SCORES.closeGeneric, params };
  }
  if (objects.some(isReserved) && !pc) return null;

  const devices = devicesFor(pc, pool);
  const statuses = objects.map((object) => index.matchApps(object.join(" "), devices, { running: true }).status);

  if (statuses.every((status) => status === "match")) return { intent: "close_app", score: pc ? SCORES.appMatchOnPc : SCORES.appMatch, params };
  if (statuses.every((status) => status !== "none")) return { intent: "close_app", score: SCORES.appWeak, params };
  if (pc) return { intent: "close_app", score: SCORES.appUnknownOnPc, params };

  return null;
}

function launchRule({ words, index, pool }) {
  const verb = phraseAtStart(words, LAUNCH_VERBS);

  if (!verb || !pool.length) return null;

  const strong = STRONG.has(verb.phrase.join(" "));
  const { rest, pc } = objectWords(words.slice(verb.end), index, pool);
  const objects = splitObjects(rest);

  if (!objects.length || objects.some(onlyPcWords)) return null;

  const params = { op: "launch", objects: objects.map((object) => object.join(" ")), generic: null, marked: false, pc: pcSummary(pc, words.slice(verb.end)), strong };
  const generic = objects.length === 1 ? genericOf(objects[0]) : null;

  if (generic === "game" || generic === "app") {
    if (!strong && !pc) return null;
    params.generic = generic;
    params.objects = [];

    return { intent: "launch_app", score: SCORES.launchGeneric, params };
  }

  // "запусти игру ведьмак": the marker says this is an app, the rest is its name
  const named = objects.map((object) => {
    if (object.length > 1 && (T.GAME_WORDS.has(object[0]) || T.APP_WORDS.has(object[0]))) {
      params.marked = true;
      return object.slice(1);
    }

    return object;
  });

  params.objects = named.map((object) => object.join(" "));

  const reserved = named.some(isReserved);

  if (reserved && !pc) return null;

  const devices = devicesFor(pc, pool);
  const statuses = named.map((object) => index.matchApps(object.join(" "), devices).status);

  if (statuses.every((status) => status === "match")) return { intent: "launch_app", score: pc ? SCORES.appMatchOnPc : SCORES.appMatch, params };
  if (statuses.every((status) => status !== "none")) return strong || pc || params.marked ? { intent: "launch_app", score: SCORES.appWeak, params } : null;
  if (pc || params.marked) return { intent: "launch_app", score: SCORES.appWeak, params };
  if (strong && named.length === 1 && named[0].length <= 5) return { intent: "launch_app", score: SCORES.launchUnknown, params };

  return null;
}

/* ── parental control: «сними ограничения на детском компьютере на час» ── */

const LIMIT_WORDS = new Set([
  "ограничения", "ограничение", "ограничений", "лимит", "лимиты", "лимитов", "лимита",
  "limits", "limit", "restrictions", "restriction",
]);
const PARENTAL_PHRASES = split(["родительский контроль", "родительского контроля", "parental control", "parental controls"]);
const PLAY_MORE = split(["разреши еще поиграть", "разреши поиграть", "дай еще поиграть", "дай поиграть", "let him play", "let her play"]);
const PARENTAL_OPS = [
  { op: "reset", verbs: split(["сбрось", "сбросить", "обнули", "обнулить", "reset"]) },
  { op: "grant", verbs: split(["сними", "снять", "убери", "убрать", "отключи", "отключить", "выключи", "выключить", "отмени", "lift", "remove", "turn off", "disable", "switch off"]) },
  { op: "revoke", verbs: split(["верни", "вернуть", "включи", "включить", "восстанови", "восстановить", "turn on", "enable", "switch on", "bring back", "restore"]) },
];
const WHOLE_DAY = split(["до конца дня", "на весь день", "на сегодня", "на день", "for today", "for the day", "for the rest of the day"]);

/** "на час", "на 30 минут", "до конца дня" → minutes or "day"; null - the owner's default. */
const durationOf = (words) => {
  if (findPhrase(words, WHOLE_DAY)) return "day";

  const span = T.findDelay(words, ["на", "for"]);

  return span ? Math.max(1, Math.round(span.sec / 60)) : null;
};

// first among the rules: «отключи родительский контроль на компьютере» is not a shutdown.
// Every PC under control in the house counts, not only the speaker's: a child asking gets
// "only the owner can" from the handler, which checks the owner by voice.
function parentalRule({ words, index }) {
  const pool = index ? index.all().filter((device) => device.parental) : [];

  if (!pool.length) return null;

  const playMore = phraseAtStart(words, PLAY_MORE);
  const about = playMore || words.some((word) => LIMIT_WORDS.has(word)) || findPhrase(words, PARENTAL_PHRASES);
  const op = playMore ? "grant" : about ? PARENTAL_OPS.find((entry) => phraseAtStart(words, entry.verbs))?.op : null;

  if (!op) return null;

  const pc = bestMention(pcMentions(words, index, pool));

  return { intent: "pc_parental", score: SCORES.parental, params: { op, minutes: op === "grant" ? durationOf(words) : null, pc: pcSummary(pc, words) } };
}

const RULES = [parentalRule, volumeRule, mediaRule, searchRule, powerRule, wakeRule, closeRule, launchRule];

/**
 * Which of our intents a phrase belongs to.
 * @param {string} text phrase as recognized
 * @param {{ index: import("./name-index").NameIndex|null, userId?: string|null, now?: Date }} options
 * @returns {{ intent: string, score: number, params: object } | null}
 */
const classifyNow = (text, { index, userId = null, now = new Date() }) => {
  const raw = T.wordsOf(text);

  if (!raw.length || T.isCondition(raw)) return null;

  const words = T.stripFillers(raw);

  if (!words.length) return null;

  const pool = index ? index.pool(userId) : [];
  const context = { words, index, pool, now };

  for (const rule of RULES) {
    const result = rule(context);

    if (result) return result;
  }

  return null;
};

// match() of every wildcard intent asks about the same phrase: parse it once
const memo = [];
const MEMO_SIZE = 8;

const classify = (text, options = {}) => {
  const key = `${text}\u0001${options.userId ?? ""}\u0001${options.index?.version ?? -1}`;
  const known = memo.find((entry) => entry.key === key);

  if (known) return known.result;

  const result = classifyNow(text, options);

  memo.unshift({ key, result });
  memo.length = Math.min(memo.length, MEMO_SIZE);

  return result;
};

module.exports = { classify, classifyNow, pcMentions, splitObjects, isReserved, SCORES, RESERVED };
