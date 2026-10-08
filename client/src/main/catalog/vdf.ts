// Valve KeyValues (VDF) text: libraryfolders.vdf and appmanifest_*.acf of Steam.

export type VdfValue = string | VdfObject;
export interface VdfObject {
  [key: string]: VdfValue;
}

const tokenize = (text: string): string[] => {
  const tokens: string[] = [];
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (char === "{" || char === "}") {
      tokens.push(char);
      i++;
    } else if (char === '"') {
      let value = "";

      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length) {
          const next = text[i + 1];

          value += next === "n" ? "\n" : next === "t" ? "\t" : next;
          i += 2;
        } else {
          value += text[i++];
        }
      }
      i++;
      tokens.push(`"${value}`);
    } else if (/\s/.test(char)) {
      i++;
    } else {
      let value = "";

      while (i < text.length && !/[\s{}"]/.test(text[i])) value += text[i++];
      tokens.push(`"${value}`);
    }
  }

  return tokens;
};

/** Parse VDF text into nested objects; keys keep their case (see `get`). */
export function parseVdf(text: string): VdfObject {
  const tokens = tokenize(text.replace(/^﻿/, ""));
  let position = 0;

  const object = (): VdfObject => {
    const out: VdfObject = {};

    while (position < tokens.length) {
      const token = tokens[position++];

      if (token === "}") return out;
      if (token === "{") continue;

      const key = token.slice(1);
      const next = tokens[position];

      if (next === "{") {
        position++;
        out[key] = object();
      } else if (next !== undefined && next !== "}") {
        out[key] = tokens[position++].slice(1);
      } else {
        out[key] = "";
      }
    }

    return out;
  };

  return object();
}

/** Case-insensitive lookup: Steam writes "AppState"/"appstate", "StateFlags"/"stateflags". */
export function get(object: VdfValue | undefined, key: string): VdfValue | undefined {
  if (!object || typeof object !== "object") return undefined;

  const lower = key.toLowerCase();

  for (const [name, value] of Object.entries(object)) if (name.toLowerCase() === lower) return value;

  return undefined;
}

export const getString = (object: VdfValue | undefined, key: string): string => {
  const value = get(object, key);

  return typeof value === "string" ? value : "";
};
