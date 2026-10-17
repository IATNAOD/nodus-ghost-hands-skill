import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";
import { comboKeys, comboLabel, fromAccelerator, toAccelerator } from "../../src/shared/scenarios/keys";
import { areaRect, selectMonitors, type Monitor } from "../../src/shared/scenarios/monitors";
import { due, nextFire, occurrences } from "../../src/shared/scenarios/schedule";
import { findText, fold, type OcrLine } from "../../src/shared/scenarios/textmatch";
import { InputLock } from "../../src/main/scenarios/input";
import { ScenarioStore, VariableStore, pngSize } from "../../src/main/scenarios/store";
import { parseImport, reviewOf } from "../../src/main/scenarios/transfer";
import { RunAbort } from "../../src/main/scenarios/engine";
import { emptyScenario } from "../../src/shared/scenarios/model";
import { scenarioOf } from "./helpers";

const line = (text: string, x: number, y: number): OcrLine => {
  let at = x;
  const words = text.split(" ").map((word) => {
    const box = { text: word, x: at, y, w: word.length * 10, h: 20 };
    at += word.length * 10 + 8;
    return box;
  });
  return { text, x, y, w: at - x, h: 20, words };
};

describe("OCR text match", () => {
  const lines = [line("Главное меню", 10, 10), line("Играть!", 100, 300), line("Настройки игры", 100, 340), line("Ghost Hands сценарий", 10, 500)];

  it("folds case, ё, punctuation and look-alike letters", () => {
    expect(fold("Ёлка, PRO!")).toBe(fold("елка pro"));
    expect(fold("Сценарий")).toBe(fold("Cцeнapий"));
  });

  it("finds the word, the phrase, inside a word, with one OCR mistake", () => {
    expect(findText(lines, "играть", "contains")?.region).toEqual({ x: 100, y: 300, w: 70, h: 20 });
    expect(findText(lines, "настройки игры", "exact")?.text).toBe("Настройки игры");
    expect(findText(lines, "сценарии", "contains")?.text).toBe("Ghost Hands сценарий");
    expect(findText(lines, "hands ghost", "words")?.text).toBe("Ghost Hands сценарий");
    expect(findText(lines, "выход", "contains")).toBeNull();
    expect(findText(lines, "настройки", "exact")).toBeNull();
  });
});

describe("monitors", () => {
  const monitors: Monitor[] = [
    { id: "1", device: "\\\\.\\DISPLAY1", name: "Dell", primary: true, bounds: { x: 0, y: 0, w: 2560, h: 1440 }, scale: 1 },
    { id: "2", device: "\\\\.\\DISPLAY2", name: "LG", primary: false, bounds: { x: 2560, y: 534, w: 1600, h: 900 }, scale: 1.25 },
  ];

  it("selects by mode, keeps listed monitors by id, name or size", () => {
    expect(selectMonitors(monitors, { mode: "all" }, {})).toHaveLength(2);
    expect(selectMonitors(monitors, { mode: "primary" }, {}).map((m) => m.id)).toEqual(["1"]);
    expect(selectMonitors(monitors, { mode: "cursor" }, { cursor: { x: 3000, y: 900 } }).map((m) => m.id)).toEqual(["2"]);
    expect(selectMonitors(monitors, { mode: "list", list: [{ id: "77", name: "LG", w: 1600, h: 900 }] }, {}).map((m) => m.id)).toEqual(["2"]);
    expect(selectMonitors(monitors, { mode: "list", list: [{ id: "77", name: "X", w: 800, h: 600 }] }, {})).toEqual([]);
  });

  it("a stored area is monitor-local", () => {
    expect(areaRect(monitors, { monitor: { id: "2", name: "LG", w: 1600, h: 900 }, x: 10, y: 20, w: 100, h: 50 })).toEqual({ x: 2570, y: 554, w: 100, h: 50 });
    expect(areaRect(monitors, { x: 1, y: 2, w: 3, h: 4 })).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });
});

describe("schedule", () => {
  const rule = { time: "08:30", days: [1, 2, 3, 4, 5], missed: "skip" as const };
  // Thursday 2026-10-08
  const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();

  it("fires on time, on weekdays only, once", () => {
    expect(due(rule, at(8, 8, 29), at(8, 8, 30, ), null)).toBe(at(8, 8, 30));
    expect(due(rule, at(8, 8, 30), at(8, 8, 31), at(8, 8, 30))).toBeNull();
    expect(due(rule, at(10, 8, 29), at(10, 8, 31), null)).toBeNull();
    expect(nextFire(rule, at(9, 9, 0))).toBe(at(12, 8, 30));
  });

  it("a run missed while asleep: skip or once", () => {
    expect(due(rule, at(8, 7, 0), at(8, 11, 0), null)).toBeNull();
    expect(due({ ...rule, missed: "once" }, at(8, 7, 0), at(8, 11, 0), null)).toBe(at(8, 8, 30));
    expect(due({ ...rule, missed: "once" }, at(1, 7, 0), at(8, 11, 0), null)).toBe(at(8, 8, 30));
  });

  it("a day with a clock change keeps the local time", () => {
    const moments = occurrences({ time: "03:30", days: [0, 1, 2, 3, 4, 5, 6], missed: "skip" }, new Date(2026, 2, 28).getTime(), new Date(2026, 2, 31).getTime());
    expect(moments.map((m) => new Date(m).getHours())).toEqual([3, 3, 3]);
  });
});

