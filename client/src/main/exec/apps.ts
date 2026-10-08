import { shell } from "electron";
import log from "../log";
import { HelperError, type Helper } from "../system/helper";
import type { RunningMonitor, RunningEntry } from "../system/running";
import type { Catalog } from "../catalog";
import { belongsTo } from "../catalog/types";
import type { ResolvedApp } from "../catalog/types";
import type { SettingsStore } from "../settings/store";

export type Result = { ok: true; data?: Record<string, unknown> } | { ok: false; code: string; data?: Record<string, unknown> };

export const ok = (data: Record<string, unknown> = {}): Result => ({ ok: true, data });
export const fail = (code: string, data?: Record<string, unknown>): Result => ({ ok: false, code, data });

export interface AppDeps {
  helper: Helper;
  catalog: Catalog;
  running: RunningMonitor;
  store: SettingsStore;
}

const SEARCH_HOME: Record<string, string> = {
  google: "https://www.google.com/",
  yandex: "https://ya.ru/",
  bing: "https://www.bing.com/",
  duckduckgo: "https://duckduckgo.com/",
};

/** exe of the default browser: UserChoice ProgId → its open command */
export async function defaultBrowserExe(helper: Helper): Promise<string | null> {
  try {
    const { value: progId } = await helper.call<{ value: unknown }>("registry.read", {
      hive: "HKCU",
      path: "Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice",
      name: "ProgId",
    });

    if (typeof progId !== "string" || !progId) return null;

    const { value: command } = await helper.call<{ value: unknown }>("registry.read", { hive: "HKCR", path: `${progId}\\shell\\open\\command`, name: "" });
    const found = typeof command === "string" ? command.match(/^"([^"]+\.exe)"|^(\S+\.exe)/i) : null;

    return found ? found[1] ?? found[2] : null;
  } catch {
    return null;
  }
}

const helperCode = (error: unknown): string => (error instanceof HelperError ? error.code : "internal");

/** Start an app; one that already runs is brought to the front. */
export async function launchApp(deps: AppDeps, app: ResolvedApp): Promise<Result> {
  const { helper } = deps;
  const open = deps.running.entries.find((entry) => entry.appId === app.id);

  await helper.call("foreground.allow").catch(() => undefined);

  if (open && app.kind !== "site") {
    const focused = await helper.call<{ focused: boolean }>("window.focus", { pid: open.pids[0] }).catch(() => ({ focused: false }));

    return ok({ already: true, focused: focused.focused });
  }

  const launch = app.launch;

  try {
    switch (launch.type) {
      case "url":
        await shell.openExternal(launch.url);
        break;
      case "exe":
        await helper.call("process.start", { path: launch.path, args: launch.args ?? "", cwd: launch.cwd ?? "" }, 15000);
        break;
      case "aumid":
        await helper.call("process.start", { path: "explorer.exe", args: `shell:AppsFolder\\${launch.appId}` }, 15000);
        break;
      case "browser": {
        const exe = await defaultBrowserExe(helper);

        if (exe) await helper.call("process.start", { path: exe }, 15000);
        else await shell.openExternal(SEARCH_HOME[deps.store.get().prefs.searchEngine] ?? SEARCH_HOME.google);
        break;
      }
      default:
        return fail("launch-failed");
    }
  } catch (error) {
    const code = helperCode(error);

    log.warn(`launch ${app.id}: ${(error as Error).message}`);
    if (launch.type === "url" && /^(steam|com\.epicgames\.launcher):/i.test(launch.url)) return fail("launcher-missing");
    if (code === "not-found") return fail("app-not-found");
    if (code === "cancelled") return fail("cancelled");
    if (code === "helper-unavailable") return fail("helper-unavailable");
    return fail("launch-failed");
  }

  return ok({ already: false });
}

interface Proc {
  pid: number;
  exe: string | null;
}

/** Processes of an app: by folder and exe through the helper, plus Store apps by their windows. */
async function processesOf(deps: AppDeps, app: ResolvedApp): Promise<number[]> {
  const pids = new Set<number>();

  if (app.match.dirs.length || app.match.exes.length) {
    const list = await deps.helper.call<Proc[]>("process.list", { underDirs: app.match.dirs, exes: app.match.exes });

    for (const proc of list) pids.add(proc.pid);
  }
  if (app.match.names.length) {
    const list = await deps.helper.call<Proc[]>("process.list", { underDirs: [], exes: [] });

    for (const proc of list) if (belongsTo({ dirs: [], exes: [], names: app.match.names, aumids: [] }, proc)) pids.add(proc.pid);
  }
  for (const entry of deps.running.entries) if (entry.appId === app.id) for (const pid of entry.pids) pids.add(pid);

  return [...pids];
}

