// The graph editor (React Flow): typed pins, a palette, and nodes placed where the person looks.
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type FinalConnectionState,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Play, Search, Trash2, Unplug, X } from "lucide-react";
import { CATEGORIES, defOf, initialData, isConnectable, NODE_DEFS, type NodeDef, type PinDef } from "../../../shared/scenarios/defs";
import { edgeId, newId, type GraphEdge, type GraphNode, type Scenario, type Value } from "../../../shared/scenarios/model";
import { heightOf, nearestFree } from "../../../shared/scenarios/structure";
import { canConnect } from "../../../shared/scenarios/pins";
import { nodeText, outText, pinText, SCENARIO_TEXTS } from "../../../shared/scenarios/texts";
import { pinVisible, type Issue } from "../../../shared/scenarios/validate";
import { useTexts } from "../i18n";
import type { RunWatch } from "./doc";
import { PinField, useFields } from "./fields";
import { CATEGORY_COLOR, NodeIcon, TYPE_COLOR } from "./look";

/* ── what the cards and edges may do ── */

interface GraphActions {
  setPin(nodeId: string, pin: string, value: Value): void;
  deleteNode(nodeId: string): void;
  deleteEdge(edgeId: string): void;
  /** the pointer is over a wire or its ×: null hides the × after a moment */
  hoverEdge(edgeId: string | null): void;
  disconnect(nodeId: string, handle: string, side: "in" | "out"): void;
  /** right click on a pin: "Disconnect all" */
  pinMenu(nodeId: string, handle: string, side: "in" | "out", x: number, y: number): void;
  runFrom(nodeId: string): void;
  select(nodeId: string | null): void;
  edges: GraphEdge[];
  issues: Issue[];
  watch: RunWatch;
}

const Actions = createContext<GraphActions | null>(null);
const useActions = () => useContext(Actions)!;

type CardData = { node: GraphNode; def: NodeDef };
type CardNode = Node<CardData, "card">;

const NODE_W = 260;

/* ── a node card ── */

