// The main-process side of the vision process: started on the first search, ends after a
// while without searches (its memory goes back), restarts when it grows too big or hangs.
import path from "path";
import { nativeImage, utilityProcess, type UtilityProcess } from "electron";
import type { Hit } from "./match";

export interface FrameRef {
  file: string;
  w: number;
  h: number;
  stride: number;
  x: number;
  y: number;
  scale: number;
  monitor: string;
}

const MATCH_TIMEOUT_MS = 20_000;
const MAX_RSS = 700 * 1024 * 1024;

export class VisionClient {
  private child: UtilityProcess | null = null;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private sent = new Set<string>();
  private sequence = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private matches = 0;

  constructor(
    private readAsset: (sha: string) => Promise<Buffer | null>,
    private idleMs: () => number,
    private warn: (text: string) => void,
  ) {}

  private start(): UtilityProcess {
    if (this.child) return this.child;

    const child = utilityProcess.fork(path.join(__dirname, "vision.js"), [], { serviceName: "Ghost Hands vision", stdio: "ignore" });

    child.on("message", (message: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(Object.assign(new Error(message.error ?? "vision-failed"), { code: message.error === "no-sample" ? "no-image" : "vision-failed" }));
    });
    child.on("exit", (code) => {
      if (this.child === child) this.child = null;
      this.sent.clear();
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(Object.assign(new Error(`vision process exited (${code})`), { code: "vision-failed" }));
        this.pending.delete(id);
      }
    });
    this.child = child;
    return child;
  }

  private request<T>(message: Record<string, unknown>, transfer?: unknown): Promise<T> {
    const child = this.start();
    const id = ++this.sequence;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error("vision timeout"), { code: "vision-failed" }));
        // a hung match: the process goes, the next search starts a new one
        this.stopChild();
      }, MATCH_TIMEOUT_MS);

      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      child.postMessage({ id, ...message }, transfer as never);
    });
  }

  /** The best match of a sample in the frames, or null. */
  async match(sha: string, scale: number, frames: FrameRef[], threshold: number, hint: Hit | null): Promise<Hit | null> {
    this.touch();

    if (!this.sent.has(sha)) {
      const png = await this.readAsset(sha);
      if (!png) throw Object.assign(new Error("sample is missing"), { code: "no-image" });

      const image = nativeImage.createFromBuffer(png);
      const size = image.getSize();
      await this.request({ type: "template", sha, w: size.width, h: size.height, scale, bgra: new Uint8Array(image.toBitmap()) });
      this.sent.add(sha);
    }

    const hit = await this.request<Hit | null>({ type: "match", sha, frames, threshold, hint: hint ? { x: hint.x, y: hint.y, w: hint.w, h: hint.h } : null });

    // every few searches: a heap that grew too big gets a fresh process
    if (++this.matches % 20 === 0) {
      const rss = await this.request<number>({ type: "memory" }).catch(() => 0);
      if (rss > MAX_RSS) {
        this.warn(`vision process uses ${Math.round(rss / 1e6)} MB: restarting`);
        this.stopChild();
      }
    }
    return hit;
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stopChild(), this.idleMs());
    this.idleTimer.unref();
  }

  private stopChild(): void {
    const child = this.child;
    this.child = null;
    this.sent.clear();
    child?.kill();
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.stopChild();
  }
}
