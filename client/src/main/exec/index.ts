import { shell, Notification } from "electron";
import { ACTIONS, isFeatureEnabled, MEDIA_KEYS, LIMITS } from "@skill/protocol.js";
import log from "../log";
import { HelperError } from "../system/helper";
import { launchApp, closeApp, ok, fail, type AppDeps, type Result } from "./apps";
import type { PowerControl, PowerAction } from "./power";

const SEARCH: Record<string, string> = {
  google: "https://www.google.com/search?q={q}",
  yandex: "https://yandex.ru/search/?text={q}",
  bing: "https://www.bing.com/search?q={q}",
  duckduckgo: "https://duckduckgo.com/?q={q}",
  youtube: "https://www.youtube.com/results?search_query={q}",
};

const POWER: Record<string, PowerAction> = {
  "power.shutdown": "shutdown",
  "power.restart": "restart",
  "power.sleep": "sleep",
  "power.lock": "lock",
  "display.off": "display_off",
};

export interface Command {
  id: string;
  action: string;
  args?: Record<string, unknown>;
  /** how long the skill waits for the result */
  timeoutMs?: number;
}

const num = (value: unknown, min: number, max: number): number | null => {
  const number = Number(value);

  return Number.isFinite(number) && value !== null && value !== "" ? Math.min(max, Math.max(min, Math.round(number))) : null;
};

/**
 * Runs commands from the skill. The server names only what this PC told it:
 * every command is checked again - the feature is on, control is not paused,
 * the app is enabled here. No paths, arguments or URLs come from the network.
 */
export class Dispatcher {
  constructor(
    private deps: AppDeps,
    private power: PowerControl,
  ) {}

  async handle(command: Command): Promise<Result> {
    const args = command.args && typeof command.args === "object" ? command.args : {};
    const settings = this.deps.store.get();

    if (!(command.action in ACTIONS)) return fail("unknown-action");
    if (!isFeatureEnabled(settings.features, command.action)) return fail("feature-disabled");
    if (settings.prefs.paused) return fail("paused");

    try {
      return await this.run(command.action, args, Number(command.timeoutMs) || 8000);
    } catch (error) {
      log.error(`${command.action}: ${(error as Error).message}`);
      return fail(error instanceof HelperError ? (error.code === "helper-timeout" ? "helper-unavailable" : error.code) : "internal");
    }
  }

  private async run(action: string, args: Record<string, unknown>, timeoutMs: number): Promise<Result> {
    const { helper, store } = this.deps;
    const delaySec = num(args.delaySec, 0, 86400) ?? 0;

    switch (action) {
      case "app.launch": {
        const app = typeof args.appId === "string" ? this.deps.catalog.get(args.appId) : undefined;

        return app ? launchApp(this.deps, app) : fail("app-not-found");
      }
      case "app.close":
        // the answer must reach the skill in time: finding the processes takes a moment too
        return closeApp(this.deps, args, Math.min(5000, Math.max(1500, timeoutMs - 2500)));
      case "volume.get":
        return ok(await helper.call("volume.get"));
      case "volume.set": {
        const level = num(args.level, 0, 100);

        return level === null ? fail("invalid-args") : ok(await helper.call("volume.set", { level }));
      }
      case "volume.change": {
        const delta = num(args.delta, -100, 100);

        return delta === null ? fail("invalid-args") : ok(await helper.call("volume.change", { delta }));
      }
      case "volume.mute":
        return typeof args.muted === "boolean" ? ok(await helper.call("volume.mute", { muted: args.muted })) : fail("invalid-args");
      case "media.key":
        return MEDIA_KEYS.includes(args.key as string) ? ok(await helper.call("media.key", { key: args.key })) : fail("invalid-args");
      case "power.cancel":
        return this.power.cancel();
      case "power.shutdown":
      case "power.restart":
      case "power.sleep":
      case "power.lock":
      case "display.off":
        return this.power.run(POWER[action], delaySec);
      case "web.search": {
        const query = typeof args.query === "string" ? args.query.trim().slice(0, LIMITS.searchQuery) : "";
        const engine = typeof args.engine === "string" && SEARCH[args.engine] ? args.engine : store.get().prefs.searchEngine;

        if (!query) return fail("invalid-args");
        await shell.openExternal(SEARCH[engine].replace("{q}", encodeURIComponent(query)));
        return ok();
      }
      case "toast.show": {
        const text = typeof args.text === "string" ? args.text.trim().slice(0, LIMITS.toastText) : "";
        const title = typeof args.title === "string" && args.title.trim() ? args.title.trim().slice(0, LIMITS.toastTitle) : "NODUS";

        if (!text) return fail("invalid-args");
        if (Notification.isSupported()) new Notification({ title, body: text }).show();
        return ok();
      }
      default:
        return fail("unknown-action");
    }
  }
}
