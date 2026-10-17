// Steps ↔ graph. The graph is the document; the step view shows it when it is "structured":
// a chain from Start where every node with several ways out has them meet again (or end), and
// loop bodies stay inside their loops. Pure.
//
//   linear node        - one way out: the next step
//   node with branches - If (Yes/No), Find image (Found/Not found), any step with Error wired:
//                        each way is a nested list of steps until the ways meet again
//   loop               - its body is a nested list; the flow goes on after Done
//   terminal           - Stop, Break: nothing after it
//
// A way that never meets the others (it ends, or stops the scenario) is a dead end: it does not
// pull the rest of the scenario inside itself. "ends" marks a branch whose last step leads
// nowhere although steps follow the node: in the graph that path ends the scenario.
import { defOf, type ExecOutDef, type NodeDef } from "./defs";
import { edgeId, type Graph, type GraphEdge, type GraphNode } from "./model";
import { pinVisible } from "./validate";

export interface StepBranch {
  out: string;
  steps: StepNode[];
  ends: boolean;
}

export interface StepNode {
  id: string;
  branches?: StepBranch[];
  body?: StepNode[];
}

export type StructureReason = "no-start" | "shared-step" | "goto" | "body-escapes";

export type Structure = { ok: true; steps: StepNode[]; unused: string[] } | { ok: false; reasons: { code: StructureReason; nodeId?: string }[] };

/** The out a linear node continues by. */
export const mainOut = (def: NodeDef): ExecOutDef | undefined => def.execOuts.find((out) => out.kind === "next") ?? def.execOuts.find((out) => out.kind === "branch");

class NotStructured extends Error {
  constructor(
    public code: StructureReason,
    public nodeId?: string,
  ) {
    super(code);
  }
}

export function toSteps(graph: Graph): Structure {
  const start = graph.nodes.find((node) => node.type === "flow.start");
  if (!start) return { ok: false, reasons: [{ code: "no-start" }] };

  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const target = (id: string, out: string): string | null => {
    const to = graph.edges.find((edge) => edge.source === id && edge.sourceHandle === out)?.target ?? null;
    return to && nodes.has(to) ? to : null;
  };
  const defOfNode = (id: string): NodeDef | undefined => defOf(nodes.get(id)?.type ?? "");

  /** ways out that count as branches of a node (unwired fail/error ones do not: they fail) */
  const waysOut = (id: string): ExecOutDef[] => {
    const def = defOfNode(id)!;
    if (def.kind === "loop" || def.kind === "terminal") return [];

    const wired = def.execOuts.filter((out) => target(id, out.id));
    const main = mainOut(def);
    // one way: the main one wired, or nothing - a plain step
    if (def.kind !== "branch" && wired.length <= 1 && (wired.length === 0 || wired[0].id === main?.id)) return [];
    return def.execOuts.filter((out) => !(out.kind === "fail" || out.kind === "error") || target(id, out.id));
  };

  /** Nodes reachable from `from` inside one region (a loop is one node: it continues after Done). */
  const reach = (from: string | null): Map<string, number> => {
    const seen = new Map<string, number>();
    const queue: [string, number][] = from ? [[from, 0]] : [];

    while (queue.length) {
      const [id, depth] = queue.shift()!;
      if (seen.has(id)) continue;
      seen.set(id, depth);

      const def = defOfNode(id);
      if (!def || def.traits?.noreturn) continue;
      for (const out of def.execOuts) {
        if (def.kind === "loop" && out.kind === "body") continue;
        const next = target(id, out.id);
        if (next) queue.push([next, depth + 1]);
      }
    }
    return seen;
  };

  /** Does every path from `from` end in Stop/Break (or a failing out) - a way that never goes on? */
  const stops = (from: string | null, seen = new Set<string>()): boolean => {
    if (!from) return false;
    if (seen.has(from)) return false;
    seen.add(from);

    const def = defOfNode(from);
    if (!def) return false;
    if (def.traits?.noreturn) return true;

    const next = def.execOuts
      .filter((out) => out.kind !== "fail" && out.kind !== "error" && !(def.kind === "loop" && out.kind === "body"))
      .map((out) => target(from, out.id))
      .filter((to): to is string => to !== null);
    return next.length > 0 && next.every((to) => stops(to, seen));
  };

  /** Where the ways out of a node meet again; null when they never do. */
  const joinOf = (id: string, outs: ExecOutDef[]): string | null => {
    const ways = outs.map((out) => reach(target(id, out.id)));
    // a dead end shares nothing with the other ways: it does not decide the join
    const alive = ways.filter((way, i) => way.size > 0 && ways.some((other, j) => j !== i && [...way.keys()].some((node) => other.has(node))));

    if (alive.length === 0) {
      // exactly one way goes on, the others are empty or stop: that way is the continuation
      // (a guard: "Not found → Stop", then the rest); two ways that go on stay nested
      const going = outs.filter((out) => {
        const to = target(id, out.id);
        return to !== null && !stops(to);
      });
      return going.length === 1 ? target(id, going[0].id) : null;
    }

    let best: string | null = null;
    let bestDepth = Infinity;
    for (const [node] of alive[0]) {
      if (!alive.every((way) => way.has(node))) continue;
      const depth = Math.max(...alive.map((way) => way.get(node)!));
      if (depth < bestDepth) {
        best = node;
        bestDepth = depth;
      }
    }
    return best;
  };

  const visited = new Set<string>();

  /** A list of steps from `entry` until `stop` (the join of the enclosing branches) or the end. */
  const sequence = (entry: string | null, stop: string | null): { steps: StepNode[]; reached: boolean } => {
    const steps: StepNode[] = [];
    let current = entry;

    while (current && current !== stop) {
      if (visited.has(current)) throw new NotStructured(entry === current ? "shared-step" : "goto", current);
      visited.add(current);

      const id = current;
      const def = defOfNode(id);
      if (!def) return { steps, reached: false };

      if (def.kind === "loop") {
        const body = sequence(target(id, "body"), null);
        steps.push({ id, body: body.steps });
        current = target(id, "done");
        continue;
      }
      if (def.kind === "terminal") {
        steps.push({ id });
        return { steps, reached: false };
      }

      const outs = waysOut(id);
      if (!outs.length) {
        steps.push({ id });
        const main = mainOut(def);
        current = main ? target(id, main.id) : null;
        continue;
      }

      const join = joinOf(id, outs);
      const branches = outs.map((out) => {
        const way = sequence(target(id, out.id), join);
        return { out: out.id, steps: way.steps, ends: join !== null && !way.reached };
      });
      steps.push({ id, branches });
      current = join;
    }
    return { steps, reached: current !== null && current === stop };
  };

  try {
    const root = sequence(target(start.id, "next"), null);

    // loop bodies must not lead out of the loop: every body node is visited from its loop only
    const unused = graph.nodes
      .filter((node) => node.id !== start.id && !visited.has(node.id))
      .filter((node) => {
        const def = defOf(node.type);
        return def && def.kind !== "pure";
      })
      .map((node) => node.id);

    for (const id of unused) {
      // a node outside the steps that leads into them would make a merge the steps cannot show
      for (const def of [defOfNode(id)].filter(Boolean) as NodeDef[]) {
        for (const out of def.execOuts) {
          const next = target(id, out.id);
          if (next && visited.has(next)) throw new NotStructured("goto", id);
        }
      }
    }
    return { ok: true, steps: root.steps, unused };
  } catch (error) {
    if (error instanceof NotStructured) return { ok: false, reasons: [{ code: error.code, nodeId: error.nodeId }] };
    throw error;
  }
}

