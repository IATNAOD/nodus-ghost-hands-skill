import { useEffect, useRef, useState } from "react";
import { CircleAlert, Link2 } from "lucide-react";
import type { UiState } from "../../../shared/types";
import { useTexts } from "../i18n";
import { Button, Field, Logo, SwitchRow } from "../ui";

const KEY_RE = /^GH-?[0-9A-Z]{4}(-?[0-9A-Z]{4}){5}$/i;

/** "gh7k3m..." → "GH-7K3M-..." while typing */
const formatKey = (value: string): string => {
  const raw = value.toUpperCase().replace(/[^0-9A-Z]/g, "");
  const body = raw.startsWith("GH") ? raw.slice(2) : raw;

  return body ? `GH-${body.slice(0, 24).match(/.{1,4}/g)!.join("-")}` : raw;
};

export function Pairing({ state }: { state: UiState }) {
  const t = useTexts();
  const [key, setKey] = useState("");
  const [name, setName] = useState(state.device.name);
  const [shared, setShared] = useState(state.device.shared);
  const [autostart, setAutostart] = useState(state.ui.autostart);
  const [host, setHost] = useState(state.connection.host);
  const [port, setPort] = useState(String(state.connection.port));
  // a PC under parental control pairs again only with the parent's PIN
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // why a paired PC is back here: the key was reissued, the PC unpaired; shown on top
  const [notice, setNotice] = useState<string | null>(null);
  const [fromLink, setFromLink] = useState(false);
  // after "Connect" errors go under the button instead
  const attempted = useRef(false);

  useEffect(() => {
    const status = state.connection.status;

    if (!attempted.current && (status === "auth-failed" || status === "removed" || status === "name-taken")) setNotice(t[`error.${status}`]);
  }, [state.connection.status, t]);

  // "Open in the app" on the personal page: ghosthands://pair?key=...
  useEffect(() => {
    const take = () =>
      window.gh.takePairLink().then((link) => {
        if (!link) return;
        setKey(formatKey(link.key));
        if (link.host) setHost(link.host);
        if (link.port) setPort(String(link.port));
        setFromLink(true);
        setNotice(null);
      });

    take();
    return window.gh.onPairLink(take);
  }, []);

  const keyValid = KEY_RE.test(key);
  const step = busy ? (state.connection.status === "connecting" ? 1 : 2) : 0;

  const connect = async () => {
    attempted.current = true;
    setError(null);
    setNotice(null);
    setBusy(true);

    const result = await window.gh.pair({ key, name: name.trim(), shared, host: host.trim(), port: Number(port) || 47300, autostart, pin: state.parental.enabled ? pin : undefined });

    setBusy(false);
    if (!result.ok) setError(t[`error.${result.code}` as keyof typeof t] as string ?? result.code);
  };

  return (
    <div className="pairing">
      <form
        className="pairing-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (keyValid && name.trim() && !busy) connect();
        }}
      >
        <div className="pairing-hero">
          <Logo size={72} />
          <h1>Ghost Hands</h1>
          <p className="hint">{t.tagline}</p>
        </div>

        <div className="grid" style={{ display: "grid", gap: 6 }}>
          <h2 style={{ fontSize: 16 }}>{t.pairTitle}</h2>
          <p className="hint">{t.pairHint}</p>
        </div>

        {notice && !busy && (
          <div className="banner danger" role="alert">
            <CircleAlert />
            <span>{notice}</span>
          </div>
        )}

        {fromLink && (
          <div className="banner">
            <Link2 />
            <span>{t.pairLinkFilled}</span>
          </div>
        )}

        <Field label={t.pairKey}>
          <input
            className={`input mono${key && !keyValid ? " invalid" : ""}`}
            value={key}
            placeholder={t.pairKeyPlaceholder}
            spellCheck={false}
            autoFocus
            onChange={(event) => setKey(formatKey(event.target.value))}
          />
        </Field>

        <Field label={t.pairName} hint={t.pairNameHint}>
          <input className="input" value={name} maxLength={40} placeholder={t.pairNamePlaceholder} onChange={(event) => setName(event.target.value)} />
        </Field>

        {state.parental.enabled && (
          <Field label={t.pairPin} hint={t.pairPinHint}>
            <input
              className="input"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={12}
              style={{ maxWidth: 200 }}
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
            />
          </Field>
        )}

        <SwitchRow title={t.pairShared} hint={t.pairSharedHint} checked={shared} onChange={setShared} />
        <SwitchRow title={t.pairAutostart} checked={autostart} onChange={setAutostart} />

        <details className="details">
          <summary>{t.pairAdvanced}</summary>
          <div className="grid-2" style={{ marginTop: 10, gridTemplateColumns: "1fr 120px" }}>
            <Field label={t.pairHost}>
              <input className="input" value={host} onChange={(event) => setHost(event.target.value)} />
            </Field>
            <Field label={t.pairPort}>
              <input className="input" value={port} inputMode="numeric" onChange={(event) => setPort(event.target.value.replace(/[^\d]/g, ""))} />
            </Field>
          </div>
        </details>

        {busy && (
          <div style={{ display: "grid", gap: 6 }}>
            <div className="steps">
              <span className={step > 0 ? "done" : "active"} />
              <span className={step > 1 ? "done" : step === 1 ? "active" : ""} />
              <span className={step === 2 ? "active" : ""} />
            </div>
            <div className="row hint" style={{ justifyContent: "space-between" }}>
              <span>{t.pairStepFind}</span>
              <span>{t.pairStepConnect}</span>
              <span>{t.pairStepPair}</span>
            </div>
          </div>
        )}

        {error && <p className="error">{error}</p>}

        <Button variant="primary" type="submit" disabled={!keyValid || !name.trim() || busy || (state.parental.enabled && pin.length < 6)} style={{ padding: "12px 18px", fontSize: 14 }}>
          {busy ? t.pairConnecting : t.pairConnect}
        </Button>
      </form>
    </div>
  );
}