/** Which running thing a close command means. */
function pickTarget(deps: AppDeps, args: Record<string, unknown>): { entry?: RunningEntry; app?: ResolvedApp } | Result {
  if (typeof args.appId === "string") {
    const app = deps.catalog.get(args.appId);

    return app ? { app } : fail("app-not-found");
  }
  if (typeof args.key === "string") {
    const entry = deps.running.entries.find((item) => item.key === args.key);

    return entry ? { entry, app: entry.appId ? deps.catalog.get(entry.appId) : undefined } : fail("not-running");
  }
  if (args.target === "game") {
    const games = deps.running.entries.filter((entry) => entry.game);
    const front = games.find((entry) => entry.fg) ?? (games.length === 1 ? games[0] : undefined);

    if (front) return { entry: front, app: front.appId ? deps.catalog.get(front.appId) : undefined };
    if (games.length > 1) return fail("ambiguous", { options: games.slice(0, 3).map((game) => ({ key: game.key, name: game.name })) });
    return fail("not-running");
  }
  if (args.target === "foreground") {
    const front = deps.running.entries.find((entry) => entry.fg);

    return front ? { entry: front, app: front.appId ? deps.catalog.get(front.appId) : undefined } : fail("not-running");
  }

  return fail("invalid-args");
}

interface CloseResult {
  closed: number[];
  hidden: number[];
  pending: number[];
  windowless: number[];
}

/**
 * Close an app like its close button: WM_CLOSE to its windows. It is closed when its windows
 * are gone - a game may save for a while after that, an app may stay in the tray. Windows still
 * open after `softMs` (a "save changes?" question) are `pending`: the skill offers to force it.
 * A forced close kills the process tree.
 * @param softMs how long to wait for the windows, within the skill's reply time
 */
export async function closeApp(deps: AppDeps, args: Record<string, unknown>, softMs = 5000): Promise<Result> {
  const target = pickTarget(deps, args);

  if ("ok" in target) return target;

  const name = target.app?.name ?? target.entry?.name ?? "";
  let pids: number[];

  try {
    pids = target.app ? await processesOf(deps, target.app) : [...(target.entry?.pids ?? [])];
    if (!target.app && target.entry?.exe) {
      const list = await deps.helper.call<Proc[]>("process.list", { underDirs: [], exes: [target.entry.exe] });

      pids = [...new Set([...pids, ...list.map((proc) => proc.pid)])];
    }
  } catch (error) {
    return fail(helperCode(error));
  }

  if (!pids.length) return fail("not-running", { name });

  try {
    if (args.force === true) {
      const killed = await deps.helper.call<{ killed: number[] }>("process.kill", { pids, tree: true }, 10000);

      return ok({ name, closed: killed.killed, pending: [] });
    }

    const startedAt = Date.now();
    const result = await deps.helper.call<CloseResult>("process.close", { pids, softMs }, softMs + 4000);

    log.info(`close ${name}: closed ${result.closed.length}, hidden ${result.hidden.length}, pending ${result.pending.length}, windowless ${result.windowless.length}`);

    // nothing had a window: it works in the background or sits in the tray
    if (result.windowless.length === pids.length) return ok({ name, closed: [], pending: result.windowless, background: true });
    if (!result.pending.length) return ok({ name, closed: [...result.closed, ...result.hidden], pending: [] });

    const forceAfterMs = deps.store.get().prefs.forceCloseSec * 1000;

    if (forceAfterMs > 0) {
      const timer = setTimeout(() => {
        deps.helper.call("process.kill", { pids: result.pending, tree: true }).catch((error) => log.warn(`force close: ${(error as Error).message}`));
      }, Math.max(0, forceAfterMs - (Date.now() - startedAt)));

      timer.unref();
      return ok({ name, closed: [...result.closed, ...result.hidden], pending: [] });
    }

    return ok({ name, closed: [...result.closed, ...result.hidden], pending: result.pending });
  } catch (error) {
    return fail(helperCode(error));
  }
}
