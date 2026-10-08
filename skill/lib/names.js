/**
 * Matching of spoken names ("доту", "ведьмака", "хром") with app names and
 * aliases ("Dota 2", "The Witcher 3: Wild Hunt", "Google Chrome").
 * Shared by the skill and the client: pure CommonJS, no Node APIs.
 *
 * Every name and alias becomes tokens with four forms: the stem (NODUS
 * stemmer), a phonetic Latin form (Cyrillic transliterated), a consonant
 * skeleton and the number value. Spoken tokens are compared form by form,
 * so "майнкрафт" meets "Minecraft" by skeleton and "доту" meets "Dota 2"
 * by the stem prefix.
 */
"use strict";

const { stemWord } = require("./nodus-routing");
const { normalizeText, NUMBER_WORDS, TENS_WORDS } = require("./text");

/* ── thresholds ── */

const ACCEPT = 0.86;
const WEAK = 0.75;
const GAP = 0.06;

/* ── normalization ── */

const TRANSLIT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh",
  щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};
// "юнити" is "unity", "яндекс" is "yandex": a second reading for vowels after which English drops "y"
const TRANSLIT_ALT = { ...TRANSLIT, ю: "u", я: "a", й: "" };

const CYRILLIC_RE = /[а-я]/;
const LETTERS_RE = /^\p{L}+$/u;

const ROMAN = {
  ii: 2, iii: 3, iv: 4, vi: 6, vii: 7, viii: 8, ix: 9, xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15,
  xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20,
};
// single-letter numerals only as the last token: "Grand Theft Auto V", "Final Fantasy X"
const ROMAN_LAST = { v: 5, x: 10 };

const STOP_WORDS = new Set([
  "the", "a", "an", "edition", "remastered", "remaster", "definitive", "goty", "launcher", "desktop",
  "app", "beta", "playtest", "demo", "client", "x64", "x86", "64bit", "s",
]);
// multi-word noise removed before tokens are made
const STOP_PHRASES = [/game of the year/g, /\b(directors|director s) cut\b/g, /\bfor windows\b/g];

const VENDORS = [
  "google", "microsoft", "adobe", "mozilla", "apple", "autodesk", "jetbrains", "nvidia", "amd", "intel",
  "tom clancy s", "sid meier s", "valve", "ubisoft", "ea", "blizzard", "epic games",
];

const translit = (word, table = TRANSLIT) => [...word].map((char) => table[char] ?? char).join("");

/**
 * Phonetic Latin form: spellings that sound alike become equal
 * ("discord" ~ "diskord", "whatsapp" ~ "vatsap", "edge" ~ "эдж").
 */
const phonetic = (latin) =>
  latin
    .replace(/shch|sch/g, "ш")
    .replace(/dzh|dge|dj/g, "ж")
    .replace(/tch/g, "ч")
    .replace(/chr/g, "kr")
    .replace(/sh/g, "ш")
    .replace(/zh|j/g, "ж")
    .replace(/ch/g, "ч")
    .replace(/kh/g, "h")
    .replace(/ts|tz/g, "ц")
    .replace(/^kn/, "n")
    .replace(/ght/g, "t")
    .replace(/gh/g, "g")
    .replace(/ph/g, "f")
    .replace(/th/g, "t")
    .replace(/wh/g, "v")
    .replace(/ow$/, "ou")
    .replace(/ck/g, "k")
    .replace(/qu/g, "kv")
    .replace(/q/g, "k")
    .replace(/x/g, "ks")
    .replace(/w/g, "v")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/y/g, "i");

/**
 * Latin spellings with more than one Russian reading: "death" → "дэс",
 * "cyber" → "кибер", "age" → "эйдж".
 */
const latinReadings = (word) => {
  const out = new Set([word]);

  if (word.includes("th")) out.add(word.replace(/th/g, "s"));
  if (word.includes("chr")) out.add(word.replace(/chr/g, "hr"));
  if (/c[eiy]/.test(word)) out.add(word.replace(/c/g, "k"));
  if (/g[eiy]/.test(word)) out.add(word.replace(/g(?=[eiy])/g, "j"));

  return [...out];
};

