// Types shared by the main process, the preload script and the UI.
import type { ImageRef, Point, RegionSel, RunEvent, RunInfo, RunRecord, Scenario, ScenarioSummary, Value } from "./scenarios/model";
import type { Issue } from "./scenarios/validate";

export type Feature = "launch" | "close" | "volume" | "media" | "power" | "lock" | "display" | "search" | "wake" | "toast" | "scenarios";
export const FEATURES: Feature[] = ["launch", "close", "volume", "media", "power", "lock", "display", "search", "wake", "toast", "scenarios"];

export type SearchEngine = "google" | "yandex" | "bing" | "duckduckgo";
export type AppKind = "game" | "app" | "site";
export type AppSource = "steam" | "epic" | "gog" | "start" | "custom" | "url" | "virtual";
export type Language = "ru" | "en";

export interface Prefs {
  confirmPower: boolean;
  searchEngine: SearchEngine;
  volumeStep: number;
  /** 0 - never force; otherwise kill an app that did not close after N seconds */
  forceCloseSec: number;
  shareRunning: boolean;
  paused: boolean;
  /** seconds of the on-screen countdown before shutdown, restart, sleep; 0 - none */
  countdownSec: number;
}

export interface UiPrefs {
  language: Language;
  startHidden: boolean;
  autostart: boolean;
  closeToTray: boolean;
  autoUpdate: boolean;
  /** the global hotkey that stops every scenario run (Electron accelerator) */
  scenarioPanic: string;
}

export interface AppView {
  id: string;
  name: string;
  kind: AppKind;
  source: AppSource;
  enabled: boolean;
  aliases: string[];
  /** aliases suggested by the dictionary or the name, before the person edited them */
  suggested: string[];
  spoken: string;
  running: boolean;
  /** custom apps, sites and Start menu picks can be removed */
  removable: boolean;
  /** path, URL or launcher, for the list */
  detail: string;
  warnings: { alias: string; code: string }[];
}

export type ConnectionStatus =
  | "unpaired"
  | "connecting"
  | "online"
  | "offline"
  | "auth-failed"
  | "removed"
  | "name-taken"
  | "proto-unsupported"
  | "rate-limited";

export interface CommandLogEntry {
  at: number;
  action: string;
  target: string;
  ok: boolean;
  code: string | null;
}

export interface UpdateState {
  status: "disabled" | "idle" | "checking" | "available" | "downloading" | "ready" | "none" | "error";
  version: string | null;
  percent: number | null;
  error: string | null;
}

export interface UiState {
  version: string;
  paired: boolean;
  connection: {
    status: ConnectionStatus;
    host: string;
    port: number;
    address: string | null;
    owner: string;
    error: string | null;
    since: number | null;
  };
  device: { id: string | null; name: string; aliases: string[]; shared: boolean };
  nameError: string | null;
  apps: AppView[];
  scanning: boolean;
  features: Record<Feature, boolean>;
  prefs: Prefs;
  ui: UiPrefs;
  wol: { mac: string | null; adapter: string | null };
  countdown: { action: "shutdown" | "restart" | "sleep"; endsAt: number } | null;
  scheduled: { action: string; at: number } | null;
  update: UpdateState;
  log: CommandLogEntry[];
  helper: { ok: boolean; error: string | null };
  /** the skill this PC talks to: its version (null before the first connection) and match threshold */
  skill: { version: string | null; accept: number };
  parental: ParentalView;
  scenarios: ScenarioSummary[];
  /** runs going on now */
  runs: RunInfo[];
}

/* ── scenarios ── */

export interface VariablesView {
  global: Record<string, Value>;
  scenarios: Record<string, Record<string, Value>>;
}

export type ScenarioStart = { ok: true; runId: string; name: string; already?: boolean; queued?: boolean } | { ok: false; code: string };

/** A display for the monitor pickers: Electron id, physical bounds of the virtual desktop. */
export interface DisplayInfo {
  id: string;
  name: string;
  primary: boolean;
  /** physical pixels */
  bounds: { x: number; y: number; w: number; h: number };
  scale: number;
}

