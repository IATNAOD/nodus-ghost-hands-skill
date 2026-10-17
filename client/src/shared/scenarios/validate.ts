import { buildFlow, dominators, dominates } from "./cfg";
import { defOf, isConnectable, type NodeDef, type PinDef } from "./defs";
import {
  ASSET_RE,
  DEFAULT_OPTIONS,
  edgeId,
  ID_RE,
  LIMITS,
  NODE_ID_RE,
  SCENARIO_SCHEMA,
  VAR_NAME_RE,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type Scenario,
  type Trigger,
  type Value,
  type VariableDecl,
} from "./model";
import { canConnect, isEmpty, sizeOf } from "./pins";

// Scenarios come from the renderer and from imported files: everything is checked here,
// in the main process, before it is stored or run.

const str = (value: unknown, max: number): string => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");
const text = (value: unknown, max: number): string => (typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max) : "");
const num = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);
const oneOf = <T extends string>(value: unknown, list: readonly T[], fallback: T): T => (list.includes(value as T) ? (value as T) : fallback);

/** A JSON value within the size limit; anything else becomes null. */
export function sanitizeValue(value: unknown, depth = 0): Value {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return text(value, LIMITS.text);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (depth > 6) return null;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, Value> = {};

    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      out[str(key, 40)] = sanitizeValue(item, depth + 1);
    }
    return out;
  }
  return null;
}

function sanitizeNode(raw: unknown): GraphNode | null {
  const node = raw as Partial<GraphNode> | null;

  if (!node || typeof node !== "object" || typeof node.id !== "string" || !NODE_ID_RE.test(node.id) || typeof node.type !== "string") return null;

  const data = sanitizeValue(node.data);
  const values: Record<string, Value> = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, Value>) : {};

  // an image sample is a reference to our own assets, nothing else
  for (const [key, value] of Object.entries(values)) {
    if (value && typeof value === "object" && !Array.isArray(value) && "asset" in value && !ASSET_RE.test(String((value as { asset: Value }).asset))) delete values[key];
    if (sizeOf(value) > LIMITS.valueBytes) delete values[key];
  }

  return {
    id: node.id,
    type: str(node.type, 60),
    v: num(node.v, 1, 1000, 1),
    position: { x: num(node.position?.x, -1e6, 1e6, 0), y: num(node.position?.y, -1e6, 1e6, 0) },
    data: values,
  };
}

function sanitizeGraph(raw: unknown): Graph {
  const graph = (raw ?? {}) as Partial<Graph>;
  const nodes: GraphNode[] = [];
  const ids = new Set<string>();

  for (const item of Array.isArray(graph.nodes) ? graph.nodes.slice(0, LIMITS.nodes) : []) {
    const node = sanitizeNode(item);
    if (node && !ids.has(node.id)) {
      ids.add(node.id);
      nodes.push(node);
    }
  }

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  // an exec output and a data input take one wire each: the first one stays
  const taken = new Set<string>();

  for (const item of Array.isArray(graph.edges) ? graph.edges.slice(0, LIMITS.edges) : []) {
    const edge = item as Partial<GraphEdge>;
    if (!edge || typeof edge !== "object") continue;

    const clean = { source: str(edge.source, 40), sourceHandle: str(edge.sourceHandle, 40), target: str(edge.target, 40), targetHandle: str(edge.targetHandle, 40) };
    if (!ids.has(clean.source) || !ids.has(clean.target) || !clean.sourceHandle || !clean.targetHandle) continue;

    const id = edgeId(clean);
    const exec = clean.targetHandle === "in";
    const key = exec ? `out:${clean.source}.${clean.sourceHandle}` : `in:${clean.target}.${clean.targetHandle}`;
    if (seen.has(id) || taken.has(key)) continue;

    seen.add(id);
    taken.add(key);
    edges.push({ id, ...clean });
  }

  const viewport = graph.viewport ?? { x: 0, y: 0, zoom: 1 };

  return { nodes, edges, viewport: { x: num(viewport.x, -1e7, 1e7, 0), y: num(viewport.y, -1e7, 1e7, 0), zoom: num(viewport.zoom, 0.1, 4, 1) } };
}

function sanitizeTrigger(raw: unknown, index: number): Trigger | null {
  const trigger = raw as Partial<Trigger> & Record<string, unknown>;
  const id = typeof trigger?.id === "string" && NODE_ID_RE.test(trigger.id) ? trigger.id : `t${index}`;

  if (trigger?.type === "hotkey") {
    const accelerator = str(trigger.accelerator, 60);
    return accelerator ? { id, type: "hotkey", accelerator, enabled: bool(trigger.enabled, true) } : null;
  }
  if (trigger?.type === "schedule") {
    const time = str(trigger.time, 5);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;

    const days = Array.isArray(trigger.days) ? [...new Set(trigger.days.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6))].sort() : [];
    return { id, type: "schedule", time, days: days.length ? days : [0, 1, 2, 3, 4, 5, 6], missed: oneOf(trigger.missed, ["skip", "once"] as const, "skip"), enabled: bool(trigger.enabled, true) };
  }
  return null;
}

