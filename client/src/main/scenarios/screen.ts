// The screen for scenarios: monitors (Electron displays matched to the helper's physical
// rectangles), frames in temp files, "Find image" through the vision process, text through the
// Windows OCR, and the pickers that take a sample, a point or an area from the screen or from a
// picture the person already has (a file, the clipboard).
import { promises as fs } from "fs";
import path from "path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, screen, type NativeImage, type Rectangle, type WebContents } from "electron";
import { t } from "../i18n";
import { load } from "../windows";
import type { Helper } from "../system/helper";
import { centerOf, type ImageRef, type MonitorSel, type Point, type Region, type RegionSel } from "../../shared/scenarios/model";
import { areaRect, keyOf, selectMonitors, type Monitor } from "../../shared/scenarios/monitors";
import { findText, linesText, type OcrLine } from "../../shared/scenarios/textmatch";
import type { DisplayInfo } from "../../shared/types";
import { NodeError } from "./engine";
import type { ImageMatch, SearchArea, TextMatch } from "./impl/services";
import type { ScenarioService } from "./service";
import { VisionClient, type FrameRef } from "./vision/client";
import type { Hit } from "./vision/match";

export const PICKER_IPC = { invoke: "gh:picker" } as const;

interface HelperMonitor {
  id: string;
  primary: boolean;
  bounds: Region;
  scale: number;
}

interface CapturedFrame {
  monitor: string;
  x: number;
  y: number;
  w: number;
  h: number;
  stride: number;
  file: string;
  uniform: boolean;
}

type PickMode = "image" | "point" | "region";

/** What one picker window shows: a frozen monitor, or a picture from a file or the clipboard. */
interface PickerFrame {
  mode: PickMode;
  /** JPEG, base64 */
  image: string;
  w: number;
  h: number;
  /** a picture, not the screen: Enter takes all of it */
  whole?: boolean;
}

interface PickResult {
  index: number;
  x: number;
  y: number;
  w?: number;
  h?: number;
}

const SAMPLE_MAX = 1024;
/** a picture to cut a sample from: a whole 8K screenshot, not more */
const PICTURE_MAX = 8192;
const PICTURE_FILE_MAX = 40_000_000;

export class ScenarioScreen {
  private monitorsCache: Monitor[] | null = null;
  private vision: VisionClient;
  private dir = path.join(app.getPath("temp"), `ghost-hands-${process.pid}`);
  private captureCount = 0;
  private hints = new Map<string, Hit>();
  private ocrLangs: { tag: string; name: string }[] | null = null;
  private picker: { windows: BrowserWindow[]; resolve: (result: PickResult | null) => void; frames: PickerFrame[] } | null = null;
  private onDisplays = () => {
    this.monitorsCache = null;
  };

  constructor(
    private helper: Helper,
    private service: ScenarioService,
    private options: { language: () => string; hideMain(hidden: boolean): void; warn(text: string): void },
  ) {
    this.vision = new VisionClient((sha) => service.store.readAsset(sha), () => 120_000, options.warn);
  }

  init(): void {
    screen.on("display-added", this.onDisplays);
    screen.on("display-removed", this.onDisplays);
    screen.on("display-metrics-changed", this.onDisplays);
    fs.rm(this.dir, { recursive: true, force: true }).catch(() => undefined);

    this.service.vision = { find: (image, area, threshold, signal) => this.findImage(image, area, threshold, signal) };
    this.service.ocr = {
      find: (text, match, area, lang, signal) => this.findText(text, match, area, lang, signal),
      read: (area, lang, signal) => this.readText(area, lang, signal),
    };

    ipcMain.handle(PICKER_IPC.invoke, (event, method: string, arg: unknown) => {
      if (!this.picker || !this.owns(event.sender)) throw new Error("forbidden");

      const index = this.picker.windows.findIndex((window) => !window.isDestroyed() && window.webContents.id === event.sender.id);
      switch (method) {
        case "init":
          return { ...this.picker.frames[index], index, lang: this.options.language() };
        case "done":
          this.picker.resolve(arg && typeof arg === "object" ? ({ ...(arg as PickResult), index } as PickResult) : null);
          return true;
        default:
          this.picker.resolve(null);
          return true;
      }
    });
  }

  private owns(sender: WebContents): boolean {
    return Boolean(this.picker?.windows.some((window) => !window.isDestroyed() && window.webContents.id === sender.id));
  }

  /* ── monitors ── */

