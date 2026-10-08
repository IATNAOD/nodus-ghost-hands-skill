import { promises as fs } from "fs";
import path from "path";
import { safeStorage } from "electron";
import log from "../log";

/**
 * The personal key, encrypted with the Windows user's DPAPI key (safeStorage)
 * in secure.json next to the settings. Async API: the sync one is going away.
 */
export class SecureStore {
  private file: string;
  private cached: string | null = null;

  constructor(dir: string) {
    this.file = path.join(dir, "secure.json");
  }

  async getKey(): Promise<string | null> {
    if (this.cached !== null) return this.cached || null;

    try {
      const { key } = JSON.parse(await fs.readFile(this.file, "utf8")) as { key?: string };

      if (!key) return (this.cached = "") || null;

      const result = await safeStorage.decryptStringAsync(Buffer.from(key, "base64"));

      this.cached = result.result;
      if (result.shouldReEncrypt) await this.setKey(this.cached);

      return this.cached || null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.warn(`secure store: ${(error as Error).message}`);
      this.cached = "";
      return null;
    }
  }

  async setKey(key: string | null): Promise<void> {
    this.cached = key ?? "";

    const encrypted = key ? (await safeStorage.encryptStringAsync(key)).toString("base64") : "";
    const temp = `${this.file}.tmp`;

    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(temp, JSON.stringify({ key: encrypted }), "utf8");
    await fs.rename(temp, this.file);
  }
}
