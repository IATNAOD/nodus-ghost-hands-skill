// Fields of node inputs: the same ones in a node card (compact), the inspector and the steps.
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Braces, ClipboardPaste, Crosshair, FolderOpen, ImageUp, Keyboard, Monitor, ScanSearch, SquareDashed, X } from "lucide-react";
import type { NodeDef, PinDef } from "../../../shared/scenarios/defs";
import { comboLabel, normalizeCombo } from "../../../shared/scenarios/keys";
import type { ImageRef, KeyCombo, MonitorSel, Point, RegionSel, ScenarioSummary, Value } from "../../../shared/scenarios/model";
import { pinText } from "../../../shared/scenarios/texts";
import type { AppView, DisplayInfo } from "../../../shared/types";
import { useTexts } from "../i18n";
import { useToast } from "../ui";

export interface FieldContext {
  lang: "ru" | "en";
  apps: AppView[];
  scenarios: ScenarioSummary[];
  scenarioId: string;
  /** names for {{...}} */
  variables: string[];
  readOnly: boolean;
}

export const FieldsContext = createContext<FieldContext>({ lang: "ru", apps: [], scenarios: [], scenarioId: "", variables: [], readOnly: false });
export const useFields = () => useContext(FieldsContext);

/* ── samples and displays, loaded once ── */

const thumbs = new Map<string, Promise<string | null>>();
export const thumbOf = (asset: string): Promise<string | null> => {
  if (!thumbs.has(asset)) thumbs.set(asset, window.gh.getAsset(asset));
  return thumbs.get(asset)!;
};

let displays: Promise<DisplayInfo[]> | null = null;
export const useDisplays = (): DisplayInfo[] => {
  const [list, setList] = useState<DisplayInfo[]>([]);
  useEffect(() => {
    displays ??= window.gh.listDisplays().catch(() => []);
    displays.then(setList);
  }, []);
  return list;
};

/* ── the value of a pin, short (a step line, a node card) ── */

export function valueLabel(pin: PinDef, value: Value, ctx: FieldContext, type: string): string {
  if (value === null || value === undefined || value === "") return "…";
  switch (pin.type) {
    case "app":
      return ctx.apps.find((app) => app.id === value)?.name ?? String(value);
    case "scenario":
      return ctx.scenarios.find((s) => s.id === value)?.name ?? "…";
    case "keys":
      return comboLabel((value as KeyCombo).codes ?? []) || "…";
    case "image":
      return "🖼";
    case "option":
      return pinText(ctx.lang, type, pin.id)?.options?.[String(value)] ?? String(value);
    case "bool":
      return value ? "✓" : "✗";
    case "point":
      return typeof value === "object" && value && "x" in value ? `${(value as Point).x}, ${(value as Point).y}` : "…";
    case "monitors":
      return (value as MonitorSel).mode;
    default:
      if (typeof value === "object") return "…";
      return pin.unit === "s" ? `${value} с` : String(value).slice(0, 60);
  }
}

/* ── fields ── */

interface FieldProps {
  def: NodeDef;
  pin: PinDef;
  value: Value;
  onChange(value: Value): void;
  compact?: boolean;
}

