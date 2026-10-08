// How the previous run ended, and the watchdog of a client under parental control.
// run.json says "running" from the start and "exited cleanly" after an allowed quit (Windows
// ends the session, an update, a quit without parental control). The watchdog is GhostHelper
// in guard mode, outside the client's process tree: when the client dies without the clean
// mark (Task Manager) while "guarded", it starts the client again with --restarted=killed.
import { spawn } from "child_process";
import { promises as fs, writeFileSync } from "fs";
import path from "path";
import { app } from "electron";
import log from "../log";
import { Helper } from "../system/helper";

interface RunMarker {
  pid: number;
  startedAt: number;
  /** the watchdog restarts the client only while this is true */
  guarded: boolean;
  cleanExitAt?: number;
}

/** guard.json, written by the watchdog: its pid and the client it watches */
interface GuardInfo {
  pid: number;
  client: number;
}

const CHECK_MS = 30_000;
// the watchdog may still be starting when control is turned off: one more look after this
const STOP_RETRY_MS = 3000;

const alive = (pid: number | undefined): boolean => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export class Guard {
  private file: string;
  private infoFile: string;
  private startedAt = Date.now();
  private guarded = false;
  private timer: NodeJS.Timeout | null = null;
  // run.json is written in turn: two quick switches must not mix their writes
  private writing: Promise<void> = Promise.resolve();

  constructor(dir: string) {
    this.file = path.join(dir, "run.json");
    this.infoFile = path.join(dir, "guard.json");
  }

  /** Mark this run; true when the previous one ended without the clean mark (killed, power cut). */
  async start(): Promise<boolean> {
    let previous: RunMarker | null = null;

    try {
      previous = JSON.parse(await fs.readFile(this.file, "utf8")) as RunMarker;
    } catch {
      // the first run
    }
    await this.write(this.marker());

    return Boolean(previous && !previous.cleanExitAt && previous.pid !== process.pid);
  }

  /** Before an allowed quit: the watchdog lets the client go. */
  async markClean(): Promise<void> {
    await this.write(this.marker(true));
  }

  /** Windows ends the session: the process is gone right after the handler, no time for async. */
  markCleanSync(): void {
    try {
      writeFileSync(this.file, JSON.stringify(this.marker(true)), "utf8");
    } catch (error) {
      log.warn(`run marker: ${(error as Error).message}`);
    }
  }

  /** A watchdog while parental control is on; none when it is off. */
  protect(on: boolean): void {
    if (on === this.guarded) return;
    this.guarded = on;
    // first the marker: a watchdog that outlives this call still sees "not guarded"
    void this.write(this.marker()).then(() => (on ? this.ensure() : this.stop()));

    if (on) {
      this.timer = setInterval(() => void this.ensure(), CHECK_MS);
      this.timer.unref();
    } else if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private marker(clean = false): RunMarker {
    return { pid: process.pid, startedAt: this.startedAt, guarded: this.guarded, ...(clean ? { cleanExitAt: Date.now() } : {}) };
  }

  private async watchdog(): Promise<GuardInfo | null> {
    try {
      const info = JSON.parse(await fs.readFile(this.infoFile, "utf8")) as GuardInfo;

      return info.client === process.pid && alive(info.pid) ? info : null;
    } catch {
      return null;
    }
  }

  private async ensure(): Promise<void> {
    if (!this.guarded || (await this.watchdog())) return;

    // installed: GhostHands.exe; from the sources: electron.exe <app>
    const relaunch = app.isPackaged ? [] : [app.getAppPath()];
    const args = ["guard", "--pid", String(process.pid), "--run", this.file, "--exe", process.execPath, ...[...relaunch, "--hidden", "--restarted=killed"].flatMap((arg) => ["--arg", arg])];

    try {
      // GhostHelper starts the real watchdog and exits: it is not a child of this process then.
      // A second watchdog of this profile quits on its mutex.
      const child = spawn(Helper.exePath(), args, { detached: true, stdio: "ignore", windowsHide: true });

      child.on("error", (error) => log.warn(`watchdog: ${error.message}`));
      child.unref();
    } catch (error) {
      log.warn(`watchdog: ${(error as Error).message}`);
    }
  }

  private async stop(): Promise<void> {
    for (const delay of [0, STOP_RETRY_MS]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay).unref());
      if (this.guarded) return;

      const info = await this.watchdog();

      if (!info) continue;
      try {
        process.kill(info.pid);
      } catch {
        // gone already
      }
    }
  }

  private write(marker: RunMarker): Promise<void> {
    this.writing = this.writing.then(async () => {
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await fs.writeFile(this.file, JSON.stringify(marker), "utf8");
      } catch (error) {
        log.warn(`run marker: ${(error as Error).message}`);
      }
    });
    return this.writing;
  }
}
