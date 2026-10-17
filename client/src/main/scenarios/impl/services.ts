import type { ImageRef, KeyCombo, MonitorSel, Point, Region, RegionSel, Value } from "../../../shared/scenarios/model";

// What node implementations may use. The runner builds one set per run (input holds, the
// guard and content protection belong to the run); tests pass fakes.

export interface ActionResult {
  ok: boolean;
  code?: string | null;
  data?: Record<string, unknown>;
}

export interface SearchArea {
  monitors: MonitorSel;
  /** a literal area (monitor-local) or a wired one (absolute) */
  region: RegionSel | Region | null;
}

export interface ImageMatch {
  point: Point;
  region: Region;
  score: number;
  monitor: string;
}

export interface TextMatch {
  point: Point;
  region: Region;
  text: string;
}

export interface ScenarioServices {
  /** an action of the remote protocol, with the local checks (parental limits) */
  perform(action: string, args: Record<string, unknown>): Promise<ActionResult>;
  apps: {
    state(appId: string): { running: boolean; front: boolean };
    active(): Promise<{ name: string; app: string; region: Region | null }>;
    focus(appId: string): Promise<void>;
    open(path: string, args: string): Promise<void>;
    openUrl(url: string): Promise<void>;
    name(appId: string): string;
  };
  system: {
    notify(title: string, text: string): void;
    say(text: string): Promise<void>;
    clipboardRead(): Promise<string>;
    clipboardWrite(text: string): Promise<void>;
    volume(): Promise<{ level: number; muted: boolean }>;
    search(query: string, engine: string): Promise<void>;
  };
  input: {
    keys(combo: KeyCombo, mode: "press" | "down" | "up", holdMs: number, repeat: number): Promise<void>;
    text(text: string, mode: "unicode" | "keys" | "paste", intervalMs: number): Promise<void>;
    click(point: Point, button: string, double: boolean, holdMs: number, returnCursor: boolean): Promise<void>;
    move(point: Point, smoothMs: number): Promise<void>;
    drag(from: Point, to: Point, button: string, durationMs: number): Promise<void>;
    scroll(amount: number, horizontal: boolean, point: Point | null): Promise<void>;
    cursor(): Promise<Point>;
    releaseAll(): Promise<void>;
  };
  vision: {
    find(image: ImageRef, area: SearchArea, threshold: number, signal: AbortSignal): Promise<ImageMatch | null>;
  };
  ocr: {
    find(text: string, match: string, area: SearchArea, lang: string, signal: AbortSignal): Promise<TextMatch | null>;
    read(area: SearchArea, lang: string, signal: AbortSignal): Promise<string>;
  };
  scenarios: {
    run(id: string, text: string, wait: boolean, signal: AbortSignal): Promise<{ status: string; output: Value }>;
  };
  now(): number;
}
