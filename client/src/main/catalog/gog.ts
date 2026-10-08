import path from "path";
import type { Helper } from "../system/helper";
import { emptyMatch, type CatalogApp } from "./types";

type Values = Record<string, unknown>;

const text = (values: Values, key: string): string => {
  const value = Object.entries(values).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];

  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
};

/** GOG game from its registry key; null for DLC (dependsOn) and broken keys. */
export function gogApp(key: string, values: Values, galaxyExe: string | null): CatalogApp | null {
  const id = text(values, "gameID") || key;
  const name = text(values, "gameName");
  const dir = text(values, "path");
  const exe = text(values, "exe");

  if (!name || !dir || text(values, "dependsOn") || text(values, "DLC") === "1") return null;

  const launch: CatalogApp["launch"] = galaxyExe
    ? { type: "exe", path: galaxyExe, args: `/command=runGame /gameId=${id} /path="${dir}"` }
    : { type: "exe", path: exe || path.join(dir, `${name}.exe`), args: text(values, "launchParam") || undefined, cwd: text(values, "workingDir") || dir };

  return {
    id: `gog:${id}`,
    name,
    kind: "game",
    source: "gog",
    launch,
    match: { ...emptyMatch(), dirs: [dir] },
    defaultEnabled: true,
    suggested: [],
    detail: `GOG · ${dir}`,
    removable: false,
  };
}

export async function scanGog(helper: Helper): Promise<{ apps: CatalogApp[]; watch: string[] }> {
  let galaxyExe: string | null = null;

  try {
    const { value } = await helper.call<{ value: unknown }>("registry.read", { hive: "HKLM", path: "SOFTWARE\\WOW6432Node\\GOG.com\\GalaxyClient\\paths", name: "client" });

    if (typeof value === "string" && value) galaxyExe = path.join(value, "GalaxyClient.exe");
  } catch {
    // no Galaxy: games start from their exe
  }

  try {
    const { subkeys } = await helper.call<{ subkeys: { name: string; values: Values }[] }>("registry.enum", { hive: "HKLM", path: "SOFTWARE\\WOW6432Node\\GOG.com\\Games" });

    return { apps: subkeys.map((subkey) => gogApp(subkey.name, subkey.values, galaxyExe)).filter((app): app is CatalogApp => Boolean(app)), watch: [] };
  } catch {
    return { apps: [], watch: [] };
  }
}
