// The step editor: the scenario as a list, like the routines of voice assistants. It edits the
// same graph: every change goes through toSteps → change the tree → toGraph.
import { useMemo, useState, type ReactNode } from "react";
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AlertTriangle, ArrowDown, ArrowUp, ChevronDown, ChevronRight, GitBranch, GripVertical, Network, Plus, ShieldAlert, Trash2, X } from "lucide-react";
import { defOf, initialData, isConnectable, type NodeDef, type PinDef } from "../../../shared/scenarios/defs";
import { newId, type GraphNode, type Scenario, type Value } from "../../../shared/scenarios/model";
import { canConnect } from "../../../shared/scenarios/pins";
import { layoutTree, mainOut, toGraph, toSteps, treeIds, type StepNode } from "../../../shared/scenarios/structure";
import { nodeText, outText, pinText } from "../../../shared/scenarios/texts";
import { pinVisible } from "../../../shared/scenarios/validate";
import { fill, useTexts } from "../i18n";
import type { RunWatch } from "./doc";
import { connect, Palette, type PaletteEntry } from "./graph";
import { PinField, useFields, valueLabel } from "./fields";
import { CATEGORY_COLOR, NodeIcon } from "./look";

/** Where a list of steps is: the parents and which branch ("body" for a loop). */
type Path = { id: string; where: string }[];

function listAt(steps: StepNode[], path: Path): StepNode[] {
  let list = steps;
  for (const { id, where } of path) {
    const step = list.find((s) => s.id === id);
    if (!step) return [];
    list = where === "body" ? (step.body ?? []) : (step.branches?.find((b) => b.out === where)?.steps ?? []);
  }
  return list;
}

function withList(steps: StepNode[], path: Path, update: (list: StepNode[]) => StepNode[]): StepNode[] {
  if (!path.length) return update(steps);
  const [{ id, where }, ...rest] = path;
  return steps.map((step) => {
    if (step.id !== id) return step;
    if (where === "body") return { ...step, body: withList(step.body ?? [], rest, update) };
    return { ...step, branches: step.branches?.map((b) => (b.out === where ? { ...b, steps: withList(b.steps, rest, update) } : b)) };
  });
}

/** Steps before a node, in order (their outputs can feed it); loops around it give their round. */
function before(steps: StepNode[], id: string): string[] {
  const order = treeIds(steps);
  const index = order.indexOf(id);
  return index > 0 ? order.slice(0, index) : [];
}

interface StepsProps {
  scenario: Scenario;
  change(mutate: (draft: Scenario) => void, merge?: string): void;
  watch: RunWatch;
  selected: string | null;
  onSelect(id: string | null): void;
  onOpenGraph(): void;
}

