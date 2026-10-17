// The scenario editor: a toolbar, the steps or the graph, the inspector, the run log.
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, CircleDashed, ListOrdered, Loader2, Network, PanelLeft, PanelRight, Play, Redo2, Settings2, Square, Trash2, Undo2, X } from "lucide-react";
import { defOf, isConnectable } from "../../../shared/scenarios/defs";
import { fromAccelerator, toAccelerator } from "../../../shared/scenarios/keys";
import { newId, type RunEvent, type Scenario, type Trigger, type Value } from "../../../shared/scenarios/model";
import { nextFire } from "../../../shared/scenarios/schedule";
import { nodeText, outText, pinText } from "../../../shared/scenarios/texts";
import { pinVisible, type Issue } from "../../../shared/scenarios/validate";
import type { ScenarioNameCheck, UiState } from "../../../shared/types";
import { fill, useTexts } from "../i18n";
import { Button, ChipsEditor, Field, Modal, NumberInput, SwitchRow, useToast } from "../ui";
import { useRunWatch, useScenarioDoc, type RunWatch } from "./doc";
import { FieldsContext, KeyRecorder, PinField, useFields, type FieldContext } from "./fields";
import { GraphView } from "./graph";
import { CATEGORY_COLOR, NodeIcon } from "./look";
import { StepsView } from "./steps";

type Mode = "steps" | "graph";

const MODE_KEY = "gh.scenarios.mode";
const PANELS_KEY = "gh.scenarios.panels";

const readMode = (): Mode => {
  try {
    return localStorage.getItem(MODE_KEY) === "graph" ? "graph" : "steps";
  } catch {
    return "steps";
  }
};

/** The palette of the graph and the inspector can be hidden; on a narrow window the palette starts hidden. */
const readPanels = (): { palette: boolean; inspector: boolean } => {
  try {
    const saved = JSON.parse(localStorage.getItem(PANELS_KEY) ?? "null") as { palette?: unknown; inspector?: unknown } | null;
    if (saved) return { palette: saved.palette !== false, inspector: saved.inspector !== false };
  } catch {
    // nothing saved
  }
  return { palette: window.innerWidth >= 1280, inspector: true };
};

/** Names of variables in a scenario, for {{...}} and the variable fields. */
function variablesOf(scenario: Scenario): string[] {
  const names = new Set<string>(scenario.variables.map((v) => v.name));
  for (const node of scenario.graph.nodes) if (node.type.startsWith("vars.") && typeof node.data.name === "string" && node.data.name) names.add(node.data.name);
  return [...names];
}

