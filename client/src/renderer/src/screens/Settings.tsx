import { useEffect, useState } from "react";
import { Download, FileText, Monitor, Network, Settings2, Unlink } from "lucide-react";
import type { Language, UiState } from "../../../shared/types";
import { fill, useTexts } from "../i18n";
import { Button, Card, ChipsEditor, Field, Locked, SwitchRow, useToast } from "../ui";

export function Settings({ state }: { state: UiState }) {
  const t = useTexts();
  const toast = useToast();
  const [name, setName] = useState(state.device.name);
  const [host, setHost] = useState(state.connection.host);
  const [port, setPort] = useState(String(state.connection.port));
  const [confirmUnpair, setConfirmUnpair] = useState(false);

  useEffect(() => setName(state.device.name), [state.device.name]);
  useEffect(() => setHost(state.connection.host), [state.connection.host]);
  useEffect(() => setPort(String(state.connection.port)), [state.connection.port]);

  const update = state.update;
  const locked = state.parental.enabled;
  const updateText = fill(t.updateStatus[update.status] ?? "", { version: update.version ?? "", percent: update.percent ?? 0, error: update.error ?? "" });

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t.navSettings}</h1>
      </div>

      <Locked locked={locked}>
      <Card title={t.settingsDevice} icon={<Monitor />}>
        <Field label={t.deviceName} hint={t.pairNameHint}>
          <div className="row">
            <input className="input" style={{ maxWidth: 320 }} value={name} maxLength={40} onChange={(event) => setName(event.target.value)} />
            <Button
              variant="secondary"
              disabled={!name.trim() || name.trim() === state.device.name}
              onClick={async () => {
                await window.gh.setDevice({ name: name.trim() });
                toast("success", t.saved);
              }}
            >
              {t.save}
            </Button>
          </div>
        </Field>
        <Field label={t.deviceAliases} hint={t.deviceAliasesHint}>
          <ChipsEditor values={state.device.aliases} onChange={(aliases) => window.gh.setDevice({ aliases })} placeholder={t.aliasesAdd} />
        </Field>
        <SwitchRow title={t.deviceShared} hint={t.pairSharedHint} checked={state.device.shared} onChange={(shared) => window.gh.setDevice({ shared })} />
      </Card>

      <Card title={t.settingsApp} icon={<Settings2 />}>
        {/* under parental control the client always starts with Windows */}
        <SwitchRow title={t.autostart} checked={state.ui.autostart || locked} onChange={(autostart) => window.gh.setUi({ autostart })} />
        <SwitchRow title={t.startHidden} checked={state.ui.startHidden} onChange={(startHidden) => window.gh.setUi({ startHidden })} />
        <SwitchRow title={t.closeToTray} checked={state.ui.closeToTray} onChange={(closeToTray) => window.gh.setUi({ closeToTray })} />
        <Field label={t.language}>
          <select className="select" style={{ maxWidth: 200 }} value={state.ui.language} onChange={(event) => window.gh.setUi({ language: event.target.value as Language })}>
            <option value="ru">Русский</option>
            <option value="en">English</option>
          </select>
        </Field>
      </Card>

      <Card title={t.settingsConnection} icon={<Network />}>
        <div className="grid-2" style={{ gridTemplateColumns: "1fr 140px" }}>
          <Field label={t.host}>
            <input className="input" value={host} onChange={(event) => setHost(event.target.value)} />
          </Field>
          <Field label={t.port}>
            <input className="input" value={port} inputMode="numeric" onChange={(event) => setPort(event.target.value.replace(/[^\d]/g, ""))} />
          </Field>
        </div>
        <div className="row">
          <Button
            variant="secondary"
            disabled={host.trim() === state.connection.host && Number(port) === state.connection.port}
            onClick={async () => {
              await window.gh.setServer({ host: host.trim(), port: Number(port) || 47300 });
              toast("success", t.saved);
            }}
          >
            {t.save}
          </Button>
          <Button variant="ghost" onClick={() => window.gh.reconnect()}>
            {t.reconnect}
          </Button>
        </div>
      </Card>
      </Locked>

      <Card title={t.settingsUpdates} icon={<Download />}>
        <SwitchRow title={t.autoUpdate} disabled={locked} checked={state.ui.autoUpdate} onChange={(autoUpdate) => window.gh.setUi({ autoUpdate })} />
        <div className="row">
          <Button variant="secondary" disabled={update.status === "disabled" || update.status === "checking"} onClick={() => window.gh.checkUpdates()}>
            {t.checkUpdates}
          </Button>
          {update.status === "ready" && (
            <Button variant="primary" onClick={() => window.gh.installUpdate()}>
              {t.updateInstall}
            </Button>
          )}
          <span className="hint">{[fill(t.version, { version: state.version }), updateText].filter(Boolean).join(" · ")}</span>
        </div>
      </Card>

      <Card>
        <div className="row">
          <Button variant="ghost" onClick={() => window.gh.openLogs()} title={t.logsHint}>
            <FileText />
            {t.logs}
          </Button>
          <span className="hint">{t.logsHint}</span>
          <span className="spacer" />
          {locked ? null : confirmUnpair ? (
            <>
              <span className="error" style={{ maxWidth: 380 }}>{t.unpairConfirm}</span>
              <Button variant="danger" onClick={() => window.gh.unpair()}>
                {t.unpair}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmUnpair(false)}>
                {t.cancel}
              </Button>
            </>
          ) : (
            <Button variant="danger" onClick={() => setConfirmUnpair(true)}>
              <Unlink />
              {t.unpair}
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
