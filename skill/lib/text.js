/**
 * Phrase helpers shared by the skill and the client: normalization, words,
 * numbers in words and digits (ru, en), delays and clock times.
 * Pure CommonJS, no Node APIs.
 */
"use strict";

/**
 * Lower case, ё → е, punctuation removed. Kept: digits with "." "," ":" inside
 * ("1.5", "23:00"), "%", and commas as separate tokens (they split lists).
 */
const normalizeText = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/(\d),(\d)/g, "$1.$2")
    .replace(/,/g, " , ")
    .replace(/[^\p{L}\p{N}%:.,\s]/gu, " ")
    .replace(/(^|[^\d])[.:]+/g, "$1 ")
    .replace(/[.:]+([^\d]|$)/g, " $1")
    .replace(/\s+/g, " ")
    .trim();

const wordsOf = (text) => normalizeText(text).split(" ").filter(Boolean);

/* ── numbers ── */

const NUMBER_WORDS = {
  // ru units
  ноль: 0, нуль: 0, нуля: 0,
  один: 1, одна: 1, одну: 1, одно: 1, одного: 1, одной: 1,
  два: 2, две: 2, двух: 2,
  три: 3, трех: 3,
  четыре: 4, четырех: 4,
  пять: 5, пяти: 5,
  шесть: 6, шести: 6,
  семь: 7, семи: 7,
  восемь: 8, восьми: 8,
  девять: 9, девяти: 9,
  // ru teens
  десять: 10, десяти: 10,
  одиннадцать: 11, одиннадцати: 11,
  двенадцать: 12, двенадцати: 12,
  тринадцать: 13, тринадцати: 13,
  четырнадцать: 14, четырнадцати: 14,
  пятнадцать: 15, пятнадцати: 15,
  шестнадцать: 16, шестнадцати: 16,
  семнадцать: 17, семнадцати: 17,
  восемнадцать: 18, восемнадцати: 18,
  девятнадцать: 19, девятнадцати: 19,
  // en
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};

