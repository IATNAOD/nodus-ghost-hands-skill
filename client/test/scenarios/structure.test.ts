import { describe, expect, it } from "vitest";
import { heightOf, layoutTree, nearestFree, toGraph, toSteps, treeIds, type StepNode } from "../../src/shared/scenarios/structure";
import { defOf, initialData } from "../../src/shared/scenarios/defs";
import type { Graph } from "../../src/shared/scenarios/model";
import { scenarioOf } from "./helpers";

const IMAGE = { image: { asset: "a".repeat(64), w: 1, h: 1, scale: 1 } };

/** A graph with these nodes and no exec wires (data wires kept). */
function bare(nodes: [string, string, Record<string, unknown>?][]): Graph {
  const scenario = scenarioOf(nodes as never, []);
  return scenario.graph;
}

const execEdges = (graph: Graph) =>
  graph.edges
    .filter((edge) => edge.targetHandle === "in")
    .map((edge) => `${edge.source}.${edge.sourceHandle}>${edge.target}`)
    .sort();

describe("steps ↔ graph", () => {
  it("a chain is a list of steps", () => {
    const scenario = scenarioOf(
      [
        ["a", "system.notify"],
        ["b", "flow.wait"],
      ],
      [
        ["start", "next", "a"],
        ["a", "next", "b"],
      ],
    );

    expect(toSteps(scenario.graph)).toEqual({ ok: true, steps: [{ id: "a" }, { id: "b" }], unused: [] });
  });

  it("If with both branches meeting again: the rest goes after the If", () => {
    const scenario = scenarioOf(
      [
        ["if", "flow.if"],
        ["yes", "system.notify"],
        ["no", "system.notify"],
        ["after", "flow.wait"],
      ],
      [
        ["start", "next", "if"],
        ["if", "then", "yes"],
        ["if", "else", "no"],
        ["yes", "next", "after"],
        ["no", "next", "after"],
      ],
    );

    expect(toSteps(scenario.graph)).toEqual({
      ok: true,
      unused: [],
      steps: [
        {
          id: "if",
          branches: [
            { out: "then", steps: [{ id: "yes" }], ends: false },
            { out: "else", steps: [{ id: "no" }], ends: false },
          ],
        },
        { id: "after" },
      ],
    });
  });

  it("Not found → Stop does not pull the rest into Found", () => {
    const scenario = scenarioOf(
      [
        ["find", "vision.find", IMAGE],
        ["stop", "flow.stop"],
        ["click", "input.click"],
        ["more", "flow.wait"],
      ],
      [
        ["start", "next", "find"],
        ["find", "found", "click"],
        ["find", "notFound", "stop"],
        ["click", "next", "more"],
      ],
    );
    const result = toSteps(scenario.graph);

    expect(result.ok && result.steps.map((s) => s.id)).toEqual(["find", "click", "more"]);
    expect(result.ok && result.steps[0].branches).toEqual([
      { out: "found", steps: [], ends: false },
      { out: "notFound", steps: [{ id: "stop" }], ends: true },
    ]);
  });

  it("an empty Else that ends the scenario is marked so", () => {
    const scenario = scenarioOf(
      [
        ["if", "flow.if"],
        ["yes", "system.notify"],
      ],
      [
        ["start", "next", "if"],
        ["if", "then", "yes"],
      ],
    );
    const result = toSteps(scenario.graph);

    expect(result.ok && result.steps).toEqual([
      {
        id: "if",
        branches: [
          { out: "then", steps: [], ends: false },
          { out: "else", steps: [], ends: true },
        ],
      },
      { id: "yes" },
    ]);
  });

  it("loops nest their body; Break inside an If inside a loop", () => {
    const scenario = scenarioOf(
      [
        ["loop", "flow.repeat"],
        ["if", "flow.if"],
        ["brk", "flow.break"],
        ["step", "system.notify"],
        ["after", "flow.wait"],
      ],
      [
        ["start", "next", "loop"],
        ["loop", "body", "if"],
        ["if", "then", "brk"],
        ["if", "else", "step"],
        ["loop", "done", "after"],
      ],
    );
    const result = toSteps(scenario.graph);

    expect(result.ok).toBe(true);
    expect(result.ok && result.steps[0]).toEqual({
      id: "loop",
      body: [{ id: "if", branches: [{ out: "then", steps: [{ id: "brk" }], ends: true }, { out: "else", steps: [], ends: false }] }, { id: "step" }],
    });
    expect(result.ok && result.steps[1]).toEqual({ id: "after" });
  });

  it("a back edge (goto) and a merge in the middle are not steps", () => {
    const loop = scenarioOf(
      [
        ["a", "system.notify"],
        ["b", "system.notify"],
      ],
      [
        ["start", "next", "a"],
        ["a", "next", "b"],
        ["b", "next", "a"],
      ],
    );
    expect(toSteps(loop.graph).ok).toBe(false);

    // a loop body that leads out of the loop
    const escape = scenarioOf(
      [
        ["loop", "flow.repeat"],
        ["a", "system.notify"],
        ["c", "system.notify"],
      ],
      [
        ["start", "next", "loop"],
        ["loop", "body", "a"],
        ["a", "next", "c"],
        ["loop", "done", "c"],
      ],
    );
    expect(toSteps(escape.graph).ok).toBe(false);
  });

  it("the error branch of a step", () => {
    const scenario = scenarioOf(
      [
        ["launch", "apps.launch", { app: "steam:570" }],
        ["oops", "system.notify"],
        ["next", "flow.wait"],
      ],
      [
        ["start", "next", "launch"],
        ["launch", "next", "next"],
        ["launch", "error", "oops"],
        ["oops", "next", "next"],
      ],
    );
    const result = toSteps(scenario.graph);

    expect(result.ok && result.steps).toEqual([
      {
        id: "launch",
        branches: [
          { out: "next", steps: [], ends: false },
          { out: "error", steps: [{ id: "oops" }], ends: false },
        ],
      },
      { id: "next" },
    ]);
  });

  // trees the step editor builds: back and forth, nothing changes
  const TREES: StepNode[][] = [
    [],
    [{ id: "a" }],
    [{ id: "a" }, { id: "b" }, { id: "c" }],
    [{ id: "if", branches: [{ out: "then", steps: [{ id: "a" }], ends: false }, { out: "else", steps: [], ends: false }] }, { id: "b" }],
    [{ id: "if", branches: [{ out: "then", steps: [{ id: "a" }, { id: "b" }], ends: false }, { out: "else", steps: [{ id: "c" }], ends: false }] }],
    [{ id: "loop", body: [{ id: "a" }, { id: "if", branches: [{ out: "then", steps: [{ id: "brk" }], ends: true }, { out: "else", steps: [], ends: false }] }, { id: "b" }] }, { id: "c" }],
    [{ id: "find", branches: [{ out: "found", steps: [{ id: "a" }], ends: false }, { out: "notFound", steps: [{ id: "stop" }], ends: true }] }, { id: "b" }],
    [{ id: "loop", body: [{ id: "loop2", body: [{ id: "a" }] }, { id: "b" }] }],
  ];
  const TYPES: Record<string, string> = { if: "flow.if", loop: "flow.repeat", loop2: "flow.while", brk: "flow.break", stop: "flow.stop", find: "vision.find" };

  it.each(TREES.map((tree, i) => [i, tree]))("tree %s survives steps → graph → steps", (_i, tree) => {
    const ids = treeIds(tree as StepNode[]);
    const graph = bare(ids.map((id) => [id, TYPES[id] ?? "system.notify", TYPES[id] === "vision.find" ? IMAGE : undefined]));
    const built = toGraph(tree as StepNode[], graph);
    const back = toSteps(built);

    expect(back.ok).toBe(true);
    if (back.ok) {
      // the same graph; the steps come back in their canonical shape, which is stable
      expect(execEdges(toGraph(back.steps, built))).toEqual(execEdges(built));
      expect([...treeIds(back.steps)].sort()).toEqual([...ids].sort());
      const again = toSteps(toGraph(back.steps, built));
      expect(again).toEqual(back);
    }
  });

  it("graph → steps → graph keeps the wires", () => {
    const scenario = scenarioOf(
      [
        ["if", "flow.if"],
        ["yes", "system.notify"],
        ["no", "system.notify"],
        ["after", "flow.wait"],
        ["v", "data.not"],
      ],
      [
        ["start", "next", "if"],
        ["if", "then", "yes"],
        ["if", "else", "no"],
        ["yes", "next", "after"],
        ["no", "next", "after"],
        ["v", "result", "if", "condition"],
      ],
    );
    const result = toSteps(scenario.graph);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const again = toGraph(result.steps, scenario.graph);
      expect(execEdges(again)).toEqual(execEdges(scenario.graph));
      expect(again.edges.some((edge) => edge.targetHandle === "condition")).toBe(true);
    }
  });

  it("new steps are placed right of the step before", () => {
    const graph = bare([
      ["a", "system.notify"],
      ["b", "flow.wait"],
    ]);
    graph.nodes.find((n) => n.id === "a")!.position = { x: 0, y: 150 };
    graph.nodes.find((n) => n.id === "b")!.position = { x: 0, y: 0 };
    const laid = layoutTree([{ id: "a" }, { id: "b" }], graph, new Set(["b"]));

    expect(laid.nodes.find((n) => n.id === "b")!.position).toEqual({ x: 320, y: 150 });
    expect(defOf("flow.if") && initialData(defOf("flow.if")!)).toEqual({ condition: false });
  });

  it("a node from the palette goes to the free spot nearest to the middle of the view", () => {
    const graph = bare([["a", "flow.wait"]]);
    const a = graph.nodes.find((n) => n.id === "a")!;
    a.position = { x: 0, y: 0 };
    const start = graph.nodes.find((n) => n.type === "flow.start")!;
    start.position = { x: -1000, y: -1000 };

    expect(nearestFree(graph.nodes, { x: 600, y: 600 })).toEqual({ x: 600, y: 600 });
    const spot = nearestFree(graph.nodes, { x: 10, y: 10 }, 120);
    const clear = spot.x >= 260 || spot.x <= -260 || spot.y >= heightOf(a) || spot.y <= -120;
    expect(clear).toBe(true);
    expect(Math.hypot(spot.x - 10, spot.y - 10)).toBeLessThan(400);
  });

  it("branches: the first on the row, the next below, the step after them to the right", () => {
    const graph = bare([
      ["if", "flow.if"],
      ["a", "flow.wait"],
      ["b", "flow.wait"],
      ["c", "flow.log"],
    ]);
    const start = graph.nodes.find((n) => n.type === "flow.start")!;
    start.position = { x: 0, y: 0 };
    const tree: StepNode[] = [
      {
        id: "if",
        branches: [
          { out: "then", steps: [{ id: "a" }], ends: false },
          { out: "else", steps: [{ id: "b" }], ends: false },
        ],
      },
      { id: "c" },
    ];
    const laid = layoutTree(tree, graph, new Set(["if", "a", "b", "c"]));
    const at = (id: string) => laid.nodes.find((n) => n.id === id)!.position;

    expect(at("if")).toEqual({ x: 320, y: 0 });
    expect(at("a")).toEqual({ x: 640, y: 0 });
    expect(at("b").x).toBe(640);
    expect(at("b").y).toBeGreaterThan(at("a").y + 60);
    expect(at("c")).toEqual({ x: 960, y: 0 });
  });
});
