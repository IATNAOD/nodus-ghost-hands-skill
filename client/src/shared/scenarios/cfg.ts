import { defOf, type NodeDef } from "./defs";
import type { Graph, GraphEdge, GraphNode } from "./model";

// The exec flow of a scenario as a control-flow graph: who can run after whom.
// A loop runs its body and comes back when the body chain ends, so an unconnected
// next/branch/done output inside a body leads back to the loop node.

export interface Flow {
  start: string | null;
  /** node id → exec successors (with the implicit returns to loops) */
  succ: Map<string, string[]>;
  /** loop id → the nodes its body can reach */
  bodies: Map<string, Set<string>>;
  /** node id → innermost loop whose body holds it */
  owner: Map<string, string>;
  reachable: Set<string>;
}

export const execNodes = (graph: Graph): GraphNode[] =>
  graph.nodes.filter((node) => {
    const def = defOf(node.type);
    return def && def.kind !== "pure";
  });

/** The edge leaving `out` of `node` (exec outputs have at most one). */
export function execTarget(edges: GraphEdge[], node: string, out: string): string | null {
  return edges.find((edge) => edge.source === node && edge.sourceHandle === out)?.target ?? null;
}

const RETURNS = new Set(["next", "branch", "done", "body"]);

export function buildFlow(graph: Graph): Flow {
  const nodes = execNodes(graph);
  const defs = new Map<string, NodeDef>(nodes.map((node) => [node.id, defOf(node.type)!]));
  const start = nodes.find((node) => defs.get(node.id)!.kind === "start")?.id ?? null;
  const direct = new Map<string, string[]>();

  for (const node of nodes) {
    const def = defs.get(node.id)!;
    const next: string[] = [];

    for (const out of def.execOuts) {
      const target = execTarget(graph.edges, node.id, out.id);
      if (target && defs.has(target)) next.push(target);
    }
    direct.set(node.id, next);
  }

  // body regions: everything a loop's body output reaches, without going past the loop itself
  const bodies = new Map<string, Set<string>>();

  for (const node of nodes) {
    if (defs.get(node.id)!.kind !== "loop") continue;

    const region = new Set<string>();
    const first = execTarget(graph.edges, node.id, "body");
    const stack = first && defs.has(first) ? [first] : [];

    while (stack.length) {
      const id = stack.pop()!;
      if (id === node.id || region.has(id)) continue;
      region.add(id);
      stack.push(...(direct.get(id) ?? []));
    }
    bodies.set(node.id, region);
  }

  // the innermost loop of a node: the smallest body that holds it
  const owner = new Map<string, string>();

  for (const node of nodes) {
    let best: string | null = null;

    for (const [loop, region] of bodies) {
      if (!region.has(node.id)) continue;
      if (best === null || bodies.get(best)!.size > region.size) best = loop;
    }
    if (best) owner.set(node.id, best);
  }

  const succ = new Map<string, string[]>();

  for (const node of nodes) {
    const def = defs.get(node.id)!;
    const list = [...(direct.get(node.id) ?? [])];
    const loop = owner.get(node.id);

    // an unconnected way out inside a body goes back to the loop
    if (loop && !def.traits?.noreturn) {
      const open = def.execOuts.some((out) => RETURNS.has(out.kind) && !execTarget(graph.edges, node.id, out.id));
      if (open || def.execOuts.length === 0) list.push(loop);
    }
    succ.set(node.id, [...new Set(list)]);
  }

  const reachable = new Set<string>();
  const stack = start ? [start] : [];

  while (stack.length) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    stack.push(...(succ.get(id) ?? []));
  }

  return { start, succ, bodies, owner, reachable };
}

/** Reverse post-order of the reachable nodes. */
function reversePostOrder(flow: Flow): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    seen.add(id);
    for (const next of flow.succ.get(id) ?? []) if (!seen.has(next)) visit(next);
    order.push(id);
  };

  if (flow.start) visit(flow.start);
  return order.reverse();
}

/** Immediate dominators (Cooper, Harvey, Kennedy): node → the node every path to it passes last. */
export function dominators(flow: Flow): Map<string, string> {
  const order = reversePostOrder(flow);
  const index = new Map(order.map((id, i) => [id, i]));
  const preds = new Map<string, string[]>();
  const idom = new Map<string, string>();

  for (const id of order) for (const next of flow.succ.get(id) ?? []) if (index.has(next)) preds.set(next, [...(preds.get(next) ?? []), id]);
  if (!flow.start) return idom;
  idom.set(flow.start, flow.start);

  const intersect = (a: string, b: string): string => {
    let x = a;
    let y = b;

    while (x !== y) {
      while (index.get(x)! > index.get(y)!) x = idom.get(x)!;
      while (index.get(y)! > index.get(x)!) y = idom.get(y)!;
    }
    return x;
  };

  for (let changed = true; changed; ) {
    changed = false;
    for (const id of order) {
      if (id === flow.start) continue;

      const done = (preds.get(id) ?? []).filter((pred) => idom.has(pred));
      if (!done.length) continue;

      const next = done.slice(1).reduce(intersect, done[0]);
      if (idom.get(id) !== next) {
        idom.set(id, next);
        changed = true;
      }
    }
  }
  return idom;
}

/** Does `a` run on every path from Start to `b`? */
export function dominates(idom: Map<string, string>, a: string, b: string): boolean {
  if (!idom.has(b)) return false;

  for (let x = b; ; x = idom.get(x)!) {
    if (x === a) return true;
    if (idom.get(x) === x) return false;
  }
}