/** Consonant skeleton: the first letter, then consonants without repeats; z is s ("Charles" ~ "чарльз"). */
const skeleton = (form) => {
  if (!form) return "";

  let out = form[0];

  for (const raw of form.slice(1)) {
    const char = raw === "z" ? "s" : raw;

    if (!"aeiou".includes(char) && char !== out[out.length - 1]) out += char;
  }

  return out;
};

/** Numbers said in words → value: "двадцать семь", "две тысячи семьдесят семь", "two". */
const wordNumberAt = (words, i) => {
  let value = 0;
  let j = i;
  let thousands = 0;
  const unit = (word) => NUMBER_WORDS[word];

  if (unit(words[j]) !== undefined && /^(тысяч|тысяча|тысячи|thousand)$/.test(words[j + 1] ?? "")) {
    thousands = unit(words[j]) * 1000;
    j += 2;
  } else if (/^(тысяча|thousand)$/.test(words[j] ?? "")) {
    thousands = 1000;
    j += 1;
  }

  const start = j;

  if (TENS_WORDS[words[j]] !== undefined) value += TENS_WORDS[words[j++]];
  if (unit(words[j]) !== undefined && (j === start || unit(words[j]) < 10)) value += unit(words[j++]);
  if (j === i) return null;

  return { value: thousands + value, end: j };
};

/** Name or phrase → normalized words with numbers as digit strings. */
const nameWords = (text) => {
  let normalized = normalizeText(String(text ?? "").replace(/[®™©℠]/g, " ").replace(/&/g, " and "));

  for (const pattern of STOP_PHRASES) normalized = normalized.replace(pattern, " ");

  const raw = normalized.split(" ").filter((word) => word && word !== ",");
  const words = [];

  for (let i = 0; i < raw.length; i++) {
    // letters said or written one by one: "r e p o" (from "R.E.P.O.") → "repo"
    if (raw[i].length === 1 && LETTERS_RE.test(raw[i]) && raw[i + 1]?.length === 1 && LETTERS_RE.test(raw[i + 1])) {
      let joined = "";

      while (i < raw.length && raw[i].length === 1 && LETTERS_RE.test(raw[i])) joined += raw[i++];
      i--;
      words.push(joined);
      continue;
    }

    const spoken = wordNumberAt(raw, i);

    if (spoken) {
      words.push(String(spoken.value));
      i = spoken.end - 1;
      continue;
    }
    if (ROMAN[raw[i]] !== undefined) {
      words.push(String(ROMAN[raw[i]]));
      continue;
    }
    if (ROMAN_LAST[raw[i]] !== undefined && i === raw.length - 1 && i > 0) {
      words.push(String(ROMAN_LAST[raw[i]]));
      continue;
    }
    words.push(raw[i]);
  }

  return words.filter((word) => !STOP_WORDS.has(word));
};

/**
 * One token in all forms. `forms` - phonetic Latin readings with skeletons:
 * for Russian words both the stem ("доту" → "dot") and the whole word
 * ("телеграм" → "telegram": the stemmer cuts loanwords too much).
 * @returns {{ word: string, num: number|null, cyr: boolean, stem: string, forms: {lat: string, skel: string}[], len: number }}
 */
const makeToken = (word) => {
  if (/^\d+(\.\d+)?$/.test(word)) return { word, num: Number(word), cyr: false, stem: word, forms: [], len: 0 };

  const stem = stemWord(word);
  const cyr = CYRILLIC_RE.test(word);
  const readings = cyr
    ? [translit(stem), translit(word), translit(stem, TRANSLIT_ALT), translit(word, TRANSLIT_ALT)]
    : [...latinReadings(word), ...(stem !== word ? latinReadings(stem) : [])];
  const seen = new Set();
  const forms = [];

  for (const reading of readings) {
    const lat = phonetic(reading);

    if (!lat || seen.has(lat)) continue;
    seen.add(lat);
    forms.push({ lat, skel: skeleton(lat) });
  }

  return { word, num: null, cyr, stem, forms, len: word.length };
};

