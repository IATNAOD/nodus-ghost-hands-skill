import { APPS, INPUT, SYSTEM, VISION } from "./actions";
import { DATA, FLOW, VARIABLES } from "./flow";
import { normalize, type NodeDef } from "./types";

export * from "./types";

/** Every node type, in palette order. */
export const NODE_DEFS: NodeDef[] = [...FLOW, ...APPS, ...SYSTEM, ...INPUT, ...VISION, ...DATA, ...VARIABLES].map(normalize);

const BY_TYPE = new Map(NODE_DEFS.map((def) => [def.type, def]));

export const defOf = (type: string): NodeDef | undefined => BY_TYPE.get(type);

/** Literal values of a new node: the defaults of its pins, then the preset. */
export function initialData(def: NodeDef, presetId?: string): Record<string, import("../model").Value> {
  const data: Record<string, import("../model").Value> = {};

  for (const pin of def.inputs) if (pin.default !== undefined) data[pin.id] = pin.default;
  return { ...data, ...(def.presets?.find((preset) => preset.id === presetId)?.data ?? {}) };
}
