import { mkdtemp, readdir, rm, utimes, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { archiveName, CRASH_DUMPS, LOG_ARCHIVES, pruneFiles } from "../src/main/logfiles";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 8, 12);
let dir = "";

/** A file of `kb` kilobytes changed `days` ago. */
const file = async (name: string, days: number, kb = 1) => {
  const full = path.join(dir, name);
  const time = new Date(NOW - days * DAY);

  await writeFile(full, Buffer.alloc(kb * 1024));
  await utimes(full, time, time);
};

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("journals", () => {
  it("archives get the time in the name, next to the log", () => {
    expect(archiveName(path.join("logs", "main.log"), new Date(Date.UTC(2026, 9, 8, 3, 42, 18, 512)))).toBe(path.join("logs", "main-2026-10-08T03-42-18.log"));
    expect(LOG_ARCHIVES.test("main-2026-10-08T03-42-18.log")).toBe(true);
    expect(LOG_ARCHIVES.test("main.old.log")).toBe(true);
    expect(LOG_ARCHIVES.test("main.log")).toBe(false);
  });

  it("removes archives older than a week and keeps the current log", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "gh-logs-"));
    await file("main.log", 30);
    await file("main-2026-09-01T10-00-00.log", 37);
    await file("main.old.log", 8);
    await file("main-2026-10-07T10-00-00.log", 1);
    await file("notes.txt", 60);

    const removed = await pruneFiles(dir, { match: LOG_ARCHIVES, now: NOW });

    expect(removed.sort()).toEqual(["main-2026-09-01T10-00-00.log", "main.old.log"]);
    expect((await readdir(dir)).sort()).toEqual(["main-2026-10-07T10-00-00.log", "main.log", "notes.txt"]);
  });

  it("keeps the newest archives within the size limit", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "gh-logs-"));
    await file("main-2026-10-08T01-00-00.log", 0, 600);
    await file("main-2026-10-07T01-00-00.log", 1, 600);
    await file("main-2026-10-06T01-00-00.log", 2, 600);

    const removed = await pruneFiles(dir, { match: LOG_ARCHIVES, maxBytes: 1300 * 1024, now: NOW });

    expect(removed).toEqual(["main-2026-10-06T01-00-00.log"]);
  });

  it("crash dumps go after a week too; a missing folder is fine", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "gh-dumps-"));
    await file("a.dmp", 10);
    await file("b.dmp", 2);

    expect(await pruneFiles(dir, { match: CRASH_DUMPS, now: NOW })).toEqual(["a.dmp"]);
    expect(await pruneFiles(path.join(dir, "missing"), { match: CRASH_DUMPS, now: NOW })).toEqual([]);
  });
});