const TENS_WORDS = {
  двадцать: 20, двадцати: 20,
  тридцать: 30, тридцати: 30,
  сорок: 40, сорока: 40,
  пятьдесят: 50, пятидесяти: 50,
  шестьдесят: 60, шестидесяти: 60,
  семьдесят: 70, семидесяти: 70,
  восемьдесят: 80, восьмидесяти: 80,
  девяносто: 90, девяноста: 90,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

const HUNDREDS_WORDS = {
  сто: 100, ста: 100, двести: 200, триста: 300, четыреста: 400, пятьсот: 500,
  шестьсот: 600, семьсот: 700, восемьсот: 800, девятьсот: 900,
};

const DIGITS_RE = /^\d+(\.\d+)?%?$/;

/**
 * Number at words[i]: "30", "30%", "1.5", "тридцать пять", "сто", "twenty one",
 * "a hundred". @returns {{ value: number, end: number } | null} end - next index
 */
const numberAt = (words, i) => {
  const word = words[i];

  if (word === undefined) return null;
  if (DIGITS_RE.test(word)) return { value: Number(word.replace("%", "")), end: i + 1 };

  let value = 0;
  let j = i;

  if ((word === "a" || word === "one") && words[i + 1] === "hundred") return { value: 100, end: i + 2 };
  if (HUNDREDS_WORDS[words[j]] !== undefined) value += HUNDREDS_WORDS[words[j++]];
  if (TENS_WORDS[words[j]] !== undefined) value += TENS_WORDS[words[j++]];
  if (NUMBER_WORDS[words[j]] !== undefined && (j === i || NUMBER_WORDS[words[j]] < 10)) value += NUMBER_WORDS[words[j++]];
  if (j === i) return null;
  if (words[j] === "hundred" && value > 0 && value < 10) return { value: value * 100, end: j + 1 };

  return { value, end: j };
};

/** First number anywhere in words, with its position. */
const findNumber = (words, from = 0) => {
  for (let i = from; i < words.length; i++) {
    const found = numberAt(words, i);

    if (found) return { ...found, start: i };
  }

  return null;
};

const ORDINALS = {
  первый: 1, первая: 1, первое: 1, первого: 1, первому: 1, первом: 1, первую: 1,
  второй: 2, вторая: 2, второе: 2, второго: 2, второму: 2, втором: 2, вторую: 2,
  третий: 3, третья: 3, третье: 3, третьего: 3, третьему: 3, третьем: 3, третью: 3,
  четвертый: 4, четвертая: 4, четвертое: 4, четвертого: 4, четвертом: 4, четвертую: 4,
  пятый: 5, пятая: 5, пятое: 5, пятого: 5, пятом: 5, пятую: 5,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
};

/** Ordinal position said in an answer ("второй", "the second", "2"), 1-based, or null. */
const ordinalOf = (text) => {
  for (const word of wordsOf(text)) {
    if (ORDINALS[word]) return ORDINALS[word];
    if (/^[1-9]$/.test(word)) return Number(word);
  }

  return null;
};

/* ── delays and clock time ── */

const UNIT_SECONDS = {
  секунд: 1, секунду: 1, секунды: 1, секунда: 1, сек: 1,
  минут: 60, минуту: 60, минуты: 60, минута: 60, мин: 60,
  час: 3600, часа: 3600, часов: 3600, часик: 3600, часика: 3600,
  second: 1, seconds: 1, sec: 1, secs: 1,
  minute: 60, minutes: 60, min: 60, mins: 60,
  hour: 3600, hours: 3600, hr: 3600, hrs: 3600,
};

/**
 * Delay "через 30 минут", "через полчаса", "через полтора часа", "через час и 10 минут",
 * "in 5 minutes", "in an hour", "in half an hour". With `starts` ["на", "for"] - a duration:
 * "на час", "на 30 минут", "for an hour".
 * @returns {{ sec: number, start: number, end: number } | null}
 */
const findDelay = (words, starts = ["через", "in", "after"]) => {
  for (let i = 0; i < words.length; i++) {
    const word = words[i];

    if (!starts.includes(word)) continue;

    let j = i + 1;
    let sec = 0;

    for (let parts = 0; parts < 3; parts++) {
      if (parts > 0 && (words[j] === "и" || words[j] === "and")) j++;

      const next = words[j];

      if (next === "полчаса" || next === "полчасика") { sec += 1800; j++; continue; }
      if (next === "полтора" && UNIT_SECONDS[words[j + 1]]) { sec += 1.5 * UNIT_SECONDS[words[j + 1]]; j += 2; continue; }
      if (next === "пару" && UNIT_SECONDS[words[j + 1]]) { sec += 2 * UNIT_SECONDS[words[j + 1]]; j += 2; continue; }
      if (next === "half" && (words[j + 1] === "an" || words[j + 1] === "a") && UNIT_SECONDS[words[j + 2]]) {
        sec += UNIT_SECONDS[words[j + 2]] / 2; j += 3; continue;
      }
      if ((next === "a" || next === "an") && UNIT_SECONDS[words[j + 1]]) { sec += UNIT_SECONDS[words[j + 1]]; j += 2; continue; }
      if (UNIT_SECONDS[next] && parts === 0) { sec += UNIT_SECONDS[next]; j++; continue; }

      const number = numberAt(words, j);

      if (number && UNIT_SECONDS[words[number.end]]) {
        sec += number.value * UNIT_SECONDS[words[number.end]];
        j = number.end + 1;
        continue;
      }
      break;
    }

    if (sec > 0) return { sec: Math.round(sec), start: i, end: j };
  }

  return null;
};

const DAY_PARTS = { утра: "am", ночи: "am", дня: "pm", вечера: "pm", am: "am", pm: "pm" };

/**
 * Clock time "в 23:00", "в 11 вечера", "в семь утра", "at 11 pm", "at 23:30".
 * @param {Date} now
 * @returns {{ sec: number, start: number, end: number, hh: number, mm: number } | null} sec - delay until then
 */
const findClock = (words, now = new Date()) => {
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i] !== "в" && words[i] !== "at" && words[i] !== "во") continue;

    let hh;
    let mm = 0;
    let j = i + 1;
    const clock = String(words[j]).match(/^(\d{1,2}):(\d{2})$/);

    if (clock) {
      hh = Number(clock[1]);
      mm = Number(clock[2]);
      j++;
    } else {
      const number = numberAt(words, j);

      if (!number || number.value > 23 || !Number.isInteger(number.value)) continue;
      hh = number.value;
      j = number.end;
      if (["час", "часа", "часов", "o'clock", "oclock"].includes(words[j])) j++;

      const minutes = numberAt(words, j);

      if (minutes && minutes.value < 60 && ["минут", "минуты", "минуту"].includes(words[minutes.end])) {
        mm = minutes.value;
        j = minutes.end + 1;
      }
      // "в 5" alone is too vague (a number of anything): require a part of day or "часов"
      if (!DAY_PARTS[words[j]] && !["час", "часа", "часов", "o'clock", "oclock"].includes(words[j - 1])) continue;
    }

    const part = DAY_PARTS[words[j]];

    if (part) {
      j++;
      if (part === "pm" && hh < 12) hh += 12;
      if (part === "am" && hh === 12) hh = 0;
    }
    if (hh > 23 || mm > 59) continue;

    const target = new Date(now);

    target.setHours(hh, mm, 0, 0);
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);

    return { sec: Math.round((target.getTime() - now.getTime()) / 1000), start: i, end: j, hh, mm };
  }

  return null;
};

