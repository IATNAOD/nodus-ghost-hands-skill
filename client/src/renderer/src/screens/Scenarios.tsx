import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CalendarClock, Download, Keyboard, Mic, Pencil, Play, Plus, Square, Trash2, Upload, Workflow } from "lucide-react";
import { defOf } from "../../../shared/scenarios/defs";
import { comboLabel, fromAccelerator } from "../../../shared/scenarios/keys";
import type { RunInfo, RunRecord, Scenario, ScenarioSummary, Value } from "../../../shared/scenarios/model";
import { nodeText, outText } from "../../../shared/scenarios/texts";
import type { ImportPreview, UiState, VariablesView } from "../../../shared/types";
import { fill, useTexts } from "../i18n";
import { Button, Locked, Modal, useToast } from "../ui";
import { Editor } from "../scenarios/editor";
import "../styles/scenarios.css";

type Tab = "list" | "history" | "variables";

export type ScenarioTarget = { id: string; nodeId?: string; at: number };

const errorText = (t: ReturnType<typeof useTexts>, error: unknown) => {
  const message = (error as Error)?.message?.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") ?? String(error);
  return t.code[message] ?? message;
};

/** The page: the list of scenarios, their runs and persistent variables; or one scenario in the editor. */
export function Scenarios({ state, target }: { state: UiState; target: ScenarioTarget | null }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [focus, setFocus] = useState<ScenarioTarget | null>(null);

  // "open at the failing step" from a notification
  useEffect(() => {
    if (!target) return;
    setEditing(target.id);
    setFocus(target);
  }, [target]);

  // the scenario was removed while open (a new one is not in the state yet for a moment)
  const seen = useRef<string | null>(null);
  useEffect(() => {
    const present = Boolean(editing && state.scenarios.some((s) => s.id === editing));
    if (present) seen.current = editing;
    else if (editing && seen.current === editing) setEditing(null);
  }, [editing, state.scenarios]);

  if (editing) return <Editor key={editing} id={editing} state={state} focus={focus} onBack={() => setEditing(null)} />;
  return <ScenarioList state={state} onEdit={(id) => (setFocus(null), setEditing(id))} />;
}

