// Scenarios on the PC: the document, values and run events. Pure: the renderer and the main
// process both import it (preloads must not: a shared chunk would break them).

export const SCENARIO_SCHEMA = 1;

/** Data pin types; "exec" pins carry the flow of a run. Literal-only types are set in the node, never wired. */
export type PinType = "exec" | "text" | "number" | "bool" | "point" | "region" | "any" | "app" | "scenario" | "image" | "keys" | "monitors" | "option";
export const WIRE_TYPES: PinType[] = ["text", "number", "bool", "point", "region", "any"];

/** Physical pixels of the virtual desktop. */
// values are type aliases, not interfaces: they must fit Value (an index signature)
export type Point = { x: number; y: number };
export type Region = { x: number; y: number; w: number; h: number };

/** A display, kept so it is found again: Electron id, its label, physical size. */
export type MonitorKey = { id: string; name: string; w: number; h: number };
export type MonitorSel = { mode: "all" | "primary" | "active" | "cursor" } | { mode: "list"; list: MonitorKey[] };
/** A search area: monitor-local physical pixels. */
export type RegionSel = { monitor: MonitorKey; x: number; y: number; w: number; h: number };
/** A sample taken from the screen: assets/<asset>.png; scale - of the display it was taken on. */
export type ImageRef = { asset: string; w: number; h: number; scale: number };
/** KeyboardEvent.code values, modifiers first. */
export type KeyCombo = { codes: string[] };

export type Value = null | string | number | boolean | Point | Region | Value[] | { [key: string]: Value };

export type VarScope = "run" | "scenario" | "global";
export type VarType = "text" | "number" | "bool" | "point" | "region" | "any";

export interface VariableDecl {
  name: string;
  scope: VarScope;
  type: VarType;
  initial: Value;
}

export type Trigger =
  | { id: string; type: "hotkey"; accelerator: string; enabled: boolean }
  | { id: string; type: "schedule"; time: string; days: number[]; missed: "skip" | "once"; enabled: boolean };

export interface ScenarioOptions {
  /** the same scenario started again while it runs */
  concurrency: "ignore" | "restart" | "queue";
  /** 0 - no limit */
  maxRunSec: number;
  /** the run holds the keyboard and mouse from its first input step to the end */
  exclusiveInput: boolean;
  /** a mouse move of the person stops the run */
  stopOnUserMouse: boolean;
  /** keys and clicks only while this app is in front ("" - any window) */
  guardApp: string;
  notifyOnError: boolean;
  /** say the error through NODUS */
  sayOnError: boolean;
  /** in the tray "Scenarios" menu */
  inTray: boolean;
}

export interface GraphNode {
  id: string;
  type: string;
  /** version of the node definition the data was written for */
  v: number;
  position: { x: number; y: number };
  /** literal values by pin id */
  data: Record<string, Value>;
}

export interface GraphEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  viewport: { x: number; y: number; zoom: number };
}

export interface Scenario {
  schema: number;
  id: string;
  rev: number;
  name: string;
  description: string;
  icon: string;
  color: string;
  /** arms hotkeys, the schedule, voice and NODUS; a manual run always works */
  enabled: boolean;
  voice: { enabled: boolean; aliases: string[]; spoken: string };
  triggers: Trigger[];
  options: ScenarioOptions;
  variables: VariableDecl[];
  graph: Graph;
  createdAt: number;
  updatedAt: number;
}

/** The list, the tray, the skill: no graph. */
export interface ScenarioSummary {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  enabled: boolean;
  voice: { enabled: boolean; aliases: string[]; spoken: string };
  triggers: Trigger[];
  inTray: boolean;
  updatedAt: number;
  /** problems that stop it from running */
  invalid: boolean;
}

/* ── runs ── */

export type RunTrigger = "manual" | "tray" | "hotkey" | "schedule" | "voice" | "nodus" | "scenario" | "debug";
export type RunStatus = "running" | "success" | "error" | "stopped";