function sanitizeVariable(raw: unknown): VariableDecl | null {
  const decl = raw as Partial<VariableDecl> | null;
  const name = str(decl?.name, LIMITS.varName);

  if (!VAR_NAME_RE.test(name)) return null;
  return {
    name,
    scope: oneOf(decl?.scope, ["run", "scenario", "global"] as const, "run"),
    type: oneOf(decl?.type, ["text", "number", "bool", "point", "region", "any"] as const, "any"),
    initial: sizeOf(sanitizeValue(decl?.initial)) <= LIMITS.valueBytes ? sanitizeValue(decl?.initial) : null,
  };
}

/** Any scenario from outside → a well-formed one (or null when it is not a scenario at all). */
export function sanitizeScenario(raw: unknown, now = Date.now()): Scenario | null {
  const s = raw as Partial<Scenario> | null;

  if (!s || typeof s !== "object") return null;

  const name = str(s.name, LIMITS.name);
  const options = (s.options ?? {}) as Partial<Scenario["options"]>;
  const voice = (s.voice ?? {}) as Partial<Scenario["voice"]>;

  return {
    schema: SCENARIO_SCHEMA,
    id: typeof s.id === "string" && ID_RE.test(s.id) ? s.id : "",
    rev: num(s.rev, 0, 1e9, 0),
    name,
    description: text(s.description, LIMITS.description),
    icon: str(s.icon, 40) || "workflow",
    color: str(s.color, 20) || "purple",
    enabled: bool(s.enabled, true),
    voice: {
      enabled: bool(voice.enabled, true),
      aliases: Array.isArray(voice.aliases) ? [...new Set(voice.aliases.map((alias) => str(alias, LIMITS.alias)).filter(Boolean))].slice(0, LIMITS.aliases) : [],
      spoken: str(voice.spoken, LIMITS.alias),
    },
    triggers: (Array.isArray(s.triggers) ? s.triggers.slice(0, LIMITS.triggers) : []).map(sanitizeTrigger).filter((t): t is Trigger => t !== null),
    options: {
      concurrency: oneOf(options.concurrency, ["ignore", "restart", "queue"] as const, DEFAULT_OPTIONS.concurrency),
      maxRunSec: num(options.maxRunSec, 0, 86400, DEFAULT_OPTIONS.maxRunSec),
      exclusiveInput: bool(options.exclusiveInput, DEFAULT_OPTIONS.exclusiveInput),
      stopOnUserMouse: bool(options.stopOnUserMouse, DEFAULT_OPTIONS.stopOnUserMouse),
      guardApp: str(options.guardApp, 130),
      notifyOnError: bool(options.notifyOnError, DEFAULT_OPTIONS.notifyOnError),
      sayOnError: bool(options.sayOnError, DEFAULT_OPTIONS.sayOnError),
      inTray: bool(options.inTray, DEFAULT_OPTIONS.inTray),
    },
    variables: (Array.isArray(s.variables) ? s.variables.slice(0, LIMITS.variables) : []).map(sanitizeVariable).filter((v): v is VariableDecl => v !== null),
    graph: sanitizeGraph(s.graph),
    createdAt: num(s.createdAt, 0, 1e15, now),
    updatedAt: num(s.updatedAt, 0, 1e15, now),
  };
}

/* ── checks ── */

export type IssueCode =
  | "no-start"
  | "many-starts"
  | "unknown-type"
  | "required"
  | "bad-edge"
  | "pure-cycle"
  | "unreachable"
  | "maybe-unavailable"
  | "no-name"
  | "bad-variable";

export interface Issue {
  severity: "error" | "warning";
  code: IssueCode;
  nodeId?: string;
  edgeId?: string;
  pin?: string;
}

const pinOf = (def: NodeDef, id: string, side: "in" | "out"): PinDef | undefined =>
  (side === "in" ? def.inputs : def.outputs).find((pin) => pin.id === id);

/** Is a pin shown (showIf) for these literal values? */
export function pinVisible(pin: PinDef, data: Record<string, Value>, def: NodeDef): boolean {
  if (!pin.showIf) return true;
  return Object.entries(pin.showIf).every(([other, values]) => {
    const value = data[other] ?? def.inputs.find((p) => p.id === other)?.default ?? null;
    return values.some((candidate) => candidate === value);
  });
}