function ScenarioList({ state, onEdit }: { state: UiState; onEdit(id: string): void }) {
  const t = useTexts();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("list");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const locked = state.parental.enabled;

  const create = async () => {
    try {
      const scenario = await window.gh.createScenario(t.sc.newName);
      onEdit(scenario.id);
    } catch (error) {
      toast("error", errorText(t, error));
    }
  };

  const importFile = async () => {
    try {
      const result = await window.gh.importScenario();
      if (result) setPreview(result);
    } catch {
      toast("error", t.sc.importFailed);
    }
  };

  const tabs: [Tab, string][] = [
    ["list", t.sc.tabList],
    ["history", t.sc.tabHistory],
    ["variables", t.sc.tabVariables],
  ];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t.sc.title}</h1>
          <p>{t.sc.hint}</p>
        </div>
      </div>

      <div className="toolbar">
        <div className="filters">
          {tabs.map(([value, label]) => (
            <button key={value} type="button" className={tab === value ? "active" : ""} onClick={() => setTab(value)}>
              {label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {state.runs.length > 0 && (
          <Button variant="danger" small onClick={() => window.gh.stopScenario({ all: true })}>
            <Square />
            {t.sc.stopAll}
          </Button>
        )}
        <Locked locked={locked}>
          <Button variant="secondary" small onClick={importFile}>
            <Upload />
            {t.sc.import}
          </Button>
          <Button variant="primary" small onClick={create}>
            <Plus />
            {t.sc.create}
          </Button>
        </Locked>
      </div>

      {tab === "list" && (
        <div className="sc-list">
          {state.scenarios.length ? (
            [...state.scenarios].sort((a, b) => a.name.localeCompare(b.name)).map((scenario) => <ScenarioRow key={scenario.id} scenario={scenario} runs={state.runs} locked={locked} onEdit={() => onEdit(scenario.id)} />)
          ) : (
            <div className="empty">{t.sc.empty}</div>
          )}
        </div>
      )}
      {tab === "history" && <History state={state} />}
      {tab === "variables" && <Variables state={state} />}

      <ImportDialog
        preview={preview}
        onClose={() => setPreview(null)}
        onAdded={(scenario) => {
          setPreview(null);
          onEdit(scenario.id);
        }}
      />
    </div>
  );
}

function ScenarioRow({ scenario, runs, locked, onEdit }: { scenario: ScenarioSummary; runs: RunInfo[]; locked: boolean; onEdit(): void }) {
  const t = useTexts();
  const toast = useToast();
  const running = runs.filter((run) => run.scenarioId === scenario.id);
  const hotkeys = scenario.triggers.filter((trigger) => trigger.type === "hotkey" && trigger.enabled);
  const schedules = scenario.triggers.filter((trigger) => trigger.type === "schedule" && trigger.enabled);

  const run = async () => {
    const result = await window.gh.runScenario(scenario.id);
    if (!result.ok) toast("error", fill(t.sc.startFailed, { error: t.code[result.code] ?? result.code }));
    else toast("info", fill(result.already ? t.sc.already : t.sc.started, { name: result.name }));
  };

  return (
    <div className={`app-row sc-row${scenario.enabled ? "" : " off"}`}>
      <span className="sc-row-icon">
        <Workflow size={18} />
      </span>
      <div className="body" onDoubleClick={onEdit}>
        <div className="name">
          {scenario.name}
          {!scenario.enabled && <span className="badge grey">{t.sc.disabled}</span>}
          {scenario.invalid && (
            <span className="badge red">
              <AlertTriangle size={11} /> {t.sc.invalid}
            </span>
          )}
          {running.length > 0 && <span className="badge orange">{t.sc.status.running}</span>}
        </div>
        {scenario.description && <div className="detail">{scenario.description}</div>}
        <div className="sc-row-triggers">
          {scenario.enabled && scenario.voice.enabled && (
            <span title={t.sc.voiceTitle}>
              <Mic size={12} /> {[scenario.name, ...scenario.voice.aliases].join(", ")}
            </span>
          )}
          {scenario.enabled &&
            hotkeys.map((trigger) => (
              <span key={trigger.id} title={t.sc.hotkey}>
                <Keyboard size={12} /> {trigger.type === "hotkey" && comboLabel(fromAccelerator(trigger.accelerator))}
              </span>
            ))}
          {scenario.enabled &&
            schedules.map((trigger) => (
              <span key={trigger.id} title={t.sc.schedule}>
                <CalendarClock size={12} /> {trigger.type === "schedule" && `${trigger.time} ${[1, 2, 3, 4, 5, 6, 0].filter((day) => trigger.days.includes(day)).map((day) => t.sc.days[day]).join(" ")}`}
              </span>
            ))}
        </div>
      </div>
      <div className="actions">
        {running.length ? (
          <Button variant="danger" small title={t.sc.stop} onClick={() => window.gh.stopScenario({ scenarioId: scenario.id })}>
            <Square />
          </Button>
        ) : (
          <Button variant="ghost" small title={t.sc.run} disabled={scenario.invalid} onClick={run}>
            <Play />
          </Button>
        )}
        <Button variant="ghost" small title={t.sc.edit} onClick={onEdit}>
          <Pencil />
        </Button>
        <Button variant="ghost" small title={t.sc.export} onClick={() => window.gh.exportScenario(scenario.id).catch((error) => toast("error", errorText(t, error)))}>
          <Download />
        </Button>
        {!locked && (
          <Button
            variant="ghost"
            small
            title={t.sc.delete}
            onClick={() => {
              if (window.confirm(fill(t.sc.deleteConfirm, { name: scenario.name }))) window.gh.deleteScenario(scenario.id).catch((error) => toast("error", errorText(t, error)));
            }}
          >
            <Trash2 />
          </Button>
        )}
      </div>
    </div>
  );
}

/* ── import ── */

function ImportDialog({ preview, onClose, onAdded }: { preview: ImportPreview | null; onClose(): void; onAdded(scenario: Scenario): void }) {
  const t = useTexts();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const list = (items: string[]) => items.slice(0, 8).join(", ") + (items.length > 8 ? ` (+${items.length - 8})` : "");

  if (!preview) return <Modal open={false} onClose={onClose} title={t.sc.importTitle} children={null} />;

  const does: [boolean, string, boolean?][] = [
    [true, fill(t.sc.importSteps, { count: preview.steps })],
    [preview.launches.length > 0, fill(t.sc.importLaunches, { list: list(preview.launches) })],
    [preview.paths.length > 0, fill(t.sc.importPaths, { list: list(preview.paths) }), true],
    [preview.urls.length > 0, fill(t.sc.importUrls, { list: list(preview.urls) })],
    [preview.keys.length > 0, fill(t.sc.importKeys, { list: list(preview.keys) }), true],
    [preview.clicks, t.sc.importClicks, true],
    [preview.text, t.sc.importText, true],
    [preview.power.length > 0, fill(t.sc.importPower, { list: list(preview.power) }), true],
    [preview.say, t.sc.importSay],
  ];

  return (
    <Modal open onClose={onClose} title={t.sc.importTitle}>
      <div className="sc-import">
        <h3>{preview.name}</h3>
        {preview.description && <p className="hint">{preview.description}</p>}
        <h4>{t.sc.importDoes}</h4>
        <ul>
          {does
            .filter(([show]) => show)
            .map(([, text, danger], i) => (
              <li key={i} className={danger ? "danger" : ""}>
                {danger && <AlertTriangle size={14} />} {text}
              </li>
            ))}
        </ul>
        {(preview.hotkeys.length > 0 || preview.schedules.length > 0) && (
          <p className="hint">{fill(t.sc.importTriggers, { hotkeys: list(preview.hotkeys) || "-", schedules: list(preview.schedules) || "-" })}</p>
        )}
        <div className="row">
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                onAdded(await window.gh.confirmImport(preview.token));
              } catch (error) {
                toast("error", errorText(t, error));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t.sc.importAdd}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* ── history ── */

const duration = (run: RunInfo) => (run.endedAt ? `${((run.endedAt - run.startedAt) / 1000).toFixed(1)} s` : "…");

function History({ state }: { state: UiState }) {
  const t = useTexts();
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [open, setOpen] = useState<RunInfo | null>(null);

  // reload when a run starts or ends
  const live = state.runs.map((run) => run.runId).join();
  useEffect(() => {
    let alive = true;
    window.gh.getRuns().then((list) => alive && setRuns(list));
    return () => {
      alive = false;
    };
  }, [live]);

  if (!runs.length) return <div className="empty">{t.sc.historyEmpty}</div>;

  return (
    <>
      <div className="sc-history">
        {runs.map((run) => (
          <button key={run.runId} type="button" className={`sc-history-row ${run.status}`} onClick={() => setOpen(run)}>
            <span className="when">{new Date(run.startedAt).toLocaleString([], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
            <span className="name">{run.name}</span>
            <span className={`sc-status ${run.status}`}>{t.sc.status[run.status] ?? run.status}</span>
            <span className="muted">{t.sc.trigger[run.trigger] ?? run.trigger}</span>
            <span className="muted">{duration(run)}</span>
            <span className="error">{run.error ? (t.code[run.error.code] ?? run.error.code) : ""}</span>
          </button>
        ))}
      </div>
      <RunDialog run={open} onClose={() => setOpen(null)} />
    </>
  );
}

function RunDialog({ run, onClose }: { run: RunInfo | null; onClose(): void }) {
  const t = useTexts();
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [types, setTypes] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    setRecord(null);
    if (!run) return undefined;
    let alive = true;
    window.gh.getRunLog(run.runId).then((log) => alive && setRecord(log));
    // titles of the steps come from the scenario as it is now
    window.gh.getScenario(run.scenarioId).then((loaded) => alive && setTypes(new Map(loaded?.scenario.graph.nodes.map((node) => [node.id, node.type]) ?? [])));
    return () => {
      alive = false;
    };
  }, [run]);

  const show = (value: Value) => (typeof value === "object" && value !== null ? JSON.stringify(value) : String(value));

  return (
    <Modal open={Boolean(run)} onClose={onClose} title={run ? `${run.name} · ${t.sc.status[run.status] ?? run.status}` : ""}>
      {run && (
        <div className="sc-runlog">
          <p className="hint">
            {new Date(run.startedAt).toLocaleString()} · {t.sc.trigger[run.trigger] ?? run.trigger} · {duration(run)}
            {run.error && ` · ${t.code[run.error.code] ?? run.error.code}${run.error.message ? `: ${run.error.message}` : ""}`}
          </p>
          {record?.events.map((event, i) => {
            if (event.t === "run") return null;
            const at = `+${((event.at - run.startedAt) / 1000).toFixed(1)} s`;
            if (event.t === "log") {
              return (
                <div key={i} className={`sc-log-row log ${event.level}`}>
                  <span className="when">{at}</span>
                  <span className="what">{event.text}</span>
                </div>
              );
            }
            if (event.phase !== "end") return null;
            const type = types.get(event.nodeId) ?? "";
            if (!event.error && !defOf(type)?.execIn) return null;
            return (
              <div key={i} className={`sc-log-row ${event.error ? "error" : ""}`}>
                <span className="when">{at}</span>
                <span className="what">
                  {type ? nodeText(t.sc.lang, type).title : event.nodeId}
                  {event.out && type && <em> → {outText(t.sc.lang, type, event.out)}</em>}
                </span>
                <span className="detail">
                  {event.error
                    ? `${t.code[event.error.code] ?? event.error.code}${event.error.message ? `: ${event.error.message}` : ""}`
                    : Object.entries(event.outputs ?? {})
                        .filter(([key]) => !key.startsWith("error"))
                        .map(([key, value]) => `${key}: ${show(value)}`)
                        .join(" · ")}
                </span>
                {event.ms !== undefined && <span className="ms">{event.ms} ms</span>}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

/* ── persistent variables ── */

/** Text typed into a variable: keeps the type of the value it replaces when it can. */
function parseValue(text: string, before: Value): Value {
  if (typeof before === "number" && text.trim() !== "" && Number.isFinite(Number(text))) return Number(text);
  if (typeof before === "boolean" && (text === "true" || text === "false")) return text === "true";
  if (typeof before === "object" && before !== null) {
    try {
      return JSON.parse(text) as Value;
    } catch {
      return text;
    }
  }
  return text;
}

const showValue = (value: Value) => (typeof value === "object" && value !== null ? JSON.stringify(value) : String(value));

function Variables({ state }: { state: UiState }) {
  const t = useTexts();
  const toast = useToast();
  const [view, setView] = useState<VariablesView | null>(null);
  const locked = state.parental.enabled;

  const load = useCallback(() => window.gh.getVariables().then(setView), []);
  const live = state.runs.map((run) => run.runId).join();
  useEffect(() => {
    void load();
  }, [load, live]);

  const groups = useMemo(() => {
    if (!view) return [];
    const names = new Map(state.scenarios.map((s) => [s.id, s.name]));
    const list: { scope: "global" | "scenario"; scenarioId: string; title: string; values: Record<string, Value> }[] = [];
    if (Object.keys(view.global).length) list.push({ scope: "global", scenarioId: "", title: t.sc.varsShared, values: view.global });
    for (const [id, values] of Object.entries(view.scenarios)) if (Object.keys(values).length) list.push({ scope: "scenario", scenarioId: id, title: names.get(id) ?? id, values });
    return list;
  }, [view, state.scenarios, t]);

  const set = async (scope: "global" | "scenario", scenarioId: string, name: string, value: Value) => {
    try {
      await window.gh.setVariable(scope, scenarioId, name, value);
    } catch (error) {
      toast("error", errorText(t, error));
    }
    void load();
  };

  return (
    <div className="sc-vars">
      <p className="hint">{t.sc.varsHint}</p>
      {!groups.length && <div className="empty">{t.sc.varsEmpty}</div>}
      {groups.map((group) => (
        <div key={group.scope + group.scenarioId} className="card sc-vars-group">
          <h3>{group.title}</h3>
          <table>
            <thead>
              <tr>
                <th>{t.sc.varName}</th>
                <th>{t.sc.varValue}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {Object.entries(group.values).map(([name, value]) => (
                <tr key={name}>
                  <td className="mono">{name}</td>
                  <td>
                    <input
                      className="input"
                      key={showValue(value)}
                      defaultValue={showValue(value)}
                      disabled={locked}
                      onBlur={(e) => e.target.value !== showValue(value) && void set(group.scope, group.scenarioId, name, parseValue(e.target.value, value))}
                      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                    />
                  </td>
                  <td>
                    {!locked && (
                      <Button
                        variant="ghost"
                        small
                        title={t.sc.delete}
                        onClick={async () => {
                          await window.gh.deleteVariable(group.scope, group.scenarioId, name).catch((error) => toast("error", errorText(t, error)));
                          void load();
                        }}
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
