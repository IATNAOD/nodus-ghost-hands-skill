// The skill's modules that the client bundles: the same name matching and phrase
// parsing must work here, through the TypeScript build, as in the skill's own tests.
import { describe, expect, it } from "vitest";
import { appKey, decide, prepare, prepareApp, scoreApp } from "@skill/names.js";
import { NameIndex } from "@skill/name-index.js";
import { classify } from "@skill/parse.js";
import { normalizeKey, sanitizeConfig } from "@skill/protocol.js";
import corpus from "../../skill/test/names.vectors.json";

type Candidate = { key: string; name: string; score: number; coverage: number };

describe("names corpus", () => {
  const apps = corpus.apps.map((app: { name: string; aliases?: string[] }, i: number) => prepareApp({ id: `x:${i}`, name: app.name, aliases: app.aliases ?? [] }));

  const resolve = (spoken: string) => {
    const tokens = prepare(spoken);
    const candidates: Candidate[] = apps
      .map((app: { name: string }) => ({ key: appKey(app.name), name: app.name, ...scoreApp(tokens, app) }))
      .filter((candidate: Candidate) => candidate.score >= 0.6);

    return decide(candidates) as { status: string; best: Candidate | null };
  };

  it("finds the same apps as in the skill", () => {
    const wrong: string[] = [];

    for (const [spoken, expected] of corpus.vectors as [string, string | null][]) {
      const result = resolve(spoken);
      const got = result.best?.name ?? null;

      if (expected === null) {
        if (result.status !== "none") wrong.push(`${spoken}: expected nothing, got ${result.status} ${got}`);
      } else if (expected === "?") {
        if (result.status !== "ambiguous") wrong.push(`${spoken}: expected a question, got ${result.status} ${got}`);
      } else if (expected.startsWith("~")) {
        if (!["match", "weak"].includes(result.status) || got !== expected.slice(1)) wrong.push(`${spoken}: expected ${expected}, got ${result.status} ${got}`);
      } else if (result.status !== "match" || got !== expected) {
        wrong.push(`${spoken}: expected ${expected}, got ${result.status} ${got}`);
      }
    }

    expect(wrong).toEqual([]);
  });
});

describe("phrase check on this PC", () => {
  const { config } = sanitizeConfig({
    name: "Игровой",
    aliases: [],
    shared: false,
    apps: [
      { id: "steam:570", name: "Dota 2", aliases: ["дота"], kind: "game", source: "steam" },
      { id: "virtual:notepad", name: "Блокнот", aliases: [], kind: "app", source: "virtual" },
    ],
  }) as { config: object };

  const check = (text: string) => {
    const index = new NameIndex();

    index.upsert({ deviceId: "this-pc", userId: "me", config, online: true });
    return classify(text, { index, userId: "me" }) as { intent: string; params: Record<string, unknown> } | null;
  };

  it("understands launch, close and volume with the PC named", () => {
    expect(check("запусти доту")?.intent).toBe("launch_app");
    expect(check("закрой блокнот на игровом")?.intent).toBe("close_app");
    expect(check("сделай громче на компьютере")?.intent).toBe("pc_volume");
  });

  it("leaves other phrases to NODUS", () => {
    expect(check("включи свет")).toBeNull();
    expect(check("громче")).toBeNull();
  });
});

describe("protocol", () => {
  it("normalizes a pasted key", () => {
    expect(normalizeKey(" gh-7k3m-a1b2-c3d4-e5f6-g7h8-j9k0 ")).toBe("GH-7K3M-A1B2-C3D4-E5F6-G7H8-J9K0");
  });
});