export function Editor({ id, state, onBack, focus }: { id: string; state: UiState; onBack(): void; focus?: { id: string; nodeId?: string; at: number } | null }) {
  const t = useTexts();
  const toast = useToast();
  const readOnly = state.parental.enabled;
  const doc = useScenarioDoc(id, readOnly);
  const watch = useRunWatch(id);
  const [mode, setMode] = useState<Mode>(readMode);
  const [panels, setPanels] = useState(readPanels);
  const [selected, setSelected] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [graphFocus, setGraphFocus] = useState<{ id: string; at: number } | null>(null);
  const scenario = doc.scenario;
  const running = state.runs.some((run) => run.scenarioId === id);

  const ctx: FieldContext = useMemo(
    () => ({ lang: t.sc.lang, apps: state.apps, scenarios: state.scenarios, scenarioId: id, variables: scenario ? variablesOf(scenario) : [], readOnly }),
    [t.sc.lang, state.apps, state.scenarios, id, scenario, readOnly],
  );

  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      // a private window: the mode is not remembered
    }
  }, [mode]);

  const toggle = (panel: "palette" | "inspector") =>
    setPanels((before) => {
      const next = { ...before, [panel]: !before[panel] };
      try {
        localStorage.setItem(PANELS_KEY, JSON.stringify(next));
      } catch {
        // not remembered
      }
      return next;
    });

  // "open at the failing step"
  useEffect(() => {
    if (!focus?.nodeId) return;
    setSelected(focus.nodeId);
    setGraphFocus({ id: focus.nodeId, at: focus.at });
  }, [focus]);

  // Ctrl+Z / Ctrl+Y outside of text fields
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.closest?.("input, textarea, select")) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.code === "KeyZ" && !event.shiftKey) {
        event.preventDefault();
        doc.undo();
      }
      if (event.code === "KeyY" || (event.code === "KeyZ" && event.shiftKey)) {
        event.preventDefault();
        doc.redo();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [doc]);

  const run = useCallback(
    async (fromNodeId?: string) => {
      await doc.flush();
      const result = await window.gh.runScenario(id, fromNodeId ? { fromNodeId } : undefined);
      if (!result.ok) toast("error", fill(t.sc.startFailed, { error: t.code[result.code] ?? result.code }));
      else if (result.already) toast("info", fill(t.sc.already, { name: result.name }));
      setLogOpen(true);
    },
    [doc, id, t, toast],
  );

  if (!scenario) return <div className="sc-editor" />;

  const saveLabel = doc.saveState === "saving" ? t.sc.saving : doc.saveState === "error" ? fill(t.sc.saveFailed, { error: doc.saveError ?? "" }) : doc.saveState === "saved" ? t.sc.saved : "";

  return (
    <FieldsContext.Provider value={ctx}>
      <div className="sc-editor">
        <div className="sc-toolbar">
          <Button variant="ghost" small onClick={onBack} title={t.sc.back}>
            <ArrowLeft />
          </Button>
          <input
            className="input sc-name"
            value={scenario.name}
            disabled={readOnly}
            onChange={(e) => doc.change((draft) => void (draft.name = e.target.value.slice(0, 80)), "name")}
          />
          <span className={`sc-save ${doc.saveState}`}>{saveLabel}</span>
          <span className="spacer" />
          <div className="sc-modes">
            <button type="button" className={mode === "steps" ? "active" : ""} onClick={() => setMode("steps")}>
              <ListOrdered size={15} /> {t.sc.modeSteps}
            </button>
            <button type="button" className={mode === "graph" ? "active" : ""} onClick={() => setMode("graph")}>
              <Network size={15} /> {t.sc.modeGraph}
            </button>
          </div>
          {mode === "graph" && !readOnly && (
            <Button variant="ghost" small title={t.sc.palette} className={panels.palette ? "on" : ""} onClick={() => toggle("palette")}>
              <PanelLeft />
            </Button>
          )}
          <Button variant="ghost" small title={t.sc.inspector} className={panels.inspector ? "on" : ""} onClick={() => toggle("inspector")}>
            <PanelRight />
          </Button>
          {!readOnly && (
            <>
              <Button variant="ghost" small title={t.sc.undo} disabled={!doc.canUndo} onClick={doc.undo}>
                <Undo2 />
              </Button>
              <Button variant="ghost" small title={t.sc.redo} disabled={!doc.canRedo} onClick={doc.redo}>
                <Redo2 />
              </Button>
            </>
          )}
          <Button variant="ghost" small title={t.sc.settings} onClick={() => setSettings(true)}>
            <Settings2 />
          </Button>
          {running ? (
            <Button variant="danger" small onClick={() => window.gh.stopScenario({ scenarioId: id })}>
              <Square /> {t.sc.stop}
            </Button>
          ) : (
            <Button variant="primary" small disabled={doc.issues.some((issue) => issue.severity === "error")} onClick={() => run()}>
              <Play /> {t.sc.run}
            </Button>
          )}
        </div>

        {readOnly && (
          <div className="banner sc-banner">
            <AlertTriangle />
            <span>{t.sc.readOnly}</span>
          </div>
        )}

        <div className={`sc-body${panels.inspector ? "" : " no-inspector"}`}>
          <div className="sc-main">
            {mode === "graph" ? (
              <GraphView scenario={scenario} change={doc.change} issues={doc.issues} watch={watch} selected={selected} onSelect={setSelected} onRunFrom={(nodeId) => run(nodeId)} focus={graphFocus} palette={panels.palette} />
            ) : (
              <StepsView scenario={scenario} change={doc.change} watch={watch} selected={selected} onSelect={setSelected} onOpenGraph={() => setMode("graph")} />
            )}
          </div>
          {panels.inspector && <Inspector scenario={scenario} issues={doc.issues} watch={watch} selected={selected} onSelect={setSelected} change={doc.change} onRunFrom={(nodeId) => run(nodeId)} />}
        </div>

        <RunLog scenario={scenario} watch={watch} open={logOpen} onToggle={() => setLogOpen(!logOpen)} onSelect={setSelected} />
        <ScenarioSettings open={settings} onClose={() => setSettings(false)} scenario={scenario} change={doc.change} state={state} />
      </div>
    </FieldsContext.Provider>
  );
}

