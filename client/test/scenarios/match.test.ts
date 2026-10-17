import { createRequire } from "module";
import { beforeAll, describe, expect, it } from "vitest";
import { findInFrame, type CV, type Frame, type Sample } from "../../src/main/scenarios/vision/match";

const require = createRequire(import.meta.url);
let cv: CV;

// cv is an Emscripten module with its own then(): never resolve a promise with it
beforeAll(async () => {
  const loaded = require("@techstark/opencv-js");
  await new Promise<void>((resolve) => {
    if (loaded.Mat) return resolve();
    loaded.onRuntimeInitialized = () => resolve();
  });
  cv = loaded;
}, 30000);

/** A noisy screen with a few UI-like boxes. */
function screen(w: number, h: number, seed = 1): Uint8Array {
  const data = new Uint8Array(w * h);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < data.length; i++) data[i] = 90 + Math.floor(rnd() * 30);
  return data;
}

/** A button: a frame, a gradient and some "text" stripes. */
function button(w: number, h: number, variant = 0): Uint8Array {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const border = x < 2 || y < 2 || x >= w - 2 || y >= h - 2;
      const text = y > h / 3 && y < (2 * h) / 3 && x > w / 5 && x < (4 * w) / 5 && ((x + variant * 3) >> 2) % 2 === 0;
      data[y * w + x] = border ? 250 : text ? 10 : 160 + Math.round((x / w) * 60);
    }
  }
  return data;
}

function put(target: Uint8Array, tw: number, source: Uint8Array, sw: number, sh: number, x: number, y: number) {
  for (let row = 0; row < sh; row++) target.set(source.subarray(row * sw, row * sw + sw), (y + row) * tw + x);
}

/** Nearest-neighbour scale, enough to fake another display scale. */
function scaled(source: Uint8Array, w: number, h: number, factor: number): { data: Uint8Array; w: number; h: number } {
  const nw = Math.round(w * factor);
  const nh = Math.round(h * factor);
  const data = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) data[y * nw + x] = source[Math.min(h - 1, Math.floor(y / factor)) * w + Math.min(w - 1, Math.floor(x / factor))];
  return { data, w: nw, h: nh };
}

const W = 1600;
const H = 900;

describe("find image", () => {
  it("finds a button among others, with the frame offset of its monitor", () => {
    const data = screen(W, H);
    put(data, W, button(140, 44, 1), 140, 44, 200, 300);
    put(data, W, button(140, 44, 0), 140, 44, 900, 610);
    const frame: Frame = { data, w: W, h: H, x: 2560, y: 534, scale: 1, monitor: "\\\\.\\DISPLAY2" };
    const sample: Sample = { data: button(140, 44, 0), w: 140, h: 44, scale: 1 };

    const hit = findInFrame(cv, frame, sample, 0.85);
    expect(hit).toMatchObject({ x: 2560 + 900, y: 534 + 610, w: 140, h: 44, monitor: "\\\\.\\DISPLAY2" });
    expect(hit!.score).toBeGreaterThan(0.95);
  });

  it("a sample taken at 125% is found on a 100% monitor", () => {
    const original = button(120, 40, 2);
    const big = scaled(original, 120, 40, 1.25);
    const data = screen(W, H, 7);
    put(data, W, original, 120, 40, 333, 444);

    const hit = findInFrame(cv, { data, w: W, h: H, x: 0, y: 0, scale: 1, monitor: "m" }, { ...big, scale: 1.25 }, 0.8);
    expect(hit).not.toBeNull();
    expect(Math.abs(hit!.x - 333)).toBeLessThanOrEqual(2);
    expect(Math.abs(hit!.y - 444)).toBeLessThanOrEqual(2);
  });

  it("nothing similar - nothing found; a flat sample does not match a flat area", () => {
    const data = screen(W, H, 3);
    expect(findInFrame(cv, { data, w: W, h: H, x: 0, y: 0, scale: 1, monitor: "m" }, { data: button(100, 30, 4), w: 100, h: 30, scale: 1 }, 0.85)).toBeNull();

    const flat = new Uint8Array(W * H).fill(128);
    expect(findInFrame(cv, { data: flat, w: W, h: H, x: 0, y: 0, scale: 1, monitor: "m" }, { data: new Uint8Array(60 * 20).fill(128), w: 60, h: 20, scale: 1 }, 0.5)).toBeNull();
  });

  it("the hint of the last hit is checked first", () => {
    const data = screen(W, H, 5);
    put(data, W, button(90, 30, 1), 90, 30, 1200, 100);
    const frame: Frame = { data, w: W, h: H, x: 0, y: 0, scale: 1, monitor: "m" };
    const hit = findInFrame(cv, frame, { data: button(90, 30, 1), w: 90, h: 30, scale: 1 }, 0.85, { x: 1198, y: 103, w: 90, h: 30 });

    expect(hit).toMatchObject({ x: 1200, y: 100 });
  });
});
