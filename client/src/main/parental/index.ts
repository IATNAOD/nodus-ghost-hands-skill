import { EventEmitter } from "events";
import path from "path";
import { powerMonitor } from "electron";
import { sanitizeParental, sanitizeParentalUsage } from "@skill/protocol.js";
import log from "../log";
import type { Helper } from "../system/helper";
import type { RunningEntry, RunningMonitor } from "../system/running";
import { ParentalClock, type LimitKind, type ParentalRules, type ParentalStatus } from "./accounting";
import { isPinHash, noAttempts, pinFailed, pinWait, verifyPin } from "./pin";
import { emptyParental, type ParentalData, type ParentalStore } from "./store";
import type { ParentalWindows } from "./windows";

const TICK_MS = 1000;
const SAVE_EVERY_MS = 30_000;
const REPORT_EVERY_MS = 60_000;
/** A game gets this long to close by itself (save) before it is ended. */
const CLOSE_GRACE_MS = 30_000;
/** Windows of Windows itself: the lock never closes them. */
const SYSTEM_EXES = new Set([
  "explorer.exe", "lockapp.exe", "logonui.exe", "shellexperiencehost.exe", "startmenuexperiencehost.exe",
  "searchapp.exe", "searchhost.exe", "textinputhost.exe", "systemsettings.exe", "applicationframehost.exe",
]);

export type NoticeKind = "games-near" | "pc-near" | "games-over";

/** What the parental pages (notice, lock) show. */
export interface ParentalPageState {
  notice: NoticeKind | null;
  status: ParentalStatus | null;
  pinSet: boolean;
  waitSec: number;
}

/** The short form for the main window and the tray. */
export interface ParentalView {
  enabled: boolean;
  granted: boolean;
  grantUntil: number | null;
  pcLeftSec: number | null;
  gamesLeftSec: number | null;
  locked: "pc" | "games" | null;
}

export interface ParentalDeps {
  store: ParentalStore;
  running: RunningMonitor;
  helper: Helper;
  windows: ParentalWindows;
  /** to the skill; false when offline (the alert waits) */
  sendAlert: (kind: string, extra?: Record<string, unknown>) => boolean;
  /** usage changed: send `state` to the skill */
  report: () => void;
}

/**
 * Parental control on this PC: counts the time (accounting.ts), warns 10 minutes before a
 * limit, closes games when their time is over and covers the screen when the PC's time is
 * over. Rules and the PIN come from the skill and are kept encrypted, so all of it works
 * without NODUS. Emits "change" when the rules or the blocking change.
 */
export class ParentalController extends EventEmitter {
  data: ParentalData = emptyParental();
  status: ParentalStatus | null = null;
  notice: NoticeKind | null = null;
  private clock: ParentalClock | null = null;
  private unlocked = true;
  private timer: NodeJS.Timeout | null = null;
  private lastSave = 0;
  private lastReport = 0;
  /** the limit a warning was shown for: an extension raises it and arms the warning again */
  private warned: Record<LimitKind, number | null> = { pc: null, games: null };
  private gamesOverShown = false;
  /** running entry key → when its closing started */
  private closing = new Map<string, number>();
  /** windows that were open when the PC was locked: covered, not closed (unsaved work) */
  private lockBaseline = new Set<string>();
  private alerts: { kind: string; extra?: Record<string, unknown> }[] = [];

  constructor(private deps: ParentalDeps) {
    super();
  }

  get enabled(): boolean {
    return this.data.enabled;
  }

  async init(): Promise<void> {
    this.data = await this.deps.store.load();
    this.rebuild();

    powerMonitor.on("lock-screen", () => (this.unlocked = false));
    powerMonitor.on("unlock-screen", () => (this.unlocked = true));
    powerMonitor.on("suspend", () => (this.unlocked = false));
    powerMonitor.on("resume", () => (this.unlocked = true));
    this.deps.running.on("change", () => this.enforce());
    this.timer = setInterval(() => this.tick(), TICK_MS);
    if (this.enabled) log.info("parental control is on");
  }

  private rebuild(): void {
    this.clock = this.data.enabled && this.data.rules ? new ParentalClock(this.data.rules, this.data.usage, this.data.grantUntil, Date.now()) : null;
    this.status = this.clock?.status(Date.now()) ?? null;
  }