  async monitors(): Promise<Monitor[]> {
    if (this.monitorsCache) return this.monitorsCache;

    const listed = await this.helper.call<{ monitors: HelperMonitor[] }>("screen.list");
    const displays = screen.getAllDisplays();
    const near = (a: Rectangle, b: Region) => Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && Math.abs(a.width - b.w) <= 2 && Math.abs(a.height - b.h) <= 2;

    this.monitorsCache = listed.monitors.map((monitor, index) => {
      const display = displays.find((d) => near(screen.dipToScreenRect(null, d.bounds), monitor.bounds)) ?? displays[index];

      return {
        id: display ? String(display.id) : monitor.id,
        device: monitor.id,
        name: display?.label || monitor.id.replace(/^\\\\\.\\/, ""),
        primary: monitor.primary,
        bounds: monitor.bounds,
        scale: monitor.scale,
      };
    });
    return this.monitorsCache;
  }

  async displays(): Promise<DisplayInfo[]> {
    return (await this.monitors()).map((m) => ({ id: m.id, name: m.name, primary: m.primary, bounds: m.bounds, scale: m.scale }));
  }

  /** What to capture for an area: one rectangle, or whole monitors. */
  private async targets(area: SearchArea): Promise<{ rect?: Region; monitors?: Monitor[]; all: Monitor[] }> {
    const all = await this.monitors();

    if (area.region) {
      const rect = areaRect(all, area.region as RegionSel | Region);
      if (!rect) throw new NodeError("monitor-missing");
      return { rect, all };
    }

    const sel = area.monitors as MonitorSel;
    const context: { active?: Point | null; cursor?: Point | null } = {};
    if (sel?.mode === "active") {
      const fg = await this.helper.call<{ rect?: Region }>("window.foreground").catch(() => ({}) as { rect?: Region });
      context.active = fg.rect ? centerOf(fg.rect) : null;
    }
    if (sel?.mode === "cursor") context.cursor = await this.helper.call<Point>("cursor.get").catch(() => null);

    const monitors = selectMonitors(all, sel, context);
    if (!monitors.length) throw new NodeError("monitor-missing");
    return { monitors, all };
  }

  private async capture(area: SearchArea, format: "gray" | "bgra" = "gray"): Promise<{ frames: CapturedFrame[]; all: Monitor[] }> {
    const { rect, monitors, all } = await this.targets(area);
    const slot = this.captureCount++ % 16;
    const count = rect ? 1 : monitors!.length;
    const files = Array.from({ length: count }, (_, i) => path.join(this.dir, `frame-${slot}-${i}.raw`));
    const result = await this.helper.call<{ frames: CapturedFrame[] }>("screen.capture", { ...(rect ? { rect } : { monitors: monitors!.map((m) => m.device) }), format, files }, 15000);

    return { frames: result.frames, all };
  }

  /* ── find image ── */

  private async findImage(image: ImageRef, area: SearchArea, threshold: number, signal: AbortSignal): Promise<ImageMatch | null> {
    const { frames, all } = await this.capture(area);
    if (signal.aborted) return null;
    if (frames.every((frame) => frame.uniform)) throw new NodeError("capture-blocked");

    const refs: FrameRef[] = frames.map((frame) => ({
      ...frame,
      scale: all.find((m) => m.device === frame.monitor)?.scale ?? 1,
    }));
    const hit = await this.vision.match(image.asset, image.scale || 1, refs, Math.min(1, Math.max(0.5, threshold)), this.hints.get(image.asset) ?? null);

    if (!hit) return null;
    this.hints.set(image.asset, hit);

    const region = { x: hit.x, y: hit.y, w: hit.w, h: hit.h };
    return { point: centerOf(region), region, score: hit.score, monitor: all.find((m) => m.device === hit.monitor)?.name ?? hit.monitor };
  }

  /* ── text ── */

  async ocrLanguages(): Promise<{ tag: string; name: string }[]> {
    if (this.ocrLangs) return this.ocrLangs;

    const result = await this.helper.call<{ languages: { tag: string; name: string }[] }>("ocr.languages").catch(() => ({ languages: [] }));
    this.ocrLangs = result.languages;
    return this.ocrLangs;
  }

  /** "auto": Russian when installed (it reads Latin too), else the profile language. */
  private async language(lang: string): Promise<string | undefined> {
    if (lang && lang !== "auto") return lang;

    const languages = await this.ocrLanguages();
    return languages.find((l) => l.tag.toLowerCase().startsWith("ru"))?.tag;
  }