/** What an imported scenario would do, shown before it is added. */
export interface ImportPreview {
  token: string;
  name: string;
  description: string;
  steps: number;
  launches: string[];
  paths: string[];
  urls: string[];
  keys: string[];
  clicks: boolean;
  text: boolean;
  power: string[];
  say: boolean;
  hotkeys: string[];
  schedules: string[];
}

/** A key while a hotkey is recorded; "stopped" - the capture ended by itself (15 s). */
export type CapturedKey = { type: "down" | "up"; code: string } | { type: "stopped" };

/** Would NODUS understand the voice name of a scenario? */
export interface ScenarioNameCheck {
  /** each name: what "запусти <name> на компьютере" gives */
  names: { name: string; ok: boolean; intent: string | null; reason: "ok" | "reserved" | "same-as-app" | "duplicate" | "ambiguous" | "other-intent" | "empty"; other?: string }[];
}

/** Parental control in short: the main window and the tray. */
export interface ParentalView {
  enabled: boolean;
  granted: boolean;
  grantUntil: number | null;
  pcLeftSec: number | null;
  gamesLeftSec: number | null;
  locked: "pc" | "games" | null;
}

export type ParentalKind = "pc" | "games";

export interface ParentalKindStatus {
  /** today's limit with the extensions; null - no limit */
  limitSec: number | null;
  usedSec: number;
  leftSec: number | null;
  near: boolean;
  reached: boolean;
  extendsLeft: number;
  extendMinutes: number;
}

/** What the parental pages (the notice and the lock) show. */
export interface ParentalPageState {
  notice: "games-near" | "pc-near" | "games-over" | null;
  status: { granted: boolean; grantUntil: number | null; pc: ParentalKindStatus; games: ParentalKindStatus } | null;
  pinSet: boolean;
  /** seconds before the next PIN try */
  waitSec: number;
}

/** window.ghp: the only API of the parental pages. */
export interface ParentalApi {
  get(): Promise<ParentalPageState>;
  extend(kind: ParentalKind): Promise<boolean>;
  unlock(pin: string): Promise<{ ok: boolean; waitSec: number; noPin?: boolean }>;
  dismiss(): Promise<void>;
  onState(listener: () => void): () => void;
}

export const PARENTAL_IPC = { invoke: "gh:parental", state: "gh:parental-state" } as const;

export interface PairRequest {
  key: string;
  name: string;
  shared: boolean;
  host: string;
  port: number;
  autostart: boolean;
  /** a PC under parental control is paired again only with the PIN */
  pin?: string;
}

export type PairResult = { ok: true } | { ok: false; code: string };

export interface PairLink {
  key: string;
  host: string;
  port: number;
}

export interface StartAppView {
  appId: string;
  name: string;
  added: boolean;
}

export interface PhraseMatch {
  spoken: string;
  status: "match" | "weak" | "ambiguous" | "none";
  /** best first; several when NODUS would ask which one */
  names: string[];
  /** 0..1 */
  score: number | null;
}

export interface PhraseCheck {
  intent: string | null;
  score: number | null;
  params: Record<string, unknown> | null;
  /** launch and close: what each named object matches on this PC */
  apps: PhraseMatch[];
}

export interface AppPatch {
  enabled?: boolean;
  aliases?: string[];
  spoken?: string;
}

export interface NewApp {
  type: "exe" | "site";
  name: string;
  path?: string;
  url?: string;
  aliases?: string[];
}

