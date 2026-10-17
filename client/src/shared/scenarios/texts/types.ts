import type { Category } from "../defs/types";
import type { PinType } from "../model";

export interface PinText {
  label: string;
  description: string;
  options?: Record<string, string>;
}

export interface NodeText {
  title: string;
  summary: string;
  description: string;
  /** the line of a step; {pin} becomes its value */
  step: string;
  pins: Record<string, PinText>;
  /** exec outputs */
  outs: Record<string, string>;
  presets?: Record<string, string>;
}

export interface ScenarioTexts {
  categories: Record<Category, string>;
  types: Record<PinType, string>;
  /** pins and outputs many nodes share; a node's own text wins */
  common: { pins: Record<string, PinText>; outs: Record<string, string> };
  nodes: Record<string, NodeText>;
}