/** An edge between pins that exist and fit. */
export function edgeFits(graph: Graph, edge: GraphEdge): boolean {
  const source = graph.nodes.find((node) => node.id === edge.source);
  const target = graph.nodes.find((node) => node.id === edge.target);
  const sourceDef = source && defOf(source.type);
  const targetDef = target && defOf(target.type);

  if (!sourceDef || !targetDef || edge.source === edge.target) return false;
  if (edge.targetHandle === "in") return targetDef.execIn && sourceDef.execOuts.some((out) => out.id === edge.sourceHandle);

  const from = pinOf(sourceDef, edge.sourceHandle, "out");
  const to = pinOf(targetDef, edge.targetHandle, "in");
  return Boolean(from && to && isConnectable(to) && canConnect(from.type, to.type));
}

/** Problems of a scenario; any "error" stops it from running. */
export function validateScenario(scenario: Scenario): Issue[] {
  const issues: Issue[] = [];
  const { graph } = scenario;
  const starts = graph.nodes.filter((node) => node.type === "flow.start");

  if (!scenario.name) issues.push({ severity: "error", code: "no-name" });
  if (starts.length === 0) issues.push({ severity: "error", code: "no-start" });
  for (const extra of starts.slice(1)) issues.push({ severity: "error", code: "many-starts", nodeId: extra.id });

  for (const node of graph.nodes) {
    const def = defOf(node.type);

    if (!def) {
      issues.push({ severity: "error", code: "unknown-type", nodeId: node.id });
      continue;
    }
    for (const pin of def.inputs) {
      if (!pin.required || !pinVisible(pin, node.data, def)) continue;

      const wired = graph.edges.some((edge) => edge.target === node.id && edge.targetHandle === pin.id);
      if (!wired && isEmpty(node.data[pin.id] ?? pin.default)) issues.push({ severity: "error", code: "required", nodeId: node.id, pin: pin.id });
    }
    if (node.type.startsWith("vars.") && !VAR_NAME_RE.test(String(node.data.name ?? ""))) {
      if (!isEmpty(node.data.name ?? null)) issues.push({ severity: "error", code: "bad-variable", nodeId: node.id, pin: "name" });
    }
  }

  for (const edge of graph.edges) if (!edgeFits(graph, edge)) issues.push({ severity: "error", code: "bad-edge", edgeId: edge.id });

  // pure nodes are evaluated through their inputs: a cycle among them never ends
  const pure = new Set(graph.nodes.filter((node) => defOf(node.type)?.kind === "pure").map((node) => node.id));
  const state = new Map<string, number>();
  const visit = (id: string): boolean => {
    state.set(id, 1);
    for (const edge of graph.edges) {
      if (edge.target !== id || !pure.has(edge.source)) continue;
      if (state.get(edge.source) === 1) return true;
      if (!state.has(edge.source) && visit(edge.source)) return true;
    }
    state.set(id, 2);
    return false;
  };
  for (const id of pure) if (!state.has(id) && visit(id)) issues.push({ severity: "error", code: "pure-cycle", nodeId: id });

  // the flow: steps nothing leads to, and values read before they can exist
  const flow = buildFlow(graph);
  const idom = dominators(flow);

  for (const node of graph.nodes) {
    const def = defOf(node.type);
    if (def && def.kind !== "pure" && def.kind !== "start" && !flow.reachable.has(node.id)) issues.push({ severity: "warning", code: "unreachable", nodeId: node.id });
  }

  // a value of an action is there only after the action ran on every way to the reader
  const consumers = (id: string): string[] => {
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) return [];
    if (defOf(node.type)?.kind !== "pure") return [id];
    return graph.edges.filter((edge) => edge.source === id).flatMap((edge) => consumers(edge.target));
  };

  for (const edge of graph.edges) {
    if (edge.targetHandle === "in") continue;

    const source = graph.nodes.find((node) => node.id === edge.source);
    const kind = source && defOf(source.type)?.kind;
    if (!source || kind === "pure" || kind === "start") continue;

    for (const reader of consumers(edge.target)) {
      if (reader === source.id || !flow.reachable.has(reader)) continue;
      // a loop reads its own body's values through its condition: fine after the first round
      if (flow.bodies.get(reader)?.has(source.id)) continue;
      if (!dominates(idom, source.id, reader)) {
        issues.push({ severity: "warning", code: "maybe-unavailable", edgeId: edge.id, nodeId: reader });
        break;
      }
    }
  }

  return issues;
}

export const hasErrors = (issues: Issue[]): boolean => issues.some((issue) => issue.severity === "error");
