// Scenarios of this PC: storage, runs, triggers and the bridge to the rest of the client.
// A run takes a checked snapshot of the saved scenario; the same scenario started again
// follows its concurrency option; at most LIMITS.parallelRuns run at once.
import { clipboard, Notification, shell } from "electron";
import { EventEmitter } from "events";
import { belongsTo } from "../catalog/types";
import type { Catalog } from "../catalog";
import type { Dispatcher } from "../exec";
import type { Helper } from "../system/helper";
import type { RunningMonitor } from "../system/running";
import type { SettingsStore } from "../settings/store";
import { emptyScenario, LIMITS, newId, summaryOf, type RunEvent, type RunInfo, type RunTrigger, type Scenario, type ScenarioSummary, type Value } from "../../shared/scenarios/model";
import { hasErrors, sanitizeScenario, validateScenario, type Issue } from "../../shared/scenarios/validate";
import { NodeError, RunAbort, ScenarioRun, type EngineHost } from "./engine";
import { IMPLS } from "./impl";
import type { ScenarioServices, SearchArea } from "./impl/services";
import { InputController, InputLock } from "./input";
import { RunHistory, ScenarioStore, VariableStore } from "./store";
import type { ImageRef } from "../../shared/scenarios/model";

export interface VisionPort {
  find(image: ImageRef, area: SearchArea, threshold: number, signal: AbortSignal): ReturnType<ScenarioServices["vision"]["find"]>;
}
export interface OcrPort {
  find: ScenarioServices["ocr"]["find"];
  read: ScenarioServices["ocr"]["read"];
}

export interface ScenarioHost {
  dir: string;
  helper: Helper;
  catalog: Catalog;
  running: RunningMonitor;
  dispatcher: Dispatcher;
  settings: SettingsStore;
  /** parental control: the lock screen is up, a launch is over the limits */
  parental: { locked(): boolean; blocksPath(path: string): boolean };
  /** NODUS: say a text to the owner; tell about a run (when the skill knows scenarios) */
  skill: { say(text: string, runId: string): boolean; event(event: ScenarioWireEvent): void };
  texts(): { failedTitle: string; failedBody: string; failedSay: string; open: string; step(type: string): string };
  openEditor(scenarioId: string, nodeId?: string): void;
  /** our own windows hidden from screen capture while vision runs */
  protectWindows(on: boolean): void;
  log: { info(text: string): void; warn(text: string): void; error(text: string): void };
}

export interface ScenarioWireEvent {
  runId: string;
  id: string;
  name: string;
  status: "started" | "finished";
  result?: "success" | "error" | "stopped";
  output?: string;
  error?: string;
  trigger: RunTrigger;
  ms?: number;
}

export interface StartOptions {
  trigger: RunTrigger;
  text?: string;
  runId?: string;
  parentRunId?: string;
  fromNodeId?: string;
}

export type StartResult = { ok: true; runId: string; name: string; already?: boolean; queued?: boolean } | { ok: false; code: string };

interface ActiveRun {
  info: RunInfo;
  scenario: Scenario;
  controller: AbortController;
  events: RunEvent[];
  done: Promise<RunInfo>;
  parents: string[];
  input: InputController;
  vision: boolean;
}

const RUN_ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const SEARCH: Record<string, string> = {
  google: "https://www.google.com/search?q={q}",
  yandex: "https://yandex.ru/search/?text={q}",
  bing: "https://www.bing.com/search?q={q}",
  duckduckgo: "https://duckduckgo.com/?q={q}",
  youtube: "https://www.youtube.com/results?search_query={q}",
};