  /** The `parental` message from the skill. */
  async apply(message: Record<string, unknown>): Promise<void> {
    const wasEnabled = this.data.enabled;

    if (message.enabled !== true) {
      if (!wasEnabled) return;
      this.data = { ...emptyParental(), ownerId: this.data.ownerId };
      this.clock = null;
      this.status = null;
      this.release();
      log.info("parental control off");
    } else {
      const rules = sanitizeParental(message.rules) as ParentalRules;
      const grantUntil = Number(message.grantUntil) || null;
      const resetAt = Number(message.resetAt) || null;

      this.data = { ...this.data, enabled: true, rev: Number(message.rev) || 0, rules, pin: isPinHash(message.pin) ? message.pin : null, grantUntil };
      if (!this.clock) this.clock = new ParentalClock(rules, this.data.usage, grantUntil, Date.now());
      this.clock.rules = rules;
      this.clock.grantUntil = grantUntil;
      if (resetAt && resetAt > (this.data.resetAt ?? 0)) {
        this.clock.reset(Date.now());
        this.data.resetAt = resetAt;
        this.warned = { pc: null, games: null };
      } else {
        this.clock.merge(sanitizeParentalUsage(message.usage));
      }
      if (!wasEnabled) log.info("parental control on");
    }

    await this.persist();
    this.tick();
    this.emit("change");
  }

  /** The PC was unpaired in the panel: its owner controls it no more. */
  async drop(): Promise<void> {
    await this.apply({ enabled: false });
  }

  isGame(entry: Pick<RunningEntry, "appId" | "game">): boolean {
    const games = this.data.rules?.games;

    if (entry.appId && games?.add.includes(entry.appId)) return true;
    if (entry.appId && games?.remove.includes(entry.appId)) return false;
    return entry.game;
  }

  private tick(): void {
    if (!this.clock) return;

    const now = Date.now();
    const entries = this.deps.running.entries;
    let idleSec = 0;

    try {
      idleSec = powerMonitor.getSystemIdleTime();
    } catch {
      // unknown: counted as present
    }

    const before = this.status;
    const status = this.clock.tick({
      now,
      mono: performance.now(),
      unlocked: this.unlocked,
      idleSec,
      fullscreen: entries.some((entry) => entry.fg && entry.fullscreen),
      gameRunning: entries.some((entry) => this.isGame(entry)),
    });

    this.status = status;
    this.data.usage = this.clock.usage;
    this.react(status);

    const lockChanged = before?.pc.reached !== status.pc.reached || before?.games.reached !== status.games.reached || before?.granted !== status.granted;

    if (now - this.lastSave > SAVE_EVERY_MS || lockChanged) {
      this.lastSave = now;
      void this.persist();
    }
    if (now - this.lastReport > REPORT_EVERY_MS || lockChanged) {
      this.lastReport = now;
      this.deps.report();
    }
    if (lockChanged) this.emit("change");
  }

  private react(status: ParentalStatus): void {
    for (const kind of ["games", "pc"] as LimitKind[]) {
      const current = status[kind];

      if (current.near && this.warned[kind] !== current.limitSec) {
        this.warned[kind] = current.limitSec;
        this.show(kind === "games" ? "games-near" : "pc-near");
      }
    }

    if (status.games.reached && !this.gamesOverShown && this.deps.running.entries.some((entry) => this.isGame(entry))) {
      this.gamesOverShown = true;
      this.show("games-over");
    }
    if (!status.games.reached) this.gamesOverShown = false;

    // a notice that is no longer true goes away; the lock covers a PC warning
    const stale =
      (this.notice === "games-near" && !status.games.near) ||
      (this.notice === "pc-near" && (!status.pc.near || status.pc.reached)) ||
      (this.notice === "games-over" && !status.games.reached);

    if (stale) this.hide();

    if (status.pc.reached && !this.deps.windows.locked) {
      this.lockBaseline = new Set(this.deps.running.entries.map((entry) => entry.key));
      this.deps.windows.lock();
      this.deps.helper.call("media.control", { op: "pause" }).catch(() => undefined);
      log.info("parental: the PC's time is over, locked");
    }
    if (!status.pc.reached && this.deps.windows.locked) {
      this.deps.windows.unlock();
      log.info("parental: unlocked");
    }

    this.enforce();
    this.deps.windows.update();
  }

  /**
   * Games over: running games are closed. PC over: games and every window opened after the
   * lock are closed; what was open before stays under the lock (unsaved work is not lost).
   * WM_CLOSE first, after CLOSE_GRACE_MS the process (never the shell, see Processes.Kill).
   */
  private enforce(): void {
    const status = this.status;
    const now = Date.now();
    const entries = this.deps.running.entries;
    const system = (entry: RunningEntry) => SYSTEM_EXES.has(path.win32.basename(entry.exe ?? "").toLowerCase());
    const targets = !status
      ? []
      : entries.filter((entry) => !system(entry) && ((status.games.reached && this.isGame(entry)) || (status.pc.reached && (this.isGame(entry) || !this.lockBaseline.has(entry.key)))));
    const keys = new Set(targets.map((entry) => entry.key));

    for (const key of [...this.closing.keys()]) if (!keys.has(key)) this.closing.delete(key);

    for (const entry of targets) {
      const since = this.closing.get(entry.key);

      if (since === undefined) {
        this.closing.set(entry.key, now);
        log.info(`parental: closing ${entry.name}`);
        this.deps.helper.call("process.close", { pids: entry.pids, softMs: 2000 }, 8000).catch((error) => log.warn(`parental close: ${(error as Error).message}`));
      } else if (now - since > CLOSE_GRACE_MS) {
        this.closing.set(entry.key, now);
        log.info(`parental: ending ${entry.name}`);
        this.deps.helper.call("process.kill", { pids: entry.pids, tree: true }, 10000).catch((error) => log.warn(`parental kill: ${(error as Error).message}`));
      }
    }
  }

