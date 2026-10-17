import { defOf, initialData } from "../../src/shared/scenarios/defs";
import { edgeId, emptyScenario, type GraphEdge, type RunEvent, type Scenario, type Value } from "../../src/shared/scenarios/model";
import { RunAbort, ScenarioRun, type EngineHost } from "../../src/main/scenarios/engine";
import { IMPLS } from "../../src/main/scenarios/impl";
import type { ScenarioServices } from "../../src/main/scenarios/impl/services";

type NodeSpec = [id: string, type: string, data?: Record<string, Value>];
type EdgeSpec = [source: string, sourceHandle: string, target: string, targetHandle?: string];

/** A scenario from a list of nodes and wires; "in" is the exec input. */
export function scenarioOf(nodes: NodeSpec[], edges: EdgeSpec[], name = "Test"): Scenario {
  const scenario = emptyScenario(name, 1000);

  scenario.id = "testscenario";
  scenario.graph.nodes = [
    { id: "start", type: "flow.start", v: 1, position: { x: 0, y: 0 }, data: {} },
    ...nodes.map(([id, type, data], i) => ({ id, type, v: 1, position: { x: 0, y: (i + 1) * 100 }, data: { ...initialData(defOf(type)!), ...(data ?? {}) } })),
  ];
  scenario.graph.edges = edges.map(([source, sourceHandle, target, targetHandle = "in"]): GraphEdge => {
    const edge = { source, sourceHandle, target, targetHandle };
    return { id: edgeId(edge), ...edge };
  });
  return scenario;
}

export interface FakeWorld {
  calls: { action: string; args: Record<string, unknown> }[];
  events: RunEvent[];
  vars: Map<string, Value>;
  clock: { now: number };
  services: ScenarioServices;
  failActions: Map<string, string>;
  found: { image: boolean; text: boolean };
}

export function world(): FakeWorld {
  const clock = { now: 1_000_000 };
  const calls: FakeWorld["calls"] = [];
  const failActions = new Map<string, string>();
  const found = { image: true, text: true };
  const record = (action: string, args: Record<string, unknown> = {}) => calls.push({ action, args });

  const services: ScenarioServices = {
    async perform(action, args) {
      record(action, args);
      const code = failActions.get(action);
      return code ? { ok: false, code } : { ok: true, data: action.startsWith("volume") ? { level: 40, muted: false } : {} };
    },
    apps: {
      state: () => ({ running: true, front: false }),
      active: async () => ({ name: "Notepad", app: "virtual:notepad", region: { x: 0, y: 0, w: 100, h: 100 } }),
      focus: async (id) => void record("focus", { id }),
      open: async (path, args) => void record("open", { path, args }),
      openUrl: async (url) => void record("openUrl", { url }),
      name: (id) => id,
    },
    system: {
      notify: (title, text) => void record("notify", { title, text }),
      say: async (text) => void record("say", { text }),
      clipboardRead: async () => "clip",
      clipboardWrite: async (text) => void record("clipboard", { text }),
      volume: async () => ({ level: 40, muted: false }),
      search: async (query, engine) => void record("search", { query, engine }),
    },
    input: {
      keys: async (combo, mode) => void record("keys", { codes: combo.codes, mode }),
      text: async (text, mode) => void record("text", { text, mode }),
      click: async (point, button) => void record("click", { ...point, button }),
      move: async (point) => void record("move", point),
      drag: async (from, to) => void record("drag", { from, to }),
      scroll: async (amount) => void record("scroll", { amount }),
      cursor: async () => ({ x: 5, y: 6 }),
      releaseAll: async () => void record("release"),
    },
    vision: {
      find: async () => (found.image ? { point: { x: 110, y: 220 }, region: { x: 100, y: 200, w: 20, h: 40 }, score: 0.97, monitor: "\\\\.\\DISPLAY1" } : null),
    },
    ocr: {
      find: async (text) => (found.text ? { point: { x: 50, y: 60 }, region: { x: 40, y: 50, w: 20, h: 20 }, text } : null),
      read: async () => "line 1\nline 2",
    },
    scenarios: { run: async (id, text) => ({ status: "success", output: `${id}:${text}` }) },
    now: () => clock.now,
  };

  return { calls, events: [], vars: new Map(), clock, services, failActions, found };
}

export function host(w: FakeWorld): EngineHost<ScenarioServices> {
  return {
    now: () => w.clock.now,
    sleep: async (ms, signal) => {
      if (signal.aborted) throw signal.reason instanceof RunAbort ? signal.reason : new RunAbort("stopped");
      w.clock.now += Math.max(1, ms);
    },
    yield: async () => undefined,
    impl: (type) => IMPLS[type],
    variables: {
      get: (scope, id, name) => w.vars.get(`${scope}:${scope === "global" ? "" : id}:${name}`),
      set: (scope, id, name, value) => void w.vars.set(`${scope}:${scope === "global" ? "" : id}:${name}`, value),
    },
    emit: (event) => void w.events.push(event),
    services: w.services,
  };
}

export async function run(scenario: Scenario, w = world(), options: Partial<{ signal: AbortSignal; text: string; fromNodeId: string; seed: Map<string, Record<string, Value>> }> = {}) {
  const info = await new ScenarioRun(scenario, host(w), {
    runId: "run1",
    trigger: "manual",
    text: options.text ?? "",
    signal: options.signal ?? new AbortController().signal,
    fromNodeId: options.fromNodeId,
    seed: options.seed,
  }).start();

  return { info, w };
}