  private async ocr(area: SearchArea, lang: string): Promise<OcrLine[]> {
    const { rect, monitors } = await this.targets(area);
    const small = rect && rect.h < 400;
    const result = await this.helper.call<{ lines: OcrLine[] }>(
      "ocr.read",
      { ...(rect ? { rect } : { monitors: monitors!.map((m) => m.device) }), lang: await this.language(lang), upscale: small ? 2 : 1 },
      30000,
    );
    return result.lines;
  }

  private async findText(text: string, match: string, area: SearchArea, lang: string, signal: AbortSignal): Promise<TextMatch | null> {
    const lines = await this.ocr(area, lang);
    if (signal.aborted) return null;

    const hit = findText(lines, text, match);
    return hit ? { point: centerOf(hit.region), region: hit.region, text: hit.text } : null;
  }

  private async readText(area: SearchArea, lang: string, _signal: AbortSignal): Promise<string> {
    return linesText(await this.ocr(area, lang));
  }

  /* ── pickers: a sample, a point, an area ── */

  async captureTemplate(): Promise<ImageRef | null> {
    const picked = await this.pick("image");
    if (!picked || !picked.w || !picked.h) return null;

    const { frame, monitor, bgra } = picked.source;
    const w = Math.min(SAMPLE_MAX, Math.max(4, Math.round(picked.w)));
    const h = Math.min(SAMPLE_MAX, Math.max(4, Math.round(picked.h)));
    const x0 = Math.max(0, Math.min(frame.w - w, Math.round(picked.x)));
    const y0 = Math.max(0, Math.min(frame.h - h, Math.round(picked.y)));
    const crop = Buffer.alloc(w * h * 4);

    for (let row = 0; row < h; row++) bgra.copy(crop, row * w * 4, (y0 + row) * frame.stride + x0 * 4, (y0 + row) * frame.stride + (x0 + w) * 4);

    const png = nativeImage.createFromBitmap(crop, { width: w, height: h }).toPNG();
    const stored = await this.service.store.putAsset(png);
    return { asset: stored.asset, w: stored.w, h: stored.h, scale: monitor.scale };
  }

  /**
   * A sample cut from a picture the person has: a PNG or JPEG file, or the clipboard (Win+Shift+S).
   * The picture opens in a window; a frame around the element, or Enter for all of it.
   */
  async loadTemplate(source: "file" | "clipboard"): Promise<ImageRef | null> {
    if (this.picker) return null;

    const picture = source === "clipboard" ? await this.clipboardPicture() : await this.filePicture();
    if (!picture) return null;

    const { width, height } = picture.getSize();
    if (width < 4 || height < 4) throw new Error("bad-image");
    if (width > PICTURE_MAX || height > PICTURE_MAX) throw new Error("image-too-big");

    // the picture is shown on the display the person works on, at its size there when it fits
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const picked = await this.openPickers([{ frame: { mode: "image", image: picture.toJPEG(92).toString("base64"), w: width, h: height, whole: width <= SAMPLE_MAX && height <= SAMPLE_MAX }, bounds: this.pictureBounds(display, width, height), fullscreen: false }]);
    if (!picked || !picked.w || !picked.h) return null;

    const w = Math.min(SAMPLE_MAX, Math.max(4, Math.round(picked.w)));
    const h = Math.min(SAMPLE_MAX, Math.max(4, Math.round(picked.h)));
    const x = Math.max(0, Math.min(width - w, Math.round(picked.x)));
    const y = Math.max(0, Math.min(height - h, Math.round(picked.y)));
    const stored = await this.service.store.putAsset(picture.crop({ x, y, width: w, height: h }).toPNG());

    // a screenshot of this PC: its pixels are of the display where the person works
    return { asset: stored.asset, w: stored.w, h: stored.h, scale: display.scaleFactor };
  }

  private async filePicture(): Promise<NativeImage | null> {
    const result = await dialog.showOpenDialog({ title: t("templateFromFile"), properties: ["openFile"], filters: [{ name: t("imageFiles"), extensions: ["png", "jpg", "jpeg"] }] });
    const file = result.canceled ? null : result.filePaths[0];
    if (!file) return null;

    if ((await fs.stat(file)).size > PICTURE_FILE_MAX) throw new Error("image-too-big");
    const picture = nativeImage.createFromBuffer(await fs.readFile(file));
    if (picture.isEmpty()) throw new Error("bad-image");
    return picture;
  }

  private async clipboardPicture(): Promise<NativeImage> {
    for (const item of await clipboard.read()) {
      if (!item.types.includes("image/png")) continue;
      const blob = await item.getType("image/png");
      if (!(blob instanceof Blob) || blob.size > PICTURE_FILE_MAX) continue;
      const picture = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
      if (!picture.isEmpty()) return picture;
    }
    throw new Error("clipboard-empty");
  }

