// Export and import of scenarios: a .ghscenario file is JSON with the samples inside.
// An import is checked (every sample is a PNG whose sha256 is its name) and reviewed before
// it is added: the person sees what the scenario runs, presses and clicks.
import { createHash } from "crypto";
import { comboLabel } from "../../shared/scenarios/keys";
import { ASSET_RE, type KeyCombo, type Scenario, type Value } from "../../shared/scenarios/model";
import { sanitizeScenario } from "../../shared/scenarios/validate";
import type { ImportPreview } from "../../shared/types";
import { pngSize } from "./store";

export const FORMAT = "ghost-hands-scenario";
export const MAX_FILE = 20_000_000;

interface ExportFile {
  format: typeof FORMAT;
  version: 1;
  scenario: Scenario;
  assets: Record<string, string>;
}

/** Sample ids a scenario uses. */
export function assetsOf(scenario: Scenario): string[] {
  const found = new Set<string>();
  const walk = (value: Value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach(walk);
    const asset = (value as { asset?: Value }).asset;
    if (typeof asset === "string" && ASSET_RE.test(asset)) found.add(asset);
    Object.values(value).forEach(walk);
  };

  for (const node of scenario.graph.nodes) walk(node.data);
  return [...found];
}

export async function buildExport(scenario: Scenario, readAsset: (sha: string) => Promise<Buffer | null>): Promise<string> {
  const assets: Record<string, string> = {};

  for (const sha of assetsOf(scenario)) {
    const png = await readAsset(sha);
    if (png) assets[sha] = png.toString("base64");
  }

  const file: ExportFile = { format: FORMAT, version: 1, scenario: { ...scenario, rev: 0 }, assets };
  return JSON.stringify(file, null, 1);
}

/** A file → a sanitized scenario and its checked samples; throws "bad-file". */
export function parseImport(raw: Buffer): { scenario: Scenario; assets: Map<string, Buffer> } {
  if (raw.length > MAX_FILE) throw new Error("bad-file");

  let file: Partial<ExportFile>;
  try {
    file = JSON.parse(raw.toString("utf8").replace(/^﻿/, ""));
  } catch {
    throw new Error("bad-file");
  }
  if (!file || file.format !== FORMAT) throw new Error("bad-file");

  const scenario = sanitizeScenario(file.scenario);
  if (!scenario || !scenario.name) throw new Error("bad-file");

  const assets = new Map<string, Buffer>();
  for (const [sha, data] of Object.entries(file.assets ?? {})) {
    if (!ASSET_RE.test(sha) || typeof data !== "string") continue;

    const png = Buffer.from(data, "base64");
    if (createHash("sha256").update(png).digest("hex") === sha && pngSize(png)) assets.set(sha, png);
  }
  return { scenario, assets };
}

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/** What the scenario would do, for the import dialog. */
export function reviewOf(scenario: Scenario, appName: (id: string) => string, token: string): ImportPreview {
  const preview: ImportPreview = {
    token,
    name: scenario.name,
    description: scenario.description,
    steps: scenario.graph.nodes.length - 1,
    launches: [],
    paths: [],
    urls: [],
    keys: [],
    clicks: false,
    text: false,
    power: [],
    say: false,
    hotkeys: [],
    schedules: [],
  };
  const add = (list: string[], value: string) => {
    if (value && !list.includes(value)) list.push(value);
  };

  for (const node of scenario.graph.nodes) {
    const data = node.data;

    switch (node.type) {
      case "apps.launch":
        add(preview.launches, appName(String(data.app ?? "")));
        break;
      case "apps.open":
        add(preview.paths, String(data.path ?? ""));
        break;
      case "apps.openUrl":
        add(preview.urls, String(data.url ?? ""));
        break;
      case "input.keys":
        add(preview.keys, comboLabel((data.keys as KeyCombo | null)?.codes ?? []));
        break;
      case "input.click":
      case "input.drag":
      case "vision.click":
      case "vision.clickText":
        preview.clicks = true;
        break;
      case "input.text":
        preview.text = true;
        break;
      case "system.power":
        add(preview.power, String(data.action ?? "lock"));
        break;
      case "system.say":
        preview.say = true;
        break;
    }
  }

  for (const trigger of scenario.triggers) {
    if (trigger.type === "hotkey") add(preview.hotkeys, trigger.accelerator);
    else add(preview.schedules, `${trigger.time} ${trigger.days.length === 7 ? "*" : trigger.days.map((d) => DAYS[d]).join(",")}`);
  }
  return preview;
}