/** Name, alias or spoken phrase → tokens. */
const prepare = (text) => nameWords(text).map(makeToken);

/* ── similarity ── */

/** Jaro-Winkler similarity 0..1. */
const jaroWinkler = (a, b) => {
  if (a === b) return 1;
  if (!a || !b) return 0;

  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array(a.length).fill(false);
  const bMatched = new Array(b.length).fill(false);
  let matches = 0;

  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;

  let transpositions = 0;

  for (let i = 0, k = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }

  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;

  while (prefix < 4 && a[prefix] && a[prefix] === b[prefix]) prefix++;

  return jaro + prefix * 0.1 * (1 - jaro);
};

/** One reading of a spoken token vs one reading of a name token. */
const formSimilarity = (spoken, target) => {
  if (spoken.lat === target.lat) return 0.97;
  if (spoken.skel.length >= 3 && spoken.skel === target.skel) return 0.95;
  // two consonants match too much ("доту" ~ "death"): the spelling must be close as well
  if (spoken.skel.length === 2 && spoken.skel === target.skel && jaroWinkler(spoken.lat, target.lat) >= 0.75) return 0.9;
  // a spoken stem is often the start of the name: "дот" → "dota", "контр" → "kontrol"
  if (spoken.lat.length >= 3 && target.lat.startsWith(spoken.lat)) return 0.75 + 0.15 * (spoken.lat.length / target.lat.length);

  const byLatin = jaroWinkler(spoken.lat, target.lat);
  // short skeletons say little: "rk" is in "ракет" and in "rock"
  const bySkeleton = spoken.skel.length >= 3 && target.skel.length >= 3 ? jaroWinkler(spoken.skel, target.skel) : byLatin;

  return Math.min(0.88, (byLatin + bySkeleton) / 2);
};

/** Spoken token vs name token, 0..1. */
const tokenSimilarity = (spoken, target) => {
  if (spoken.num !== null || target.num !== null) return spoken.num === target.num ? 1 : 0;
  if (spoken.stem === target.stem || spoken.word === target.word) return 1;

  // both Russian ("параграф" vs "параметры"): no spelling ambiguity, only typos and forms
  if (spoken.cyr && target.cyr) {
    if (spoken.stem.length >= 4 && target.stem.startsWith(spoken.stem)) return 0.86;

    const value = Math.max(jaroWinkler(spoken.stem, target.stem), jaroWinkler(spoken.word, target.word));

    return value >= 0.92 ? 0.86 : value * 0.7;
  }

  let best = 0;

  for (const a of spoken.forms) for (const b of target.forms) best = Math.max(best, formSimilarity(a, b));

  return best;
};

/** First letters of the words (+ numbers): "Grand Theft Auto V" → "gta" / "gta5". */
const acronymOf = (tokens) => {
  const letters = phonetic(tokens.filter((token) => token.num === null).map((token) => token.word[0] ?? "").join(""));
  const numbers = tokens.filter((token) => token.num !== null).map((token) => token.word).join("");

  return { letters, withNumbers: letters + numbers };
};

/**
 * Spoken tokens vs one alias.
 * @returns {{ score: number, coverage: number }} score 0..1; coverage - share of the alias
 * that was said ("дип рок" covers half of "Deep Rock Galactic", "дота" all of "Dota 2")
 */
