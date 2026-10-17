// Scenarios on disk, in userData/scenarios/:
//   items/<id>.json   - one file per scenario, written atomically, the previous one kept as .bak
//   assets/<sha>.png  - samples taken from the screen; unused ones are removed
//   variables.json    - persistent variables (of a scenario and shared)
//   runs.json         - the last runs with their step logs
// No electron, no log module: vitest runs it on a temp folder.
import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { EventEmitter } from "events";
import { ASSET_RE, ID_RE, LIMITS, type RunRecord, type Scenario, type Value } from "../../shared/scenarios/model";
import { sizeOf } from "../../shared/scenarios/pins";
import { sanitizeScenario, sanitizeValue } from "../../shared/scenarios/validate";

type Warn = (text: string) => void;

/** temp file + rename; the file before goes to .bak */
async function writeAtomic(file: string, data: string | Buffer, backup = false): Promise<void> {
  const temp = `${file}.tmp`;

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(temp, data);
  if (backup) await fs.copyFile(file, `${file}.bak`).catch(() => undefined);
  await fs.rename(temp, file);
}

async function readJson(file: string): Promise<unknown> {
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw.replace(/^﻿/, ""));
}

/** Width and height of a PNG, or null when it is not one. */
export function pngSize(data: Buffer): { w: number; h: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  if (data.length < 24 || signature.some((byte, i) => data[i] !== byte) || data.toString("ascii", 12, 16) !== "IHDR") return null;
  return { w: data.readUInt32BE(16), h: data.readUInt32BE(20) };
}

export class ScenarioStore extends EventEmitter {
  readonly dir: string;
  private items = new Map<string, Scenario>();
  private queues = new Map<string, Promise<void>>();

  constructor(
    root: string,
    private warn: Warn = () => undefined,
  ) {
    super();
    this.dir = path.join(root, "scenarios");
  }

  private file(id: string): string {
    return path.join(this.dir, "items", `${id}.json`);
  }

  async load(): Promise<void> {
    let names: string[] = [];

    try {
      names = await fs.readdir(path.join(this.dir, "items"));
    } catch {
      return;
    }

    for (const name of names.filter((n) => /^[a-z0-9]{12}\.json$/.test(n))) {
      const id = name.slice(0, 12);
      let scenario: Scenario | null = null;

      for (const candidate of [this.file(id), `${this.file(id)}.bak`]) {
        try {
          scenario = sanitizeScenario(await readJson(candidate));
          if (scenario) break;
        } catch (error) {
          this.warn(`scenario ${id}: ${(error as Error).message}`);
        }
      }
      if (scenario) this.items.set(id, { ...scenario, id });
    }
    await this.collectAssets();
  }

  list(): Scenario[] {
    return [...this.items.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): Scenario | undefined {
    return this.items.get(id);
  }

  /** Stores a scenario (already sanitized); the revision grows. */
  async save(scenario: Scenario, now = Date.now()): Promise<Scenario> {
    if (!ID_RE.test(scenario.id)) throw new Error("bad scenario id");
    if (!this.items.has(scenario.id) && this.items.size >= LIMITS.scenarios) throw new Error("too-many-scenarios");

    const previous = this.items.get(scenario.id);
    const saved: Scenario = { ...scenario, rev: (previous?.rev ?? 0) + 1, createdAt: previous?.createdAt ?? scenario.createdAt ?? now, updatedAt: now };

    this.items.set(saved.id, saved);
    await this.queue(saved.id, () => writeAtomic(this.file(saved.id), JSON.stringify(saved, null, 1), true));
    this.emit("change", saved.id);
    return saved;
  }

  async remove(id: string): Promise<void> {
    if (!this.items.delete(id)) return;
    await this.queue(id, async () => {
      for (const file of [this.file(id), `${this.file(id)}.bak`]) await fs.rm(file, { force: true });
    });
    this.emit("change", id);
    await this.collectAssets();
  }

  /** Writes of one scenario go one after another. */
  private queue(id: string, write: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(id) ?? Promise.resolve()).then(write).catch((error) => this.warn(`scenario ${id} write: ${(error as Error).message}`));

    this.queues.set(id, next);
    return next;
  }

  /* ── samples ── */

  assetPath(sha: string): string {
    if (!ASSET_RE.test(sha)) throw new Error("bad asset id");
    return path.join(this.dir, "assets", `${sha}.png`);
  }

  /** Keeps a PNG; its id is the sha256 of the bytes. */
  async putAsset(png: Buffer): Promise<{ asset: string; w: number; h: number }> {
    const size = pngSize(png);

    if (!size || png.length > LIMITS.imageBytes || size.w > LIMITS.imageSide || size.h > LIMITS.imageSide || size.w < 4 || size.h < 4) throw new Error("bad-image");

    const asset = createHash("sha256").update(png).digest("hex");
    const file = this.assetPath(asset);

    await fs.access(file).catch(() => writeAtomic(file, png));
    return { asset, ...size };
  }

