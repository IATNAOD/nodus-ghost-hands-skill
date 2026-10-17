// Keyboard and mouse of scenario runs through the helper. One InputLock for all runs: two
// scenarios never mix their keys. One InputController per run: it remembers what it holds
// down and lets everything go when the run ends, however it ends.
import { comboKeys } from "../../shared/scenarios/keys";
import type { KeyCombo, Point } from "../../shared/scenarios/model";
import { NodeError, RunAbort } from "./engine";

export interface InputDeps {
  call<T>(cmd: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  clipboard: { read(): Promise<string>; write(text: string): Promise<void> };
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

/** FIFO lock; the owner holding it may take it again. Release hands it straight to the next in line. */
export class InputLock {
  private owner: string | null = null;
  private depth = 0;
  private waiting: { owner: string; resolve: () => void }[] = [];

  async acquire(owner: string, signal?: AbortSignal): Promise<() => void> {
    if (this.owner === null) {
      this.owner = owner;
      this.depth = 1;
    } else if (this.owner === owner) {
      this.depth++;
    } else {
      await new Promise<void>((resolve, reject) => {
        const entry = { owner, resolve };
        const onAbort = () => {
          if (!this.waiting.includes(entry)) return;
          this.waiting = this.waiting.filter((w) => w !== entry);
          reject(signal?.reason instanceof RunAbort ? signal.reason : new RunAbort("stopped"));
        };

        this.waiting.push(entry);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      // release() made us the owner already
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseOnce();
    };
  }

  private releaseOnce(): void {
    if (--this.depth > 0) return;

    const next = this.waiting.shift();
    if (next) {
      this.owner = next.owner;
      this.depth = 1;
      next.resolve();
    } else {
      this.owner = null;
      this.depth = 0;
    }
  }

  get busy(): boolean {
    return this.owner !== null;
  }
}

export interface InputOptions {
  runId: string;
  signal: AbortSignal;
  /** hold the lock from the first input step to the end of the run */
  exclusive: boolean;
  /** wait until the person lets go of the hotkey that started the run */
  waitRelease: boolean;
  /** pids input is allowed for (the guard app), null - any window; throws when the app does not run */
  guardPids(): number[] | null;
  /** a person's mouse move stops the run */
  stopOnUserMouse: boolean;
  abort(code: string): void;
}

const MOVE_TOLERANCE = 8;

export class InputController {
  private held = new Map<string, { scan: number; ext: boolean; vk: number }>();
  private buttons = new Set<string>();
  private release: (() => void) | null = null;
  private started = false;
  private watch: NodeJS.Timeout | null = null;
  /** where our own last move put the cursor; null - unknown */
  private expected: Point | null = null;
  private busy = 0;

  constructor(
    private deps: InputDeps,
    private lock: InputLock,
    private options: InputOptions,
  ) {}

  private guard(): Record<string, unknown> {
    const pids = this.options.guardPids();
    return pids ? { guard: { pids } } : {};
  }

  /** Every input call: the lock, the first-time checks, the user-mouse watch. */
  private async step<T>(work: () => Promise<T>): Promise<T> {
    if (this.options.signal.aborted) throw new RunAbort("stopped");

    let unlock: (() => void) | null = null;
    if (this.options.exclusive) {
      if (!this.release) this.release = await this.lock.acquire(this.options.runId, this.options.signal);
    } else {
      unlock = await this.lock.acquire(this.options.runId, this.options.signal);
    }

    try {
      if (!this.started) {
        this.started = true;
        if (this.options.waitRelease) await this.deps.call("input.waitRelease", { timeoutMs: 3000 }, 5000).catch(() => undefined);
        if (this.options.stopOnUserMouse) this.startWatch();
      }
      this.busy++;
      return await work();
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code && !(error instanceof RunAbort)) throw new NodeError(code, (error as Error).message);
      throw error;
    } finally {
      this.busy--;
      unlock?.();
    }
  }

  async keys(combo: KeyCombo, mode: "press" | "down" | "up", holdMs: number, repeat: number): Promise<void> {
    const keys = comboKeys(combo.codes);
    if (!keys.length) throw new NodeError("invalid-args", "keys");

    await this.step(async () => {
      await this.deps.call("input.keys", { keys, action: mode, holdMs, repeat, intervalMs: 60, ...this.guard() }, 5000 + (holdMs + 100) * repeat);
      for (const [i, key] of keys.entries()) {
        const id = combo.codes[i] ?? `${key.scan}:${key.vk}`;
        if (mode === "down") this.held.set(id, key);
        else this.held.delete(id);
      }
    });
  }

  async text(text: string, mode: "unicode" | "keys" | "paste", intervalMs: number): Promise<void> {
    if (!text) return;
    await this.step(async () => {
      if (mode === "paste") {
        const before = await this.deps.clipboard.read();
        await this.deps.clipboard.write(text);
        await this.deps.call("input.keys", { keys: comboKeys(["ControlLeft", "KeyV"]), action: "press", holdMs: 40, ...this.guard() });
        // give the app a moment to read the clipboard before it is restored
        await this.deps.sleep(150, this.options.signal).catch(() => undefined);
        await this.deps.clipboard.write(before);
        return;
      }
      await this.deps.call("input.text", { text, mode, intervalMs, ...this.guard() }, 5000 + text.length * (intervalMs + 5));
    });
  }

  async click(point: Point, button: string, double: boolean, holdMs: number, returnCursor: boolean): Promise<void> {
    await this.step(async () => {
      const back = returnCursor ? await this.deps.call<Point>("cursor.get") : null;

      await this.deps.call("input.mouse", { action: "click", x: point.x, y: point.y, button, clicks: double ? 2 : 1, holdMs, ...this.guard() }, 5000 + holdMs * 2);
      this.expected = point;
      if (back) {
        await this.deps.call("input.mouse", { action: "move", x: back.x, y: back.y });
        this.expected = back;
      }
    });
  }

  async move(point: Point, smoothMs: number): Promise<void> {
    await this.step(async () => {
      await this.deps.call("input.mouse", { action: "move", x: point.x, y: point.y, smoothMs, ...this.guard() }, 5000 + smoothMs);
      this.expected = point;
    });
  }

  async drag(from: Point, to: Point, button: string, durationMs: number): Promise<void> {
    await this.step(async () => {
      await this.deps.call("input.mouse", { action: "down", x: from.x, y: from.y, button, ...this.guard() });
      this.buttons.add(button);
      this.expected = from;
      await this.deps.call("input.mouse", { action: "move", x: to.x, y: to.y, smoothMs: durationMs, ...this.guard() }, 5000 + durationMs);
      this.expected = to;
      await this.deps.call("input.mouse", { action: "up", button });
      this.buttons.delete(button);
    });
  }

  async scroll(amount: number, horizontal: boolean, point: Point | null): Promise<void> {
    await this.step(async () => {
      await this.deps.call("input.scroll", { amount, horizontal, ...(point ? { x: point.x, y: point.y } : {}), ...this.guard() });
      if (point) this.expected = point;
    });
  }

  cursor(): Promise<Point> {
    return this.deps.call<Point>("cursor.get");
  }

  /** Lets go of everything this run holds down. */
  async releaseAll(): Promise<void> {
    if (!this.held.size && !this.buttons.size) return;

    const keys = [...this.held.values()].reverse();
    const buttons = [...this.buttons];

    this.held.clear();
    this.buttons.clear();
    await this.deps.call("input.release", { keys, buttons }).catch(() => undefined);
  }

  /** The run is over: keys up, the lock free, the watch off. */
  async dispose(): Promise<void> {
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
    await this.releaseAll();
    this.release?.();
    this.release = null;
  }

  /** "Stop if I move the mouse": the cursor away from where our last step left it. */
  private startWatch(): void {
    this.watch = setInterval(() => {
      if (this.busy > 0) return;
      this.deps
        .call<Point>("cursor.get")
        .then((now) => {
          if (this.busy > 0) return;
          if (!this.expected) {
            this.expected = now;
            return;
          }
          if (Math.abs(now.x - this.expected.x) > MOVE_TOLERANCE || Math.abs(now.y - this.expected.y) > MOVE_TOLERANCE) this.options.abort("user-mouse");
        })
        .catch(() => undefined);
    }, 250);
    this.watch.unref?.();
  }
}
