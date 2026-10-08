import type { Feature, Language, Prefs, UiPrefs } from "../../shared/types";
import { FEATURES } from "../../shared/types";

export interface CustomApp {
  id: string;
  type: "exe" | "site";
  name: string;
  /** exe or shortcut (.lnk, .url) */
  path?: string;
  args?: string;
  /** what a shortcut points to: the exe whose processes are this app */
  target?: string;
  url?: string;
}

export interface StartPick {
  appId: string;
  name: string;
  target: string | null;
}

export interface AppOverride {
  enabled?: boolean;
  aliases?: string[];
  spoken?: string;
}

export interface Settings {
  schemaVersion: 1;
  server: { host: string; port: number; lastIp: string | null };
  device: { id: string | null; name: string; aliases: string[]; shared: boolean };
  paired: { owner: string; at: number } | null;
  apps: {
    overrides: Record<string, AppOverride>;
    custom: CustomApp[];
    start: StartPick[];
  };
  features: Record<Feature, boolean>;
  prefs: Prefs;
  ui: UiPrefs;
  /** grows with every change of what the skill should know */
  configRev: number;
}

export const DEFAULT_HOST = "project-nod.local";
export const DEFAULT_PORT = 47300;

export const defaultSettings = (language: Language = "ru"): Settings => ({
  schemaVersion: 1,
  server: { host: DEFAULT_HOST, port: DEFAULT_PORT, lastIp: null },
  device: { id: null, name: "", aliases: [], shared: false },
  paired: null,
  apps: { overrides: {}, custom: [], start: [] },
  features: Object.fromEntries(FEATURES.map((feature) => [feature, true])) as Record<Feature, boolean>,
  prefs: {
    confirmPower: true,
    searchEngine: language === "ru" ? "yandex" : "google",
    volumeStep: 10,
    forceCloseSec: 0,
    shareRunning: true,
    paused: false,
    countdownSec: 15,
  },
  ui: { language, startHidden: true, autostart: true, closeToTray: true, autoUpdate: true },
  configRev: 1,
});