  async readAsset(sha: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.assetPath(sha));
    } catch {
      return null;
    }
  }

  /** Samples no scenario refers to any more go. */
  async collectAssets(): Promise<void> {
    const used = new Set<string>();
    const walk = (value: Value) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) return value.forEach(walk);
      if (typeof (value as { asset?: Value }).asset === "string") used.add((value as { asset: string }).asset);
      Object.values(value).forEach(walk);
    };

    for (const scenario of this.items.values()) for (const node of scenario.graph.nodes) walk(node.data);

    let files: string[] = [];
    try {
      files = await fs.readdir(path.join(this.dir, "assets"));
    } catch {
      return;
    }
    for (const file of files) {
      const sha = file.replace(/\.png$/, "");
      if (ASSET_RE.test(sha) && !used.has(sha)) await fs.rm(path.join(this.dir, "assets", file), { force: true }).catch(() => undefined);
    }
  }
}

interface VariablesFile {
  global: Record<string, Value>;
  scenarios: Record<string, Record<string, Value>>;
}

/** Persistent variables: shared ones and those of each scenario. Written 500 ms after a change. */
export class VariableStore extends EventEmitter {
  private file: string;
  private data: VariablesFile = { global: {}, scenarios: {} };
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    root: string,
    private warn: Warn = () => undefined,
  ) {
    super();
    this.file = path.join(root, "scenarios", "variables.json");
  }

  async load(): Promise<void> {
    try {
      const raw = (await readJson(this.file)) as Partial<VariablesFile>;
      const clean = (values: unknown): Record<string, Value> => {
        const out: Record<string, Value> = {};
        if (values && typeof values === "object") for (const [name, value] of Object.entries(values)) out[name.slice(0, LIMITS.varName)] = sanitizeValue(value);
        return out;
      };

      this.data.global = clean(raw.global);
      for (const [id, values] of Object.entries(raw.scenarios ?? {})) if (ID_RE.test(id)) this.data.scenarios[id] = clean(values);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.warn(`variables: ${(error as Error).message}`);
    }
  }

  get(scope: "scenario" | "global", scenarioId: string, name: string): Value | undefined {
    return scope === "global" ? this.data.global[name] : this.data.scenarios[scenarioId]?.[name];
  }

  /** @throws "value-too-big" / "variables-full" */
  set(scope: "scenario" | "global", scenarioId: string, name: string, value: Value): void {
    if (sizeOf(value) > LIMITS.valueBytes) throw Object.assign(new Error("value-too-big"), { code: "value-too-big" });

    const bucket = scope === "global" ? this.data.global : (this.data.scenarios[scenarioId] ??= {});
    const before = bucket[name];

    bucket[name] = value;
    if (sizeOf(this.data as unknown as Value) > LIMITS.storeBytes) {
      if (before === undefined) delete bucket[name];
      else bucket[name] = before;
      throw Object.assign(new Error("variables-full"), { code: "variables-full" });
    }
    this.changed();
  }

  delete(scope: "scenario" | "global", scenarioId: string, name: string): void {
    const bucket = scope === "global" ? this.data.global : this.data.scenarios[scenarioId];

    if (bucket && name in bucket) {
      delete bucket[name];
      this.changed();
    }
  }

  /** A deleted scenario takes its variables along. */
  dropScenario(id: string): void {
    if (this.data.scenarios[id]) {
      delete this.data.scenarios[id];
      this.changed();
    }
  }

  all(): VariablesFile {
    return structuredClone(this.data);
  }

  private changed(): void {
    this.emit("change");
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writing = this.writing.then(() => writeAtomic(this.file, JSON.stringify(this.data))).catch((error) => this.warn(`variables write: ${(error as Error).message}`));
    }, 500);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.writing = this.writing.then(() => writeAtomic(this.file, JSON.stringify(this.data)));
    }
    await this.writing.catch(() => undefined);
  }
}

/** The last runs with their step logs. */
export class RunHistory {
  private file: string;
  private records: RunRecord[] = [];
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    root: string,
    private warn: Warn = () => undefined,
  ) {
    this.file = path.join(root, "scenarios", "runs.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readJson(this.file);
      if (Array.isArray(raw)) this.records = (raw as RunRecord[]).filter((r) => r && r.info && typeof r.info.runId === "string").slice(-LIMITS.history);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.warn(`runs: ${(error as Error).message}`);
    }
  }

  add(record: RunRecord): void {
    this.records = [...this.records.filter((r) => r.info.runId !== record.info.runId), { info: record.info, events: record.events.slice(-LIMITS.runEvents) }].slice(-LIMITS.history);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writing = this.writing.then(() => writeAtomic(this.file, JSON.stringify(this.records))).catch((error) => this.warn(`runs write: ${(error as Error).message}`));
    }, 1000);
  }

  /** Newest first. */
  list(scenarioId?: string): RunRecord["info"][] {
    return this.records
      .filter((r) => !scenarioId || r.info.scenarioId === scenarioId)
      .map((r) => r.info)
      .reverse();
  }

  get(runId: string): RunRecord | undefined {
    return this.records.find((r) => r.info.runId === runId);
  }

  /** The last finished run of a scenario: "run from this step" takes its outputs. */
  last(scenarioId: string): RunRecord | undefined {
    for (let i = this.records.length - 1; i >= 0; i--) if (this.records[i].info.scenarioId === scenarioId) return this.records[i];
    return undefined;
  }

  dropScenario(id: string): void {
    this.records = this.records.filter((r) => r.info.scenarioId !== id);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.writing = this.writing.then(() => writeAtomic(this.file, JSON.stringify(this.records)));
    }
    await this.writing.catch(() => undefined);
  }
}
