import { promises as fs } from "fs";
import path from "path";
import { safeStorage } from "electron";
import log from "../log";
import type { ParentalRules, Usage } from "./accounting";
import { noAttempts, type PinAttempts, type PinHash } from "./pin";

/** Parental control of this PC as the skill last sent it, plus what the PC counted itself. */
export interface ParentalData {
  enabled: boolean;
  rev: number;
  rules: ParentalRules | null;
  pin: PinHash | null;
  grantUntil: number | null;
  /** the last "reset today" from the owner that was applied */
  resetAt: number | null;
  usage: Usage | null;
  attempts: PinAttempts;
  /** the account the PC is paired to: a new pairing to another one needs the PIN */
  ownerId: string | null;
}

export const emptyParental = (): ParentalData => ({
  enabled: false,
  rev: 0,
  rules: null,
  pin: null,
  grantUntil: null,
  resetAt: null,
  usage: null,
  attempts: noAttempts(),
  ownerId: null,
});

/**
 * parental.dat next to the settings, encrypted with the Windows user's DPAPI key (safeStorage):
 * the rules keep working without NODUS, and the file cannot be edited by hand. A deleted file
 * comes back from the skill on the next connection, with the time it counted.
 */
export class ParentalStore {
  private file: string;
  private writing: Promise<void> = Promise.resolve();

  constructor(dir: string) {
    this.file = path.join(dir, "parental.dat");
  }

  async load(): Promise<ParentalData> {
    try {
      const raw = await fs.readFile(this.file);
      const { result } = await safeStorage.decryptStringAsync(raw);

      return { ...emptyParental(), ...(JSON.parse(result) as Partial<ParentalData>) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.warn(`parental store: ${(error as Error).message}`);
      return emptyParental();
    }
  }

  /** Writes go one after another; the last one wins. */
  save(data: ParentalData): Promise<void> {
    const snapshot = JSON.stringify(data);

    this.writing = this.writing.then(async () => {
      const temp = `${this.file}.tmp`;

      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(temp, await safeStorage.encryptStringAsync(snapshot));
      await fs.rename(temp, this.file);
    }).catch((error) => log.warn(`parental store: ${(error as Error).message}`));

    return this.writing;
  }
}