  /** A window for a picture: its size on the display when it fits in 90% of the work area. */
  private pictureBounds(display: Electron.Display, width: number, height: number): Rectangle {
    const area = display.workArea;
    const k = Math.min(1 / display.scaleFactor, (area.width * 0.9) / width, (area.height * 0.9) / height);
    const w = Math.max(560, Math.round(width * k));
    const h = Math.max(360, Math.round(height * k));
    return { x: Math.round(area.x + (area.width - w) / 2), y: Math.round(area.y + (area.height - h) / 2), width: w, height: h };
  }

  async pickPoint(): Promise<Point | null> {
    const picked = await this.pick("point");
    return picked ? { x: picked.source.frame.x + Math.round(picked.x), y: picked.source.frame.y + Math.round(picked.y) } : null;
  }

  async pickRegion(): Promise<RegionSel | null> {
    const picked = await this.pick("region");
    if (!picked || !picked.w || !picked.h) return null;
    return { monitor: keyOf(picked.source.monitor), x: Math.round(picked.x), y: Math.round(picked.y), w: Math.round(picked.w), h: Math.round(picked.h) };
  }

  /** Hides our window, freezes every monitor and lets the person pick on any of them. */
  private async pick(mode: PickMode): Promise<(PickResult & { source: { frame: CapturedFrame; monitor: Monitor; bgra: Buffer } }) | null> {
    if (this.picker) return null;

    this.options.hideMain(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));

      const all = await this.monitors();
      const { frames } = await this.capture({ monitors: { mode: "all" }, region: null }, "bgra");
      const sources = await Promise.all(
        frames.map(async (frame) => ({ frame, monitor: all.find((m) => m.device === frame.monitor) ?? all[0], bgra: await fs.readFile(frame.file) })),
      );

      const result = await this.openPickers(
        sources.map(({ frame, bgra }) => ({
          frame: { mode, image: nativeImage.createFromBitmap(bgra, { width: frame.w, height: frame.h }).toJPEG(85).toString("base64"), w: frame.w, h: frame.h },
          bounds: screen.screenToDipRect(null, { x: frame.x, y: frame.y, width: frame.w, height: frame.h }),
          fullscreen: true,
        })),
      );

      if (!result) return null;
      const source = sources[result.index];
      return source ? { ...result, source } : null;
    } finally {
      this.options.hideMain(false);
    }
  }

  /** A window per frame; the first answer (a pick, Esc, a closed window) closes them all. */
  private openPickers(items: { frame: PickerFrame; bounds: Rectangle; fullscreen: boolean }[]): Promise<PickResult | null> {
    return new Promise<PickResult | null>((resolve) => {
      // a late "closed" of an earlier picker's window must not end this one
      const session: NonNullable<ScenarioScreen["picker"]> = { windows: [], resolve: () => undefined, frames: items.map((item) => item.frame) };
      const finish = (value: PickResult | null) => {
        if (this.picker !== session) return;
        this.picker = null;
        for (const window of session.windows) if (!window.isDestroyed()) window.destroy();
        resolve(value);
      };

      session.resolve = finish;
      this.picker = session;
      session.windows = items.map((item) => this.pickerWindow(item.bounds, item.fullscreen, finish));
    });
  }

  private pickerWindow(bounds: Rectangle, fullscreen: boolean, finish: (value: PickResult | null) => void): BrowserWindow {
    const window = new BrowserWindow({
      ...bounds,
      frame: false,
      resizable: fullscreen,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      backgroundColor: "#000000",
      webPreferences: {
        preload: path.join(__dirname, "../preload/picker.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        devTools: !app.isPackaged,
      },
    });

    window.setMenu(null);
    window.setAlwaysOnTop(true, "screen-saver");
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.on("closed", () => finish(null));
    // Windows fits a new window into the work area: the bounds go on after it is shown
    window.once("ready-to-show", () => {
      window.setBounds(bounds);
      window.show();
      window.setBounds(bounds);
      if (fullscreen) window.setKiosk(true);
      window.focus();
    });
    load(window, "picker", {});
    return window;
  }

  dispose(): void {
    screen.off("display-added", this.onDisplays);
    screen.off("display-removed", this.onDisplays);
    screen.off("display-metrics-changed", this.onDisplays);
    ipcMain.removeHandler(PICKER_IPC.invoke);
    this.picker?.resolve(null);
    this.vision.dispose();
    fs.rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

