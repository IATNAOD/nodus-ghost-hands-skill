// lib/nodus-routing.js
const byLength = (s) => s.split(" ").sort((a, b) => b.length - a.length);
const RU = byLength("ться тесь ишь ешь ите ете ить ать ять еть уть оть ают яют ует ёт ют ал ял ил ел ул ала яла " +
  "ила ела али яли или ели вший вшая вшие вшей ющий ющая ющие ющей нный нная нные нной ость ости остью остей ение " +
  "ению ений ание анию аний ного ному ными ого ому ами ями ую юю ой ей ий ом ем ах ях ов ев ам ям ки ку ке ок ть чь " +
  "а о у е и ы й");
const EN = byLength("ational tional ization fulness iveness ousness ement ness ment ance ence able ible ally tion " +
  "sion ical ular ing ful ous ive ize ise ity ent ant ism ist ate ies ied ly er ed al en es ty s y");
const IRREGULAR = { lit: "light", ran: "run", playing: "play", dimmer: "dim" };
const cut = (w, endings) => endings.find((e) => w.endsWith(e) && w.length - e.length >= 2);

const stemWord = (word) => {
  const w = String(word).toLowerCase().trim();
  const ru = (w.match(/[а-яё]/g) || []).length, en = (w.match(/[a-z]/g) || []).length;
  if (!ru && !en) return w;
  if (ru >= en) { const e = w.length > 3 && cut(w, RU); return e ? w.slice(0, -e.length) : w; }
  if (Object.hasOwn(IRREGULAR, w)) return IRREGULAR[w];
  if (w.length <= 3) return w;
  const d = w.match(/^(.+?)([bcdfgklmnprstvz])\2(ing|ed)$/);
  if (d && d[1].length >= 2) return d[1] + d[2];
  const e = cut(w, EN);
  if (!e) return w;
  const base = w.slice(0, -e.length);
  if (e === "ies" || e === "ied") return base + "y";
  if (e === "ing" && /[bcdfghjklmnpqrstvwxyz]$/.test(base) && /[aeiou]/.test(base.slice(-2, -1))) return base + "e";
  return base;
};
const stems = (text) => String(text).toLowerCase().split(/\s+/).filter((w) => w.length > 1).map(stemWord);

const lev = (a, b) => {
  let p = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    const c = [i];
    for (let j = 1; j <= b.length; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] !== b[j - 1]));
    p = c;
  }
  return p[b.length];
};
const near = (word, target) => lev(word, target) <= (target.length <= 4 ? 1 : 2);

// счёт обычного интента; null - антипаттерн; names - основы registerRoutingWords его скилла
const score = (intent, text, names = []) => {
  const words = stems(text), own = (list) => (list || []).map(stemWord);
  if (own(intent.antipatterns).some((a) => words.includes(a))) return null;
  let total = 0;
  for (const phrase of (intent.phrases || []).map(stems)) {
    const ratio = phrase.filter((s) => words.includes(s)).length / phrase.length;
    if (ratio >= 1) { total += 15; break; }
    if (ratio >= 0.7) total += 8;
  }
  for (const t of own(intent.triggers)) total += words.includes(t) ? 4 : words.some((w) => near(w, t)) ? 2 : 0;
  for (const c of own(intent.context)) total += words.includes(c) ? 1 : words.some((w) => near(w, c)) ? 0.5 : 0;
  const named = [...names].some((n) => n.length >= 4 && words.some((w) => w.length >= 4 && near(w, n)));
  return total >= 4 && named ? total + 8 : total;
};

const decide = (results) => {
  const list = [...results].sort((a, b) => b.score - a.score || (b.priority || 0) - (a.priority || 0));
  const [best, second] = list;
  if (!best) return { action: "no-match" };
  if (second && second.score / best.score >= 0.7)
    return { action: "ask", options: list.filter((r) => r.score / best.score >= 0.5).slice(0, 3).map((r) => r.id) };
  return { action: "run", id: best.id };
};

module.exports = { stemWord, stems, score, decide };