export function StepsView({ scenario, change, watch, selected, onSelect, onOpenGraph }: StepsProps) {
  const t = useTexts();
  const ctx = useFields();
  const structure = useMemo(() => toSteps(scenario.graph), [scenario.graph]);

  /** A change of the tree, written back into the graph; new nodes get positions. */
  const edit = (update: (steps: StepNode[], draft: Scenario) => StepNode[], fresh: string[] = []) =>
    change((draft) => {
      const current = toSteps(draft.graph);
      if (!current.ok) return;
      const tree = update(current.steps, draft);
      draft.graph = layoutTree(tree, toGraph(tree, draft.graph), new Set(fresh));
    });

  const ops: StepOps = {
    insert: (path, index, entry) => {
      const def = entry.def;
      const id = `n${newId(8)}`;
      edit((steps, draft) => {
        draft.graph.nodes.push({ id, type: def.type, v: def.version, position: { x: 0, y: 0 }, data: initialData(def, entry.preset) });
        const node: StepNode =
          def.kind === "loop" ? { id, body: [] } : def.kind === "branch" ? { id, branches: def.execOuts.map((out) => ({ out: out.id, steps: [], ends: false })) } : { id };
        return withList(steps, path, (list) => [...list.slice(0, index), node, ...list.slice(index)]);
      }, [id]);
      onSelect(id);
    },
    remove: (path, index) =>
      edit((steps, draft) => {
        const list = listAt(steps, path);
        const gone = new Set(treeIds([list[index]]));
        // values computed only for the removed steps go with them
        const feeders = draft.graph.edges.filter((e) => gone.has(e.target)).map((e) => e.source);
        draft.graph.edges = draft.graph.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target));
        for (const source of feeders) {
          const node = draft.graph.nodes.find((n) => n.id === source);
          if (node && defOf(node.type)?.kind === "pure" && !draft.graph.edges.some((e) => e.source === source)) gone.add(source);
        }
        draft.graph.nodes = draft.graph.nodes.filter((n) => !gone.has(n.id));
        draft.graph.edges = draft.graph.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target));
        return withList(steps, path, (items) => items.filter((_, i) => i !== index));
      }),
    move: (path, from, to) => edit((steps) => withList(steps, path, (list) => arrayMove(list, from, Math.max(0, Math.min(list.length - 1, to))))),
    branch: (path, index, out, on) =>
      edit((steps, draft) => {
        const step = listAt(steps, path)[index];
        const def = defOf(draft.graph.nodes.find((n) => n.id === step.id)?.type ?? "");
        const main = def && mainOut(def);
        if (!def || !main) return steps;

        let branches = step.branches ?? [{ out: main.id, steps: [], ends: false }];
        if (on && !branches.some((b) => b.out === out)) branches = [...branches, { out, steps: [], ends: false }];
        if (!on) {
          const removed = branches.find((b) => b.out === out);
          const gone = new Set(treeIds(removed?.steps ?? []));
          draft.graph.nodes = draft.graph.nodes.filter((n) => !gone.has(n.id));
          draft.graph.edges = draft.graph.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target) && !(e.source === step.id && e.sourceHandle === out));
          branches = branches.filter((b) => b.out !== out);
        }
        // only the main way left, with nothing in it: a plain step again
        const plain = branches.length === 1 && branches[0].out === main.id && !branches[0].steps.length;
        return withList(steps, path, (list) => list.map((s, i) => (i === index ? { id: s.id, ...(plain ? {} : { branches }) } : s)));
      }),
  };

  if (!structure.ok) {
    return (
      <div className="st-view">
        <div className="banner">
          <Network />
          <span>{fill(t.sc.notStructured, { reasons: structure.reasons.map((r) => t.sc.reason[r.code] ?? r.code).join(", ") })}</span>
          <span className="spacer" />
          <button type="button" className="btn btn-secondary" onClick={onOpenGraph}>
            {t.sc.openGraph}
          </button>
        </div>
        <ol className="st-outline">
          {scenario.graph.nodes
            .filter((node) => defOf(node.type)?.kind !== "pure")
            .map((node) => (
              <li key={node.id} onClick={() => onSelect(node.id)}>
                <NodeIcon name={defOf(node.type)?.icon ?? "workflow"} size={14} /> {nodeText(ctx.lang, node.type).title}
              </li>
            ))}
        </ol>
      </div>
    );
  }

  return (
    <div className="st-view">
      <StepList steps={structure.steps} path={[]} all={structure.steps} scenario={scenario} change={change} ops={ops} watch={watch} selected={selected} onSelect={onSelect} />
      {structure.unused.length > 0 && <p className="hint st-unused">{fill(t.sc.unused, { count: structure.unused.length })}</p>}
    </div>
  );
}

interface StepOps {
  insert(path: Path, index: number, entry: PaletteEntry): void;
  remove(path: Path, index: number): void;
  move(path: Path, from: number, to: number): void;
  branch(path: Path, index: number, out: string, on: boolean): void;
}

interface ListProps {
  steps: StepNode[];
  path: Path;
  all: StepNode[];
  scenario: Scenario;
  change(mutate: (draft: Scenario) => void, merge?: string): void;
  ops: StepOps;
  watch: RunWatch;
  selected: string | null;
  onSelect(id: string | null): void;
}

