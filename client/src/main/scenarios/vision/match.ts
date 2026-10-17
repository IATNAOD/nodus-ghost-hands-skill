// Template matching for "Find image": grey frames, normalized correlation (TM_CCOEFF_NORMED),
// coarse to fine. Pure: takes the opencv.js instance, so vitest runs it with real OpenCV.
//
// 1. the sample scaled by monitor scale / sample scale (a sample from a 125% monitor on a 100% one)
// 2. a pyramid level where the sample is still >= 12 px: the best few peaks there
// 3. each peak refined at full resolution in a small window; flat patches are no match
// 4. other scales (0.8-1.5) only when the expected one found nothing
// Every Mat is freed: opencv.js memory is not garbage collected.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CV = any;

export interface GrayImage {
  data: Uint8Array;
  w: number;
  h: number;
}

export interface Frame extends GrayImage {
  /** where the frame is on the virtual desktop, physical px */
  x: number;
  y: number;
  /** display scale (1.25 for 125%) */
  scale: number;
  monitor: string;
}

export interface Sample extends GrayImage {
  /** the display scale it was taken at */
  scale: number;
}

export interface Hit {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  monitor: string;
}

const PEAKS = 5;
const MIN_SIDE = 12;
const FLAT = 4;
const FALLBACK_SCALES = [1, 0.9, 1.1, 0.8, 1.2, 1.25, 1.33, 1.5, 0.75, 0.67];

/** Runs `work` with a list that frees every Mat put into it. */
function withMats<T>(work: (keep: <M extends { delete(): void }>(mat: M) => M) => T): T {
  const mats: { delete(): void }[] = [];
  try {
    return work((mat) => {
      mats.push(mat);
      return mat;
    });
  } finally {
    for (const mat of mats) {
      try {
        mat.delete();
      } catch {
        // already freed
      }
    }
  }
}

export const toMat = (cv: CV, image: GrayImage) => cv.matFromArray(image.h, image.w, cv.CV_8UC1, image.data);

/** BGRA → grey (the same weights as the helper). */
export function grayOf(bgra: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = (bgra[i + 2] * 77 + bgra[i + 1] * 150 + bgra[i] * 29) >> 8;
  return out;
}

/**
 * The best place of the sample in the frame with a score of at least `threshold`, or null.
 * `hint` - where it was last time: looked at first.
 */
export function findInFrame(cv: CV, frame: Frame, sample: Sample, threshold: number, hint?: { x: number; y: number; w: number; h: number } | null): Hit | null {
  return withMats((keep) => {
    const image = keep(toMat(cv, frame));
    const template = keep(toMat(cv, sample));
    const expected = Math.round((frame.scale / (sample.scale || 1)) * 100) / 100;
    const scales = [expected, ...FALLBACK_SCALES.map((s) => Math.round(expected * s * 100) / 100).filter((s) => s !== expected)];

    for (const [index, scale] of scales.entries()) {
      const scaled = scale === 1 ? template : keep(new cv.Mat());
      if (scale !== 1) {
        const w = Math.round(sample.w * scale);
        const h = Math.round(sample.h * scale);
        if (w < 4 || h < 4 || w > frame.w || h > frame.h) continue;
        cv.resize(template, scaled, new cv.Size(w, h), 0, 0, scale < 1 ? cv.INTER_AREA : cv.INTER_CUBIC);
      }
      if (scaled.cols > frame.w || scaled.rows > frame.h) continue;

      // the place of the last hit first: a waiting loop finds it at once
      if (hint && index === 0) {
        const quick = refine(cv, keep, image, scaled, frame, hint.x - frame.x, hint.y - frame.y, 6);
        if (quick && quick.score >= threshold) return quick;
      }

      const hit = searchScale(cv, keep, image, scaled, frame, threshold);
      if (hit) return hit;
      // other scales are a fallback: the expected one found nothing
    }
    return null;
  });
}

function searchScale(cv: CV, keep: <M extends { delete(): void }>(mat: M) => M, image: CV, template: CV, frame: Frame, threshold: number): Hit | null {
  const side = Math.min(template.cols, template.rows);
  let level = 0;
  while (level < 3 && side / 2 ** (level + 1) >= MIN_SIDE) level++;

  const factor = 2 ** level;
  let small = image;
  let smallTemplate = template;

  if (level > 0) {
    small = keep(new cv.Mat());
    smallTemplate = keep(new cv.Mat());
    cv.resize(image, small, new cv.Size(Math.floor(image.cols / factor), Math.floor(image.rows / factor)), 0, 0, cv.INTER_AREA);
    cv.resize(template, smallTemplate, new cv.Size(Math.max(1, Math.round(template.cols / factor)), Math.max(1, Math.round(template.rows / factor))), 0, 0, cv.INTER_AREA);
  }
  if (smallTemplate.cols > small.cols || smallTemplate.rows > small.rows) return null;

  const result = keep(new cv.Mat());
  cv.matchTemplate(small, smallTemplate, result, cv.TM_CCOEFF_NORMED);

  let best: Hit | null = null;
  const coarse = Math.max(0.3, threshold - 0.15);

  for (let peak = 0; peak < PEAKS; peak++) {
    const found = cv.minMaxLoc(result);
    if (!Number.isFinite(found.maxVal) || found.maxVal < coarse) break;

    const hit = refine(cv, keep, image, template, frame, found.maxLoc.x * factor, found.maxLoc.y * factor, factor + 2);
    if (hit && hit.score >= threshold && (!best || hit.score > best.score)) {
      best = hit;
      if (hit.score >= Math.min(0.99, threshold + 0.1)) break;
    }

    // this peak is done: blank it and the sample-sized area around it
    const w = smallTemplate.cols;
    const h = smallTemplate.rows;
    cv.rectangle(result, new cv.Point(found.maxLoc.x - w / 2, found.maxLoc.y - h / 2), new cv.Point(found.maxLoc.x + w / 2, found.maxLoc.y + h / 2), new cv.Scalar(-1), -1);
  }
  return best;
}

/** The exact place near (x, y) at full resolution; null on a flat patch. */
function refine(cv: CV, keep: <M extends { delete(): void }>(mat: M) => M, image: CV, template: CV, frame: Frame, x: number, y: number, pad: number): Hit | null {
  const left = Math.max(0, Math.round(x) - pad);
  const top = Math.max(0, Math.round(y) - pad);
  const width = Math.min(image.cols - left, template.cols + pad * 2);
  const height = Math.min(image.rows - top, template.rows + pad * 2);
  if (width < template.cols || height < template.rows) return null;

  const roi = keep(image.roi(new cv.Rect(left, top, width, height)));
  const result = keep(new cv.Mat());
  cv.matchTemplate(roi, template, result, cv.TM_CCOEFF_NORMED);

  const found = cv.minMaxLoc(result);
  if (!Number.isFinite(found.maxVal)) return null;

  const hx = left + found.maxLoc.x;
  const hy = top + found.maxLoc.y;

  // normalized correlation is meaningless on a flat area: a blank sample matches any blank spot
  const patch = keep(image.roi(new cv.Rect(hx, hy, template.cols, template.rows)));
  const mean = keep(new cv.Mat());
  const std = keep(new cv.Mat());
  cv.meanStdDev(patch, mean, std);
  if (std.doubleAt(0, 0) < FLAT) return null;

  return { x: frame.x + hx, y: frame.y + hy, w: template.cols, h: template.rows, score: found.maxVal, monitor: frame.monitor };
}