const Card = memo(function Card({ data, selected }: NodeProps<CardNode>) {
  const t = useTexts();
  const ctx = useFields();
  const actions = useActions();
  const { node, def } = data;
  const text = nodeText(ctx.lang, def.type);
  const wiredIn = (pin: string) => actions.edges.some((edge) => edge.target === node.id && edge.targetHandle === pin);
  const wiredOut = (pin: string) => actions.edges.some((edge) => edge.source === node.id && edge.sourceHandle === pin);
  const run = actions.watch.nodes.get(node.id);
  const problems = actions.issues.filter((issue) => issue.nodeId === node.id);
  const color = CATEGORY_COLOR[def.category];
  const menu = (handle: string, side: "in" | "out") => (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    actions.pinMenu(node.id, handle, side, event.clientX, event.clientY);
  };

  // advanced pins show on the card only when wired: the inspector has all of them
  const inputs = def.inputs.filter((pin) => pinVisible(pin, node.data, def) && (!pin.advanced || wiredIn(pin.id)));
  const outputs = def.outputs.filter((pin) => !["errorCode", "errorMessage"].includes(pin.id) || wiredOut(pin.id) || wiredOut("error"));

  return (
    <div className={`gh-node ${selected ? "selected" : ""} ${run?.status ?? ""} ${problems.some((p) => p.severity === "error") ? "invalid" : ""}`} style={{ ["--cat" as string]: color }}>
      <div className="gh-node-head" title={text.description}>
        {def.execIn && <Handle type="target" position={Position.Left} id="in" className="gh-h exec" title={t.sc.ways} onContextMenu={menu("in", "in")} />}
        <span className="gh-node-icon">
          <NodeIcon name={def.icon} size={14} />
        </span>
        <span className="gh-node-title">{text.title}</span>
        {run?.ms !== undefined && <span className="gh-node-ms">{run.ms} ms</span>}
        {def.type !== "flow.start" && !ctx.readOnly && (
          <button type="button" className="gh-node-x nodrag" title={t.sc.deleteNode} onClick={() => actions.deleteNode(node.id)}>
            <X size={12} />
          </button>
        )}
      </div>

      <div className="gh-node-body">
        {def.execOuts.map((out) => (
          <div key={out.id} className={`gh-row out exec ${out.kind}`}>
            <span className="gh-label">{outText(ctx.lang, def.type, out.id)}</span>
            <Handle
              type="source"
              position={Position.Right}
              id={out.id}
              className={`gh-h exec ${actions.watch.passed.has(`${node.id}.${out.id}`) ? "passed" : ""}`}
              onContextMenu={menu(out.id, "out")}
            />
          </div>
        ))}

        {inputs.map((pin) => {
          const ptext = pinText(ctx.lang, def.type, pin.id);
          const wired = wiredIn(pin.id);
          return (
            <div key={pin.id} className="gh-row in" title={`${ptext?.description ?? ""} (${t.sc.lang === "ru" ? "тип" : "type"}: ${pin.type})`}>
              {isConnectable(pin) && (
                <Handle type="target" position={Position.Left} id={pin.id} className="gh-h data" style={{ ["--pin" as string]: TYPE_COLOR[pin.type] }} onContextMenu={menu(pin.id, "in")} />
              )}
              <span className="gh-label">{ptext?.label ?? pin.id}</span>
              {wired ? (
                <span className="gh-wired">{t.sc.wired}</span>
              ) : (
                <span className="gh-field">
                  <PinField def={def} pin={pin} value={node.data[pin.id] ?? pin.default ?? null} onChange={(value) => actions.setPin(node.id, pin.id, value)} compact />
                </span>
              )}
            </div>
          );
        })}

        {outputs.map((pin) => {
          const ptext = pinText(ctx.lang, def.type, pin.id);
          const value = run?.outputs?.[pin.id];
          return (
            <div key={pin.id} className="gh-row out" title={ptext?.description}>
              {value !== undefined && value !== null && <span className="gh-value">{typeof value === "object" ? JSON.stringify(value) : String(value)}</span>}
              <span className="gh-label">{ptext?.label ?? pin.id}</span>
              <Handle type="source" position={Position.Right} id={pin.id} className="gh-h data" style={{ ["--pin" as string]: TYPE_COLOR[pin.type] }} onContextMenu={menu(pin.id, "out")} />
            </div>
          );
        })}
      </div>

      {run?.error && <div className="gh-node-error">{run.error.message ?? run.error.code}</div>}
    </div>
  );
});

/* ── an edge with a delete button ── */

type WireData = { exec: boolean; passed: boolean; hovered: boolean };

