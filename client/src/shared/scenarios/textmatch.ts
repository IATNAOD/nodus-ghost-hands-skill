// Finding a label among the lines the Windows OCR read. OCR mixes Latin and Cyrillic
// look-alikes and loses punctuation, so both sides are folded before comparing; a long word
// may differ by one character.
import type { Region } from "./model";

export interface OcrWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface OcrLine extends OcrWord {
  words: OcrWord[];
}

export interface TextHit {
  text: string;
  region: Region;
  /** 1 - exact, lower - looser */
  quality: number;
}

const LOOKALIKES: Record<string, string> = { а: "a", е: "e", ё: "e", о: "o", р: "p", с: "c", х: "x", у: "y", к: "k", м: "m", т: "t", н: "h", в: "b", і: "i", ј: "j", ѕ: "s" };

/** lower case, look-alikes folded, punctuation gone, single spaces */
export function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[аеёорсхукмтнвіјѕ]/g, (char) => LOOKALIKES[char] ?? char)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, current[j]);
    }
    if (best > max) return max + 1;
    previous = current;
  }
  return previous[b.length];
}

/** Two folded words are the same: equal, or one edit apart when long enough. */
const sameWord = (a: string, b: string): boolean => a === b || (Math.min(a.length, b.length) >= 5 && distance(a, b, 1) <= 1);

const union = (words: OcrWord[]): Region => {
  const x = Math.min(...words.map((w) => w.x));
  const y = Math.min(...words.map((w) => w.y));
  return { x, y, w: Math.max(...words.map((w) => w.x + w.w)) - x, h: Math.max(...words.map((w) => w.y + w.h)) - y };
};

/**
 * The best place of `query` in the lines.
 *  contains - the words of the query in a row (a word may also contain the query: "Играть" in "Играть!")
 *  exact    - a whole line equal to the query (a button label is a line of its own)
 *  words    - all words of the query anywhere in one line
 */
export function findText(lines: OcrLine[], query: string, mode: string): TextHit | null {
  const wanted = fold(query).split(" ").filter(Boolean);
  if (!wanted.length) return null;

  let best: TextHit | null = null;
  const offer = (hit: TextHit) => {
    if (!best || hit.quality > best.quality || (hit.quality === best.quality && hit.region.w * hit.region.h < best.region.w * best.region.h)) best = hit;
  };

  for (const line of lines) {
    const words = line.words.length ? line.words : [line];
    const folded = words.map((w) => fold(w.text));

    if (mode === "words") {
      const used: OcrWord[] = [];
      const ok = wanted.every((want) => {
        const index = folded.findIndex((word) => sameWord(word, want) || word.includes(want));
        if (index >= 0) used.push(words[index]);
        return index >= 0;
      });
      if (ok) offer({ text: line.text, region: union(used), quality: used.length === words.length ? 1 : 0.8 });
      continue;
    }

    // a run of consecutive words equal to the query (word by word)
    for (let start = 0; start + wanted.length <= folded.length; start++) {
      const run = folded.slice(start, start + wanted.length);
      const exactRun = run.every((word, i) => word === wanted[i]);
      const looseRun = run.every((word, i) => sameWord(word, wanted[i]));

      if (!exactRun && !looseRun) continue;

      const whole = wanted.length === folded.length;
      if (mode === "exact" && !whole) continue;
      offer({ text: line.text, region: union(words.slice(start, start + wanted.length)), quality: (exactRun ? 1 : 0.85) * (whole ? 1 : 0.95) });
    }

    // the query inside one word ("Играть!", "Settings…") or the whole line
    if (mode === "contains") {
      const query1 = wanted.join(" ");
      folded.forEach((word, i) => {
        if (wanted.length === 1 && word.includes(query1) && word !== query1) offer({ text: line.text, region: union([words[i]]), quality: 0.7 });
      });
      if (wanted.length > 1 && fold(line.text).includes(query1)) offer({ text: line.text, region: union(words), quality: 0.6 });
    }
  }
  return best;
}

/** The lines as plain text, top to bottom. */
export const linesText = (lines: OcrLine[]): string =>
  [...lines]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((line) => line.text)
    .join("\n");
