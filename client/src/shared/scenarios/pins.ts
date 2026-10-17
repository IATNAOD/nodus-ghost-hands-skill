import { centerOf, isPoint, isRegion, type PinType, type Value } from "./model";

/** Which output may wire into which input. Exec only to exec; "any" both ways; a few safe conversions. */
export function canConnect(from: PinType, to: PinType): boolean {
  if (from === "exec" || to === "exec") return from === to;
  if (from === to || from === "any" || to === "any") return true;
  if (to === "text") return from === "number" || from === "bool" || from === "point";
  if (to === "point") return from === "region";
  return false;
}

const FALSE_WORDS = new Set(["", "0", "false", "no", "нет", "off", "выкл"]);

export function toText(value: Value): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(Math.round(value * 1e6) / 1e6) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return value.map(toText).join(", ");
  if (isRegion(value)) return `${value.x}, ${value.y}, ${value.w}×${value.h}`;
  if (isPoint(value)) return `${value.x}, ${value.y}`;
  return JSON.stringify(value);
}

export function toNumber(value: Value): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(",", "."));

    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function toBool(value: Value): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return !FALSE_WORDS.has(value.trim().toLowerCase());
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined;
}

/** A value as the pin type wants it; null when it cannot be (a point from text). */
export function coerce(value: Value, type: PinType): Value {
  switch (type) {
    case "text":
      return toText(value);
    case "number":
      return toNumber(value);
    case "bool":
      return toBool(value);
    case "point":
      if (isRegion(value)) return centerOf(value);
      return isPoint(value) ? { x: Math.round(value.x), y: Math.round(value.y) } : null;
    case "region":
      return isRegion(value) ? value : null;
    default:
      return value ?? null;
  }
}

/** Empty for "required": nothing, blank text, an empty list. */
export const isEmpty = (value: Value | undefined): boolean =>
  value === null || value === undefined || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0);

/** Compare of the data.compare node: numbers as numbers, text without case. */
export function compareValues(a: Value, op: string, b: Value): boolean {
  if (op === "empty") return isEmpty(a);

  const numeric = (v: Value) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.trim().replace(",", "."))));
  const both = numeric(a) && numeric(b);
  const x = both ? toNumber(a) : toText(a).toLowerCase();
  const y = both ? toNumber(b) : toText(b).toLowerCase();

  switch (op) {
    case "eq":
      return x === y;
    case "ne":
      return x !== y;
    case "gt":
      return x > y;
    case "lt":
      return x < y;
    case "ge":
      return x >= y;
    case "le":
      return x <= y;
    case "contains":
      return toText(a).toLowerCase().includes(toText(b).toLowerCase());
    case "starts":
      return toText(a).toLowerCase().startsWith(toText(b).toLowerCase());
    default:
      return false;
  }
}

/** JSON size of a value, for the limits of variables and run events. */
export const sizeOf = (value: Value): number => {
  try {
    return JSON.stringify(value ?? null).length;
  } catch {
    return Infinity;
  }
};

/** A value cut to fit a run event: long text shortened, big structures summarized. */
export function preview(value: Value, max: number): Value {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}…` : value;
  return sizeOf(value) > max ? `${toText(value).slice(0, max)}…` : value;
}