/** Every node id of a tree, in order. */
export function treeIds(steps: StepNode[]): string[] {
  return steps.flatMap((step) => [step.id, ...treeIds(step.body ?? []), ...(step.branches ?? []).flatMap((branch) => treeIds(branch.steps))]);
}

/**
 * The exec wires of a tree written into the graph: nodes, positions, data wires and the
 * wires of nodes outside the tree stay as they are.
 */
export function toGraph(steps: StepNode[], graph: Graph): Graph {
  const start = graph.nodes.find((node) => node.type === "flow.start");
  if (!start) return graph;

  const inTree = new Set([start.id, ...treeIds(steps)]);
  const typeOf = new Map(graph.nodes.map((node) => [node.id, node.type]));
  // exec wires leaving tree nodes are rebuilt; everything else stays
  const edges: GraphEdge[] = graph.edges.filter((edge) => !(edge.targetHandle === "in" && inTree.has(edge.source)));
  const add = (source: string, sourceHandle: string, to: string | null) => {
    if (!to) return;
    const edge = { source, sourceHandle, target: to, targetHandle: "in" };
    edges.push({ id: edgeId(edge), ...edge });
  };

  const wire = (list: StepNode[], next: string | null) => {
    list.forEach((step, i) => {
      const after = i + 1 < list.length ? list[i + 1].id : next;
      const def = defOf(typeOf.get(step.id) ?? "");
      if (!def) return;

      if (def.kind === "loop") {
        add(step.id, "body", step.body?.[0]?.id ?? null);
        wire(step.body ?? [], null);
        add(step.id, "done", after);
      } else if (step.branches?.length) {
        for (const branch of step.branches) {
          const to = branch.steps[0]?.id ?? (branch.ends ? null : after);
          add(step.id, branch.out, to);
          wire(branch.steps, branch.ends ? null : after);
        }
      } else if (def.kind !== "terminal") {
        const main = mainOut(def);
        if (main) add(step.id, main.id, after);
      }
    });
  };

  add(start.id, "next", steps[0]?.id ?? null);
  wire(steps, null);
  return { ...graph, edges };
}