function Wire({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data, style }: EdgeProps<Edge<WireData>>) {
  const t = useTexts();
  const actions = useActions();
  const ctx = useFields();
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });

  return (
    <>
      <BaseEdge id={id} path={path} style={style} className={`gh-wire ${data?.exec ? "exec" : "data"} ${data?.passed ? "passed" : ""}`} interactionWidth={18} />
      {(selected || data?.hovered) && !ctx.readOnly && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="gh-wire-x nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            title={t.sc.deleteEdge}
            onMouseEnter={() => actions.hoverEdge(id)}
            onMouseLeave={() => actions.hoverEdge(null)}
            onClick={() => actions.deleteEdge(id)}
          >
            <X size={12} />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { card: Card };
const edgeTypes = { wire: Wire };

/* ── palette ── */

export interface PaletteEntry {
  type: string;
  preset?: string;
  def: NodeDef;
  title: string;
  summary: string;
  keywords: string;
}

function entries(lang: "ru" | "en"): PaletteEntry[] {
  return NODE_DEFS.filter((def) => def.type !== "flow.start").flatMap((def) => {
    const text = nodeText(lang, def.type);
    const base = { type: def.type, def, title: text.title, summary: text.summary, keywords: `${text.title} ${text.summary} ${text.description} ${def.type}`.toLowerCase() };
    return [base, ...(def.presets ?? []).map((preset) => ({ ...base, preset: preset.id, title: text.presets?.[preset.id] ?? text.title, keywords: `${base.keywords} ${text.presets?.[preset.id] ?? ""}`.toLowerCase() }))];
  });
}

/** Nodes that fit a dangling wire: an exec out wants an exec in, a data out a fitting input... */
function fits(entry: PaletteEntry, from: Dangling | null): boolean {
  if (!from) return true;
  const { def } = entry;
  if (from.exec) return from.side === "out" ? def.execIn : def.execOuts.length > 0;
  if (from.side === "out") return def.inputs.some((pin) => isConnectable(pin) && canConnect(from.type, pin.type));
  return def.outputs.some((pin) => canConnect(pin.type, from.type));
}

export function Palette({
  onPick,
  filter,
  autoFocus,
  onClose,
  stepsOnly,
}: {
  onPick(entry: PaletteEntry): void;
  filter?: Dangling | null;
  autoFocus?: boolean;
  onClose?(): void;
  /** the step editor: no pure nodes (values are set inside steps) */
  stepsOnly?: boolean;
}) {
  const t = useTexts();
  const ctx = useFields();
  const [query, setQuery] = useState("");
  const all = useMemo(() => entries(ctx.lang), [ctx.lang]);
  const needle = query.trim().toLowerCase();
  const list = all.filter((entry) => (!stepsOnly || entry.def.kind !== "pure") && fits(entry, filter ?? null) && (!needle || entry.keywords.includes(needle)));

  return (
    <div className="gh-palette">
      <label className="gh-search">
        <Search size={14} />
        <input
          autoFocus={autoFocus}
          value={query}
          placeholder={t.sc.search}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose?.();
            if (e.key === "Enter" && list[0]) onPick(list[0]);
          }}
        />
      </label>
      <div className="gh-palette-list">
        {CATEGORIES.map((category) => {
          const items = list.filter((entry) => entry.def.category === category);
          if (!items.length) return null;
          return (
            <div key={category} className="gh-palette-group">
              <div className="gh-palette-cat" style={{ color: CATEGORY_COLOR[category] }}>
                {nodeTextCategory(ctx.lang, category)}
              </div>
              {items.map((entry) => (
                <button
                  key={`${entry.type}:${entry.preset ?? ""}`}
                  type="button"
                  className="gh-palette-item"
                  title={entry.summary}
                  draggable
                  onDragStart={(event: DragEvent) => {
                    event.dataTransfer.setData("application/gh-node", JSON.stringify({ type: entry.type, preset: entry.preset }));
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onClick={() => onPick(entry)}
                >
                  <span className="gh-palette-icon" style={{ color: CATEGORY_COLOR[category] }}>
                    <NodeIcon name={entry.def.icon} size={14} />
                  </span>
                  <span className="gh-palette-text">
                    <span className="gh-palette-title">{entry.title}</span>
                    <span className="gh-palette-summary">{entry.summary}</span>
                  </span>
                </button>
              ))}
            </div>
          );
        })}
        {!list.length && <div className="gh-palette-empty">{t.sc.nothingFound}</div>}
      </div>
    </div>
  );
}

const nodeTextCategory = (lang: "ru" | "en", category: (typeof CATEGORIES)[number]) => SCENARIO_TEXTS[lang].categories[category];

/* ── the graph view ── */

export interface Dangling {
  nodeId: string;
  handle: string;
  side: "out" | "in";
  exec: boolean;
  type: PinDef["type"];
}

interface Floating {
  screen: { x: number; y: number };
  flow: { x: number; y: number };
  from: Dangling | null;
  kind: "palette" | "node" | "edge" | "pin";
  target?: string;
}

export interface GraphViewProps {
  scenario: Scenario;
  change(mutate: (draft: Scenario) => void, merge?: string): void;
  issues: Issue[];
  watch: RunWatch;
  selected: string | null;
  onSelect(id: string | null): void;
  onRunFrom(id: string): void;
  focus?: { id: string; at: number } | null;
  /** the palette on the left (nodes can also be added with a right click or Space) */
  palette?: boolean;
}

export function GraphView(props: GraphViewProps) {
  return (
    <ReactFlowProvider>
      <GraphCanvas {...props} />
    </ReactFlowProvider>
  );
}

function pinOf(node: GraphNode | undefined, handle: string, side: "in" | "out"): { exec: boolean; type: PinDef["type"] } | null {
  const def = node && defOf(node.type);
  if (!def) return null;
  if (side === "in") {
    if (handle === "in") return def.execIn ? { exec: true, type: "exec" } : null;
    const pin = def.inputs.find((p) => p.id === handle);
    return pin && isConnectable(pin) ? { exec: false, type: pin.type } : null;
  }
  if (def.execOuts.some((out) => out.id === handle)) return { exec: true, type: "exec" };
  const pin = def.outputs.find((p) => p.id === handle);
  return pin ? { exec: false, type: pin.type } : null;
}

/** A new edge replaces what was on the same exec out or the same data input. */
export function connect(draft: Scenario, edge: Omit<GraphEdge, "id">): void {
  const exec = edge.targetHandle === "in";
  draft.graph.edges = draft.graph.edges.filter((e) =>
    exec ? !(e.source === edge.source && e.sourceHandle === edge.sourceHandle && e.targetHandle === "in") : !(e.target === edge.target && e.targetHandle === edge.targetHandle),
  );
  draft.graph.edges.push({ id: edgeId(edge), ...edge });
}

function GraphCanvas({ scenario, change, issues, watch, selected, onSelect, onRunFrom, focus, palette = true }: GraphViewProps) {
  const t = useTexts();
  const ctx = useFields();
  const flow = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const [floating, setFloating] = useState<Floating | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const unhover = useRef<number | null>(null);
  const [dragged, setDragged] = useState<Map<string, { x: number; y: number }>>(new Map());
  const { graph } = scenario;
  // a graph nobody has moved yet (made in the steps) opens with everything in view
  const [fitFirst] = useState(() => graph.viewport.x === 120 && graph.viewport.y === 80 && graph.viewport.zoom === 1);

  const nodes: CardNode[] = useMemo(
    () =>
      graph.nodes
        .filter((node) => defOf(node.type))
        .map((node) => ({
          id: node.id,
          type: "card",
          position: dragged.get(node.id) ?? node.position,
          data: { node, def: defOf(node.type)! },
          selected: node.id === selected,
          deletable: node.type !== "flow.start" && !ctx.readOnly,
          draggable: !ctx.readOnly,
          style: { width: NODE_W },
        })),
    [graph.nodes, selected, dragged, ctx.readOnly],
  );

  const hoverEdge = useCallback((id: string | null) => {
    if (unhover.current) window.clearTimeout(unhover.current);
    unhover.current = null;
    // leaving the wire for its × must not hide the ×
    if (id) setHoveredEdge(id);
    else unhover.current = window.setTimeout(() => setHoveredEdge(null), 350);
  }, []);

  const edges: Edge<WireData>[] = useMemo(
    () =>
      graph.edges.map((edge) => {
        const exec = edge.targetHandle === "in";
        const source = graph.nodes.find((n) => n.id === edge.source);
        const pin = exec ? null : pinOf(source, edge.sourceHandle, "out");
        return {
          id: edge.id,
          type: "wire",
          source: edge.source,
          sourceHandle: edge.sourceHandle,
          target: edge.target,
          targetHandle: edge.targetHandle,
          selected: edge.id === selectedEdge,
          deletable: !ctx.readOnly,
          data: { exec, passed: watch.passed.has(`${edge.source}.${edge.sourceHandle}`), hovered: edge.id === hoveredEdge },
          style: exec ? undefined : { stroke: TYPE_COLOR[pin?.type ?? "any"] },
        };
      }),
    [graph.edges, graph.nodes, selectedEdge, hoveredEdge, watch.passed, ctx.readOnly],
  );

  /* ── changes ── */

  const deleteNodes = useCallback(
    (ids: string[]) =>
      change((draft) => {
        const gone = new Set(ids.filter((id) => draft.graph.nodes.find((n) => n.id === id)?.type !== "flow.start"));
        draft.graph.nodes = draft.graph.nodes.filter((n) => !gone.has(n.id));
        draft.graph.edges = draft.graph.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target));
      }),
    [change],
  );

  const deleteEdges = useCallback((ids: string[]) => change((draft) => void (draft.graph.edges = draft.graph.edges.filter((e) => !ids.includes(e.id)))), [change]);

  const actions: GraphActions = useMemo(
    () => ({
      setPin: (nodeId, pin, value) =>
        change((draft) => {
          const node = draft.graph.nodes.find((n) => n.id === nodeId);
          if (node) node.data[pin] = value;
        }, `${nodeId}.${pin}`),
      deleteNode: (id) => deleteNodes([id]),
      deleteEdge: (id) => deleteEdges([id]),
      hoverEdge,
      disconnect: (nodeId, handle, side) =>
        change((draft) => {
          draft.graph.edges = draft.graph.edges.filter((e) => !(side === "out" ? e.source === nodeId && e.sourceHandle === handle : e.target === nodeId && e.targetHandle === handle));
        }),
      pinMenu: (nodeId, handle, side, x, y) => {
        if (!ctx.readOnly) setFloating({ screen: { x, y }, flow: { x: 0, y: 0 }, from: null, kind: "pin", target: `${nodeId}|${handle}|${side}` });
      },
      runFrom: onRunFrom,
      select: onSelect,
      edges: graph.edges,
      issues,
      watch,
    }),
    [change, deleteNodes, deleteEdges, hoverEdge, onRunFrom, onSelect, graph.edges, issues, watch, ctx.readOnly],
  );

  /**
   * A node of a type at a flow position. `nearest`: the free spot closest to it (the palette button
   * puts it where the person looks); otherwise exactly there, nudged off a node at the same point.
   */
  const addNode = useCallback(
    (type: string, preset: string | undefined, at: { x: number; y: number }, from?: Dangling | null, nearest = false) => {
      const def = defOf(type);
      if (!def) return;

      const id = `n${newId(8)}`;
      change((draft) => {
        const node: GraphNode = { id, type, v: def.version, position: { x: Math.round(at.x), y: Math.round(at.y) }, data: initialData(def, preset) };
        if (nearest) node.position = nearestFree(draft.graph.nodes, node.position, heightOf(node));
        else {
          for (let i = 0; i < 40 && draft.graph.nodes.some((n) => Math.abs(n.position.x - node.position.x) < 24 && Math.abs(n.position.y - node.position.y) < 24); i++) {
            node.position.x += 24;
            node.position.y += 24;
          }
        }
        draft.graph.nodes.push(node);

        // a wire dropped on empty space: connect it to the first pin that fits
        if (from) {
          if (from.exec && from.side === "out" && def.execIn) connect(draft, { source: from.nodeId, sourceHandle: from.handle, target: id, targetHandle: "in" });
          if (from.exec && from.side === "in") {
            const out = def.execOuts.find((o) => o.kind === "next" || o.kind === "branch" || o.kind === "done");
            if (out) connect(draft, { source: id, sourceHandle: out.id, target: from.nodeId, targetHandle: "in" });
          }
          if (!from.exec && from.side === "out") {
            const pin = def.inputs.find((p) => isConnectable(p) && canConnect(from.type, p.type));
            if (pin) connect(draft, { source: from.nodeId, sourceHandle: from.handle, target: id, targetHandle: pin.id });
          }
          if (!from.exec && from.side === "in") {
            const pin = def.outputs.find((p) => canConnect(p.type, from.type));
            if (pin) connect(draft, { source: id, sourceHandle: pin.id, target: from.nodeId, targetHandle: from.handle });
          }
        }
      });
      onSelect(id);
    },
    [change, onSelect],
  );

  /** Where the person looks: the middle of the visible part of the graph. */
  const center = useCallback(() => {
    const rect = wrapper.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const at = flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    return { x: at.x - NODE_W / 2, y: at.y - 40 };
  }, [flow]);

  const pick = useCallback(
    (entry: PaletteEntry) => {
      if (floating) addNode(entry.type, entry.preset, floating.flow, floating.from);
      else addNode(entry.type, entry.preset, center(), null, true);
      setFloating(null);
    },
    [floating, addNode, center],
  );

  /* ── events ── */

  const onNodesChange = useCallback(
    (changes: NodeChange<CardNode>[]) => {
      for (const c of changes) {
        if (c.type === "position" && c.position) {
          const position = c.position;
          setDragged((map) => new Map(map).set(c.id, position));
        }
        if (c.type === "select" && c.selected) onSelect(c.id);
      }
    },
    [onSelect],
  );

  const onNodeDragStop = useCallback(
    (_event: unknown, _node: CardNode, moved: CardNode[]) => {
      const positions = new Map(moved.map((n) => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }]));
      change((draft) => {
        for (const node of draft.graph.nodes) {
          const p = positions.get(node.id);
          if (p) node.position = p;
        }
      });
      setDragged(new Map());
    },
    [change],
  );

  const isValidConnection = useCallback(
    (c: Connection | Edge) => {
      if (!c.source || !c.target || c.source === c.target) return false;
      const from = pinOf(graph.nodes.find((n) => n.id === c.source), c.sourceHandle ?? "", "out");
      const to = pinOf(graph.nodes.find((n) => n.id === c.target), c.targetHandle ?? "", "in");
      if (!from || !to) return false;
      return from.exec ? to.exec : !to.exec && canConnect(from.type, to.type);
    },
    [graph.nodes],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!isValidConnection(c)) return;
      change((draft) => connect(draft, { source: c.source, sourceHandle: c.sourceHandle ?? "", target: c.target, targetHandle: c.targetHandle ?? "" }));
    },
    [change, isValidConnection],
  );

  // a wire dropped on empty space: the palette there, only nodes that fit
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (state.isValid || !state.fromNode || !state.fromHandle || ctx.readOnly) return;
      const point = "changedTouches" in event ? event.changedTouches[0] : event;
      const side = state.fromHandle.type === "source" ? "out" : "in";
      const pin = pinOf(graph.nodes.find((n) => n.id === state.fromNode!.id), state.fromHandle.id ?? "", side);
      if (!pin) return;
      setFloating({
        screen: { x: point.clientX, y: point.clientY },
        flow: flow.screenToFlowPosition({ x: point.clientX, y: point.clientY }),
        from: { nodeId: state.fromNode.id, handle: state.fromHandle.id ?? "", side, exec: pin.exec, type: pin.type },
        kind: "palette",
      });
    },
    [flow, graph.nodes, ctx.readOnly],
  );

  const onDrop = useCallback(
    (event: DragEvent) => {
      const raw = event.dataTransfer.getData("application/gh-node");
      if (!raw || ctx.readOnly) return;
      event.preventDefault();
      const { type, preset } = JSON.parse(raw) as { type: string; preset?: string };
      const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      addNode(type, preset, { x: at.x - NODE_W / 2, y: at.y - 20 });
    },
    [flow, addNode, ctx.readOnly],
  );

  // keys: F - fit, Space - the palette at the cursor
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const typing = (event.target as HTMLElement)?.closest?.("input, textarea, select, [contenteditable]");
      if (typing || !wrapper.current?.contains(document.activeElement) && document.activeElement !== document.body) return;
      if (event.key === "f" || event.key === "F" || event.key === "а" || event.key === "А") flow.fitView({ padding: 0.2, duration: 250 });
      if (event.code === "Space" && pointer.current && !ctx.readOnly) {
        event.preventDefault();
        setFloating({ screen: pointer.current, flow: flow.screenToFlowPosition(pointer.current), from: null, kind: "palette" });
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [flow, ctx.readOnly]);

  // "open at the failing step": centre on it
  useEffect(() => {
    if (!focus) return;
    const node = graph.nodes.find((n) => n.id === focus.id);
    if (node) flow.setCenter(node.position.x + NODE_W / 2, node.position.y + 60, { zoom: 1.1, duration: 300 });
  }, [focus, flow, graph.nodes]);

  return (
    <Actions.Provider value={actions}>
      <div className="gh-graph">
        {!ctx.readOnly && palette && (
          <aside className="gh-side">
            <Palette onPick={pick} />
          </aside>
        )}
        <div
          className="gh-canvas"
          ref={wrapper}
          onMouseMove={(e) => (pointer.current = { x: e.clientX, y: e.clientY })}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          onDrop={onDrop}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            defaultViewport={graph.viewport}
            fitView={fitFirst}
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
            minZoom={0.2}
            maxZoom={2.5}
            snapToGrid
            snapGrid={[8, 8]}
            deleteKeyCode={ctx.readOnly ? null : ["Delete", "Backspace"]}
            nodesConnectable={!ctx.readOnly}
            elementsSelectable
            onNodesChange={onNodesChange}
            onNodeDragStop={onNodeDragStop}
            onNodesDelete={(deleted) => deleteNodes(deleted.map((n) => n.id))}
            onEdgesDelete={(deleted) => deleteEdges(deleted.map((e) => e.id))}
            onConnect={onConnect}
            onConnectEnd={onConnectEnd}
            isValidConnection={isValidConnection}
            onEdgeClick={(event, edge) => {
              // Alt+click deletes a wire at once
              if (event.altKey && !ctx.readOnly) deleteEdges([edge.id]);
              else setSelectedEdge(edge.id);
            }}
            onEdgeMouseEnter={(_event, edge) => hoverEdge(edge.id)}
            onEdgeMouseLeave={() => hoverEdge(null)}
            onPaneClick={() => {
              setSelectedEdge(null);
              setFloating(null);
              onSelect(null);
            }}
            onPaneContextMenu={(event) => {
              event.preventDefault();
              if (ctx.readOnly) return;
              setFloating({ screen: { x: event.clientX, y: event.clientY }, flow: flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }), from: null, kind: "palette" });
            }}
            onNodeContextMenu={(event, node) => {
              event.preventDefault();
              onSelect(node.id);
              setFloating({ screen: { x: event.clientX, y: event.clientY }, flow: { x: 0, y: 0 }, from: null, kind: "node", target: node.id });
            }}
            onEdgeContextMenu={(event, edge) => {
              event.preventDefault();
              if (ctx.readOnly) return;
              setFloating({ screen: { x: event.clientX, y: event.clientY }, flow: { x: 0, y: 0 }, from: null, kind: "edge", target: edge.id });
            }}
            onMoveEnd={(_event, viewport) => change((draft) => void (draft.graph.viewport = viewport), "viewport")}
            proOptions={{ hideAttribution: true }}
            colorMode="dark"
          >
            <Background gap={24} size={1} color="#2b2140" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable style={{ width: 150, height: 100 }} nodeColor={(node) => CATEGORY_COLOR[(node.data as CardData).def.category]} maskColor="rgba(10, 6, 18, 0.7)" />
          </ReactFlow>

          {floating && (
            <div className="gh-float" style={{ left: floating.screen.x - (wrapper.current?.getBoundingClientRect().left ?? 0), top: floating.screen.y - (wrapper.current?.getBoundingClientRect().top ?? 0) }} onMouseDown={(e) => e.stopPropagation()}>
              {floating.kind === "palette" && <Palette onPick={pick} filter={floating.from} autoFocus onClose={() => setFloating(null)} />}
              {floating.kind === "node" && floating.target && (
                <div className="gh-menu">
                  <button type="button" onClick={() => (onRunFrom(floating.target!), setFloating(null))}>
                    <Play size={14} /> {t.sc.runFrom}
                  </button>
                  {!ctx.readOnly && graph.nodes.find((n) => n.id === floating.target)?.type !== "flow.start" && (
                    <button type="button" className="danger" onClick={() => (deleteNodes([floating.target!]), setFloating(null))}>
                      <Trash2 size={14} /> {t.sc.deleteNode}
                    </button>
                  )}
                </div>
              )}
              {floating.kind === "pin" && floating.target && (
                <div className="gh-menu">
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      const [nodeId, handle, side] = floating.target!.split("|");
                      actions.disconnect(nodeId, handle, side as "in" | "out");
                      setFloating(null);
                    }}
                  >
                    <Unplug size={14} /> {t.sc.disconnect}
                  </button>
                </div>
              )}
              {floating.kind === "edge" && floating.target && (
                <div className="gh-menu">
                  <button type="button" className="danger" onClick={() => (deleteEdges([floating.target!]), setFloating(null))}>
                    <Unplug size={14} /> {t.sc.deleteEdge}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Actions.Provider>
  );
}
