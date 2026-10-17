// Would NODUS understand the voice names of a scenario? The same parser and name index as
// the skill: "запусти <name>" must reach this scenario, not an app, another scenario or a
// command of NODUS itself.
import { NameIndex } from "@skill/name-index.js";
import { classifyNow } from "@skill/parse.js";
import type { ScenarioSummary } from "../../shared/scenarios/model";
import type { ScenarioNameCheck } from "../../shared/types";

interface Input {
  id: string;
  names: string[];
  apps: { id: string; name: string; aliases: string[]; spoken: string; kind: string; source: string }[];
  scenarios: ScenarioSummary[];
  device: { name: string; aliases: string[] };
  accept: number;
}

export function checkScenarioNames({ id, names, apps, scenarios, device, accept }: Input): ScenarioNameCheck {
  const clean = names.map((name) => name.trim());
  const index = new NameIndex();
  const others = scenarios
    .filter((scenario) => scenario.id !== id)
    .map((scenario) => ({ id: scenario.id, name: scenario.name, aliases: scenario.voice.aliases, spoken: scenario.voice.spoken, voice: scenario.enabled && scenario.voice.enabled }));
  const [main, ...aliases] = clean;

  index.setAccept(accept);
  index.upsert({
    deviceId: "pc",
    userId: "me",
    online: true,
    config: { name: device.name, aliases: device.aliases, apps, scenarios: [...others, { id, name: main || "-", aliases: aliases.filter(Boolean), spoken: "", voice: true }] },
  });

  const entry = index.get("pc")!;

  return {
    names: clean.map((name) => {
      if (!name) return { name, ok: false, intent: null, reason: "empty" as const };

      // classifyNow: the memo of classify is keyed by the index version, and this index is new
      const parsed = classifyNow(`запусти ${name}`, { index, userId: "me" });
      if (!parsed) return { name, ok: false, intent: null, reason: "reserved" as const };
      if (parsed.intent !== "launch_app") return { name, ok: false, intent: parsed.intent, reason: "other-intent" as const };

      const found = index.matchApps(name, [entry], { scenarios: "include" });
      const best = found.best as { scenarioId?: string; kind?: string; name?: string } | null;

      if (found.status === "match" && best?.scenarioId === id) return { name, ok: true, intent: parsed.intent, reason: "ok" as const };

      const rival = (found.options as { scenarioId?: string; kind?: string; name?: string }[]).find((option) => option.scenarioId !== id) ?? (best?.scenarioId !== id ? best : null);
      if (rival?.kind === "scenario") return { name, ok: false, intent: parsed.intent, reason: "duplicate" as const, other: rival.name };
      if (rival) return { name, ok: false, intent: parsed.intent, reason: "same-as-app" as const, other: rival.name };
      return { name, ok: false, intent: parsed.intent, reason: "ambiguous" as const };
    }),
  };
}