/* ── the inspector ── */

function Inspector({
  scenario,
  issues,
  watch,
  selected,
  onSelect,
  change,
  onRunFrom,
}: {
  scenario: Scenario;
  issues: Issue[];
  watch: RunWatch;
  selected: string | null;
  onSelect(id: string | null): void;
  change(mutate: (draft: Scenario) => void, merge?: string): void;
  onRunFrom(id: string): void;
}) {
  const t = useTexts();
  const ctx = useFields();
  const node = scenario.graph.nodes.find((n) => n.id === selected);
  const def = node && defOf(node.type);

  if (!node || !def) {
    return (
      <aside className="sc-inspector">
        <h3>{t.sc.issuesTitle}</h3>
        {issues.length ? (
          <ul className="sc-issues">
            {issues.map((issue, i) => (
              <li key={i} className={issue.severity} onClick={() => issue.nodeId && onSelect(issue.nodeId)}>
                <AlertTriangle size={14} />
                <span>
                  {fill(t.sc.issue[issue.code] ?? issue.code, { pin: issue.nodeId && issue.pin ? (pinText(ctx.lang, scenario.graph.nodes.find((n) => n.id === issue.nodeId)?.type ?? "", issue.pin)?.label ?? issue.pin) : "" })}
                  {issue.nodeId && <em> · {nodeText(ctx.lang, scenario.graph.nodes.find((n) => n.id === issue.nodeId)?.type ?? "").title}</em>}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">{t.sc.noIssues}</p>
        )}
        <p className="hint">{t.sc.noSelection}</p>
      </aside>
    );
  }

  const text = nodeText(ctx.lang, def.type);
  const run = watch.nodes.get(node.id);
  const wired = (pin: string) => scenario.graph.edges.some((e) => e.target === node.id && e.targetHandle === pin);
  const show = (value: Value | undefined) => (value === undefined ? null : typeof value === "object" && value !== null ? JSON.stringify(value) : String(value));

  return (
    <aside className="sc-inspector">
      <div className="sc-insp-head" style={{ ["--cat" as string]: CATEGORY_COLOR[def.category] }}>
        <NodeIcon name={def.icon} size={18} />
        <h3>{text.title}</h3>
      </div>
      <p className="sc-insp-desc">{text.description}</p>
      {issues
        .filter((issue) => issue.nodeId === node.id)
        .map((issue, i) => (
          <p key={i} className={`sc-insp-issue ${issue.severity}`}>
            <AlertTriangle size={14} /> {fill(t.sc.issue[issue.code] ?? issue.code, { pin: issue.pin ? (pinText(ctx.lang, def.type, issue.pin)?.label ?? issue.pin) : "" })}
          </p>
        ))}
      {run?.error && <p className="sc-insp-issue error">{run.error.message ?? run.error.code}</p>}

      {def.inputs.length > 0 && <h4>{t.sc.inputs}</h4>}
      {def.inputs
        .filter((pin) => pinVisible(pin, node.data, def))
        .map((pin) => {
          const ptext = pinText(ctx.lang, def.type, pin.id);
          return (
            <div key={pin.id} className="sc-insp-pin">
              <div className="sc-insp-pin-head">
                <span>{ptext?.label ?? pin.id}</span>
                {run?.inputs && pin.id in run.inputs && <span className="sc-insp-last" title={t.sc.lastValue}>{show(run.inputs[pin.id])}</span>}
              </div>
              {isConnectable(pin) && wired(pin.id) ? (
                <span className="gh-wired">{t.sc.wired}</span>
              ) : (
                <PinField
                  def={def}
                  pin={pin}
                  value={node.data[pin.id] ?? pin.default ?? null}
                  onChange={(value) =>
                    change((draft) => {
                      const target = draft.graph.nodes.find((n) => n.id === node.id);
                      if (target) target.data[pin.id] = value;
                    }, `${node.id}.${pin.id}`)
                  }
                />
              )}
              <p className="hint">{ptext?.description}</p>
            </div>
          );
        })}

      {def.outputs.length > 0 && <h4>{t.sc.outputs}</h4>}
      {def.outputs.map((pin) => {
        const ptext = pinText(ctx.lang, def.type, pin.id);
        const last = run?.outputs?.[pin.id];
        return (
          <div key={pin.id} className="sc-insp-pin">
            <div className="sc-insp-pin-head">
              <span>{ptext?.label ?? pin.id}</span>
              {last !== undefined && <span className="sc-insp-last" title={t.sc.lastValue}>{show(last)}</span>}
            </div>
            <p className="hint">{ptext?.description}</p>
          </div>
        );
      })}

      {def.execOuts.length > 0 && <h4>{t.sc.ways}</h4>}
      <ul className="sc-insp-ways">
        {def.execOuts.map((out) => (
          <li key={out.id} className={watch.passed.has(`${node.id}.${out.id}`) ? "passed" : ""}>
            {outText(ctx.lang, def.type, out.id)}
          </li>
        ))}
      </ul>

      <div className="sc-insp-actions">
        {def.kind !== "pure" && (
          <Button variant="secondary" small onClick={() => onRunFrom(node.id)}>
            <Play /> {t.sc.runFrom}
          </Button>
        )}
        {def.type !== "flow.start" && !ctx.readOnly && (
          <Button
            variant="danger"
            small
            onClick={() => {
              change((draft) => {
                draft.graph.nodes = draft.graph.nodes.filter((n) => n.id !== node.id);
                draft.graph.edges = draft.graph.edges.filter((e) => e.source !== node.id && e.target !== node.id);
              });
              onSelect(null);
            }}
          >
            <Trash2 /> {t.sc.deleteNode}
          </Button>
        )}
      </div>
    </aside>
  );
}

/* ── the run log ── */

function RunLog({ scenario, watch, open, onToggle, onSelect }: { scenario: Scenario; watch: RunWatch; open: boolean; onToggle(): void; onSelect(id: string): void }) {
  const t = useTexts();
  const ctx = useFields();
  const started = watch.run?.startedAt ?? 0;
  const status = watch.run?.status;
  const rows = watch.events.filter((e): e is Extract<RunEvent, { t: "node" | "log" }> => (e.t === "node" && e.phase === "end" && Boolean(defOf(scenario.graph.nodes.find((n) => n.id === e.nodeId)?.type ?? "")?.execIn || e.error)) || e.t === "log");

  return (
    <div className={`sc-log ${open ? "open" : ""}`}>
      <button type="button" className="sc-log-head" onClick={onToggle}>
        {status === "running" ? <Loader2 className="spin" size={14} /> : status === "error" ? <AlertTriangle size={14} /> : status ? <CheckCircle2 size={14} /> : <CircleDashed size={14} />}
        <span>{t.sc.log}</span>
        {watch.run && (
          <span className={`sc-log-status ${status}`}>
            {t.sc.status[status ?? "running"]} · {t.sc.trigger[watch.run.trigger] ?? watch.run.trigger}
            {watch.run.error && ` · ${t.code[watch.run.error.code] ?? watch.run.error.code}`}
          </span>
        )}
      </button>
      {open && (
        <div className="sc-log-body">
          {!rows.length && <p className="hint">{t.sc.logEmpty}</p>}
          {rows.map((event, i) => {
            const node = scenario.graph.nodes.find((n) => n.id === event.nodeId);
            const at = `+${((event.at - started) / 1000).toFixed(1)} s`;
            if (event.t === "log") {
              return (
                <div key={i} className={`sc-log-row log ${event.level}`} onClick={() => event.nodeId && onSelect(event.nodeId)}>
                  <span className="when">{at}</span>
                  <span className="what">{event.text}</span>
                </div>
              );
            }
            return (
              <div key={i} className={`sc-log-row ${event.error ? "error" : ""}`} onClick={() => onSelect(event.nodeId)}>
                <span className="when">{at}</span>
                <span className="what">
                  {node ? nodeText(ctx.lang, node.type).title : event.nodeId}
                  {event.out && node && <em> → {outText(ctx.lang, node.type, event.out)}</em>}
                </span>
                <span className="detail">
                  {event.error
                    ? `${t.code[event.error.code] ?? event.error.code}${event.error.message ? `: ${event.error.message}` : ""}`
                    : Object.entries(event.outputs ?? {})
                        .filter(([key]) => !key.startsWith("error"))
                        .map(([key, value]) => `${node ? (pinText(ctx.lang, node.type, key)?.label ?? key) : key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
                        .join(" · ")}
                </span>
                {event.ms !== undefined && <span className="ms">{event.ms} ms</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── settings of the scenario ── */

function ScenarioSettings({ open, onClose, scenario, change, state }: { open: boolean; onClose(): void; scenario: Scenario; change(mutate: (draft: Scenario) => void, merge?: string): void; state: UiState }) {
  const t = useTexts();
  const ctx = useFields();
  const [check, setCheck] = useState<ScenarioNameCheck | null>(null);
  const [hotkeyProblem, setHotkeyProblem] = useState<Record<string, string>>({});
  const disabled = ctx.readOnly;
  const names = useMemo(() => [scenario.name, ...scenario.voice.aliases], [scenario.name, scenario.voice.aliases]);

  // what NODUS will hear: checked with the same parser as the skill
  useEffect(() => {
    if (!open || !scenario.voice.enabled) return undefined;
    const timer = window.setTimeout(() => window.gh.checkScenarioName(scenario.id, names).then(setCheck).catch(() => setCheck(null)), 400);
    return () => window.clearTimeout(timer);
  }, [open, names, scenario.id, scenario.voice.enabled]);

  const setTrigger = (index: number, patch: Partial<Trigger>) =>
    change((draft) => {
      draft.triggers[index] = { ...draft.triggers[index], ...patch } as Trigger;
    }, `trigger.${index}`);

  const recordHotkey = async (index: number, codes: string[]) => {
    const accelerator = toAccelerator(codes);
    const trigger = scenario.triggers[index];
    if (!accelerator) {
      setHotkeyProblem((p) => ({ ...p, [trigger.id]: t.sc.hotkeyReason.invalid }));
      return;
    }
    const result = await window.gh.checkHotkey(accelerator, scenario.id);
    setHotkeyProblem((p) => ({ ...p, [trigger.id]: result.ok ? "" : (t.sc.hotkeyReason[result.reason ?? "invalid"] ?? "") }));
    if (result.ok || result.reason === "taken") setTrigger(index, { accelerator } as Partial<Trigger>);
  };

  const options = scenario.options;
  const setOption = <K extends keyof Scenario["options"]>(key: K, value: Scenario["options"][K]) => change((draft) => void (draft.options[key] = value), `option.${key}`);

  return (
    <Modal open={open} onClose={onClose} title={t.sc.settings}>
      <div className="sc-settings">
        <Field label={t.sc.name}>
          <input className="input" value={scenario.name} disabled={disabled} maxLength={80} onChange={(e) => change((draft) => void (draft.name = e.target.value), "name")} />
        </Field>
        <Field label={t.sc.description}>
          <textarea className="input" rows={2} value={scenario.description} disabled={disabled} maxLength={500} onChange={(e) => change((draft) => void (draft.description = e.target.value), "description")} />
        </Field>
        <SwitchRow title={t.sc.enabled} hint={t.sc.enabledHint} checked={scenario.enabled} disabled={disabled} onChange={(enabled) => change((draft) => void (draft.enabled = enabled))} />

        <h4>{t.sc.voiceTitle}</h4>
        <SwitchRow title={t.sc.voiceEnabled} checked={scenario.voice.enabled} disabled={disabled} onChange={(on) => change((draft) => void (draft.voice.enabled = on))} />
        {scenario.voice.enabled && (
          <>
            <Field label={t.sc.voiceAliases}>
              <ChipsEditor values={scenario.voice.aliases} onChange={(aliases) => change((draft) => void (draft.voice.aliases = aliases.slice(0, 8)))} placeholder={t.sc.voiceAliasesPlaceholder} />
            </Field>
            {check && (
              <ul className="sc-voice-check">
                {check.names.map((item) => (
                  <li key={item.name} className={item.ok ? "ok" : "bad"}>
                    {item.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                    {item.ok ? fill(t.sc.voiceOk, { name: item.name }) : fill(t.sc.voiceReason[item.reason] ?? item.reason, { name: item.name, other: item.other ?? "" })}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        <h4>{t.sc.triggersTitle}</h4>
        <div className="sc-triggers">
          {scenario.triggers.map((trigger, index) => (
            <div key={trigger.id} className="sc-trigger">
              <input type="checkbox" checked={trigger.enabled} disabled={disabled} onChange={(e) => setTrigger(index, { enabled: e.target.checked })} />
              {trigger.type === "hotkey" ? (
                <>
                  <span className="sc-trigger-label">{t.sc.hotkey}</span>
                  <KeyRecorder codes={fromAccelerator(trigger.accelerator)} onChange={(codes) => void recordHotkey(index, codes)} disabled={disabled} />
                  {hotkeyProblem[trigger.id] && <span className="error">{hotkeyProblem[trigger.id]}</span>}
                </>
              ) : (
                <>
                  <span className="sc-trigger-label">{t.sc.schedule}</span>
                  <input type="time" className="input sc-time" value={trigger.time} disabled={disabled} onChange={(e) => setTrigger(index, { time: e.target.value } as Partial<Trigger>)} />
                  <span className="sc-days">
                    {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                      <button
                        key={day}
                        type="button"
                        className={trigger.days.includes(day) ? "on" : ""}
                        disabled={disabled}
                        onClick={() => setTrigger(index, { days: trigger.days.includes(day) ? trigger.days.filter((d) => d !== day) : [...trigger.days, day] } as Partial<Trigger>)}
                      >
                        {t.sc.days[day]}
                      </button>
                    ))}
                  </span>
                  <select className="select" value={trigger.missed} disabled={disabled} onChange={(e) => setTrigger(index, { missed: e.target.value as "skip" | "once" } as Partial<Trigger>)}>
                    <option value="skip">{t.sc.missed.skip}</option>
                    <option value="once">{t.sc.missed.once}</option>
                  </select>
                  {trigger.enabled && nextFire(trigger, Date.now()) && (
                    <span className="hint">{fill(t.sc.nextRun, { time: new Date(nextFire(trigger, Date.now())!).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) })}</span>
                  )}
                </>
              )}
              {!disabled && (
                <button type="button" className="btn btn-ghost btn-sm" title={t.sc.delete} onClick={() => change((draft) => void draft.triggers.splice(index, 1))}>
                  <X />
                </button>
              )}
            </div>
          ))}
          {!disabled && (
            <div className="row">
              <Button variant="secondary" small onClick={() => change((draft) => void draft.triggers.push({ id: `t${newId(6)}`, type: "hotkey", accelerator: "Control+Alt+1", enabled: false }))}>
                + {t.sc.addHotkey}
              </Button>
              <Button variant="secondary" small onClick={() => change((draft) => void draft.triggers.push({ id: `t${newId(6)}`, type: "schedule", time: "09:00", days: [1, 2, 3, 4, 5], missed: "skip", enabled: true }))}>
                + {t.sc.addSchedule}
              </Button>
            </div>
          )}
        </div>

        <h4>{t.sc.optionsTitle}</h4>
        <Field label={t.sc.concurrency}>
          <select className="select" value={options.concurrency} disabled={disabled} onChange={(e) => setOption("concurrency", e.target.value as Scenario["options"]["concurrency"])}>
            {(["ignore", "restart", "queue"] as const).map((value) => (
              <option key={value} value={value}>
                {t.sc.concurrencyValue[value]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t.sc.maxRunSec} hint={t.sc.maxRunHint}>
          <NumberInput value={options.maxRunSec} min={0} max={86400} onCommit={(value) => setOption("maxRunSec", value)} />
        </Field>
        <SwitchRow title={t.sc.exclusiveInput} hint={t.sc.exclusiveInputHint} checked={options.exclusiveInput} disabled={disabled} onChange={(on) => setOption("exclusiveInput", on)} />
        <SwitchRow title={t.sc.stopOnUserMouse} checked={options.stopOnUserMouse} disabled={disabled} onChange={(on) => setOption("stopOnUserMouse", on)} />
        <Field label={t.sc.guardApp}>
          <select className="select" value={options.guardApp} disabled={disabled} onChange={(e) => setOption("guardApp", e.target.value)}>
            <option value="">{t.sc.guardAny}</option>
            {state.apps
              .filter((app) => app.enabled && app.kind !== "site")
              .map((app) => (
                <option key={app.id} value={app.id}>
                  {app.name}
                </option>
              ))}
          </select>
        </Field>
        <SwitchRow title={t.sc.notifyOnError} checked={options.notifyOnError} disabled={disabled} onChange={(on) => setOption("notifyOnError", on)} />
        <SwitchRow title={t.sc.sayOnError} checked={options.sayOnError} disabled={disabled} onChange={(on) => setOption("sayOnError", on)} />
        <SwitchRow title={t.sc.inTray} checked={options.inTray} disabled={disabled} onChange={(on) => setOption("inTray", on)} />
      </div>
    </Modal>
  );
}
