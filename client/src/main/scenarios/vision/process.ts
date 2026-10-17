// The vision process (Electron utilityProcess): OpenCV runs here, not in the main process,
// so a crash or the never-shrinking WebAssembly heap does not touch the client. It reads the
// frames the helper wrote to temp files; samples come once per sha as BGRA pixels.
import { promises as fs } from "fs";
import { findInFrame, grayOf, type CV, type Frame, type Hit, type Sample } from "./match";

interface FrameRef {
  file: string;
  w: number;
  h: number;
  stride: number;
  x: number;
  y: number;
  scale: number;
  monitor: string;
}

type Request =
  | { id: number; type: "template"; sha: string; w: number; h: number; scale: number; bgra: Uint8Array }
  | { id: number; type: "match"; sha: string; frames: FrameRef[]; threshold: number; hint: { x: number; y: number; w: number; h: number } | null }
  | { id: number; type: "memory" };

const MAX_SAMPLES = 64;
const samples = new Map<string, Sample>();
let cv: CV | null = null;

// cv is an Emscripten module with its own then(): never resolve a promise with it
const ready: Promise<void> = new Promise((resolve) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loaded = require("@techstark/opencv-js");
  const done = () => {
    cv = loaded;
    resolve();
  };

  if (loaded.Mat) done();
  else loaded.onRuntimeInitialized = done;
});

async function readFrame(ref: FrameRef): Promise<Frame> {
  const raw = await fs.readFile(ref.file);
  const data = new Uint8Array(raw.buffer, raw.byteOffset, ref.w * ref.h);

  return { data, w: ref.w, h: ref.h, x: ref.x, y: ref.y, scale: ref.scale, monitor: ref.monitor };
}

async function handle(request: Request): Promise<unknown> {
  switch (request.type) {
    case "template": {
      samples.delete(request.sha);
      samples.set(request.sha, { data: grayOf(request.bgra, request.w, request.h), w: request.w, h: request.h, scale: request.scale });
      while (samples.size > MAX_SAMPLES) samples.delete(samples.keys().next().value!);
      return true;
    }
    case "match": {
      const sample = samples.get(request.sha);
      if (!sample) throw new Error("no-sample");
      await ready;

      let best: Hit | null = null;
      for (const ref of request.frames) {
        const frame = await readFrame(ref);
        const hint = request.hint && request.hint.x >= ref.x && request.hint.y >= ref.y && request.hint.x < ref.x + ref.w && request.hint.y < ref.y + ref.h ? request.hint : null;
        const hit = findInFrame(cv, frame, sample, request.threshold, hint);
        if (hit && (!best || hit.score > best.score)) best = hit;
      }
      return best;
    }
    case "memory":
      return process.memoryUsage().rss;
  }
}

process.parentPort.on("message", (event) => {
  const request = event.data as Request;

  handle(request).then(
    (result) => process.parentPort.postMessage({ id: request.id, ok: true, result }),
    (error: Error) => process.parentPort.postMessage({ id: request.id, ok: false, error: error.message }),
  );
});
