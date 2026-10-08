import { useEffect, useMemo, useState } from "react";
import { AppWindow, FolderOpen, Globe, Mic, Play, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import type { AppView, PhraseCheck, StartAppView, UiState } from "../../../shared/types";
import { fill, useTexts } from "../i18n";
import { Button, Card, ChipsEditor, Field, Locked, Modal, Switch, useToast } from "../ui";

type Filter = "all" | "game" | "app" | "site" | "off";

const splitAliases = (text: string) =>
  text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

function AppRow({ app }: { app: AppView }) {
  const t = useTexts();
  const toast = useToast();
  const [showSpoken, setShowSpoken] = useState(Boolean(app.spoken));
  const warnings = Object.fromEntries(app.warnings.map((warning) => [warning.alias, t.warning[warning.code as keyof typeof t.warning] ?? warning.code]));
  const learned = app.aliases.filter((alias) => !app.suggested.includes(alias));

  return (
    <div className={`app-row${app.enabled ? "" : " off"}`}>
      <Switch checked={app.enabled} onChange={(enabled) => window.gh.setApp(app.id, { enabled })} label={app.name} />
      <div className="body">
        <div className="name">
          {app.name}
          <span className="badge grey">{t.source[app.source]}</span>
          {app.kind === "game" && <span className="badge">{t.kind.game}</span>}
          {app.running && <span className="badge orange">{t.running}</span>}
        </div>
        {app.detail && <div className="detail" title={app.detail}>{app.detail}</div>}
        {app.enabled && (
          <>
            <ChipsEditor values={app.aliases} onChange={(aliases) => window.gh.setApp(app.id, { aliases })} placeholder={t.aliasesAdd} learned={learned} warnings={warnings} />
            {showSpoken ? (
              <div className="row">
                <span className="hint">{t.spoken}</span>
                <input
                  className="input"
                  style={{ maxWidth: 220, padding: "6px 10px" }}
                  defaultValue={app.spoken}
                  placeholder={t.spokenPlaceholder}
                  onBlur={(event) => event.target.value !== app.spoken && window.gh.setApp(app.id, { spoken: event.target.value })}
                />
              </div>
            ) : null}
          </>
        )}
      </div>
      <div className="actions">
        {app.enabled && !showSpoken && (
          <Button variant="ghost" small title={t.spoken} onClick={() => setShowSpoken(true)}>
            <Mic />
          </Button>
        )}
        <Button
          variant="ghost"
          small
          title={t.testLaunch}
          onClick={async () => {
            const result = await window.gh.testLaunch(app.id);

            toast(result.ok ? "success" : "error", result.ok ? t.launched : result.code ?? "error");
          }}
        >
          <Play />
        </Button>
        {app.removable && (
          <Button variant="ghost" small title={t.remove} onClick={() => window.gh.removeApp(app.id)}>
            <Trash2 />
          </Button>
        )}
      </div>
    </div>
  );
}

function StartMenuDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTexts();
  const [items, setItems] = useState<StartAppView[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");

  const load = async () => {
    setItems(null);
    setChosen(new Set());
    setItems(await window.gh.listStartApps());
  };

  useEffect(() => {
    if (open) load();
  }, [open]);

  const visible = (items ?? []).filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <Modal open={open} onClose={onClose} title={t.startTitle}>
      <input className="input" placeholder={t.search} value={query} onChange={(event) => setQuery(event.target.value)} />
      {items === null ? (
        <p className="hint">{t.startLoading}</p>
      ) : (
        <div className="modal-list">
          {visible.map((item) => (
            <label key={item.appId}>
              <input
                type="checkbox"
                checked={item.added || chosen.has(item.appId)}
                disabled={item.added}
                onChange={(event) => {
                  const next = new Set(chosen);

                  if (event.target.checked) next.add(item.appId);
                  else next.delete(item.appId);
                  setChosen(next);
                }}
              />
              {item.name}
            </label>
          ))}
        </div>
      )}
      <Button
        variant="primary"
        disabled={!chosen.size}
        onClick={async () => {
          await window.gh.addStartApps([...chosen]);
          onClose();
        }}
      >
        {t.startAdd}
      </Button>
    </Modal>
  );
}