const similarity = (spoken, alias, appNumbers = []) => {
  if (!spoken.length || !alias.length) return { score: 0, coverage: 0 };

  const words = spoken.filter((token) => token.num === null);
  const aliasWords = alias.filter((token) => token.num === null);
  const spokenNumbers = spoken.filter((token) => token.num !== null).map((token) => token.num);
  const aliasNumbers = alias.filter((token) => token.num !== null).map((token) => token.num);

  // acronym: "гта" → "Grand Theft Auto", "кс 2" → "Counter-Strike 2", "лол" → "League of Legends"
  if (words.length === 1 && aliasWords.length >= 2 && words[0].word.length <= 5) {
    const acronym = acronymOf(alias);
    const numbersAgree = spokenNumbers.every((number) => aliasNumbers.includes(number) || appNumbers.includes(number));
    const said = words[0].forms.map((form) => form.lat);

    if (numbersAgree && said.some((lat) => lat.length >= 2 && (lat === acronym.letters || lat + spokenNumbers.join("") === acronym.withNumbers))) {
      return { score: 0.93, coverage: 1 };
    }
  }

  // pairs are taken best first, so "эмпайрс" gets "empires" before "эйдж" can
  const pairs = [];

  words.forEach((token, i) => aliasWords.forEach((target, j) => {
    const value = tokenSimilarity(token, target);

    if (value >= 0.6) pairs.push({ i, j, value });
  }));
  pairs.sort((a, b) => b.value - a.value);

  const usedSpoken = new Set();
  const usedAlias = new Set();
  let total = 0;
  let matched = 0;
  let coveredLength = 0;
  let exact = true;

  for (const { i, j, value } of pairs) {
    if (usedSpoken.has(i) || usedAlias.has(j)) continue;
    usedSpoken.add(i);
    usedAlias.add(j);
    total += value;
    matched++;
    if (value < 1) exact = false;
    if (value >= 0.9) coveredLength += aliasWords[j].len;
  }

  if (matched < words.length) exact = false;
  if (!matched) return { score: 0, coverage: 0 };

  const aliasLength = aliasWords.reduce((sum, token) => sum + token.len, 0) || 1;
  const coverage = Math.min(1, coveredLength / aliasLength);
  // words said but not found in the name weigh a lot: "холлоу найт" is not "Battle.net"
  const spokenCoverage = matched / words.length;
  let score = exact && coverage >= 1 ? 1 : (total / matched) * (0.9 + 0.1 * coverage) * (0.55 + 0.45 * spokenCoverage);

  if (spokenNumbers.some((number) => !aliasNumbers.includes(number) && !appNumbers.includes(number))) score *= 0.5;
  if (aliasNumbers.some((number) => !spokenNumbers.includes(number))) score -= 0.02;
  if (!words.length) score = 0;

  return { score: Math.max(0, Math.min(1, score)), coverage };
};

/* ── apps ── */

/** "The Witcher 3: Wild Hunt" → ["The Witcher 3", "Wild Hunt"]; "Photoshop - Beta" → ["Photoshop", "Beta"] */
const splitSubtitle = (name) => {
  const match = String(name).match(/^(.{2,}?)\s*(?::|\s-\s|\s–\s|\s—\s)\s*(.{2,})$/);

  return match ? [match[1].trim(), match[2].trim()] : [String(name).trim(), ""];
};

const stripVendor = (name) => {
  const words = normalizeText(name).split(" ");

  for (const vendor of VENDORS) {
    const parts = vendor.split(" ");

    if (parts.every((part, i) => words[i] === part) && words.length > parts.length) return words.slice(parts.length).join(" ");
  }

  return "";
};

/** Automatic aliases from a name: without the subtitle and without the vendor. */
const autoAliases = (name) => {
  const out = new Set();
  const [main] = splitSubtitle(name);

  if (main && main !== name) out.add(main);
  for (const text of [name, main]) {
    const withoutVendor = stripVendor(text);

    if (withoutVendor) out.add(withoutVendor);
  }

  return [...out];
};

/**
 * App ready for matching: tokens of the name, its automatic aliases and user aliases.
 * @param {{ id: string, name: string, aliases?: string[], spoken?: string }} app
 */