export interface RunInfo {
  runId: string;
  scenarioId: string;
  name: string;
  trigger: RunTrigger;
  parentRunId?: string;
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  error?: { code: string; message?: string; nodeId?: string };
  output?: Value;
}

export type RunEvent =
  | { t: "run"; run: RunInfo }
  | {
      t: "node";
      runId: string;
      nodeId: string;
      phase: "start" | "end";
      at: number;
      ms?: number;
      out?: string;
      inputs?: Record<string, Value>;
      outputs?: Record<string, Value>;
      error?: { code: string; message?: string };
    }
  | { t: "log"; runId: string; at: number; level: "info" | "warn" | "error"; text: string; nodeId?: string };

/** A run with its step log, as the history keeps it. */
export interface RunRecord {
  info: RunInfo;
  events: RunEvent[];
}

/* ── limits ── */

export const LIMITS = {
  scenarios: 200,
  name: 80,
  description: 500,
  aliases: 8,
  alias: 64,
  nodes: 500,
  edges: 1000,
  variables: 100,
  varName: 40,
  /** one value, serialized */
  valueBytes: 10_000,
  /** all persistent variables */
  storeBytes: 256_000,
  text: 5000,
  triggers: 10,
  /** runs at the same time */
  parallelRuns: 8,
  steps: 100_000,
  loopIterations: 10_000,
  nesting: 64,
  subScenarios: 5,
  history: 100,
  runEvents: 2000,
  eventValueBytes: 2000,
  /** images: side, PNG size */
  imageSide: 1024,
  imageBytes: 4_000_000,
} as const;

export const ID_RE = /^[a-z0-9]{12}$/;
export const NODE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
export const ASSET_RE = /^[0-9a-f]{64}$/;
export const VAR_NAME_RE = /^[\p{L}_][\p{L}\p{N}_]{0,39}$/u;

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Random id of `length` [a-z0-9]; crypto in both Node and the browser. */
export function newId(length = 12): string {
  const bytes = new Uint8Array(length);

  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join("");
}

export const edgeId = (edge: Omit<GraphEdge, "id">): string => `${edge.source}.${edge.sourceHandle}>${edge.target}.${edge.targetHandle}`;

export const DEFAULT_OPTIONS: ScenarioOptions = {
  concurrency: "ignore",
  maxRunSec: 600,
  exclusiveInput: true,
  stopOnUserMouse: false,
  guardApp: "",
  notifyOnError: true,
  sayOnError: false,
  inTray: true,
};

/** A new scenario: only the Start node. */
export function emptyScenario(name: string, now = Date.now()): Scenario {
  return {
    schema: SCENARIO_SCHEMA,
    id: newId(),
    rev: 0,
    name,
    description: "",
    icon: "workflow",
    color: "purple",
    enabled: true,
    voice: { enabled: true, aliases: [], spoken: "" },
    triggers: [],
    options: { ...DEFAULT_OPTIONS },
    variables: [],
    graph: {
      nodes: [{ id: "start", type: "flow.start", v: 1, position: { x: 0, y: 0 }, data: {} }],
      edges: [],
      viewport: { x: 120, y: 80, zoom: 1 },
    },
    createdAt: now,
    updatedAt: now,
  };
}

export const summaryOf = (scenario: Scenario, invalid: boolean): ScenarioSummary => ({
  id: scenario.id,
  name: scenario.name,
  description: scenario.description,
  icon: scenario.icon,
  color: scenario.color,
  enabled: scenario.enabled,
  voice: scenario.voice,
  triggers: scenario.triggers,
  inTray: scenario.options.inTray,
  updatedAt: scenario.updatedAt,
  invalid,
});

export const isPoint = (value: unknown): value is Point =>
  Boolean(value) && typeof value === "object" && Number.isFinite((value as Point).x) && Number.isFinite((value as Point).y);

export const isRegion = (value: unknown): value is Region =>
  isPoint(value) && Number.isFinite((value as Region).w) && Number.isFinite((value as Region).h);

export const centerOf = (region: Region): Point => ({ x: Math.round(region.x + region.w / 2), y: Math.round(region.y + region.h / 2) });