export class ScenarioService extends EventEmitter {
  readonly store: ScenarioStore;
  readonly variables: VariableStore;
  readonly history: RunHistory;
  vision: VisionPort | null = null;
  ocr: OcrPort | null = null;
  private active = new Map<string, ActiveRun>();
  private queued = new Map<string, { options: StartOptions; resolve: (result: StartResult) => void }[]>();
  private issues = new Map<string, Issue[]>();
  private inputLock = new InputLock();
  private subscribers = 0;
  private batch: RunEvent[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private lockWatch: NodeJS.Timeout | null = null;

  constructor(private host: ScenarioHost) {
    super();
    const warn = (text: string) => host.log.warn(text);

    this.store = new ScenarioStore(host.dir, warn);
    this.variables = new VariableStore(host.dir, warn);
    this.history = new RunHistory(host.dir, warn);
  }

  async init(): Promise<void> {
    await Promise.all([this.store.load(), this.variables.load(), this.history.load()]);
    for (const scenario of this.store.list()) this.issues.set(scenario.id, validateScenario(scenario));
    this.store.on("change", () => this.emit("change"));
    this.variables.on("change", () => this.emit("variables"));

    // the parental lock screen stops every run: input would hit the lock
    this.lockWatch = setInterval(() => {
      if (this.active.size && this.host.parental.locked()) this.stop({ all: true }, "parental-limit");
    }, 1000);
    this.lockWatch.unref();
  }

  /* ── documents ── */

  summaries(): ScenarioSummary[] {
    return this.store.list().map((scenario) => summaryOf(scenario, hasErrors(this.issues.get(scenario.id) ?? [])));
  }

  get(id: string): { scenario: Scenario; issues: Issue[] } | null {
    const scenario = this.store.get(id);
    return scenario ? { scenario, issues: this.issues.get(id) ?? validateScenario(scenario) } : null;
  }

  /** Two scenarios with one name would make NODUS ask which one: a new or imported one gets a number. */
  private uniqueName(name: string): string {
    const base = name.trim().slice(0, LIMITS.name) || "Scenario";
    const taken = new Set(this.store.list().map((scenario) => scenario.name.trim().toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; n < 1000; n++) {
      const suffix = ` ${n}`;
      const candidate = base.slice(0, LIMITS.name - suffix.length) + suffix;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return base;
  }

  async create(name: string): Promise<Scenario> {
    const scenario = emptyScenario(this.uniqueName(name));
    const saved = await this.store.save(scenario);

    this.issues.set(saved.id, validateScenario(saved));
    return saved;
  }

  /** A scenario from the editor: checked here, stored, issues returned. */
  async save(raw: unknown): Promise<{ scenario: Scenario; issues: Issue[] }> {
    const clean = sanitizeScenario(raw);
    if (!clean || !clean.id || !this.store.get(clean.id)) throw new Error("scenario-not-found");

    const saved = await this.store.save(clean);
    const issues = validateScenario(saved);

    this.issues.set(saved.id, issues);
    this.emit("saved", saved.id);
    return { scenario: saved, issues };
  }

  async remove(id: string): Promise<void> {
    this.stop({ scenarioId: id });
    await this.store.remove(id);
    this.variables.dropScenario(id);
    this.history.dropScenario(id);
    this.issues.delete(id);
  }

  /** A scenario from an import: a new id, triggers off until the person turns them on. */
  async adopt(raw: Scenario): Promise<Scenario> {
    const clean = sanitizeScenario(raw);
    if (!clean) throw new Error("bad-scenario");

    const scenario: Scenario = { ...clean, id: newId(), rev: 0, name: this.uniqueName(clean.name), triggers: clean.triggers.map((t) => ({ ...t, enabled: false })), createdAt: Date.now() };
    const saved = await this.store.save(scenario);

    this.issues.set(saved.id, validateScenario(saved));
    return saved;
  }

  /* ── runs ── */

  runs(): RunInfo[] {
    return [...this.active.values()].map((run) => run.info);
  }

  isRunning(scenarioId: string): boolean {
    return [...this.active.values()].some((run) => run.scenario.id === scenarioId);
  }

  start(id: string, options: StartOptions): StartResult {
    const scenario = this.store.get(id);
    if (!scenario) return { ok: false, code: "scenario-not-found" };
    if (this.host.parental.locked()) return { ok: false, code: "parental-limit" };

    const issues = this.issues.get(id) ?? validateScenario(scenario);
    if (hasErrors(issues)) return { ok: false, code: "scenario-invalid" };

    const parent = options.parentRunId ? this.active.get(options.parentRunId) : undefined;
    const parents = parent ? [...parent.parents, parent.scenario.id] : [];
    if (parents.length >= LIMITS.subScenarios || parents.includes(id)) return { ok: false, code: "scenario-recursion" };

    const current = [...this.active.values()].find((run) => run.scenario.id === id);
    if (current && options.trigger !== "scenario") {
      if (scenario.options.concurrency === "ignore") return { ok: true, runId: current.info.runId, name: scenario.name, already: true };
      if (scenario.options.concurrency === "restart") current.controller.abort(new RunAbort("stopped"));
      if (scenario.options.concurrency === "queue") {
        const queue = this.queued.get(id) ?? [];
        if (queue.length >= 5) return { ok: false, code: "scenario-busy" };
        const runId = options.runId && RUN_ID_RE.test(options.runId) ? options.runId : newId(16);
        queue.push({ options: { ...options, runId }, resolve: () => undefined });
        this.queued.set(id, queue);
        return { ok: true, runId, name: scenario.name, queued: true };
      }
    }
    if (this.active.size >= LIMITS.parallelRuns) return { ok: false, code: "scenario-busy" };

    return this.launch(scenario, options, parents);
  }

  private launch(scenario: Scenario, options: StartOptions, parents: string[]): StartResult {
    const runId = options.runId && RUN_ID_RE.test(options.runId) ? options.runId : newId(16);
    const controller = new AbortController();
    const abort = (code: string) => controller.abort(new RunAbort(code));
    const vision = scenario.graph.nodes.some((node) => node.type.startsWith("vision."));
    const input = new InputController(
      {
        call: (cmd, args, timeoutMs) => this.host.helper.call(cmd, args, timeoutMs),
        // Electron 44: the clipboard is asynchronous
        clipboard: { read: () => clipboard.readText(), write: (text) => clipboard.writeText(text) },
        sleep: (ms, signal) => sleep(ms, signal),
      },
      this.inputLock,
      {
        runId,
        signal: controller.signal,
        exclusive: scenario.options.exclusiveInput,
        waitRelease: options.trigger === "hotkey",
        stopOnUserMouse: scenario.options.stopOnUserMouse,
        guardPids: () => this.guardPids(scenario),
        abort,
      },
    );

    const active: ActiveRun = {
      info: { runId, scenarioId: scenario.id, name: scenario.name, trigger: options.trigger, parentRunId: options.parentRunId, startedAt: Date.now(), status: "running" },
      scenario,
      controller,
      events: [],
      parents,
      input,
      vision,
      done: Promise.resolve(null as unknown as RunInfo),
    };

    const seed = options.fromNodeId ? this.seedFor(scenario.id) : undefined;
    const host: EngineHost<ScenarioServices> = {
      now: () => Date.now(),
      sleep,
      yield: () => new Promise((resolve) => setImmediate(resolve)),
      impl: (type) => IMPLS[type],
      variables: {
        get: (scope, scenarioId, name) => this.variables.get(scope, scenarioId, name),
        set: (scope, scenarioId, name, value) => {
          try {
            this.variables.set(scope, scenarioId, name, value);
          } catch (error) {
            throw new NodeError((error as { code?: string }).code ?? "internal");
          }
        },
      },
      emit: (event) => this.record(active, event),
      services: this.services(active),
    };

    const limit = scenario.options.maxRunSec > 0 ? setTimeout(() => abort("run-timeout"), scenario.options.maxRunSec * 1000) : null;

    this.active.set(runId, active);
    if (vision) this.updateProtection();
    this.host.skill.event({ runId, id: scenario.id, name: scenario.name, status: "started", trigger: options.trigger });
    this.emit("change");

    active.done = new ScenarioRun(scenario, host, { runId, trigger: options.trigger, text: options.text ?? "", signal: controller.signal, parentRunId: options.parentRunId, fromNodeId: options.fromNodeId, seed })
      .start()
      .then(async (info) => {
        if (limit) clearTimeout(limit);
        await input.dispose().catch(() => undefined);
        this.finish(active, info);
        return info;
      });

    return { ok: true, runId, name: scenario.name };
  }

  private finish(active: ActiveRun, info: RunInfo): void {
    active.info = info;
    this.active.delete(info.runId);
    this.history.add({ info, events: active.events });
    this.flushEvents();
    if (active.vision) this.updateProtection();

    const ms = (info.endedAt ?? Date.now()) - info.startedAt;
    this.host.skill.event({
      runId: info.runId,
      id: info.scenarioId,
      name: info.name,
      status: "finished",
      result: info.status === "running" ? "success" : info.status,
      output: info.output === undefined || info.output === null ? undefined : String(typeof info.output === "object" ? JSON.stringify(info.output) : info.output).slice(0, 1000),
      error: info.error?.code,
      trigger: info.trigger,
      ms,
    });
    this.host.log.info(`scenario "${info.name}" ${info.status}${info.error ? ` (${info.error.code} at ${info.error.nodeId ?? "?"})` : ""} in ${ms} ms`);

    if (info.status === "error" && info.trigger !== "debug" && info.trigger !== "scenario") this.reportError(active.scenario, info);
    this.emit("change");
    this.emit("finished", info);

    // the next one of a queued scenario
    const queue = this.queued.get(info.scenarioId);
    const next = queue?.shift();
    if (next) {
      const scenario = this.store.get(info.scenarioId);
      if (scenario) this.launch(scenario, next.options, active.parents);
    }
  }

  /** Waits for a run (a sub-scenario, the NODUS block) and gives its result. */
  wait(runId: string): Promise<RunInfo | null> {
    const run = this.active.get(runId);
    return run ? run.done : Promise.resolve(this.history.get(runId)?.info ?? null);
  }

  /** Stops runs: one, those of a scenario, or all; the number stopped. */
  stop(selector: { runId?: string; scenarioId?: string; all?: boolean }, code = "stopped"): number {
    let count = 0;

    for (const run of this.active.values()) {
      if (selector.all || run.info.runId === selector.runId || run.scenario.id === selector.scenarioId) {
        run.controller.abort(new RunAbort(code));
        count++;
      }
    }
    if (selector.all) this.queued.clear();
    else if (selector.scenarioId) this.queued.delete(selector.scenarioId);
    return count;
  }

  /** "Run from this step": outputs of the steps before come from the last run. */
  private seedFor(scenarioId: string): Map<string, Record<string, Value>> {
    const seed = new Map<string, Record<string, Value>>();
    const last = this.history.last(scenarioId);

    for (const event of last?.events ?? []) if (event.t === "node" && event.phase === "end" && event.outputs) seed.set(event.nodeId, event.outputs);
    return seed;
  }

  private guardPids(scenario: Scenario): number[] | null {
    if (!scenario.options.guardApp) return null;

    const entry = this.host.running.entries.find((item) => item.appId === scenario.options.guardApp);
    if (!entry) throw new NodeError("focus-lost", "the app is not running");
    return entry.pids;
  }

  private reportError(scenario: Scenario, info: RunInfo): void {
    const texts = this.host.texts();
    const node = scenario.graph.nodes.find((n) => n.id === info.error?.nodeId);
    const body = texts.failedBody.replace("{error}", info.error?.message ?? info.error?.code ?? "").replace("{step}", node ? texts.step(node.type) : "—");

    if (scenario.options.notifyOnError && Notification.isSupported()) {
      const note = new Notification({ title: texts.failedTitle.replace("{name}", scenario.name), body, actions: [{ type: "button", text: texts.open }] });

      note.on("click", () => this.host.openEditor(scenario.id, info.error?.nodeId));
      note.on("action", () => this.host.openEditor(scenario.id, info.error?.nodeId));
      note.show();
    }
    if (scenario.options.sayOnError) this.host.skill.say(texts.failedSay.replace("{name}", scenario.name), info.runId);
  }

  private updateProtection(): void {
    this.host.protectWindows([...this.active.values()].some((run) => run.vision));
  }

  /* ── run events: the history keeps them, the editor gets them in batches ── */

  private record(active: ActiveRun, event: RunEvent): void {
    if (event.t === "run") active.info = event.run;
    if (active.events.length < LIMITS.runEvents) active.events.push(event);
    if (!this.subscribers) return;

    this.batch.push(event);
    if (!this.batchTimer) this.batchTimer = setTimeout(() => this.flushEvents(), 100);
  }

  private flushEvents(): void {
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = null;
    if (!this.batch.length) return;

    const batch = this.batch;
    this.batch = [];
    this.emit("events", batch);
  }

  /** The editor subscribes while it is open. */
  setListening(on: boolean): void {
    this.subscribers = on ? 1 : 0;
    if (!on) this.batch = [];
  }

  /* ── what nodes may use ── */

  private services(active: ActiveRun): ScenarioServices {
    const { helper, catalog, running, dispatcher, settings, parental } = this.host;
    const signal = active.controller.signal;

    return {
      perform: (action, args) => dispatcher.perform(action, args),
      apps: {
        state: (appId) => {
          const entry = running.entries.find((item) => item.appId === appId);
          return { running: Boolean(entry), front: Boolean(entry?.fg) };
        },
        active: async () => {
          const fg = await helper.call<{ none?: boolean; pid?: number; exe?: string; rect?: { x: number; y: number; w: number; h: number } }>("window.foreground");
          const entry = fg.pid ? running.entries.find((item) => item.pids.includes(fg.pid!)) : undefined;
          const name = entry?.name ?? (fg.exe ? fg.exe.split("\\").pop()!.replace(/\.exe$/i, "") : "");
          return { name, app: entry?.appId ?? "", region: fg.rect ?? null };
        },
        focus: async (appId) => {
          const entry = running.entries.find((item) => item.appId === appId);
          if (!entry) throw new NodeError("not-running");
          await helper.call("foreground.allow").catch(() => undefined);
          await helper.call("window.focus", { pid: entry.pids[0] });
        },
        open: async (path, args) => {
          if (parental.blocksPath(path)) throw new NodeError("parental-limit");
          await helper.call("process.start", { path, args: args || undefined }, 15000);
        },
        openUrl: async (url) => {
          await shell.openExternal(url);
        },
        name: (appId) => catalog.get(appId)?.name ?? appId,
      },
      system: {
        notify: (title, text) => {
          if (Notification.isSupported()) new Notification({ title: title.slice(0, 120), body: text.slice(0, 500) }).show();
        },
        say: async (text) => {
          if (!this.host.skill.say(text, active.info.runId)) throw new NodeError("offline");
        },
        clipboardRead: () => clipboard.readText(),
        clipboardWrite: (text) => clipboard.writeText(text),
        volume: () => helper.call<{ level: number; muted: boolean }>("volume.get"),
        search: async (query, engine) => {
          const name = SEARCH[engine] ? engine : settings.get().prefs.searchEngine;
          await shell.openExternal((SEARCH[name] ?? SEARCH.google).replace("{q}", encodeURIComponent(query)));
        },
      },
      input: {
        keys: (combo, mode, hold, repeat) => active.input.keys(combo, mode, hold, repeat),
        text: (text, mode, interval) => active.input.text(text, mode, interval),
        click: (point, button, double, hold, returnCursor) => active.input.click(point, button, double, hold, returnCursor),
        move: (point, smooth) => active.input.move(point, smooth),
        drag: (from, to, button, duration) => active.input.drag(from, to, button, duration),
        scroll: (amount, horizontal, point) => active.input.scroll(amount, horizontal, point),
        cursor: () => active.input.cursor(),
        releaseAll: () => active.input.releaseAll(),
      },
      vision: {
        find: (image, area, threshold, sig) => {
          if (!this.vision) throw new NodeError("unsupported");
          return this.vision.find(image, area, threshold, sig);
        },
      },
      ocr: {
        find: (text, match, area, lang, sig) => {
          if (!this.ocr) throw new NodeError("unsupported");
          return this.ocr.find(text, match, area, lang, sig);
        },
        read: (area, lang, sig) => {
          if (!this.ocr) throw new NodeError("unsupported");
          return this.ocr.read(area, lang, sig);
        },
      },
      scenarios: {
        run: async (id, text, wait) => {
          const started = this.start(id, { trigger: "scenario", text, parentRunId: active.info.runId });
          if (!started.ok) throw new NodeError(started.code);
          if (!wait) return { status: "running", output: null };

          // the parent stopping stops the child too
          const onAbort = () => this.stop({ runId: started.runId });
          signal.addEventListener("abort", onAbort, { once: true });
          try {
            const info = await this.wait(started.runId);
            return { status: info?.status ?? "error", output: info?.output ?? null };
          } finally {
            signal.removeEventListener("abort", onAbort);
          }
        },
      },
      now: () => Date.now(),
    };
  }

  async dispose(): Promise<void> {
    if (this.lockWatch) clearInterval(this.lockWatch);
    this.stop({ all: true });
    await Promise.all([...this.active.values()].map((run) => run.done.catch(() => undefined)));
    await Promise.all([this.variables.flush(), this.history.flush()]);
  }
}

/** Abortable sleep: rejects with the run abort. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason instanceof RunAbort ? signal.reason : new RunAbort("stopped"));

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof RunAbort ? signal.reason : new RunAbort("stopped"));
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Does a path open something parental control holds back now (a game when game time is over)? */
export function pathBlocked(path: string, catalog: Catalog, blocksLaunch: (app: { id: string; kind: string }) => boolean): boolean {
  const apps = catalog.all().filter((app) => belongsTo(app.match, { exe: path }));
  return apps.some((app) => blocksLaunch(app)) || blocksLaunch({ id: "", kind: "app" });
}