function StepList(props: ListProps) {
  const { steps, path, ops } = props;
  const ctx = useFields();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const onDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return;
    const from = steps.findIndex((s) => s.id === event.active.id);
    const to = steps.findIndex((s) => s.id === event.over!.id);
    if (from >= 0 && to >= 0) ops.move(path, from, to);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
        <div className="st-list">
          {!ctx.readOnly && <AddStep onAdd={(entry) => ops.insert(path, 0, entry)} />}
          {steps.map((step, index) => (
            <div key={step.id}>
              <StepCard {...props} step={step} index={index} />
              {!ctx.readOnly && <AddStep onAdd={(entry) => ops.insert(path, index + 1, entry)} />}
            </div>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function AddStep({ onAdd }: { onAdd(entry: PaletteEntry): void }) {
  const t = useTexts();
  const [open, setOpen] = useState(false);

  return (
    <div className={`st-add ${open ? "open" : ""}`}>
      <button type="button" className="st-add-btn" title={t.sc.addStep} onClick={() => setOpen(!open)}>
        <Plus size={14} />
      </button>
      {open && (
        <div className="st-add-pop">
          <Palette
            stepsOnly
            autoFocus
            onClose={() => setOpen(false)}
            onPick={(entry) => {
              setOpen(false);
              onAdd(entry);
            }}
          />
        </div>
      )}
    </div>
  );
}

function StepCard(props: ListProps & { step: StepNode; index: number }) {
  const { step, index, path, steps, scenario, change, ops, watch, selected, onSelect } = props;
  const t = useTexts();
  const ctx = useFields();
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const sortable = useSortable({ id: step.id, disabled: ctx.readOnly });
  const node = scenario.graph.nodes.find((n) => n.id === step.id);
  const def = node && defOf(node.type);
  if (!node || !def) return null;

  const text = nodeText(ctx.lang, def.type);
  const run = watch.nodes.get(step.id);
  const color = CATEGORY_COLOR[def.category];
  const main = mainOut(def);
  const errorOut = def.execOuts.find((o) => o.kind === "error");
  const failOut = def.execOuts.find((o) => o.kind === "fail");
  const has = (out: string) => step.branches?.some((b) => b.out === out) ?? false;
  const line = stepLine(def, node, scenario, ctx, text.step);
  const inputs = def.inputs.filter((pin) => pinVisible(pin, node.data, def) && (more || !pin.advanced));
  const hasAdvanced = def.inputs.some((pin) => pin.advanced && pinVisible(pin, node.data, def));

  return (
    <div
      ref={sortable.setNodeRef}
      style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition, ["--cat" as string]: color }}
      className={`st-card ${selected === step.id ? "selected" : ""} ${run?.status ?? ""} ${sortable.isDragging ? "dragging" : ""}`}
    >
      <div className="st-head" onClick={() => onSelect(step.id)}>
        {!ctx.readOnly && (
          <span className="st-grip" {...sortable.attributes} {...sortable.listeners}>
            <GripVertical size={14} />
          </span>
        )}
        <span className="st-icon">
          <NodeIcon name={def.icon} size={15} />
        </span>
        <button type="button" className="st-line" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span>{line}</span>
        </button>
        {run?.status === "error" && (
          <span className="st-error" title={run.error?.message ?? run.error?.code}>
            <AlertTriangle size={14} />
            {run.error?.code}
          </span>
        )}
        {run?.ms !== undefined && run.status !== "error" && <span className="st-ms">{run.ms} ms</span>}
        {!ctx.readOnly && (
          <span className="st-tools">
            <button type="button" className="btn btn-ghost btn-sm" title={t.sc.moveUp} disabled={index === 0} onClick={() => ops.move(path, index, index - 1)}>
              <ArrowUp />
            </button>
            <button type="button" className="btn btn-ghost btn-sm" title={t.sc.moveDown} disabled={index === steps.length - 1} onClick={() => ops.move(path, index, index + 1)}>
              <ArrowDown />
            </button>
            {failOut && main && (
              <button type="button" className={`btn btn-ghost btn-sm ${has(failOut.id) ? "on" : ""}`} title={t.sc.addFail} onClick={() => ops.branch(path, index, failOut.id, !has(failOut.id))}>
                <GitBranch />
              </button>
            )}
            {errorOut && main && (
              <button type="button" className={`btn btn-ghost btn-sm ${has("error") ? "on" : ""}`} title={has("error") ? t.sc.removeError : t.sc.addError} onClick={() => ops.branch(path, index, "error", !has("error"))}>
                <ShieldAlert />
              </button>
            )}
            <button type="button" className="btn btn-ghost btn-sm danger" title={t.sc.delete} onClick={() => ops.remove(path, index)}>
              <Trash2 />
            </button>
          </span>
        )}
      </div>

      {open && (
        <div className="st-fields">
          <p className="hint">{text.description}</p>
          {inputs.map((pin) => (
            <StepInput key={pin.id} def={def} node={node} pin={pin} scenario={scenario} change={change} all={props.all} />
          ))}
          {hasAdvanced && (
            <button type="button" className="link" onClick={() => setMore(!more)}>
              {more ? t.sc.less : t.sc.more}
            </button>
          )}
        </div>
      )}

      {step.body && (
        <div className="st-branch">
          <div className="st-branch-label">{outText(ctx.lang, def.type, "body")}</div>
          <StepList {...props} steps={step.body} path={[...path, { id: step.id, where: "body" }]} />
        </div>
      )}
      {step.branches?.map((branch) => (
        <div key={branch.out} className={`st-branch ${branch.out === "error" || branch.out === failOut?.id ? "alt" : ""}`}>
          <div className="st-branch-label">
            {outText(ctx.lang, def.type, branch.out)}
            {!ctx.readOnly && def.kind !== "branch" && branch.out !== main?.id && (
              <button type="button" className="btn btn-ghost btn-sm" title={t.sc.delete} onClick={() => ops.branch(path, index, branch.out, false)}>
                <X />
              </button>
            )}
          </div>
          <StepList {...props} steps={branch.steps} path={[...path, { id: step.id, where: branch.out }]} />
          {branch.ends && !(branch.steps.length && defOf(scenario.graph.nodes.find((n) => n.id === branch.steps.at(-1)!.id)?.type ?? "")?.traits?.noreturn) && <p className="st-ends">{t.sc.endsHere}</p>}
        </div>
      ))}
    </div>
  );
}

/** The step line: "Launch Dota 2", "Press Ctrl+S", "If {{count}} > 3". */
function stepLine(def: NodeDef, node: GraphNode, scenario: Scenario, ctx: ReturnType<typeof useFields>, template: string): string {
  return template.replace(/\{(\w+)\}/g, (_, pinId: string) => {
    const pin = def.inputs.find((p) => p.id === pinId);
    if (!pin) return "";
    const edge = scenario.graph.edges.find((e) => e.target === node.id && e.targetHandle === pinId);
    if (edge) {
      const source = scenario.graph.nodes.find((n) => n.id === edge.source);
      const sourceDef = source && defOf(source.type);
      if (source && sourceDef?.kind === "pure") return stepLine(sourceDef, source, scenario, ctx, nodeText(ctx.lang, source.type).step);
      return source ? `«${nodeText(ctx.lang, source.type).title}: ${pinText(ctx.lang, source.type, edge.sourceHandle)?.label ?? edge.sourceHandle}»` : "…";
    }
    return valueLabel(pin, node.data[pinId] ?? pin.default ?? null, ctx, def.type);
  });
}

/** One input of a step: a value, or the output of an earlier step; a condition is built here too. */
function StepInput({ def, node, pin, scenario, change, all }: { def: NodeDef; node: GraphNode; pin: PinDef; scenario: Scenario; change(mutate: (draft: Scenario) => void, merge?: string): void; all: StepNode[] }) {
  const t = useTexts();
  const ctx = useFields();
  const text = pinText(ctx.lang, def.type, pin.id);
  const edge = scenario.graph.edges.find((e) => e.target === node.id && e.targetHandle === pin.id);
  const source = edge && scenario.graph.nodes.find((n) => n.id === edge.source);
  const sourceDef = source && defOf(source.type);

  // outputs of earlier steps that fit this input
  const options = isConnectable(pin)
    ? before(all, node.id).flatMap((id) => {
        const step = scenario.graph.nodes.find((n) => n.id === id);
        const stepDef = step && defOf(step.type);
        if (!step || !stepDef) return [];
        return stepDef.outputs
          .filter((out) => canConnect(out.type, pin.type) && !["errorCode", "errorMessage"].includes(out.id))
          .map((out) => ({ key: `${id}.${out.id}`, label: fill(t.sc.stepOutput, { step: nodeText(ctx.lang, step.type).title, output: pinText(ctx.lang, step.type, out.id)?.label ?? out.id }), id, out: out.id }));
      })
    : [];

  const setValue = (value: Value) =>
    change((draft) => {
      const target = draft.graph.nodes.find((n) => n.id === node.id);
      if (target) target.data[pin.id] = value;
    }, `${node.id}.${pin.id}`);

  const setSource = (key: string) =>
    change((draft) => {
      draft.graph.edges = draft.graph.edges.filter((e) => !(e.target === node.id && e.targetHandle === pin.id));
      const option = options.find((o) => o.key === key);
      if (option) connect(draft, { source: option.id, sourceHandle: option.out, target: node.id, targetHandle: pin.id });
    });

  // a yes/no input of If / While / Wait until: a Compare built right here
  const condition = pin.type === "bool" && isConnectable(pin) && def.kind !== "pure";
  const addCondition = () =>
    change((draft) => {
      const compare = defOf("data.compare")!;
      const id = `n${newId(8)}`;
      draft.graph.nodes.push({ id, type: "data.compare", v: 1, position: { x: node.position.x - 300, y: node.position.y + 40 }, data: initialData(compare) });
      connect(draft, { source: id, sourceHandle: "result", target: node.id, targetHandle: pin.id });
    });
  const removeCondition = () =>
    change((draft) => {
      if (!source) return;
      draft.graph.nodes = draft.graph.nodes.filter((n) => n.id !== source.id);
      draft.graph.edges = draft.graph.edges.filter((e) => e.source !== source.id && e.target !== source.id);
    });

  let body: ReactNode;
  if (source && sourceDef?.kind === "pure" && source.type === "data.compare") {
    // the Compare node edited inline: "{{count}} > 3"
    body = (
      <span className="st-condition">
        {sourceDef.inputs
          .filter((p) => pinVisible(p, source.data, sourceDef))
          .map((p) => (
            <PinField
              key={p.id}
              def={sourceDef}
              pin={p}
              value={source.data[p.id] ?? p.default ?? null}
              onChange={(value) =>
                change((draft) => {
                  const target = draft.graph.nodes.find((n) => n.id === source.id);
                  if (target) target.data[p.id] = value;
                }, `${source.id}.${p.id}`)
              }
            />
          ))}
        {!ctx.readOnly && (
          <button type="button" className="btn btn-ghost btn-sm" title={t.sc.clear} onClick={removeCondition}>
            <X />
          </button>
        )}
      </span>
    );
  } else if (source && sourceDef?.kind === "pure") {
    body = <span className="st-expr">{stepLine(sourceDef, source, scenario, ctx, nodeText(ctx.lang, source.type).step)}</span>;
  } else {
    body = (
      <span className="st-input">
        {options.length > 0 && !ctx.readOnly && (
          <select className="select st-source" value={edge ? `${edge.source}.${edge.sourceHandle}` : ""} onChange={(e) => setSource(e.target.value)}>
            <option value="">{t.sc.sourceValue}</option>
            {options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        )}
        {!edge && (condition && !ctx.readOnly ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={addCondition}>
            {text?.label}…
          </button>
        ) : (
          <PinField def={def} pin={pin} value={node.data[pin.id] ?? pin.default ?? null} onChange={setValue} />
        ))}
      </span>
    );
  }

  return (
    <div className="st-field" title={text?.description}>
      <span className="st-field-label">{text?.label ?? pin.id}</span>
      {body}
    </div>
  );
}
