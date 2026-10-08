import { promises as fs } from "fs";
import path from "path";
import type { Helper } from "../system/helper";
import { emptyMatch, type CatalogApp } from "./types";

interface EpicManifest {
  DisplayName?: string;
  AppName?: string;
  CatalogNamespace?: string;
  CatalogItemId?: string;
  MainGameAppName?: string;
  InstallLocation?: string;
  LaunchExecutable?: string;
  bIsExecutable?: boolean;
  bIsIncompleteInstall?: boolean;
  AppCategories?: string[];
}

export async function manifestsDir(helper: Helper): Promise<string> {
  try {
    const { value } = await helper.call<{ value: unknown }>("registry.read", {
      hive: "HKLM",
      path: "SOFTWARE\\WOW6432Node\\Epic Games\\EpicGamesLauncher",
      name: "AppDataPath",
    });

    if (typeof value === "string" && value) return path.join(value, "Manifests");
  } catch {
    // default place
  }

  return path.join(process.env.ProgramData ?? "C:\\ProgramData", "Epic", "EpicGamesLauncher", "Data", "Manifests");
}

/**
 * One *.item manifest → app. Skipped (as Playnite does): unfinished installs,
 * DLC and hidden content, add-ons that cannot be launched, plugins.
 */
export function manifestApp(manifest: EpicManifest): CatalogApp | null {
  const categories = manifest.AppCategories ?? [];
  const launchable = categories.includes("addons/launchable");
  const game = categories.includes("games");

  if (!manifest.AppName || !manifest.DisplayName || !manifest.InstallLocation) return null;
  if (manifest.bIsIncompleteInstall || manifest.bIsExecutable === false || !manifest.LaunchExecutable) return null;
  if (categories.includes("hidden") || categories.some((category) => category.startsWith("plugins"))) return null;
  if (categories.includes("addons") && !launchable) return null;
  if (manifest.MainGameAppName && manifest.MainGameAppName !== manifest.AppName && !launchable) return null;

  const target = `${manifest.CatalogNamespace}:${manifest.CatalogItemId}:${manifest.AppName}`;

  return {
    id: `epic:${manifest.AppName}`,
    name: manifest.DisplayName,
    kind: game ? "game" : "app",
    source: "epic",
    launch: { type: "url", url: `com.epicgames.launcher://apps/${encodeURIComponent(target)}?action=launch&silent=true` },
    match: { ...emptyMatch(), dirs: [manifest.InstallLocation] },
    defaultEnabled: game,
    suggested: [],
    detail: `Epic Games · ${manifest.InstallLocation}`,
    removable: false,
  };
}

export async function scanEpic(helper: Helper): Promise<{ apps: CatalogApp[]; watch: string[] }> {
  const dir = await manifestsDir(helper);
  let files: string[] = [];

  try {
    files = (await fs.readdir(dir)).filter((file) => file.toLowerCase().endsWith(".item"));
  } catch {
    return { apps: [], watch: [] };
  }

  const apps: CatalogApp[] = [];

  for (const file of files) {
    try {
      const app = manifestApp(JSON.parse((await fs.readFile(path.join(dir, file), "utf8")).replace(/^\uFEFF/, "")));

      if (app) {
        await fs.access(app.match.dirs[0]);
        apps.push(app);
      }
    } catch {
      // broken manifest or the game folder is gone
    }
  }

  return { apps, watch: [dir] };
}