describe("keys", () => {
  it("modifiers first, scan codes, labels and accelerators", () => {
    expect(comboLabel(["KeyK", "ShiftLeft", "ControlLeft"])).toBe("Ctrl+Shift+K");
    expect(comboKeys(["ControlLeft", "ArrowLeft"])).toEqual([
      { scan: 0x1d, ext: false, vk: 0xa2 },
      { scan: 0x4b, ext: true, vk: 0x25 },
    ]);
    expect(comboKeys(["MediaPlayPause"])).toEqual([{ scan: 0, ext: false, vk: 0xb3 }]);
    expect(toAccelerator(["ControlLeft", "AltLeft", "Digit1"])).toBe("Control+Alt+1");
    expect(toAccelerator(["KeyA"])).toBeNull();
    expect(toAccelerator(["F9"])).toBe("F9");
    expect(fromAccelerator("Control+Alt+1")).toEqual(["ControlLeft", "AltLeft", "Digit1"]);
  });
});

describe("input lock", () => {
  it("first come, first served; one owner may take it again; an abort leaves the queue", async () => {
    const lock = new InputLock();
    const order: string[] = [];
    const a = await lock.acquire("a");
    const again = await lock.acquire("a");
    const b = lock.acquire("b").then((release) => (order.push("b"), release));
    const controller = new AbortController();
    const c = lock.acquire("c", controller.signal).catch((error) => (order.push(error instanceof RunAbort ? "c aborted" : "c?"), null));
    const d = lock.acquire("d").then((release) => (order.push("d"), release));

    controller.abort(new RunAbort("stopped"));
    again();
    a();
    (await b)();
    await c;
    (await d)();
    expect(order).toEqual(["c aborted", "b", "d"]);
    expect(lock.busy).toBe(false);
  });
});

describe("storage", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-scenarios-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // a 4x4 PNG
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d4948445200000004000000040806000000a9f19e7e0000001449444154789c63fcffff3f03b580611818d000003fcb0ff1a1a3c3d50000000049454e44ae426082",
    "hex",
  );

  it("saves, reloads, keeps only used samples", async () => {
    const store = new ScenarioStore(dir);
    await store.load();
    const scenario = emptyScenario("Утро");
    const sample = await store.putAsset(png);
    expect(pngSize(png)).toEqual({ w: 4, h: 4 });
    scenario.graph.nodes.push({ id: "find", type: "vision.find", v: 1, position: { x: 0, y: 0 }, data: { image: { ...sample, scale: 1 } } });

    const saved = await store.save(scenario);
    expect(saved.rev).toBe(1);
    await store.putAsset(Buffer.concat([png.subarray(0, 33), png.subarray(33)])); // same bytes, same id

    const again = new ScenarioStore(dir);
    await again.load();
    expect(again.get(scenario.id)?.name).toBe("Утро");
    expect(await again.readAsset(sample.asset)).not.toBeNull();

    await again.remove(scenario.id);
    expect(await again.readAsset(sample.asset)).toBeNull();
  });

  it("variables: limits, persist on flush", async () => {
    const vars = new VariableStore(dir);
    vars.set("global", "", "count", 5);
    expect(() => vars.set("global", "", "big", "x".repeat(20_000))).toThrow("value-too-big");
    await vars.flush();

    const again = new VariableStore(dir);
    await again.load();
    expect(again.get("global", "", "count")).toBe(5);
  });

  it("an import is checked and reviewed", () => {
    const scenario = scenarioOf(
      [
        ["launch", "apps.launch", { app: "steam:570" }],
        ["keys", "input.keys", { keys: { codes: ["ControlLeft", "KeyS"] } }],
        ["off", "system.power", { action: "shutdown" }],
      ],
      [],
    );
    const file = Buffer.from(JSON.stringify({ format: "ghost-hands-scenario", version: 1, scenario, assets: { ["0".repeat(64)]: "AAAA" } }));
    const { scenario: imported, assets } = parseImport(file);

    expect(assets.size).toBe(0);
    expect(reviewOf(imported, (id) => (id === "steam:570" ? "Dota 2" : id), "t")).toMatchObject({ launches: ["Dota 2"], keys: ["Ctrl+S"], power: ["shutdown"] });
    expect(() => parseImport(Buffer.from("{}"))).toThrow("bad-file");
  });
});
