// Journals do not pile up: a full log file becomes an archive with its time in the name,
// archives and crash dumps older than a week, or over 10 MB in all, are removed.
// No electron here: vitest checks it on a temporary folder.
import { promises as fs } from "fs";
import path from "path";

export const KEEP_DAYS = 7;
export const MAX_BYTES = 10 * 1024 * 1024;
/** archives of main.log: main-2026-10-08T03-42-18.log, and main.old.log of older versions */
export const LOG_ARCHIVES = /^main(\.old|-[\dT-]+)\.log$/i;
export const CRASH_DUMPS = /\.dmp$/i;

export interface PruneOptions {
  match: RegExp;
  keepDays?: number;
  maxBytes?: number;
  now?: number;
}

/**
 * Remove files of `dir` that `match`: older than `keepDays`, then the oldest until the rest
 * fits into `maxBytes`. A missing folder or a locked file is skipped.
 * @returns names of the removed files
 */
export async function pruneFiles(dir: string, { match, keepDays = KEEP_DAYS, maxBytes = MAX_BYTES, now = Date.now() }: PruneOptions): Promise<string[]> {
  let names: string[];

  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }

  const files: { name: string; mtime: number; size: number }[] = [];

  for (const name of names) {
    if (!match.test(name)) continue;
    try {
      const stat = await fs.stat(path.join(dir, name));

      if (stat.isFile()) files.push({ name, mtime: stat.mtimeMs, size: stat.size });
    } catch {
      // removed meanwhile
    }
  }

  const cutoff = now - keepDays * 86_400_000;
  const removed: string[] = [];
  let total = 0;

  // newest first: they stay while they fit
  for (const file of files.sort((a, b) => b.mtime - a.mtime)) {
    if (file.mtime >= cutoff && total + file.size <= maxBytes) {
      total += file.size;
      continue;
    }
    try {
      await fs.unlink(path.join(dir, file.name));
      removed.push(file.name);
    } catch {
      // in use
    }
  }

  return removed;
}

/** "…/main.log" → "…/main-2026-10-08T03-42-18.log" */
export const archiveName = (file: string, date = new Date()): string => {
  const { dir, name, ext } = path.parse(file);

  return path.join(dir, `${name}-${date.toISOString().slice(0, 19).replace(/:/g, "-")}${ext}`);
};
