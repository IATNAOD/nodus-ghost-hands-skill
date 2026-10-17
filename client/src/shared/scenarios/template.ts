import { toText } from "./pins";
import type { Value } from "./model";

// {{name}} in text: run variables, then the scenario ones, then the shared ones.
//   {{global.x}} / {{scenario.x}} / {{run.x}} - one scope only
//   {{trigger.text}}, {{trigger.type}}, {{now.time}}, {{now.date}} - built in
//   \{{ - a literal "{{"
const TOKEN = /(\\)?\{\{\s*([^{}]*?)\s*\}\}/g;
const WHOLE = /^\s*\{\{\s*([^{}]*?)\s*\}\}\s*$/;

export type Lookup = (name: string) => Value | undefined;

/** Text with the variables put in; unknown ones become empty. */
export function interpolate(text: string, lookup: Lookup): string {
  return text.replace(TOKEN, (match, escaped: string | undefined, name: string) => (escaped ? match.slice(1) : toText(lookup(name) ?? null)));
}

/** A template that is one variable keeps its value (a point stays a point); otherwise text. */
export function resolveTemplate(text: string, lookup: Lookup): Value {
  const whole = text.match(WHOLE);

  if (whole) return lookup(whole[1]) ?? null;
  return interpolate(text, lookup);
}

/** Variable names a template uses (for hints and checks). */
export function templateNames(text: string): string[] {
  const names = new Set<string>();

  for (const match of text.matchAll(TOKEN)) if (!match[1] && match[2]) names.add(match[2]);
  return [...names];
}

export const hasTemplate = (text: string): boolean => templateNames(text).length > 0;