/** The editor of one input, by its widget. */
export function PinField({ def, pin, value, onChange, compact }: FieldProps) {
  const ctx = useFields();
  const t = useTexts();
  const text = pinText(ctx.lang, def.type, pin.id);
  const disabled = ctx.readOnly;
  const cls = compact ? "pf compact nodrag nowheel" : "pf";

  switch (pin.widget ?? defaultWidget(pin)) {
    case "switch":
      return <input type="checkbox" className={`${cls} pf-check`} checked={Boolean(value)} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />;

    case "select":
      return (
        <select className={`${cls} select`} value={String(value ?? pin.default ?? "")} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {(pin.options ?? []).map((option) => (
            <option key={option} value={option}>
              {text?.options?.[option] ?? option}
            </option>
          ))}
        </select>
      );

    case "number":
    case "duration":
    case "slider":
      return <NumberField pin={pin} value={value} onChange={onChange} className={cls} disabled={disabled} slider={pin.widget === "slider" && !compact} />;

    case "app":
      return (
        <select className={`${cls} select`} value={String(value ?? "")} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">{t.sc.chooseApp}</option>
          {ctx.apps
            .filter((app) => app.enabled || app.id === value)
            .sort((a, b) => Number(b.kind === "game") - Number(a.kind === "game") || a.name.localeCompare(b.name))
            .map((app) => (
              <option key={app.id} value={app.id}>
                {app.name}
              </option>
            ))}
        </select>
      );

    case "scenario":
      return (
        <select className={`${cls} select`} value={String(value ?? "")} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">{t.sc.chooseScenario}</option>
          {ctx.scenarios
            .filter((s) => s.id !== ctx.scenarioId)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </select>
      );

    case "hotkey":
      return <KeyRecorder codes={(value as KeyCombo | null)?.codes ?? []} onChange={(codes) => onChange({ codes })} compact={compact} disabled={disabled} />;

    case "image":
      return <ImageField value={value as ImageRef | null} onChange={onChange} compact={compact} disabled={disabled} />;

    case "point":
      return <PointField value={value as Point | null} onChange={onChange} compact={compact} disabled={disabled} />;

    case "region":
      return <RegionField value={value as RegionSel | null} onChange={onChange} compact={compact} disabled={disabled} />;

    case "monitors":
      return <MonitorsField value={(value as MonitorSel | null) ?? { mode: "all" }} onChange={onChange} compact={compact} disabled={disabled} />;

    case "path":
      return (
        <span className={`${cls} pf-row`}>
          <TextField value={String(value ?? "")} onChange={onChange} template={pin.template} compact={compact} disabled={disabled} />
          {!compact && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={disabled}
              onClick={async () => {
                const picked = await window.gh.pickExecutable();
                if (picked) onChange(picked.path);
              }}
            >
              <FolderOpen />
            </button>
          )}
        </span>
      );

    case "variable":
      return (
        <>
          <input className={`${cls} input`} list="gh-variables" value={String(value ?? "")} disabled={disabled} onChange={(e) => onChange(e.target.value.replace(/[^\p{L}\p{N}_]/gu, "").slice(0, 40))} />
          <datalist id="gh-variables">
            {ctx.variables.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </>
      );

    case "textarea":
      return <TextField value={value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value)} onChange={onChange} template={pin.template} multiline={!compact} compact={compact} disabled={disabled} />;

    default:
      return <TextField value={value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value)} onChange={onChange} template={pin.template} compact={compact} disabled={disabled} />;
  }
}

const defaultWidget = (pin: PinDef) =>
  pin.type === "bool" ? "switch" : pin.type === "number" ? "number" : pin.type === "option" ? "select" : pin.type === "point" ? "point" : pin.type === "region" ? "region" : "text";

function NumberField({ pin, value, onChange, className, disabled, slider }: { pin: PinDef; value: Value; onChange(value: Value): void; className: string; disabled: boolean; slider: boolean }) {
  const t = useTexts();
  const [draft, setDraft] = useState(String(value ?? pin.default ?? 0));
  useEffect(() => setDraft(String(value ?? pin.default ?? 0)), [value, pin.default]);

  const commit = (raw: string) => {
    let number = Number(raw.replace(",", "."));
    if (!Number.isFinite(number)) number = Number(pin.default ?? 0);
    if (pin.min !== undefined) number = Math.max(pin.min, number);
    if (pin.max !== undefined) number = Math.min(pin.max, number);
    onChange(number);
    setDraft(String(number));
  };

  return (
    <span className={`${className} pf-row`}>
      {slider && (
        <input type="range" min={pin.min ?? 0} max={pin.max ?? 100} step={pin.step ?? 1} value={Number(value ?? pin.default ?? 0)} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
      )}
      <input
        className="input pf-number"
        inputMode="decimal"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && commit((e.target as HTMLInputElement).value)}
      />
      {pin.unit && <span className="pf-unit">{pin.unit === "s" ? (t.sc.lang === "ru" ? "с" : "s") : pin.unit === "ms" ? (t.sc.lang === "ru" ? "мс" : "ms") : pin.unit}</span>}
    </span>
  );
}

