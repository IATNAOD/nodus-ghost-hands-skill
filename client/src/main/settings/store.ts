import { promises as fs } from "fs";
import path from "path";
import { EventEmitter } from "events";
import log from "../log";
import { defaultSettings, type Settings } from "./defaults";
import type { Language } from "../../shared/types";

/** Deep merge of saved values over defaults: new fields of new versions get defaults. */
const merge = <T>(base: T, saved: unknown): T => {
  if (!saved || typeof saved !== "object" || Array.isArray(saved) || !base || typeof base !== "object" || Array.isArray(base)) {
    return (saved === undefined ? base : (saved as T));
  }

  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };

  for (const [key, value] of Object.entries(saved as Record<string, unknown>)) {
    const current = (base as Record<string, unknown>)[key];

    out[key] = current && typeof current === "object" && !Array.isArray(current) && key !== "overrides" ? merge(current, value) : value;
  }

  return out as T;
};

/**
 * settings.json in the user data folder. Writes are atomic (temp file + rename)
 * and debounced; every change emits "change".
 */
export class SettingsStore extends EventEmitter {
  private file: string;
  private data: Settings;
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(dir: string, language: Language) {
    super();
    this.file = path.join(dir, "settings.json");
    this.data = defaultSettings(language);
  }

  async load(): Promise<Settings> {
    try {
      const raw = await fs.readFile(this.file, "utf8");

      this.data = merge(this.data, JSON.parse(raw.replace(/^﻿/, "")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.warn(`settings: ${(error as Error).message}, using defaults`);
    }

    return this.data;
  }

  get(): Settings {
    return this.data;
  }

  /**
   * Change settings. `skill` - the change matters to the skill: the config
   * revision grows and the config is sent again.
   */
  update(change: (draft: Settings) => void, { skill = true }: { skill?: boolean } = {}): void {
    const draft = structuredClone(this.data);

    change(draft);
    if (skill) draft.configRev = this.data.configRev + 1;
    this.data = draft;
    this.scheduleWrite();
    this.emit("change", { skill });
  }

  private scheduleWrite(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writing = this.writing.then(() => this.write()).catch((error) => log.error(`settings write: ${(error as Error).message}`));
    }, 300);
  }

  private async write(): Promise<void> {
    const temp = `${this.file}.tmp`;

    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(temp, JSON.stringify(this.data, null, 2), "utf8");
    await fs.rename(temp, this.file);
  }

  /** Write now (before quitting). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.writing = this.writing.then(() => this.write());
    }
    await this.writing.catch(() => undefined);
  }
}