function AddDialog({ type, onClose }: { type: "exe" | "site" | null; onClose: () => void }) {
  const t = useTexts();
  const toast = useToast();
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [aliases, setAliases] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName("");
    setTarget("");
    setAliases("");
    setError(null);
    onClose();
  };

  return (
    <Modal open={type !== null} onClose={reset} title={type === "site" ? t.siteTitle : t.programTitle}>
      {type === "exe" ? (
        <div className="row">
          <Button
            variant="secondary"
            onClick={async () => {
              const picked = await window.gh.pickExecutable();

              if (picked) {
                setTarget(picked.path);
                if (!name) setName(picked.name);
              }
            }}
          >
            <FolderOpen />
            {t.programPick}
          </Button>
          <span className="hint" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 300 }}>
            {target}
          </span>
        </div>
      ) : (
        <Field label={t.siteUrl}>
          <input className="input" value={target} placeholder="https://youtube.com" onChange={(event) => setTarget(event.target.value)} />
        </Field>
      )}
      <Field label={t.siteName}>
        <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label={t.aliases}>
        <input className="input" value={aliases} placeholder="ютуб, ютюб" onChange={(event) => setAliases(event.target.value)} />
      </Field>
      {error && <p className="error">{error}</p>}
      <Button
        variant="primary"
        disabled={!name.trim() || !target.trim()}
        onClick={async () => {
          const result = await window.gh.addApp(type === "site" ? { type: "site", name, url: target, aliases: splitAliases(aliases) } : { type: "exe", name, path: target, aliases: splitAliases(aliases) });

          if (result.ok) {
            toast("success", t.saved);
            reset();
          } else {
            setError((t[`error.${result.code}` as keyof typeof t] as string) ?? result.code ?? "error");
          }
        }}
      >
        {t.add}
      </Button>
    </Modal>
  );
}

type PhraseParams = {
  op?: string;
  value?: number | null;
  query?: string;
  key?: string;
  delaySec?: number;
  generic?: string | null;
  pc?: { words?: string } | null;
};

/** What NODUS would do with the phrase, in words */
function PhraseResult({ result }: { result: PhraseCheck }) {
  const t = useTexts();
  const params = (result.params ?? {}) as PhraseParams;
  const lines: string[] = [];
  const pick = (table: Record<string, string>, key: string | null | undefined) => (key ? (table[key] ?? key) : "");

  if (params.generic) lines.push(pick(t.phraseGeneric, params.generic));
  if (result.intent === "pc_volume") {
    const by = (params.op === "up" || params.op === "down") && params.value ? ` ${fill(t.phraseBy, { value: params.value })}` : "";

    lines.push(fill(pick(t.phraseVolume, params.op), { value: params.value ?? "" }) + by);
  }
  if (result.intent === "pc_power") {
    const delay = params.delaySec ? ` ${fill(t.phraseDelay, { minutes: Math.round(params.delaySec / 60) })}` : "";

    lines.push(pick(t.phrasePower, params.op) + delay);
  }
  if (result.intent === "pc_media") lines.push(pick(t.phraseMedia, params.key));
  if (result.intent === "pc_search" && params.query) lines.push(fill(t.phraseQuery, { query: params.query }));
  if (params.pc?.words) lines.push(fill(t.phrasePc, { words: params.pc.words }));

  return (
    <div className="phrase-result">
      <div className="row">
        <span className="badge">{pick(t.phraseIntent, result.intent)}</span>
        <span className="muted">{fill(t.phraseScore, { score: result.score ?? 0 })}</span>
      </div>
      {result.apps.map((app) => (
        <div key={app.spoken} className={`phrase-line ${app.status}`}>
          {fill(t.phraseApp[app.status], { spoken: app.spoken, names: app.names.join(t.phraseOr), percent: Math.round((app.score ?? 0) * 100) })}
        </div>
      ))}
      {lines.map((line) => (
        <div key={line} className="phrase-line">
          {line}
        </div>
      ))}
    </div>
  );
}

