import { promises as fs } from "fs";
import path from "path";
import type { Helper } from "../system/helper";
import { parseVdf, get, getString } from "./vdf";
import { emptyMatch, normalizePath, type CatalogApp } from "./types";

// not games: Steamworks redistributables, runtimes, Proton, SteamVR tools
const HIDDEN = new Set(["228980", "1070560", "1391110", "1628350", "1493710", "1826330", "2180100", "250820"]);
const NOT_A_GAME = /redistributable|dedicated server|soundtrack|\bsdk\b|proton|steam linux runtime|steamworks|benchmark|playtest/i;

export interface SteamInstall {
  root: string;
  libraries: string[];
}

/** Steam folder from the registry (SteamPath is written in lower case with "/") */
export async function findSteam(helper: Helper): Promise<string | null> {
  const reads = [
    { hive: "HKCU", path: "Software\\Valve\\Steam", name: "SteamPath" },
    { hive: "HKLM", path: "SOFTWARE\\WOW6432Node\\Valve\\Steam", name: "InstallPath" },
    { hive: "HKLM", path: "SOFTWARE\\Valve\\Steam", name: "InstallPath" },
  ];

  for (const read of reads) {
    try {
      const { value } = await helper.call<{ value: unknown }>("registry.read", read);

      if (typeof value === "string" && value) return path.normalize(value);
    } catch {
      // next place
    }
  }

  return null;
}

/** Library folders from libraryfolders.vdf, old and new format. */
export function libraryPaths(vdfText: string, root: string): string[] {
  const data = parseVdf(vdfText);
  const folders = get(data, "libraryfolders") ?? get(data, "LibraryFolders");
  // the registry says "d:/steam", the file "D:\\steam": one library, spelled as in the file
  const out = new Map<string, string>([[normalizePath(root), path.normalize(root)]]);

  if (folders && typeof folders === "object") {
    for (const [key, value] of Object.entries(folders)) {
      if (!/^\d+$/.test(key)) continue;

      const folder = typeof value === "string" ? value : getString(value, "path");

      if (folder) out.set(normalizePath(folder), path.normalize(folder));
    }
  }

  return [...out.values()];
}

/** One appmanifest_*.acf → app, or null when not installed or not a game. */
export function manifestApp(acfText: string, library: string): CatalogApp | null {
  const state = get(parseVdf(acfText), "AppState");
  const appId = getString(state, "appid");
  const name = getString(state, "name");
  const installDir = getString(state, "installdir");
  const flags = Number(getString(state, "StateFlags"));

  // bit 4 - fully installed (4 or 6 while updating)
  if (!appId || !name || !(flags & 4) || HIDDEN.has(appId)) return null;

  const dir = path.join(library, "steamapps", "common", installDir);

  return {
    id: `steam:${appId}`,
    name,
    kind: "game",
    source: "steam",
    launch: { type: "url", url: `steam://rungameid/${appId}` },
    match: { ...emptyMatch(), dirs: installDir ? [dir] : [] },
    defaultEnabled: !NOT_A_GAME.test(name),
    suggested: [],
    detail: `Steam · ${dir}`,
    removable: false,
  };
}

export async function scanSteam(helper: Helper): Promise<{ apps: CatalogApp[]; watch: string[] }> {
  const root = await findSteam(helper);

  if (!root) return { apps: [], watch: [] };

  let libraries = [root];

  try {
    libraries = libraryPaths(await fs.readFile(path.join(root, "steamapps", "libraryfolders.vdf"), "utf8"), root);
  } catch {
    // only the main library
  }

  const apps: CatalogApp[] = [];
  const seen = new Set<string>();

  for (const library of libraries) {
    const dir = path.join(library, "steamapps");
    let files: string[] = [];

    try {
      files = (await fs.readdir(dir)).filter((file) => /^appmanifest_\d+\.acf$/i.test(file));
    } catch {
      continue;
    }

    for (const file of files) {
      try {
        const app = manifestApp(await fs.readFile(path.join(dir, file), "utf8"), library);

        if (app && !seen.has(app.id)) {
          seen.add(app.id);
          apps.push(app);
        }
      } catch {
        // a broken manifest: skip it
      }
    }
  }

  // the Steam client itself
  apps.push({
    id: "steam:client",
    name: "Steam",
    kind: "app",
    source: "steam",
    launch: { type: "url", url: "steam://open/main" },
    match: { ...emptyMatch(), exes: [path.join(root, "steam.exe")] },
    defaultEnabled: true,
    suggested: ["стим"],
    detail: root,
    removable: false,
  });

  return { apps, watch: libraries.map((library) => path.join(library, "steamapps")) };
}
