// The scenario being edited: one document for both views, undo/redo, autosave after a pause,
// and what the runs of this scenario show live (the step running now, the last values).
import { useCallback, useEffect, useRef, useState } from "react";
import type { RunEvent, RunInfo, Scenario, Value } from "../../../shared/scenarios/model";
import type { Issue } from "../../../shared/scenarios/validate";

export type SaveState = "saved" | "dirty" | "saving" | "error";

const HISTORY = 100;
const SAVE_DELAY = 800;
/** edits of one field within this time are one undo step */
const MERGE_MS = 1200;

export interface Doc {
  scenario: Scenario | null;
  issues: Issue[];
  saveState: SaveState;
  saveError: string | null;
  /** change the scenario; `merge` - a key of a field typed into, consecutive edits merge */
  change(mutate: (draft: Scenario) => void, merge?: string): void;
  undo(): void;
  redo(): void;
  canUndo: boolean;
  canRedo: boolean;
  /** save now (before running it) */
  flush(): Promise<void>;
}

export function useScenarioDoc(id: string, readOnly: boolean): Doc {
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const current = useRef<Scenario | null>(null);
  const past = useRef<Scenario[]>([]);
  const future = useRef<Scenario[]>([]);
  const merged = useRef<{ key: string; at: number } | null>(null);
  const timer = useRef<number | null>(null);
  const saving = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let alive = true;
    window.gh.getScenario(id).then((loaded) => {
      if (!alive || !loaded) return;
      current.current = loaded.scenario;
      setScenario(loaded.scenario);
      setIssues(loaded.issues);
    });
    return () => {
      alive = false;
    };
  }, [id]);

  const save = useCallback(async () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;

    const snapshot = current.current;
    if (!snapshot || readOnly) return;

    setSaveState("saving");
    saving.current = saving.current.then(async () => {
      try {
        const result = await window.gh.saveScenario(snapshot);
        setIssues(result.issues);
        // edits made while saving stay: only the revision comes back
        if (current.current) current.current = { ...current.current, rev: result.scenario.rev, updatedAt: result.scenario.updatedAt };
        setScenario(current.current);
        setSaveState(current.current === snapshot || current.current?.graph === snapshot.graph ? "saved" : "dirty");
        setSaveError(null);
      } catch (error) {
        setSaveState("error");
        setSaveError((error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
      }
    });
    await saving.current;
  }, [readOnly]);

  const schedule = useCallback(() => {
    setSaveState("dirty");
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(), SAVE_DELAY);
  }, [save]);

  // leaving the editor saves what is pending
  useEffect(
    () => () => {
      if (timer.current) void save();
    },
    [save],
  );

  const change = useCallback(
    (mutate: (draft: Scenario) => void, merge?: string) => {
      const before = current.current;
      if (!before || readOnly) return;

      const next = structuredClone(before);
      mutate(next);

      const now = Date.now();
      const same = merge && merged.current && merged.current.key === merge && now - merged.current.at < MERGE_MS;
      // moving around the graph is saved but is not an undo step
      if (!same && merge !== "viewport") {
        past.current = [...past.current, before].slice(-HISTORY);
        future.current = [];
      }
      merged.current = merge ? { key: merge, at: now } : null;

      current.current = next;
      setScenario(next);
      schedule();
    },
    [readOnly, schedule],
  );

  const step = useCallback(
    (from: typeof past, to: typeof future) => {
      const target = from.current.at(-1);
      if (!target || !current.current || readOnly) return;

      from.current = from.current.slice(0, -1);
      to.current = [...to.current, current.current].slice(-HISTORY);
      merged.current = null;
      // the revision is the stored one, whatever the snapshot had
      current.current = { ...target, rev: current.current.rev };
      setScenario(current.current);
      setTick((n) => n + 1);
      schedule();
    },
    [readOnly, schedule],
  );

  return {
    scenario,
    issues,
    saveState,
    saveError,
    change,
    undo: () => step(past, future),
    redo: () => step(future, past),
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    flush: save,
  };
}

/* ── runs of the scenario, live ── */

export interface NodeRun {
  status: "running" | "done" | "error";
  out?: string;
  ms?: number;
  inputs?: Record<string, Value>;
  outputs?: Record<string, Value>;
  error?: { code: string; message?: string };
}

export interface RunWatch {
  run: RunInfo | null;
  nodes: Map<string, NodeRun>;
  /** exec wires taken: "node.out" */
  passed: Set<string>;
  events: RunEvent[];
}

const EMPTY: RunWatch = { run: null, nodes: new Map(), passed: new Set(), events: [] };

function reduce(state: RunWatch, event: RunEvent, scenarioId: string): RunWatch {
  if (event.t === "run") {
    if (event.run.scenarioId !== scenarioId) return state;
    // a new run starts clean
    if (state.run?.runId !== event.run.runId) return { run: event.run, nodes: new Map(), passed: new Set(), events: [event] };
    return { ...state, run: event.run, events: [...state.events, event] };
  }
  if (!state.run || event.runId !== state.run.runId) return state;

  const events = [...state.events, event].slice(-2000);
  if (event.t === "log") return { ...state, events };

  const nodes = new Map(state.nodes);
  const passed = new Set(state.passed);
  if (event.phase === "start") {
    nodes.set(event.nodeId, { ...(nodes.get(event.nodeId) ?? {}), status: "running" });
  } else {
    nodes.set(event.nodeId, { status: event.error ? "error" : "done", out: event.out, ms: event.ms, inputs: event.inputs, outputs: event.outputs, error: event.error });
    if (event.out) passed.add(`${event.nodeId}.${event.out}`);
  }
  return { run: state.run, nodes, passed, events };
}

export function useRunWatch(scenarioId: string): RunWatch {
  const [watch, setWatch] = useState<RunWatch>(EMPTY);

  useEffect(() => {
    let alive = true;

    // the last run, from the history, until a new one starts
    window.gh.getRuns(scenarioId).then(async (runs) => {
      const last = runs[0];
      if (!last || !alive) return;
      const record = await window.gh.getRunLog(last.runId);
      if (!record || !alive) return;
      setWatch((state) => (state.run ? state : record.events.reduce<RunWatch>((acc, event) => reduce(acc, event, scenarioId), { ...EMPTY, run: record.info })));
    });

    window.gh.setRunEvents(true).catch(() => undefined);
    const off = window.gh.onRunEvents((events) => setWatch((state) => events.reduce<RunWatch>((acc, event) => reduce(acc, event, scenarioId), state)));
    return () => {
      alive = false;
      off();
      window.gh.setRunEvents(false).catch(() => undefined);
    };
  }, [scenarioId]);

  return watch;
}
