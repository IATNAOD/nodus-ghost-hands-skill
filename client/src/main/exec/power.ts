import { EventEmitter } from "events";
import { execFile } from "child_process";
import { Notification } from "electron";
import log from "../log";
import { t } from "../i18n";
import type { Helper } from "../system/helper";
import type { SettingsStore } from "../settings/store";
import { ok, fail, type Result } from "./apps";

export type PowerAction = "shutdown" | "restart" | "sleep" | "lock" | "display_off";
type CountdownAction = "shutdown" | "restart" | "sleep";

const COUNTED = new Set<PowerAction>(["shutdown", "restart", "sleep"]);

const shutdownExe = (args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile("shutdown.exe", args, { windowsHide: true }, (error) => (error ? reject(error) : resolve()));
  });

export interface OverlayHost {
  show(action: CountdownAction, endsAt: number): void;
  hide(): void;
}

/**
 * Power commands. Shutdown and restart are never forced (no /f, so no lost work):
 * a countdown window with "Cancel" first, then shutdown /s|/r /t 0. Delays are
 * our own timer - `shutdown /t N` would imply /f.
 */
export class PowerControl extends EventEmitter {
  scheduled: { action: PowerAction; at: number; timer: NodeJS.Timeout } | null = null;
  countdown: { action: CountdownAction; endsAt: number; timer: NodeJS.Timeout } | null = null;

  constructor(
    private helper: Helper,
    private store: SettingsStore,
    private overlay: OverlayHost,
  ) {
    super();
  }

  async run(action: PowerAction, delaySec: number): Promise<Result> {
    if (delaySec > 0) {
      this.clearScheduled();

      const at = Date.now() + delaySec * 1000;
      const timer = setTimeout(() => {
        this.scheduled = null;
        this.emit("change");
        this.now(action).catch((error) => log.error(`power ${action}: ${(error as Error).message}`));
      }, delaySec * 1000);

      this.scheduled = { action, at, timer };
      this.emit("change");
      this.notifyScheduled(action, at);
      return ok({ at });
    }

    try {
      const at = await this.now(action);

      return ok({ at });
    } catch (error) {
      log.error(`power ${action}: ${(error as Error).message}`);
      return fail("internal");
    }
  }

  /** Right away; for shutdown, restart and sleep - after the countdown. Returns when it will happen. */
  private async now(action: PowerAction): Promise<number> {
    const seconds = this.store.get().prefs.countdownSec;

    if (COUNTED.has(action) && seconds > 0) {
      this.clearCountdown();

      const endsAt = Date.now() + seconds * 1000;
      const timer = setTimeout(() => {
        this.countdown = null;
        this.overlay.hide();
        this.emit("change");
        this.execute(action).catch((error) => log.error(`power ${action}: ${(error as Error).message}`));
      }, seconds * 1000);

      this.countdown = { action: action as CountdownAction, endsAt, timer };
      this.overlay.show(action as CountdownAction, endsAt);
      this.emit("change");
      return endsAt;
    }

    await this.execute(action);
    return Date.now();
  }

  private async execute(action: PowerAction): Promise<void> {
    log.info(`power: ${action}`);

    switch (action) {
      case "shutdown":
        await shutdownExe(["/s", "/t", "0"]);
        break;
      case "restart":
        await shutdownExe(["/r", "/t", "0"]);
        break;
      case "sleep":
        await this.helper.call("power.sleep");
        break;
      case "lock":
        await this.helper.call("power.lock");
        break;
      case "display_off":
        await this.helper.call("display.off");
        break;
      default:
        break;
    }
  }

  /** Cancel what we scheduled and any shutdown Windows has pending. */
  async cancel(): Promise<Result> {
    const had = Boolean(this.scheduled || this.countdown);

    this.clearScheduled();
    this.clearCountdown();
    this.emit("change");

    let systemPending = false;

    try {
      await shutdownExe(["/a"]);
      systemPending = true;
    } catch {
      // nothing was scheduled by Windows
    }

    return ok({ cancelled: had || systemPending });
  }

  /** When the PC will go down, for the skill (state.shutdownAt). */
  shutdownAt(): number | null {
    return this.countdown?.endsAt ?? this.scheduled?.at ?? null;
  }

  private clearScheduled(): void {
    if (this.scheduled) clearTimeout(this.scheduled.timer);
    this.scheduled = null;
  }

  private clearCountdown(): void {
    if (this.countdown) {
      clearTimeout(this.countdown.timer);
      this.overlay.hide();
    }
    this.countdown = null;
  }

  private notifyScheduled(action: PowerAction, at: number): void {
    if (!Notification.isSupported() || !COUNTED.has(action)) return;

    const time = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const title = t(action === "restart" ? "scheduledRestart" : action === "sleep" ? "scheduledSleep" : "scheduledShutdown", { t: time });

    new Notification({ title, body: t("scheduledBody") }).show();
  }

  dispose(): void {
    this.clearScheduled();
    this.clearCountdown();
  }
}
