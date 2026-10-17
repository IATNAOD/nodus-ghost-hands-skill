import type { PinType, Value } from "../model";

/**
 * start    - where a run begins (one per scenario)
 * action   - does something when the flow reaches it
 * pure     - computes outputs from inputs whenever a wired input needs them (no exec pins)
 * branch   - picks one of its exec outputs
 * loop     - runs its "body" output again and again, then "done"
 * terminal - ends the flow (Stop, Break)
 */
export type NodeKind = "start" | "action" | "pure" | "branch" | "loop" | "terminal";

/**
 * next   - the flow goes on; unconnected - this path ends
 * branch - one of several ways; unconnected - this path ends
 * fail   - "not found", "timeout"; unconnected - the node fails
 * body / done - of a loop
 * error  - added to fallible nodes; unconnected - the run fails
 */
export type ExecOutKind = "next" | "branch" | "fail" | "body" | "done" | "error";

export type Category = "flow" | "apps" | "system" | "input" | "vision" | "data" | "variables";
export const CATEGORIES: Category[] = ["flow", "apps", "system", "input", "vision", "data", "variables"];

export type Widget =
  | "text"
  | "textarea"
  | "number"
  | "slider"
  | "switch"
  | "select"
  | "app"
  | "scenario"
  | "hotkey"
  | "image"
  | "point"
  | "region"
  | "monitors"
  | "duration"
  | "path"
  | "url"
  | "variable";

export interface PinDef {
  id: string;
  type: PinType;
  default?: Value;
  /** an empty value fails the check before the run */
  required?: boolean;
  /** can take a wire; by default data types can, literal-only types (app, image, keys, ...) cannot */
  connectable?: boolean;
  /** text with {{variables}} */
  template?: boolean;
  widget?: Widget;
  /** for "option" pins: values; labels are in the texts */
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  unit?: "ms" | "s" | "%" | "px";
  /** shown only while another pin has one of these values */
  showIf?: Record<string, Value[]>;
  /** folded under "more" in the node and the step */
  advanced?: boolean;
}

export interface ExecOutDef {
  id: string;
  kind: ExecOutKind;
}

export interface NodeDef {
  type: string;
  version: number;
  kind: NodeKind;
  category: Category;
  /** lucide icon name */
  icon: string;
  execIn: boolean;
  execOuts: ExecOutDef[];
  inputs: PinDef[];
  outputs: PinDef[];
  /** may fail: gets the "error" exec output and the errorCode/errorMessage outputs */
  fallible?: boolean;
  traits?: {
    /** presses keys or clicks: takes the input lock, checks the guard */
    input?: boolean;
    /** looks at the screen: our own window is hidden from capture while it runs */
    vision?: boolean;
    /** listed in the import review */
    dangerous?: boolean;
    /** the flow never goes past it (Stop, Break) */
    noreturn?: boolean;
  };
  /** extra palette entries with other defaults ("Wait for image") */
  presets?: { id: string; data: Record<string, Value> }[];
}

export const ERROR_OUT: ExecOutDef = { id: "error", kind: "error" };
export const ERROR_OUTPUTS: PinDef[] = [
  { id: "errorCode", type: "text" },
  { id: "errorMessage", type: "text" },
];

/** Data types wire by default; literal-only types never do. */
export const isConnectable = (pin: PinDef): boolean =>
  pin.type !== "exec" && (pin.connectable ?? ["text", "number", "bool", "point", "region", "any"].includes(pin.type));

/** The full definition: a fallible node with its error output and pins. */
export function normalize(def: NodeDef): NodeDef {
  if (!def.fallible) return def;
  return {
    ...def,
    execOuts: def.execOuts.some((out) => out.id === "error") ? def.execOuts : [...def.execOuts, ERROR_OUT],
    outputs: [...def.outputs.filter((pin) => !ERROR_OUTPUTS.some((extra) => extra.id === pin.id)), ...ERROR_OUTPUTS],
  };
}