const prepareApp = (app) => {
  const variants = [];
  const seen = new Set();
  const add = (text, source) => {
    const tokens = prepare(text);
    const key = tokens.map((token) => token.word).join(" ");

    if (!tokens.length || seen.has(key)) return;
    seen.add(key);
    variants.push({ text, source, tokens });
  };

  add(app.name, "name");
  for (const alias of app.aliases ?? []) add(alias, "alias");
  if (app.spoken) add(app.spoken, "alias");
  for (const alias of autoAliases(app.name)) add(alias, "auto");

  return { ...app, variants };
};

/**
 * Best score of a spoken phrase against a prepared app (or a running app).
 * @returns {{ score: number, coverage: number, variant: object|null }}
 */
const scoreApp = (spokenTokens, prepared) => {
  let best = { score: 0, coverage: 0, variant: null };
  const appNumbers = (prepared.variants[0]?.tokens ?? []).filter((token) => token.num !== null).map((token) => token.num);

  for (const variant of prepared.variants) {
    const { score, coverage } = similarity(spokenTokens, variant.tokens, appNumbers);

    if (score > best.score || (score === best.score && coverage > best.coverage)) best = { score, coverage, variant };
  }

  return best;
};

/**
 * Decision over scored candidates [{ key, score, coverage?, ... }] where `key`
 * identifies the thing (the same app on two PCs has one key).
 * Among close scores the only name said in full wins: "контрол" is "Control",
 * not "NVIDIA Control Panel"; "дип рок" stays a question.
 * @param {object[]} candidates
 * @param {{ accept?: number }} [options] accept - score that runs without a question
 *   (the skill setting app_confidence); below it, down to WEAK, NODUS asks to confirm
 * @returns {{ status: "match"|"weak"|"ambiguous"|"none", best: object|null, options: object[] }}
 */
const decide = (candidates, { accept = ACCEPT } = {}) => {
  const weak = Math.min(WEAK, accept);
  const byKey = new Map();

  for (const candidate of candidates) {
    const known = byKey.get(candidate.key);

    if (!known || candidate.score > known.score) byKey.set(candidate.key, candidate);
  }

  const sorted = [...byKey.values()].sort((a, b) => b.score - a.score || (b.coverage ?? 0) - (a.coverage ?? 0));
  let [best] = sorted;

  if (!best || best.score < weak) return { status: "none", best: best ?? null, options: [] };

  let close = sorted.filter((candidate) => best.score - candidate.score < GAP && candidate.score >= weak);

  if (close.length > 1) {
    const full = close.filter((candidate) => (candidate.coverage ?? 0) >= 1);

    if (full.length !== 1) return { status: "ambiguous", best, options: close.slice(0, 3) };
    best = full[0];
    close = [best];
  }
  if (best.score >= accept) return { status: "match", best, options: [best] };

  const second = sorted.find((candidate) => candidate !== best && candidate.score >= weak);

  return { status: "weak", best, options: second ? [best, second] : [best] };
};

/**
 * Name to say aloud: "how to call it" from the client, otherwise the name without
 * trademarks and subtitle ("The Witcher 3"). Aliases are not used: they are typed
 * in any form ("доту") and NODUS cannot decline them ("Закрыл доту").
 */
const spokenName = (app) => {
  if (app?.spoken) return app.spoken;

  const clean = String(app?.name ?? "").replace(/[®™©℠]/g, "").replace(/\s+/g, " ").trim();
  const [main] = splitSubtitle(clean);

  return main || clean;
};

/** The same app on different PCs has one key: "Google Chrome" → "google chrome". */
const appKey = (name) => nameWords(name).join(" ");

/** Tokens of a device name and its aliases, without words like "компьютер". */
const prepareDeviceName = (name, pcWords) => prepare(name).filter((token) => !pcWords.has(token.word));

module.exports = {
  ACCEPT,
  WEAK,
  GAP,
  translit,
  phonetic,
  skeleton,
  nameWords,
  makeToken,
  prepare,
  jaroWinkler,
  tokenSimilarity,
  similarity,
  splitSubtitle,
  autoAliases,
  prepareApp,
  scoreApp,
  decide,
  spokenName,
  appKey,
  prepareDeviceName,
};
