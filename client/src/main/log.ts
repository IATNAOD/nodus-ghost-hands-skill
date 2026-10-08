import { renameSync } from "fs";
import path from "path";
import log from "electron-log/main";
import { archiveName, CRASH_DUMPS, LOG_ARCHIVES, pruneFiles } from "./logfiles";

// %APPDATA%/Ghost Hands/logs/main.log; keys and tokens never go here.
// A full file (1 MB) becomes main-<time>.log; archives live a week, 10 MB in all.
log.transports.file.level = "info";
log.transports.file.maxSize = 1024 * 1024;
log.transports.file.archiveLogFn = (file) => {
  try {
    renameSync(file.path, archiveName(file.path));
  } catch {
    // locked: start over in the same file rather than grow it
    file.clear();
  }
};
log.transports.console.level = process.env.NODE_ENV === "development" ? "debug" : "warn";

/** Old journals out: log archives and crash dumps. */
export async function pruneLogs(crashDumps: string | null): Promise<void> {
  const removed = [
    ...(await pruneFiles(path.dirname(log.transports.file.getFile().path), { match: LOG_ARCHIVES })),
    ...(crashDumps ? await pruneFiles(path.join(crashDumps, "reports"), { match: CRASH_DUMPS }) : []),
  ];

  if (removed.length) log.info(`removed old journals: ${removed.join(", ")}`);
}

export default log;
