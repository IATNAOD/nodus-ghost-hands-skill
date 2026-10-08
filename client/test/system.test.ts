import { describe, expect, it } from "vitest";
import { belongsTo, emptyMatch } from "../src/main/catalog/types";
import { broadcastOf } from "../src/main/system/nic";

describe("wake-on-lan broadcast", () => {
  it("is the last address of the network", () => {
    expect(broadcastOf("192.168.0.10", "255.255.255.0")).toBe("192.168.0.255");
    expect(broadcastOf("10.1.2.3", "255.255.0.0")).toBe("10.1.255.255");
    expect(broadcastOf("172.16.5.4", "255.255.255.252")).toBe("172.16.5.7");
  });
});

describe("processes of an app", () => {
  const game = { ...emptyMatch(), dirs: ["E:\\SteamLibrary\\steamapps\\common\\Hollow Knight"] };

  it("matches a process inside the install folder, whatever the case and slashes", () => {
    expect(belongsTo(game, { exe: "e:/steamlibrary/steamapps/common/hollow knight/hollow_knight.exe" })).toBe(true);
  });

  it("does not match a folder that only starts the same way", () => {
    expect(belongsTo(game, { exe: "E:\\SteamLibrary\\steamapps\\common\\Hollow Knight Silksong\\Silksong.exe" })).toBe(false);
  });

  it("matches by exe path, exe name and AppUserModelID", () => {
    expect(belongsTo({ ...emptyMatch(), exes: ["C:\\Windows\\notepad.exe"] }, { exe: "c:\\windows\\NOTEPAD.EXE" })).toBe(true);
    expect(belongsTo({ ...emptyMatch(), names: ["calculatorapp.exe"] }, { exe: "C:\\Program Files\\WindowsApps\\Calc\\CalculatorApp.exe" })).toBe(true);
    expect(belongsTo({ ...emptyMatch(), aumids: ["Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"] }, { exe: null, aumid: "microsoft.windowscalculator_8wekyb3d8bbwe!app" })).toBe(true);
    expect(belongsTo(emptyMatch(), { exe: "C:\\x.exe", aumid: null })).toBe(false);
  });
});
