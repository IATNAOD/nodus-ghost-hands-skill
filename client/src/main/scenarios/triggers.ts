// What starts scenarios on the PC by itself: global hotkeys, the schedule, and the panic
// hotkey that stops every run.
import { promises as fs } from "fs";
import path from "path";
import { globalShortcut, powerMonitor } from "electron";
import log from "../log";
import type { SettingsStore } from "../settings/store";
import { due } from "../../shared/scenarios/schedule";
import type { ScenarioService } from "./service";

const MINUTE = 60_000;

export class ScenarioTriggers {
  /** accelerator → scenario id of the hotkeys registered now */
  private hotkeys = new Map<string, string>();
  private suspended = false;
  private timer: NodeJS.Timeout | null = null;
  private file: string;
  private memory: { lastTick: number; fired: Record<string, number> } = { lastTick: Date.now(), fired: {} };
  private onResume = () => this.tick();
  private refreshSoon: NodeJS.Timeout | null = null;

  constructor(
    private service: ScenarioService,
    private settings: SettingsStore,
  ) {
    this.file = path.join(service.store.dir, "schedule.json");
  }

  init(): void {
    this.load()
      .catch(() => undefined)
      .finally(() => {
        this.register();
        this.schedule();
        this.tick();
      });

    const refresh = () => {
      if (this.refreshSoon) clearTimeout(this.refreshSoon);
      this.refreshSoon = setTimeout(() => this.register(), 200);
    };
    this.service.on("saved", refresh);
    this.service.on("change", refresh);
    this.settings.on("change", refresh);
    powerMonitor.on("resume", this.onResume);
    powerMonitor.on("unlock-screen", this.onResume);
  }

  private panic(): string {
    return this.settings.get().ui.scenarioPanic || "Control+Alt+Escape";
  }

  /* ── hotkeys ── */

  private register(): void {
    globalShortcut.unregisterAll();
    this.hotkeys.clear();
    if (this.suspended) return;

    const panic = this.panic();
    try {
      if (!globalShortcut.register(panic, () => this.service.stop({ all: true }))) log.warn(`scenarios: the panic hotkey ${panic} is taken`);
    } catch (error) {
      log.warn(`scenarios: panic hotkey ${panic}: ${(error as Error).message}`);
    }

    for (const scenario of this.service.store.list()) {
      if (!scenario.enabled) continue;
      for (const trigger of scenario.triggers) {
        if (trigger.type !== "hotkey" || !trigger.enabled || this.hotkeys.has(trigger.accelerator) || trigger.accelerator === panic) continue;
        try {
          const id = scenario.id;
          if (globalShortcut.register(trigger.accelerator, () => this.fire(id, "hotkey"))) this.hotkeys.set(trigger.accelerator, id);
          else log.warn(`scenarios: hotkey ${trigger.accelerator} of "${scenario.name}" is taken by another program`);
        } catch (error) {
          log.warn(`scenarios: hotkey ${trigger.accelerator}: ${(error as Error).message}`);
        }
      }
    }
  }

  /** Can a scenario use this hotkey? */
  check(accelerator: string, scenarioId: string): { ok: boolean; reason?: "invalid" | "taken" | "duplicate" | "panic" } {
    if (!accelerator) return { ok: false, reason: "invalid" };
    if (accelerator === this.panic()) return { ok: false, reason: "panic" };

    const owner = this.hotkeys.get(accelerator);
    if (owner) return owner === scenarioId ? { ok: true } : { ok: false, reason: "duplicate" };

    const other = this.service.store.list().find((s) => s.id !== scenarioId && s.triggers.some((t) => t.type === "hotkey" && t.accelerator === accelerator));
    if (other) return { ok: false, reason: "duplicate" };

    try {
      if (!globalShortcut.register(accelerator, () => undefined)) return { ok: false, reason: "taken" };
      globalShortcut.unregister(accelerator);
      return { ok: true };
    } catch {
      return { ok: false, reason: "invalid" };
    }
  }

  /** While the key recorder listens, global hotkeys are off: a recorded combination must reach it. */
  suspend(on: boolean): void {
    this.suspended = on;
    this.register();
  }

  private fire(scenarioId: string, trigger: "hotkey" | "schedule"): void {
    const result = this.service.start(scenarioId, { trigger });
    if (!result.ok) log.warn(`scenarios: ${trigger} start failed: ${result.code}`);
  }

  /* ── schedule ── */

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    // a second after the next whole minute
    const wait = MINUTE - (Date.now() % MINUTE) + 1000;
    this.timer = setTimeout(() => {
      this.tick();
      this.schedule();
    }, wait);
    this.timer.unref();
  }

  private tick(): void {
    const now = Date.now();
    let changed = false;

    for (const scenario of this.service.store.list()) {
      if (!scenario.enabled) continue;
      for (const trigger of scenario.triggers) {
        if (trigger.type !== "schedule" || !trigger.enabled) continue;

        const key = `${scenario.id}:${trigger.id}`;
        const moment = due(trigger, this.memory.lastTick, now, this.memory.fired[key] ?? null);
        if (moment === null) continue;

        this.memory.fired[key] = moment;
        changed = true;
        this.fire(scenario.id, "schedule");
      }
    }

    this.memory.lastTick = now;
    if (changed || now % (10 * MINUTE) < MINUTE) this.save().catch(() => undefined);
  }

  private async load(): Promise<void> {
    const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as Partial<ScenarioTriggers["memory"]>;
    if (Number.isFinite(raw.lastTick)) this.memory.lastTick = Math.min(Date.now(), raw.lastTick!);
    if (raw.fired && typeof raw.fired === "object") this.memory.fired = Object.fromEntries(Object.entries(raw.fired).filter(([, v]) => Number.isFinite(v)));
  }

  private async save(): Promise<void> {
    const temp = `${this.file}.tmp`;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(temp, JSON.stringify(this.memory));
    await fs.rename(temp, this.file);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.refreshSoon) clearTimeout(this.refreshSoon);
    powerMonitor.off("resume", this.onResume);
    powerMonitor.off("unlock-screen", this.onResume);
    globalShortcut.unregisterAll();
    this.save().catch(() => undefined);
  }
}