function PhraseTester({ accept }: { accept: number }) {
  const t = useTexts();
  const [text, setText] = useState("");
  const [result, setResult] = useState<PhraseCheck | null>(null);

  const check = async () => {
    if (text.trim()) setResult(await window.gh.checkPhrase(text));
  };

  return (
    <Card title={t.phraseTitle} icon={<Mic />}>
      <div className="row">
        <input
          className="input"
          style={{ flex: 1 }}
          value={text}
          placeholder={t.phrasePlaceholder}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && check()}
        />
        <Button variant="secondary" onClick={check}>
          {t.phraseCheck}
        </Button>
      </div>
      {result && (result.intent ? <PhraseResult result={result} /> : <p className="hint">{t.phraseNone}</p>)}
      <p className="hint">{fill(t.phraseAccept, { percent: Math.round(accept * 100) })}</p>
    </Card>
  );
}

export function Apps({ state }: { state: UiState }) {
  const t = useTexts();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [startOpen, setStartOpen] = useState(false);
  const [adding, setAdding] = useState<"exe" | "site" | null>(null);

  const apps = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return state.apps
      .filter((app) => (filter === "all" ? true : filter === "off" ? !app.enabled : app.kind === filter))
      .filter((app) => !needle || app.name.toLowerCase().includes(needle) || app.aliases.some((alias) => alias.toLowerCase().includes(needle)))
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || Number(b.kind === "game") - Number(a.kind === "game") || a.name.localeCompare(b.name));
  }, [state.apps, filter, query]);

  const filters: [Filter, string][] = [
    ["all", t.filterAll],
    ["game", t.filterGames],
    ["app", t.filterApps],
    ["site", t.filterSites],
    ["off", t.filterOff],
  ];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t.navApps}</h1>
          <p>{t.appsHint}</p>
        </div>
      </div>

      <PhraseTester accept={state.skill.accept} />

      <div className="toolbar">
        <div className="row" style={{ position: "relative" }}>
          <Search size={16} style={{ position: "absolute", left: 10, color: "var(--muted)" }} />
          <input className="input" style={{ paddingLeft: 32 }} placeholder={t.search} value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="filters">
          {filters.map(([value, label]) => (
            <button key={value} type="button" className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>
              {label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <Locked locked={state.parental.enabled}>
        <Button variant="secondary" small onClick={() => setStartOpen(true)}>
          <AppWindow />
          {t.addStart}
        </Button>
        <Button variant="secondary" small onClick={() => setAdding("exe")}>
          <Plus />
          {t.addProgram}
        </Button>
        <Button variant="secondary" small onClick={() => setAdding("site")}>
          <Globe />
          {t.addSite}
        </Button>
        <Button variant="ghost" small disabled={state.scanning} onClick={() => window.gh.rescan()} title={t.rescan}>
          <RefreshCw />
          {state.scanning ? t.scanning : t.rescan}
        </Button>
        </Locked>
      </div>

      <Locked locked={state.parental.enabled}>
        <div className="app-list">{apps.length ? apps.map((app) => <AppRow key={app.id} app={app} />) : <div className="empty">{t.emptyApps}</div>}</div>
      </Locked>

      <StartMenuDialog open={startOpen} onClose={() => setStartOpen(false)} />
      <AddDialog type={adding} onClose={() => setAdding(null)} />
      <p className="muted" style={{ fontSize: 12 }}>
        {fill("{count}", { count: state.apps.filter((app) => app.enabled).length })} / {state.apps.length}
      </p>
    </div>
  );
}
