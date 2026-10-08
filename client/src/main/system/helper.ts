import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import readline from "readline";
import log from "../log";
import { resourcePath } from "../paths";

export class HelperError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const RESTART_DELAYS = [500, 1000, 2000, 5000, 10000, 30000];

/**
 * GhostHelper.exe (C#): volume, windows, processes, power, Start menu, registry.
 * JSON Lines over stdin/stdout; it exits with us (--parent). Restarts after a crash
 * and emits "restart" so watchers subscribe again.
 */
export class Helper extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private restarts = 0;
  private stopped = false;
  private restartTimer: NodeJS.Timeout | null = null;
  ok = false;
  lastError: string | null = null;

  static exePath(): string {
    return resourcePath("helper", "GhostHelper.exe");
  }

  start(): void {
    this.stopped = false;
    this.spawn();
  }

  private spawn(): void {
    const exe = Helper.exePath();

    let proc: ChildProcessWithoutNullStreams;

    try {
      proc = spawn(exe, ["--parent", String(process.pid)], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      this.fail(`cannot start ${exe}: ${(error as Error).message}`);
      return;
    }

    this.proc = proc;
    proc.on("error", (error) => this.fail(`helper: ${error.message}`));
    proc.stdin.on("error", (error) => log.warn(`helper stdin: ${error.message}`));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => log.info(`[helper] ${chunk.trim()}`));

    const lines = readline.createInterface({ input: proc.stdout });

    lines.on("line", (line) => this.onLine(line));
    proc.on("exit", (code) => {
      lines.close();
      if (this.proc === proc) this.proc = null;
      this.ok = false;
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new HelperError("helper-unavailable", "helper exited"));
        this.pending.delete(id);
      }
      if (this.stopped) return;

      const delay = RESTART_DELAYS[Math.min(this.restarts++, RESTART_DELAYS.length - 1)];

      log.warn(`helper exited with ${code}, restarting in ${delay} ms`);
      this.restartTimer = setTimeout(() => this.spawn(), delay);
    });

    this.call<{ version: string }>("ping", {}, 10000)
      .then((data) => {
        this.ok = true;
        this.lastError = null;
        this.restarts = 0;
        log.info(`helper ${data.version} ready`);
        this.emit("restart");
      })
      .catch((error) => this.fail(`helper ping: ${error.message}`));
  }

  private fail(message: string): void {
    this.ok = false;
    this.lastError = message;
    log.error(message);
    this.emit("status");
  }

  private onLine(line: string): void {
    let message: { id?: number | null; ok?: boolean; data?: unknown; code?: string; message?: string; event?: string };

    try {
      message = JSON.parse(line);
    } catch {
      log.warn(`helper: bad line ${line.slice(0, 120)}`);
      return;
    }

    if (message.event) {
      this.emit(message.event, message.data);
      return;
    }

    const pending = typeof message.id === "number" ? this.pending.get(message.id) : undefined;

    if (!pending) return;
    this.pending.delete(message.id as number);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.data);
    else pending.reject(new HelperError(message.code ?? "internal", message.message ?? "helper error"));
  }

  /** Call a helper command; rejects with HelperError("helper-unavailable") when it is down. */
  call<T>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 5000): Promise<T> {
    const proc = this.proc;

    if (!proc || !proc.stdin.writable) return Promise.reject(new HelperError("helper-unavailable", "helper is not running"));

    const id = ++this.sequence;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HelperError("helper-timeout", `${cmd} timed out`));
      }, timeoutMs);

      this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject, timer });
      proc.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new HelperError("helper-unavailable", error.message));
      });
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    try {
      this.proc?.stdin.end();
      this.proc?.kill();
    } catch {
      // already gone
    }
    this.proc = null;
  }
}
