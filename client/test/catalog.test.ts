import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { get, getString, parseVdf } from "../src/main/catalog/vdf";
import { libraryPaths, manifestApp as steamApp } from "../src/main/catalog/steam";
import { manifestApp as epicApp } from "../src/main/catalog/epic";
import { gogApp } from "../src/main/catalog/gog";
import { dictionaryAliases } from "../src/main/catalog/aliases";

// fixtures are real files from a Windows PC, without the owner's ids
const fixture = (...parts: string[]) => readFileSync(path.join(__dirname, "fixtures", ...parts), "utf8");
const epic = (name: string) => JSON.parse(fixture("epic", name));

describe("vdf", () => {
  it("reads nested objects, escapes and comments", () => {
    const data = parseVdf('// comment\n"Root"\n{\n\t"path"\t\t"D:\\\\Games\\\\Steam"\n\t"quote"\t"say \\"hi\\""\n\t"empty"\t""\n\t"child" { "a" "1" }\n}\n');
    const root = get(data, "root");

    expect(getString(root, "PATH")).toBe("D:\\Games\\Steam");
    expect(getString(root, "quote")).toBe('say "hi"');
    expect(getString(root, "empty")).toBe("");
    expect(getString(get(root, "child"), "a")).toBe("1");
  });

  it("survives a BOM and unquoted tokens", () => {
    const data = parseVdf('\uFEFF"AppState" { appid 570 "name" "Dota 2" }');

    expect(getString(get(data, "AppState"), "appid")).toBe("570");
  });
});

describe("steam", () => {
  it("finds libraries in the new format, spelled as in the file", () => {
    expect(libraryPaths(fixture("steam", "libraryfolders.vdf"), "d:/steam")).toEqual(["D:\\steam", "E:\\SteamLibrary"]);
  });

  it("finds libraries in the old format", () => {
    expect(libraryPaths(fixture("steam", "libraryfolders-old.vdf"), "C:\\Program Files (x86)\\Steam")).toEqual([
      "C:\\Program Files (x86)\\Steam",
      "D:\\SteamLibrary",
      "E:\\Games\\Steam",
    ]);
  });

  it("turns an installed game into an app that starts through Steam", () => {
    const app = steamApp(fixture("steam", "appmanifest_570.acf"), "D:\\steam");

    expect(app).toMatchObject({
      id: "steam:570",
      name: "Dota 2",
      kind: "game",
      source: "steam",
      launch: { type: "url", url: "steam://rungameid/570" },
      defaultEnabled: true,
    });
    expect(app!.match.dirs).toEqual(["D:\\steam\\steamapps\\common\\dota 2 beta"]);
  });

  it("skips redistributables and apps that are not installed", () => {
    expect(steamApp(fixture("steam", "appmanifest_228980.acf"), "D:\\steam")).toBeNull();
    expect(steamApp(fixture("steam", "appmanifest_1007.acf"), "D:\\steam")).toBeNull();
  });
});

describe("epic", () => {
  it("launches a game through the launcher URI", () => {
    const app = epicApp(epic("satisfactory.item"));

    expect(app).toMatchObject({ id: "epic:CrabEA", name: "Satisfactory", kind: "game", defaultEnabled: true });
    expect(app!.launch).toEqual({
      type: "url",
      url: "com.epicgames.launcher://apps/crab%3Ab915dfe8dcf74770841c82a4162dc954%3ACrabEA?action=launch&silent=true",
    });
    expect(app!.match.dirs).toEqual(["E:\\EpicGames\\SatisfactoryEarlyAccess"]);
  });

  it("keeps launchable add-ons as programs, turned off", () => {
    expect(epicApp(epic("uefn.item"))).toMatchObject({ id: "epic:Fortnite_Studio", kind: "app", defaultEnabled: false });
    expect(epicApp(epic("fortnite.item"))).toMatchObject({ id: "epic:Fortnite", kind: "game" });
  });

  it("skips hidden content, DLC and unfinished installs", () => {
    expect(epicApp(epic("hidden-content.item"))).toBeNull();
    expect(epicApp(epic("dlc.item"))).toBeNull();
    expect(epicApp(epic("incomplete.item"))).toBeNull();
  });
});

describe("gog", () => {
  // registry values of HKLM\SOFTWARE\WOW6432Node\GOG.com\Games\1744110647
  const dredge = {
    gameID: "1744110647",
    gameName: "DREDGE",
    path: "E:\\games\\DREDGE",
    exe: "E:\\games\\DREDGE\\DREDGE.exe",
    workingDir: "E:\\games\\DREDGE",
    launchParam: "",
    dependsOn: "",
    DLC: "",
  };

  it("starts the exe when GOG Galaxy is not installed", () => {
    expect(gogApp("1744110647", dredge, null)).toMatchObject({
      id: "gog:1744110647",
      name: "DREDGE",
      kind: "game",
      launch: { type: "exe", path: "E:\\games\\DREDGE\\DREDGE.exe", cwd: "E:\\games\\DREDGE" },
    });
  });

  it("starts through Galaxy when it is installed", () => {
    const galaxy = "C:\\Program Files (x86)\\GOG Galaxy\\GalaxyClient.exe";

    expect(gogApp("1744110647", dredge, galaxy)!.launch).toEqual({
      type: "exe",
      path: galaxy,
      args: '/command=runGame /gameId=1744110647 /path="E:\\games\\DREDGE"',
    });
  });

  it("skips DLC", () => {
    expect(gogApp("1", { ...dredge, gameName: "DREDGE - The Pale Reach", dependsOn: "1744110647" }, null)).toBeNull();
  });
});

describe("voice names from the dictionary", () => {
  it("finds names by catalog id", () => {
    expect(dictionaryAliases({ id: "steam:570", name: "Dota 2" })).toEqual(expect.arrayContaining(["дота"]));
    expect(dictionaryAliases({ id: "steam:730", name: "Counter-Strike 2" })).toEqual(expect.arrayContaining(["кс", "контра"]));
  });

  it("finds names by the whole name, its start or its end", () => {
    expect(dictionaryAliases({ id: "start:1", name: "Microsoft Word" })).toContain("ворд");
    expect(dictionaryAliases({ id: "start:2", name: "Adobe Photoshop 2025" })).toContain("фотошоп");
    expect(dictionaryAliases({ id: "start:3", name: "Steam" })).toContain("стим");
  });

  it("gives nothing to an unknown app", () => {
    expect(dictionaryAliases({ id: "start:4", name: "Some Tool" })).toEqual([]);
  });
});