/* ── vocabulary ── */

/** Words that mean "a computer" by themselves, in any form. */
const PC_WORDS = new Set([
  "компьютер", "компьютера", "компьютеру", "компьютере", "компьютером", "компьютеры", "компьютеров", "компьютерах",
  "комп", "компа", "компе", "компу", "компом", "компы",
  "пк", "писи", "пэка",
  "ноутбук", "ноутбука", "ноутбуке", "ноутбуку", "ноутбуком", "ноутбуки",
  "ноут", "ноута", "ноуте", "ноуту", "ноутом",
  "системник", "системника", "системнике", "системнику",
  "десктоп", "десктопе", "десктопа",
  "computer", "computers", "pc", "pcs", "laptop", "laptops", "desktop", "notebook",
]);

/** Prepositions before a PC mention: "на игровом", "on the laptop". */
const LOCATIVE_PREPS = new Set(["на", "в", "во", "у", "on", "at"]);

/** Words dropped before parsing: politeness and "can you". */
const FILLERS = new Set([
  "пожалуйста", "плиз", "ка", "ну", "эй", "слушай", "окей", "ок", "можешь", "можно", "сможешь",
  "please", "can", "could", "would", "will", "you", "kindly", "just", "hey", "ok", "okay",
]);

/** Possessives and articles dropped from objects. */
const DETERMINERS = new Set([
  "мой", "моя", "мое", "мою", "моего", "моем", "моей", "моему", "мои",
  "свой", "свою", "свое", "своего", "своем",
  "этот", "эту", "это", "этого", "этом", "эта",
  "наш", "нашу", "наше", "нашего", "нашем",
  "the", "a", "an", "my", "this", "that", "our",
]);

const GAME_WORDS = new Set(["игру", "игра", "игры", "игре", "игрой", "игрушку", "игрушка", "игрушки", "game", "games"]);
const APP_WORDS = new Set([
  "программу", "программа", "программы", "программе", "прогу", "прога", "проги",
  "приложение", "приложения", "приложении", "приложением", "софт",
  "app", "application", "program", "software",
]);
const WINDOW_WORDS = new Set(["окно", "окна", "window"]);
/** "активную программу", "текущее окно", "the active window": the one in front */
const ACTIVE_WORDS = new Set([
  "активную", "активное", "активный", "активная", "активной",
  "текущую", "текущее", "текущий", "текущая", "текущей",
  "active", "current", "focused",
]);

/** Conjunctions that join several objects: "стим и дискорд", "steam and discord". */
const AND_WORDS = new Set(["и", "and", ",", "а", "плюс", "plus"]);

/** Starts of a conditional phrase: base/conditional owns them. */
const CONDITION_STARTS = new Set(["если", "когда", "if", "when", "once", "whenever"]);

const isCondition = (words) =>
  CONDITION_STARTS.has(words[0]) ||
  words.includes("если") ||
  words.includes("if") ||
  (words[0] === "как" && words[1] === "только") ||
  (words[0] === "as" && words[1] === "soon");

/** Index of a multi-word phrase starting exactly at words[i], or -1. */
const phraseAt = (words, i, phrase) => {
  const parts = Array.isArray(phrase) ? phrase : phrase.split(" ");

  for (let k = 0; k < parts.length; k++) if (words[i + k] !== parts[k]) return -1;

  return i + parts.length;
};

/** Longest phrase from the list that starts at words[i]: { phrase, end } or null. */
const longestPhraseAt = (words, i, phrases) => {
  let best = null;

  for (const phrase of phrases) {
    const end = phraseAt(words, i, phrase);

    if (end > 0 && (!best || end > best.end)) best = { phrase, end };
  }

  return best;
};

const POLITE = new Set(["пожалуйста", "плиз", "please"]);

/** Words without fillers at the start and politeness anywhere ("можешь, пожалуйста, запустить стим" → "запустить стим"). */
const stripFillers = (words) => {
  let i = 0;

  while (i < words.length && (FILLERS.has(words[i]) || words[i] === ",")) i++;

  return words.slice(i).filter((word) => !POLITE.has(word));
};

module.exports = {
  normalizeText,
  wordsOf,
  numberAt,
  findNumber,
  ordinalOf,
  findDelay,
  findClock,
  phraseAt,
  longestPhraseAt,
  stripFillers,
  isCondition,
  PC_WORDS,
  LOCATIVE_PREPS,
  FILLERS,
  DETERMINERS,
  GAME_WORDS,
  ACTIVE_WORDS,
  APP_WORDS,
  WINDOW_WORDS,
  AND_WORDS,
  NUMBER_WORDS,
  TENS_WORDS,
  UNIT_SECONDS,
};
