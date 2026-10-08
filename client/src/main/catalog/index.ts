import { EventEmitter } from "events";
import { watch, type FSWatcher } from "fs";
import { dictionaryAliases } from "./aliases";
import log from "../log";
import type { Helper } from "../system/helper";
import type { SettingsStore } from "../settings/store";
import type { CustomApp } from "../settings/defaults";
import type { AppView } from "../../shared/types";
import { builtinApps } from "./builtin";
import { scanSteam } from "./steam";
import { scanEpic } from "./epic";
import { scanGog } from "./gog";
import { startApp } from "./startmenu";
import { emptyMatch, type CatalogApp, type ResolvedApp } from "./types";

const MAX_APPS = 600;
const RESCAN_DELAY_MS = 3000;

const unique = (list: string[]): string[] => [...new Set(list.map((item) => item.trim()).filter(Boolean))];

export function customApp(app: CustomApp & { target?: string }): CatalogApp {
  if (app.type === "site") {
    return {
      id: app.id,
      name: app.name,
      kind: "site",
      source: "url",
      launch: { type: "url", url: app.url ?? "" },
      match: emptyMatch(),
      defaultEnabled: true,
      suggested: [],
      detail: app.url ?? "",
      removable: true,
    };
  }

  const target = app.target || app.path || "";

  return {
    id: app.id,
    name: app.name,
    kind: "app",
    source: "custom",
    launch: { type: "exe", path: app.path ?? "", args: app.args },
    match: { ...emptyMatch(), exes: /\.exe$/i.test(target) ? [target] : [] },
    defaultEnabled: true,
    suggested: [],
    detail: app.path ?? "",
    removable: true,
  };
}

/**
 * Every app the PC can start by voice: built-in Windows apps, Steam, Epic and GOG
 * games, Start menu picks, custom programs and sites - with the person's choices.
 * Watches the game libraries: an installed or removed game updates the list.
 */
export class Catalog extends EventEmitter {
  private scanned: CatalogApp[] = [];
  private watchers: FSWatcher[] = [];
  private rescanTimer: NodeJS.Timeout | null = null;
  scanning = false;

  constructor(
    private helper: Helper,
    private store: SettingsStore,
  ) {
    super();
  }

  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    this.emit("change");

    try {
      const empty = { apps: [] as CatalogApp[], watch: [] as string[] };
      const [steam, epic, gog] = await Promise.all([
        scanSteam(this.helper).catch((error) => (log.warn(`steam scan: ${error.message}`), empty)),
        scanEpic(this.helper).catch((error) => (log.warn(`epic scan: ${error.message}`), empty)),
        scanGog(this.helper).catch((error) => (log.warn(`gog scan: ${error.message}`), empty)),
      ]);

      this.scanned = [...steam.apps, ...epic.apps, ...gog.apps];
      this.watch([...steam.watch, ...epic.watch]);
      log.info(`catalog: steam ${steam.apps.length}, epic ${epic.apps.length}, gog ${gog.apps.length}`);
    } finally {
      this.scanning = false;
      this.emit("change");
    }
  }

  /** Every app with the person's choices applied. */
  all(): ResolvedApp[] {
    const settings = this.store.get();
    const seen = new Set<string>();
    const base = [
      ...builtinApps(settings.ui.language),
      ...this.scanned,
      ...settings.apps.start.map(startApp),
      ...settings.apps.custom.map((app) => customApp(app)),
    ].filter((app) => (seen.has(app.id) ? false : (seen.add(app.id), true)));

    return base.map((app) => {
      const override = settings.apps.overrides[app.id] ?? {};
      const suggested = unique([...app.suggested, ...dictionaryAliases(app)]);

      return {
        ...app,
        suggested,
        enabled: override.enabled ?? app.defaultEnabled,
        aliases: override.aliases ?? suggested,
        spoken: override.spoken ?? "",
      };
    });
  }

  enabled(): ResolvedApp[] {
    return this.all().filter((app) => app.enabled).slice(0, MAX_APPS);
  }

  /** An enabled app: the server may name only these. */
  get(id: string): ResolvedApp | undefined {
    return this.enabled().find((app) => app.id === id);
  }

  /** `config.data.apps` for the skill */
  configApps() {
    return this.enabled().map((app) => ({ id: app.id, name: app.name, aliases: app.aliases.slice(0, 16), spoken: app.spoken, kind: app.kind, source: app.source }));
  }

  views(running: Set<string>, warnings: Map<string, { alias: string; code: string }[]>): AppView[] {
    return this.all().map((app) => ({
      id: app.id,
      name: app.name,
      kind: app.kind,
      source: app.source,
      enabled: app.enabled,
      aliases: app.aliases,
      suggested: app.suggested,
      spoken: app.spoken,
      running: running.has(app.id),
      removable: app.removable,
      detail: app.detail,
      warnings: warnings.get(app.id) ?? [],
    }));
  }

  private watch(dirs: string[]): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];

    for (const dir of dirs) {
      try {
        const watcher = watch(dir, (event, file) => {
          if (file && !/\.(acf|item)$/i.test(String(file))) return;
          if (this.rescanTimer) clearTimeout(this.rescanTimer);
          this.rescanTimer = setTimeout(() => this.scan().catch((error) => log.warn(`rescan: ${error.message}`)), RESCAN_DELAY_MS);
        });

        watcher.on("error", (error) => log.warn(`watch ${dir}: ${error.message}`));
        this.watchers.push(watcher);
      } catch (error) {
        log.warn(`watch ${dir}: ${(error as Error).message}`);
      }
    }
  }

  dispose(): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }
}
