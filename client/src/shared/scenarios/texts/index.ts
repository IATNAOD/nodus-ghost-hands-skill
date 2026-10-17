import { en } from "./en";
import { ru } from "./ru";
import type { NodeText, PinText, ScenarioTexts } from "./types";

export type { NodeText, PinText, ScenarioTexts } from "./types";

export const SCENARIO_TEXTS: Record<"ru" | "en", ScenarioTexts> = { ru, en };

const EMPTY_NODE: NodeText = { title: "", summary: "", description: "", step: "", pins: {}, outs: {} };

export const nodeText = (lang: "ru" | "en", type: string): NodeText => SCENARIO_TEXTS[lang].nodes[type] ?? { ...EMPTY_NODE, title: type };

/** The node's own pin text, else the shared one. */
export const pinText = (lang: "ru" | "en", type: string, pin: string): PinText | undefined =>
  SCENARIO_TEXTS[lang].nodes[type]?.pins[pin] ?? SCENARIO_TEXTS[lang].common.pins[pin];

export const outText = (lang: "ru" | "en", type: string, out: string): string =>
  SCENARIO_TEXTS[lang].nodes[type]?.outs[out] ?? SCENARIO_TEXTS[lang].common.outs[out] ?? out;
