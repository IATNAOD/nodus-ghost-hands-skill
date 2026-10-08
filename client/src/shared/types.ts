// Types shared by the main process, the preload script and the UI.

export type Feature = "launch" | "close" | "volume" | "media" | "power" | "lock" | "display" | "search" | "wake" | "toast";
export const FEATURES: Feature[] = ["launch", "close", "volume", "media", "power", "lock", "display", "search", "wake", "toast"];

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
}

export const IPC = {
  state: "gh:state",
  pairLink: "gh:pair-link",
  invoke: "gh:invoke",
} as const;

/** Methods of GhostApi called through one invoke channel: [method, ...args] */
export type InvokeMethod = Exclude<keyof GhostApi, "onState" | "onPairLink">;
