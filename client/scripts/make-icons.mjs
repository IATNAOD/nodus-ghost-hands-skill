// Draws the Ghost Hands icons without dependencies:
//   build/icon.ico                    app and installer icon
//   resources/icons/icon.png          window icon
//   resources/icons/tray-<state>.ico  tray: online, connecting, offline, error
// The ghost is the Logo from the UI, in its 48×48 viewBox:
//   M10 42V20a14 14 0 0 1 28 0v22l-4.67-4-4.66 4-4.67-4-4.67 4-4.66-4z
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const hex = (value) => [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16) / 255);
const mix = (from, to, t) => from.map((value, i) => value + (to[i] - value) * Math.min(1, Math.max(0, t)));

const PURPLE = hex("#ad67ff");
const ORANGE = hex("#ff9a4d");
const GREY = hex("#8f86a3");
const RED = hex("#ff5c7a");
const FACE = hex("#140c20");
const CLEAR = [0, 0, 0, 0];

// semicircle head around (24, 20) with r 14, straight sides, zigzag hem
const GHOST = [];

for (let i = 0; i <= 96; i++) {
  const angle = Math.PI + (Math.PI * i) / 96;

  GHOST.push([24 + 14 * Math.cos(angle), 20 + 14 * Math.sin(angle)]);
}
GHOST.push([38, 42], [33.33, 38], [28.67, 42], [24, 38], [19.33, 42], [14.67, 38], [10, 42]);

const inGhost = (x, y) => {
  let inside = false;

  if (x < 10 || x > 38 || y < 6 || y > 42) return false;

  for (let i = 0, j = GHOST.length - 1; i < GHOST.length; j = i++) {
    const [xi, yi] = GHOST[i];
    const [xj, yj] = GHOST[j];

    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }

  return inside;
};

const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

const inEyes = (x, y, r) => inCircle(x, y, 18.5, 21, r) || inCircle(x, y, 29.5, 21, r);

// smile: arc of r 5 around (24, 26) from 30° to 150°, round caps
const onSmile = (x, y, width) => {
  const angle = Math.atan2(y - 26, x - 24);

  if (angle >= Math.PI / 6 && angle <= (5 * Math.PI) / 6) return Math.abs(Math.hypot(x - 24, y - 26) - 5) <= width / 2;
  return inCircle(x, y, 19.67, 28.5, width / 2) || inCircle(x, y, 28.33, 28.5, width / 2);
};

const inRoundRect = (x, y, from, to, r) => {
  const dx = Math.max(from + r - x, 0, x - (to - r));
  const dy = Math.max(from + r - y, 0, y - (to - r));

  return dx * dx + dy * dy <= r * r;
};

const gradient = (x, y) => mix(PURPLE, ORANGE, (x - 10 + (y - 6)) / 64);

// the ghost alone, filling the frame: small app sizes and the tray
const GLYPH_BOX = [5, 5, 38];

/** Large app icon: the gradient ghost with a face on a dark rounded square. */
const tile = (x, y) => {
  if (!inRoundRect(x, y, 1, 47, 11)) return CLEAR;
  if (!inGhost(x, y)) return [...mix(hex("#2a1f40"), hex("#120d1c"), (y - 1) / 46), 1];
  if (inEyes(x, y, 3) || onSmile(x, y, 2.4)) return [...FACE, 1];
  return [...gradient(x, y), 1];
};

/** Small app icon: no square and no smile, they blur at 16-24 px. */
const glyph = (x, y) => {
  if (!inGhost(x, y)) return CLEAR;
  return [...(inEyes(x, y, 3.4) ? FACE : gradient(x, y)), 1];
};

/** Tray: a flat ghost of the state color; a red dot for "needs attention". */
const tray = (color, dot) => (x, y) => {
  if (dot && inCircle(x, y, 36.5, 36.5, 8)) return inCircle(x, y, 36.5, 36.5, 6.2) ? [...RED, 1] : CLEAR;
  if (!inGhost(x, y)) return CLEAR;
  return [...(inEyes(x, y, 3.4) ? FACE : color), 1];
};

/** RGBA pixels of a scene, 6×6 samples per pixel. */
function render(size, scene, [left, top, span] = [0, 0, 48], samples = 6) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = span / size;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const [cr, cg, cb, ca] = scene(left + (px + (sx + 0.5) / samples) * step, top + (py + (sy + 0.5) / samples) * step);

          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }

      const at = (py * size + px) * 4;

      if (a > 0) {
        pixels[at] = Math.round((r / a) * 255);
        pixels[at + 1] = Math.round((g / a) * 255);
        pixels[at + 2] = Math.round((b / a) * 255);
      }
      pixels[at + 3] = Math.round((a / (samples * samples)) * 255);
    }
  }

  return pixels;
}

const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  const tail = Buffer.alloc(4);

  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
};

function png(size, pixels) {
  const header = Buffer.alloc(13);
  const stride = size * 4;
  const rows = Buffer.alloc(size * (stride + 1));

  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // RGBA
  for (let y = 0; y < size; y++) pixels.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** ICO entry as a 32-bit DIB: BGRA rows bottom-up plus the AND mask. */
function dib(size, pixels) {
  const header = Buffer.alloc(40);
  const maskStride = Math.ceil(size / 32) * 4;
  const color = Buffer.alloc(size * size * 4);
  const mask = Buffer.alloc(maskStride * size);

  for (let y = 0; y < size; y++) {
    const row = size - 1 - y;

    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4;
      const to = (row * size + x) * 4;

      color[to] = pixels[from + 2];
      color[to + 1] = pixels[from + 1];
      color[to + 2] = pixels[from];
      color[to + 3] = pixels[from + 3];
      if (pixels[from + 3] === 0) mask[row * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }

  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(color.length + mask.length, 20);
  return Buffer.concat([header, color, mask]);
}

/** ICO with DIB entries and a PNG one for 256 px, the way Windows expects. */
function ico(sizes, draw) {
  const images = sizes.map((size) => ({ size, data: size >= 256 ? png(size, draw(size)) : dib(size, draw(size)) }));
  const head = Buffer.alloc(6 + 16 * images.length);
  let offset = head.length;

  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  images.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i;

    head[at] = size >= 256 ? 0 : size;
    head[at + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(data.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });

  return Buffer.concat([head, ...images.map((image) => image.data)]);
}

const appImage = (size) => (size <= 24 ? render(size, glyph, GLYPH_BOX) : render(size, tile));

const TRAY = {
  online: tray(ORANGE, false),
  connecting: tray(PURPLE, false),
  offline: tray(GREY, false),
  error: tray(GREY, true),
};

const icons = join(root, "resources", "icons");

await mkdir(join(root, "build"), { recursive: true });
await mkdir(icons, { recursive: true });
await writeFile(join(root, "build", "icon.ico"), ico([16, 20, 24, 32, 40, 48, 64, 128, 256], appImage));
await writeFile(join(icons, "icon.png"), png(256, appImage(256)));
for (const [state, scene] of Object.entries(TRAY)) {
  await writeFile(join(icons, `tray-${state}.ico`), ico([16, 20, 24, 32, 40, 48], (size) => render(size, scene, GLYPH_BOX)));
}

console.log("icons: build/icon.ico, resources/icons/icon.png, resources/icons/tray-{online,connecting,offline,error}.ico");