/* ── layout of new nodes ── */

// The flow goes left to right (exec pins are on the sides of a node): the next step to the right,
// a loop body and the second and later branches below.
const STEP_X = 320;
const GAP_Y = 40;
const NODE_W = 260;

/** About how tall a node is drawn: the head and a row per way out and visible pin. */
export function heightOf(node: GraphNode): number {
  const def = defOf(node.type);
  if (!def) return 120;
  const rows = def.execOuts.length + def.inputs.filter((pin) => pinVisible(pin, node.data, def)).length + def.outputs.length;
  return 58 + rows * 26;
}

const overlaps = (node: GraphNode, spot: { x: number; y: number }, h: number) =>
  node.position.x < spot.x + NODE_W && spot.x < node.position.x + NODE_W && node.position.y < spot.y + h && spot.y < node.position.y + heightOf(node);

/** A free spot near `want`: down the column until nothing is in the way. */
export function freeSpot(nodes: GraphNode[], want: { x: number; y: number }, skip?: string): { x: number; y: number } {
  const spot = { ...want };
  const self = skip ? nodes.find((node) => node.id === skip) : undefined;
  const h = self ? heightOf(self) : 120;
  for (let i = 0; i < 400 && nodes.some((node) => node.id !== skip && overlaps(node, spot, h)); i++) spot.y += GAP_Y;
  return spot;
}

/** The free spot closest to `want` for a node `h` tall, with a little room around: near where the person looks. */
export function nearestFree(nodes: GraphNode[], want: { x: number; y: number }, h = 120): { x: number; y: number } {
  const ROOM = 16;
  const free = (spot: { x: number; y: number }) =>
    !nodes.some(
      (node) =>
        node.position.x < spot.x + NODE_W + ROOM && spot.x - ROOM < node.position.x + NODE_W && node.position.y < spot.y + h + ROOM && spot.y - ROOM < node.position.y + heightOf(node),
    );
  if (free(want)) return want;
  for (let ring = 1; ring <= 40; ring++) {
    let best: { x: number; y: number } | null = null;
    let distance = Infinity;
    for (let ix = -ring; ix <= ring; ix++) {
      for (let iy = -ring; iy <= ring; iy++) {
        if (Math.max(Math.abs(ix), Math.abs(iy)) !== ring) continue;
        const spot = { x: want.x + ix * 70, y: want.y + iy * 40 };
        const d = Math.hypot(ix * 70, iy * 40);
        if (d < distance && free(spot)) {
          best = spot;
          distance = d;
        }
      }
    }
    if (best) return best;
  }
  return want;
}

/** Positions for the nodes in `fresh`: right of the step before; bodies and other branches below. */
export function layoutTree(steps: StepNode[], graph: Graph, fresh: Set<string>): Graph {
  const nodes = graph.nodes.map((node) => ({ ...node, position: { ...node.position } }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const start = nodes.find((node) => node.type === "flow.start");
  // nodes not placed yet stay out of the way of the free spot search
  const waiting = new Set(fresh);
  const placed = () => nodes.filter((node) => !waiting.has(node.id));

  const bottomOf = (step: StepNode, fallback: number) =>
    Math.max(fallback, ...treeIds([step]).map((id) => byId.get(id)).filter((node): node is GraphNode => Boolean(node) && !waiting.has(node!.id)).map((node) => node.position.y + heightOf(node)));
  const rightOf = (step: StepNode, fallback: number) =>
    Math.max(fallback, ...treeIds([step]).map((id) => byId.get(id)).filter((node): node is GraphNode => Boolean(node) && !waiting.has(node!.id)).map((node) => node.position.x));

  const place = (list: StepNode[], from: { x: number; y: number }) => {
    let previous = from;
    for (const step of list) {
      const node = byId.get(step.id);
      if (!node) continue;
      if (waiting.has(step.id)) {
        node.position = freeSpot([...placed(), node], { x: previous.x + STEP_X, y: previous.y }, node.id);
        waiting.delete(step.id);
      }
      previous = node.position;
      if (step.body) place(step.body, { x: node.position.x, y: node.position.y + heightOf(node) + GAP_Y });
      step.branches?.forEach((branch, i) => {
        const y = i === 0 ? node.position.y : bottomOf(step, node.position.y + heightOf(node)) + GAP_Y;
        place(branch.steps, { x: node.position.x, y });
      });
      // the steps after a node with branches go right of all of them, on its row
      if (step.branches?.length || step.body?.length) previous = { x: rightOf(step, node.position.x), y: node.position.y };
    }
  };

  place(steps, start?.position ?? { x: 0, y: 0 });
  return { ...graph, nodes };
}
