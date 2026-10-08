import { EventEmitter } from "events";
import { app, Notification } from "electron";
import { autoUpdater } from "electron-updater";
import log from "./log";
import { t } from "./i18n";
import type { UiPrefs, UpdateState } from "../shared/types";

const FIRST_CHECK_MS = 60_000;
const CHECK_EVERY_MS = 4 * 3600_000;
const IDLE_MS = 10 * 60_000;

/**
 * Updates from GitHub Releases (IATNAOD/nodus-ghost-hands-skill, see electron-builder.yml):
 * the release marked Latest, the one `npm run release` makes for the skill and the client.
 * Downloads in the background; with automatic updates on, installs on quit or silently
 * when nothing happened for 10 minutes.
 */
export class Updater extends EventEmitter {
  state: UpdateState = { status: app.isPackaged ? "idle" : "disabled", version: null, percent: null, error: null };
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private getUi: () => UiPrefs,
    private isIdle: () => boolean,
  ) {
    super();
  }

  start(): void {
    if (!app.isPackaged) return;

    autoUpdater.logger = log;
    autoUpdater.autoDownload = true;
    autoUpdater.allowPrerelease = false;
    this.applyPrefs();

    autoUpdater.on("checking-for-update", () => this.set({ status: "checking", error: null }));
    autoUpdater.on("update-available", (info) => this.set({ status: "available", version: info.version }));
    autoUpdater.on("update-not-available", () => this.set({ status: "none", percent: null }));
    autoUpdater.on("download-progress", (progress) => this.set({ status: "downloading", percent: Math.round(progress.percent) }));
    autoUpdater.on("update-downloaded", (info) => {
      this.set({ status: "ready", version: info.version, percent: 100 });
      if (Notification.isSupported()) new Notification({ title: t("updateReady", { v: info.version }), body: t("updateReadyBody") }).show();
    });
    autoUpdater.on("error", (error) => this.set({ status: "error", error: error.message }));

    this.timers.push(setTimeout(() => this.check(), FIRST_CHECK_MS));
    this.timers.push(setInterval(() => this.check(), CHECK_EVERY_MS));
    this.timers.push(
      setInterval(() => {
        if (this.state.status === "ready" && this.getUi().autoUpdate && this.isIdle()) this.install();
      }, 60_000),
    );
  }

  async check(): Promise<void> {
    if (!app.isPackaged) return;

    this.applyPrefs();
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.set({ status: "error", error: (error as Error).message });
    }
  }

  /** "Install updates automatically" also decides installing on quit */
  applyPrefs(): void {
    if (app.isPackaged) autoUpdater.autoInstallOnAppQuit = this.getUi().autoUpdate;
  }

  install(): void {
    if (this.state.status !== "ready") return;
    log.info(`installing ${this.state.version}`);
    // a client under parental control may quit only for this
    this.emit("install");
    // silent install, then start the new version
    autoUpdater.quitAndInstall(true, true);
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.emit("change");
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
  }
}

export { IDLE_MS };
