import path from "path";
import type { AppKind, AppSource } from "../../shared/types";

export type LaunchSpec =
  | { type: "url"; url: string }
  | { type: "exe"; path: string; args?: string; cwd?: string }
  | { type: "aumid"; appId: string }
  | { type: "browser" };

/** How to find the processes of an app: by install folder, exe path, exe file name, AppUserModelID */
export interface MatchSpec {
  dirs: string[];
  exes: string[];
  names: string[];
  aumids: string[];
}

export interface CatalogApp {
  id: string;
  name: string;
  kind: AppKind;
  source: AppSource;
  launch: LaunchSpec;
  match: MatchSpec;
  /** a new game is on, a redistributable or a dedicated server is off */
  defaultEnabled: boolean;
  /** names suggested before the person edits them: dictionary, built-in */
  suggested: string[];
  detail: string;
  removable: boolean;
}

/** An app with the person's choices applied */
export interface ResolvedApp extends CatalogApp {
  enabled: boolean;
  aliases: string[];
  spoken: string;
}

export const emptyMatch = (): MatchSpec => ({ dirs: [], exes: [], names: [], aumids: [] });

/** Windows paths compare without case and with one kind of slash */
export const normalizePath = (value: string): string => value.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();

/** Does a process belong to an app: inside its folder, its exe, its exe name, its AUMID. */
export function belongsTo(match: MatchSpec, proc: { exe: string | null; aumid?: string | null }): boolean {
  const exe = proc.exe ? normalizePath(proc.exe) : null;

  if (exe) {
    if (match.exes.some((item) => normalizePath(item) === exe)) return true;
    if (match.dirs.some((dir) => dir && exe.startsWith(`${normalizePath(dir)}\\`))) return true;
    if (match.names.includes(path.win32.basename(exe))) return true;
  }

  return Boolean(proc.aumid && match.aumids.some((aumid) => aumid.toLowerCase() === proc.aumid!.toLowerCase()));
}