  /** Dispatcher: launches the skill asks for while time is over are refused. */
  blocksLaunch(app: { id: string; kind: string }): boolean {
    if (!this.status) return false;
    if (this.status.pc.reached) return true;

    return this.status.games.reached && this.isGame({ appId: app.id, game: app.kind === "game" });
  }

  /** "+N minutes" from the notice or the lock. */
  async extend(kind: LimitKind): Promise<boolean> {
    if (!this.clock?.extend(kind, Date.now())) return false;

    this.warned[kind] = null;
    this.alert("extended");
    await this.persist();
    this.tick();
    this.deps.report();
    return true;
  }

  /** Anyone who knows the PIN lifts the limits for the owner's "unlock minutes". */
  async unlockWithPin(pin: string): Promise<{ ok: boolean; waitSec: number; noPin?: boolean }> {
    const now = Date.now();

    if (!this.clock) return { ok: false, waitSec: 0 };
    if (!this.data.pin) return { ok: false, waitSec: 0, noPin: true };

    const wait = pinWait(this.data.attempts, now);

    if (wait > 0) return { ok: false, waitSec: wait };

    if (await verifyPin(String(pin ?? ""), this.data.pin)) {
      const until = now + (this.data.rules?.unlockMinutes ?? 120) * 60_000;

      this.data.attempts = noAttempts();
      this.data.grantUntil = until;
      this.clock.grantUntil = until;
      this.hide();
      this.alert("pin-unlock", { until });
      await this.persist();
      this.tick();
      return { ok: true, waitSec: 0 };
    }

    this.data.attempts = pinFailed(this.data.attempts, now);
    // the owner hears it once, when the pauses begin
    if (this.data.attempts.failures.length === 5) this.alert("pin-failed");
    await this.persist();
    this.deps.windows.update();

    return { ok: false, waitSec: pinWait(this.data.attempts, now) };
  }

  /** Check the PIN without unlocking (a new pairing of a PC under control). */
  async checkPin(pin: string): Promise<boolean> {
    if (!this.data.pin || pinWait(this.data.attempts, Date.now()) > 0) return false;

    const ok = await verifyPin(String(pin ?? ""), this.data.pin);

    if (!ok) {
      this.data.attempts = pinFailed(this.data.attempts, Date.now());
      await this.persist();
    }
    return ok;
  }

  private show(kind: NoticeKind): void {
    this.notice = kind;
    this.deps.windows.showNotice();
  }

  hide(): void {
    this.notice = null;
    this.deps.windows.hideNotice();
  }

  /** Alerts wait for the connection: "the client was killed" comes before NODUS answers. */
  alert(kind: string, extra?: Record<string, unknown>): void {
    if (!this.deps.sendAlert(kind, extra)) this.alerts.push({ kind, extra });
  }

  flushAlerts(): void {
    const waiting = this.alerts;

    this.alerts = [];
    for (const { kind, extra } of waiting) this.alert(kind, extra);
  }

  setOwner(ownerId: string | null): void {
    if (!ownerId || ownerId === this.data.ownerId) return;
    this.data.ownerId = ownerId;
    void this.persist();
  }

  pageState(): ParentalPageState {
    return { notice: this.notice, status: this.status, pinSet: Boolean(this.data.pin), waitSec: pinWait(this.data.attempts, Date.now()) };
  }

  /** `state.parental` for the skill. */
  report(): Record<string, unknown> | null {
    if (!this.clock || !this.status) return null;

    const usage = this.clock.usage;

    return {
      day: usage.day,
      pcSec: Math.round(usage.pcSec),
      gameSec: Math.round(usage.gameSec),
      extended: usage.extended,
      locked: this.status.pc.reached ? "pc" : this.status.games.reached ? "games" : null,
    };
  }

  view(): ParentalView {
    const status = this.status;

    return {
      enabled: this.enabled,
      granted: Boolean(status?.granted),
      grantUntil: status?.grantUntil ?? null,
      pcLeftSec: status?.pc.leftSec ?? null,
      gamesLeftSec: status?.games.leftSec ?? null,
      locked: status?.pc.reached ? "pc" : status?.games.reached ? "games" : null,
    };
  }

  private release(): void {
    this.hide();
    this.deps.windows.unlock();
    this.closing.clear();
    this.warned = { pc: null, games: null };
    this.gamesOverShown = false;
  }

  persist(): Promise<void> {
    if (this.clock) this.data.usage = this.clock.usage;
    return this.deps.store.save(this.data);
  }

  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.persist();
    this.deps.windows.dispose();
  }
}