/** What the preload script exposes as window.gh */
export interface GhostApi {
  getState(): Promise<UiState>;
  onState(listener: (state: UiState) => void): () => void;
  pair(request: PairRequest): Promise<PairResult>;
  unpair(): Promise<void>;
  reconnect(): Promise<void>;
  setDevice(patch: Partial<UiState["device"]>): Promise<void>;
  setServer(server: { host: string; port: number }): Promise<void>;
  setApp(id: string, patch: AppPatch): Promise<void>;
  addApp(app: NewApp): Promise<{ ok: boolean; code?: string }>;
  removeApp(id: string): Promise<void>;
  listStartApps(): Promise<StartAppView[]>;
  addStartApps(appIds: string[]): Promise<void>;
  pickExecutable(): Promise<{ path: string; name: string } | null>;
  rescan(): Promise<void>;
  testLaunch(id: string): Promise<{ ok: boolean; code: string | null }>;
  setFeatures(patch: Partial<Record<Feature, boolean>>): Promise<void>;
  setPrefs(patch: Partial<Prefs>): Promise<void>;
  setUi(patch: Partial<UiPrefs>): Promise<void>;
  checkPhrase(text: string): Promise<PhraseCheck>;
  checkUpdates(): Promise<void>;
  installUpdate(): Promise<void>;
  openLogs(): Promise<void>;
  openExternal(url: string): Promise<void>;
  cancelCountdown(): Promise<void>;
  /** the last deep link ghosthands://pair?key=..., once */
  takePairLink(): Promise<PairLink | null>;
  /** a deep link arrived: call takePairLink() */
  onPairLink(listener: () => void): () => void;

  getScenario(id: string): Promise<{ scenario: Scenario; issues: Issue[] } | null>;
  createScenario(name: string): Promise<Scenario>;
  saveScenario(scenario: Scenario): Promise<{ scenario: Scenario; issues: Issue[] }>;
  deleteScenario(id: string): Promise<void>;
  runScenario(id: string, options?: { fromNodeId?: string }): Promise<ScenarioStart>;
  stopScenario(selector: { runId?: string; scenarioId?: string; all?: boolean }): Promise<number>;
  getRuns(scenarioId?: string): Promise<RunInfo[]>;
  getRunLog(runId: string): Promise<RunRecord | null>;
  /** live run events for the editor while it is open */
  setRunEvents(on: boolean): Promise<void>;
  onRunEvents(listener: (events: RunEvent[]) => void): () => void;
  /** "open at the failing step" from a notification */
  onOpenScenario(listener: (target: { id: string; nodeId?: string }) => void): () => void;
  getVariables(): Promise<VariablesView>;
  setVariable(scope: "scenario" | "global", scenarioId: string, name: string, value: Value): Promise<void>;
  deleteVariable(scope: "scenario" | "global", scenarioId: string, name: string): Promise<void>;
  /** a sample as a data: URL for the editor */
  getAsset(asset: string): Promise<string | null>;
  exportScenario(id: string): Promise<boolean>;
  importScenario(): Promise<ImportPreview | null>;
  confirmImport(token: string): Promise<Scenario>;
  captureTemplate(): Promise<ImageRef | null>;
  /** a sample cut from a picture the person has: a PNG/JPEG file or the clipboard; errors: clipboard-empty, bad-image, image-too-big */
  loadTemplate(source: "file" | "clipboard"): Promise<ImageRef | null>;
  pickPoint(): Promise<Point | null>;
  pickRegion(): Promise<RegionSel | null>;
  listDisplays(): Promise<DisplayInfo[]>;
  getOcrLanguages(): Promise<{ tag: string; name: string }[]>;
  /** is an accelerator free for a scenario hotkey */
  checkHotkey(accelerator: string, scenarioId: string): Promise<{ ok: boolean; reason?: "invalid" | "taken" | "duplicate" | "panic" }>;
  /** while the key recorder has focus, global hotkeys are off */
  suspendHotkeys(on: boolean): Promise<void>;
  /**
   * Record keys before Windows sees them (Win+D, Alt+Tab): on - true when the helper took the
   * keyboard, they come to onCapturedKey; false - the window's own key events are all there is.
   */
  captureKeys(on: boolean): Promise<boolean>;
  onCapturedKey(listener: (key: CapturedKey) => void): () => void;
  checkScenarioName(id: string, names: string[]): Promise<ScenarioNameCheck>;
}

export const IPC = {
  state: "gh:state",
  pairLink: "gh:pair-link",
  invoke: "gh:invoke",
  runEvents: "gh:run-events",
  openScenario: "gh:open-scenario",
  capturedKey: "gh:captured-key",
} as const;

/** Methods of GhostApi called through one invoke channel: [method, ...args] */
export type InvokeMethod = Exclude<keyof GhostApi, "onState" | "onPairLink" | "onRunEvents" | "onOpenScenario" | "onCapturedKey">;