/** Text with {{variables}}: typing commits after a pause; the {x} button inserts a variable. */
export function TextField({ value, onChange, template, multiline, compact, disabled }: { value: string; onChange(value: Value): void; template?: boolean; multiline?: boolean; compact?: boolean; disabled?: boolean }) {
  const ctx = useFields();
  const t = useTexts();
  const [draft, setDraft] = useState(value);
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => setDraft(value), [value]);

  const change = (next: string) => {
    setDraft(next);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => onChange(next), 400);
  };
  const insert = (name: string) => {
    const el = ref.current;
    const at = el?.selectionStart ?? draft.length;
    const next = `${draft.slice(0, at)}{{${name}}}${draft.slice(el?.selectionEnd ?? at)}`;
    setMenu(false);
    setDraft(next);
    onChange(next);
  };

  const props = {
    ref,
    className: `input ${compact ? "nodrag nowheel" : ""}`,
    value: draft,
    disabled,
    onChange: (e: { target: { value: string } }) => change(e.target.value),
    onBlur: () => draft !== value && onChange(draft),
  };

  return (
    <span className={`pf pf-row pf-text ${compact ? "compact" : ""}`}>
      {multiline ? <textarea rows={3} {...props} /> : <input {...props} />}
      {template && !compact && !disabled && (
        <span className="pf-vars">
          <button type="button" className="btn btn-ghost btn-sm" title={t.sc.sourceVariable} onClick={() => setMenu(!menu)}>
            <Braces />
          </button>
          {menu && (
            <span className="pf-menu">
              {[...ctx.variables, "trigger.text", "now.time", "now.date"].map((name) => (
                <button key={name} type="button" onClick={() => insert(name)}>
                  {`{{${name}}}`}
                </button>
              ))}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

/**
 * Press a combination to record it. The helper takes the keys before Windows does, so Win+D or
 * Alt+Tab are recorded instead of done; the window's own key events are the fallback. Global
 * hotkeys are off meanwhile, so existing ones can be recorded.
 */
export function KeyRecorder({ codes, onChange, compact, disabled }: { codes: string[]; onChange(codes: string[]): void; compact?: boolean; disabled?: boolean }) {
  const t = useTexts();
  const [recording, setRecording] = useState(false);
  const [live, setLive] = useState<string[]>([]);
  const changed = useRef(onChange);
  changed.current = onChange;

  useEffect(() => {
    if (!recording) return undefined;

    const pressed = new Set<string>();
    const seen: string[] = [];
    let done = false;
    const press = (code: string, isDown: boolean) => {
      if (done) return;
      if (isDown) {
        pressed.add(code);
        if (!seen.includes(code)) seen.push(code);
        setLive(normalizeCombo(seen));
        return;
      }
      pressed.delete(code);
      // all keys let go: that was the combination
      if (pressed.size === 0 && seen.length) {
        done = true;
        changed.current(normalizeCombo(seen));
        setRecording(false);
      }
    };
    const down = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      press(event.code, true);
    };
    const up = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      press(event.code, false);
    };
    const blur = () => setRecording(false);
    const off = window.gh.onCapturedKey((key) => {
      if (key.type === "stopped") setRecording(false);
      else press(key.code, key.type === "down");
    });

    window.gh.suspendHotkeys(true).catch(() => undefined);
    window.gh.captureKeys(true).catch(() => false);
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", blur);
    return () => {
      off();
      window.gh.captureKeys(false).catch(() => false);
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", blur);
      window.gh.suspendHotkeys(false).catch(() => undefined);
    };
  }, [recording]);

  return (
    <button
      type="button"
      className={`btn btn-secondary btn-sm pf-keys ${compact ? "nodrag" : ""} ${recording ? "recording" : ""}`}
      disabled={disabled}
      onClick={() => {
        setLive([]);
        setRecording(!recording);
      }}
    >
      <Keyboard />
      {recording ? (live.length ? comboLabel(live) : t.sc.recording) : comboLabel(codes) || t.sc.record}
    </button>
  );
}

function ImageField({ value, onChange, compact, disabled }: { value: ImageRef | null; onChange(value: Value): void; compact?: boolean; disabled?: boolean }) {
  const t = useTexts();
  const toast = useToast();
  const [src, setSrc] = useState<string | null>(null);
  const load = async (source: "file" | "clipboard") => {
    try {
      const ref = await window.gh.loadTemplate(source);
      if (ref) onChange(ref);
    } catch (error) {
      const code = String((error as Error)?.message ?? "").replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
      toast("error", t.sc.pictureError[code] ?? t.sc.pictureError["bad-image"]);
    }
  };

  useEffect(() => {
    setSrc(null);
    if (value?.asset) thumbOf(value.asset).then(setSrc);
  }, [value?.asset]);

  return (
    <span className={`pf pf-image ${compact ? "compact nodrag" : ""}`}>
      {src ? <img src={src} alt="" /> : <span className="pf-empty">{t.sc.noImage}</span>}
      <span className="pf-image-actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          title={compact ? t.sc.capture : undefined}
          disabled={disabled}
          onClick={async () => {
            const ref = await window.gh.captureTemplate().catch(() => null);
            if (ref) onChange(ref);
          }}
        >
          <ScanSearch />
          {!compact && (value ? t.sc.recapture : t.sc.capture)}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" title={t.sc.fromFile} disabled={disabled} onClick={() => void load("file")}>
          <ImageUp />
        </button>
        <button type="button" className="btn btn-ghost btn-sm" title={t.sc.fromClipboard} disabled={disabled} onClick={() => void load("clipboard")}>
          <ClipboardPaste />
        </button>
      </span>
    </span>
  );
}

function PointField({ value, onChange, compact, disabled }: { value: Point | null; onChange(value: Value): void; compact?: boolean; disabled?: boolean }) {
  const t = useTexts();
  const set = (axis: "x" | "y", raw: string) => {
    const n = Math.round(Number(raw));
    if (Number.isFinite(n)) onChange({ x: value?.x ?? 0, y: value?.y ?? 0, [axis]: n });
  };

  return (
    <span className={`pf pf-row ${compact ? "compact nodrag nowheel" : ""}`}>
      <input className="input pf-number" placeholder="x" value={value?.x ?? ""} disabled={disabled} onChange={(e) => set("x", e.target.value)} />
      <input className="input pf-number" placeholder="y" value={value?.y ?? ""} disabled={disabled} onChange={(e) => set("y", e.target.value)} />
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        title={t.sc.pickPoint}
        disabled={disabled}
        onClick={async () => {
          const point = await window.gh.pickPoint().catch(() => null);
          if (point) onChange(point);
        }}
      >
        <Crosshair />
      </button>
    </span>
  );
}

function RegionField({ value, onChange, compact, disabled }: { value: RegionSel | null; onChange(value: Value): void; compact?: boolean; disabled?: boolean }) {
  const t = useTexts();

  return (
    <span className={`pf pf-row ${compact ? "compact nodrag" : ""}`}>
      <span className="pf-summary">{value && "monitor" in value ? `${value.monitor.name}: ${value.x}, ${value.y}, ${value.w}×${value.h}` : t.sc.wholeMonitor}</span>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        title={t.sc.pickRegion}
        disabled={disabled}
        onClick={async () => {
          const region = await window.gh.pickRegion().catch(() => null);
          if (region) onChange(region);
        }}
      >
        <SquareDashed />
      </button>
      {value && (
        <button type="button" className="btn btn-ghost btn-sm" title={t.sc.clear} disabled={disabled} onClick={() => onChange(null)}>
          <X />
        </button>
      )}
    </span>
  );
}

function MonitorsField({ value, onChange, compact, disabled }: { value: MonitorSel; onChange(value: Value): void; compact?: boolean; disabled?: boolean }) {
  const t = useTexts();
  const list = useDisplays();
  const chosen = value.mode === "list" ? value.list : [];

  return (
    <span className={`pf pf-monitors ${compact ? "compact nodrag" : ""}`}>
      <select
        className="select"
        value={value.mode}
        disabled={disabled}
        onChange={(e) => {
          const mode = e.target.value as MonitorSel["mode"];
          onChange(mode === "list" ? { mode, list: list.filter((d) => d.primary).map((d) => ({ id: d.id, name: d.name, w: d.bounds.w, h: d.bounds.h })) } : { mode } as Value);
        }}
      >
        {(["all", "primary", "active", "cursor", "list"] as const).map((mode) => (
          <option key={mode} value={mode}>
            {t.sc.monitors[mode]}
          </option>
        ))}
      </select>
      {value.mode === "list" && !compact && (
        <span className="pf-displays">
          {list.map((display) => {
            const on = chosen.some((key) => key.id === display.id);
            return (
              <label key={display.id} className="pf-display">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={disabled}
                  onChange={() =>
                    onChange({
                      mode: "list",
                      list: on ? chosen.filter((key) => key.id !== display.id) : [...chosen, { id: display.id, name: display.name, w: display.bounds.w, h: display.bounds.h }],
                    })
                  }
                />
                <Monitor size={14} />
                {display.name} · {display.bounds.w}×{display.bounds.h}
              </label>
            );
          })}
        </span>
      )}
    </span>
  );
}

