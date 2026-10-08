import { EventEmitter } from "events";
import log from "../log";
import type { Helper } from "./helper";
import type { Catalog } from "../catalog";
import { belongsTo } from "../catalog/types";

export interface WindowProcess {
  pid: number;
  exe: string | null;
  name: string;
  product: string | null;
  description: string | null;
  aumid: string | null;
  foreground: boolean;
  fullscreen: boolean;
}

export interface RunningEntry {
  /** stable key for the skill: the exe path, or the AppUserModelID of a Store app */
  key: string;
  name: string;
  appId: string | null;
  game: boolean;
  fg: boolean;
  fullscreen: boolean;
  pids: number[];
  exe: string | null;
}

/**
 * Apps with windows, from GhostHelper's window watcher: which enabled apps run,
 * which is in front. No window titles: only exe paths and names.
 */
export class RunningMonitor extends EventEmitter {
  private windows: WindowProcess[] = [];
  entries: RunningEntry[] = [];

  constructor(
    private helper: Helper,
    private catalog: Catalog,
  ) {
    super();
    helper.on("windows", (list: unknown) => this.update(list));
    helper.on("restart", () => this.watch());
    catalog.on("change", () => this.recompute());
  }

  watch(): void {
    this.helper.call("windows.watch", { intervalMs: 2000 }).catch((error) => log.warn(`windows.watch: ${(error as Error).message}`));
  }

  private update(list: unknown): void {
    this.windows = Array.isArray(list) ? (list as WindowProcess[]) : [];
    this.recompute();
  }

  recompute(): void {
    const apps = this.catalog.enabled();
    const entries = new Map<string, RunningEntry>();

    for (const window of this.windows) {
      // our own windows are not "running apps" to close
      if (window.pid === process.pid) continue;

      const app = apps.find((item) => belongsTo(item.match, window));
      const key = window.exe ? `exe:${window.exe.toLowerCase()}` : window.aumid ? `aumid:${window.aumid}` : `pid:${window.pid}`;
      const known = entries.get(key);

      entries.set(key, {
        key,
        name: app?.name ?? (window.name || window.product || window.description || "?"),
        appId: app?.id ?? known?.appId ?? null,
        game: app?.kind === "game",
        fg: window.foreground || Boolean(known?.fg),
        fullscreen: window.fullscreen || Boolean(known?.fullscreen),
        pids: [...new Set([...(known?.pids ?? []), window.pid])],
        exe: window.exe,
      });
    }

    const next = [...entries.values()];
    const changed = JSON.stringify(next.map(({ key, appId, fg }) => [key, appId, fg])) !== JSON.stringify(this.entries.map(({ key, appId, fg }) => [key, appId, fg]));

    this.entries = next;
    if (changed) this.emit("change");
  }

  /** Window pids of all running processes, for soft closing. */
  windowPids(): Set<number> {
    return new Set(this.windows.map((window) => window.pid));
  }

  runningIds(): Set<string> {
    return new Set(this.entries.map((entry) => entry.appId).filter((id): id is string => Boolean(id)));
  }

  /** `state.data.running` for the skill; without sharing only enabled apps are told. */
  forSkill(share: boolean) {
    return this.entries
      .filter((entry) => share || entry.appId)
      .slice(0, 100)
      .map((entry) => ({ key: entry.key, name: entry.name, appId: entry.appId, game: entry.game, fg: entry.fg }));
  }
}
