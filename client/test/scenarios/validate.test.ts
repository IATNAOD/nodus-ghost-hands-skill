import { describe, expect, it } from "vitest";
import { NODE_DEFS, isConnectable } from "../../src/shared/scenarios/defs";
import { SCENARIO_TEXTS, pinText, outText } from "../../src/shared/scenarios/texts";
import { canConnect, coerce, compareValues } from "../../src/shared/scenarios/pins";
import { interpolate, resolveTemplate } from "../../src/shared/scenarios/template";
import { sanitizeScenario, validateScenario } from "../../src/shared/scenarios/validate";
import { IMPLS } from "../../src/main/scenarios/impl";
import { scenarioOf } from "./helpers";

describe("scenario checks", () => {
  it("a missing required input, a bad wire, a pure cycle are errors", () => {
    const scenario = scenarioOf(
      [
        ["launch", "apps.launch"],
        ["a", "data.not"],
        ["b", "data.not"],
        ["click", "input.click", { point: { x: 1, y: 1 } }],
      ],
      [
        ["start", "next", "launch"],
        ["a", "result", "b", "value"],
        ["b", "result", "a", "value"],
        ["a", "result", "click", "point"],
      ],
    );
    const codes = validateScenario(scenario).map((issue) => `${issue.severity}:${issue.code}`);

    expect(codes).toContain("error:required");
    expect(codes).toContain("error:pure-cycle");
    expect(codes).toContain("error:bad-edge");
    expect(codes).toContain("warning:unreachable");
  });

  it("warns when a value is read where its step may not have run", () => {
    const scenario = scenarioOf(
      [
        ["if", "flow.if"],
        ["find", "vision.find", { image: { asset: "a".repeat(64), w: 1, h: 1, scale: 1 } }],
        ["click", "input.click"],
      ],
      [
        ["start", "next", "if"],
        ["if", "then", "find"],
        ["if", "else", "click"],
        ["find", "found", "click"],
        ["find", "point", "click", "point"],
      ],
    );

    expect(validateScenario(scenario).map((issue) => issue.code)).toContain("maybe-unavailable");
  });

  it("a value from the steps before is fine", () => {
    const scenario = scenarioOf(
      [
        ["find", "vision.find", { image: { asset: "a".repeat(64), w: 1, h: 1, scale: 1 } }],
        ["click", "input.click"],
      ],
      [
        ["start", "next", "find"],
        ["find", "found", "click"],
        ["find", "point", "click", "point"],
      ],
    );

    expect(validateScenario(scenario)).toEqual([]);
  });

  it("sanitize drops foreign assets, duplicate wires and extra wires into one input", () => {
    const scenario = scenarioOf([["find", "vision.find"]], []);
    scenario.graph.nodes[1].data.image = { asset: "../../secret", w: 1, h: 1, scale: 1 };
    scenario.graph.edges = [
      { id: "x", source: "start", sourceHandle: "next", target: "find", targetHandle: "in" },
      { id: "y", source: "start", sourceHandle: "next", target: "find", targetHandle: "in" },
      { id: "z", source: "start", sourceHandle: "next", target: "ghost", targetHandle: "in" },
    ];

    const clean = sanitizeScenario({ ...scenario, name: " Name\u0000 ", id: "BAD" })!;
    expect(clean.name).toBe("Name");
    expect(clean.id).toBe("");
    expect(clean.graph.nodes[1].data.image).toBeUndefined();
    expect(clean.graph.edges).toHaveLength(1);
    expect(sanitizeScenario("nope")).toBeNull();
  });

  it("pins: wiring rules, coercion, comparison, templates", () => {
    expect(canConnect("exec", "exec")).toBe(true);
    expect(canConnect("exec", "any")).toBe(false);
    expect(canConnect("number", "text")).toBe(true);
    expect(canConnect("text", "number")).toBe(false);
    expect(canConnect("region", "point")).toBe(true);
    expect(coerce({ x: 10, y: 20, w: 10, h: 10 }, "point")).toEqual({ x: 15, y: 25 });
    expect(coerce("нет", "bool")).toBe(false);
    expect(coerce("3,5", "number")).toBe(3.5);
    expect(compareValues("10", "gt", "9")).toBe(true);
    expect(compareValues("Играть", "contains", "игра")).toBe(true);
    expect(interpolate("a {{x}} \\{{y}}", (name) => (name === "x" ? 1 : undefined))).toBe("a 1 {{y}}");
    expect(resolveTemplate(" {{p}} ", () => ({ x: 1, y: 2 }))).toEqual({ x: 1, y: 2 });
  });

  it("every node has an implementation and texts for all its pins and outputs in both languages", () => {
    for (const def of NODE_DEFS) {
      if (def.type !== "flow.start" && def.type !== "flow.break" && def.type !== "flow.stop") expect(IMPLS[def.type], def.type).toBeDefined();

      for (const lang of ["ru", "en"] as const) {
        const node = SCENARIO_TEXTS[lang].nodes[def.type];
        expect(node?.title, `${lang} ${def.type}`).toBeTruthy();
        expect(node.description, `${lang} ${def.type}`).toBeTruthy();

        for (const pin of [...def.inputs, ...def.outputs]) {
          const text = pinText(lang, def.type, pin.id);
          expect(text?.label, `${lang} ${def.type}.${pin.id}`).toBeTruthy();
          expect(text?.description, `${lang} ${def.type}.${pin.id}`).toBeTruthy();
          for (const option of pin.options ?? []) expect(text?.options?.[option], `${lang} ${def.type}.${pin.id}.${option}`).toBeTruthy();
        }
        for (const out of def.execOuts) expect(outText(lang, def.type, out.id), `${lang} ${def.type} out ${out.id}`).not.toBe(out.id);
        for (const preset of def.presets ?? []) expect(node.presets?.[preset.id], `${lang} ${def.type} preset`).toBeTruthy();
      }
      // a pin id "in" would clash with the exec input
      for (const pin of def.inputs) expect(pin.id).not.toBe("in");
      expect(def.inputs.filter(isConnectable).every((pin) => pin.type !== "exec")).toBe(true);
    }
  });
});
