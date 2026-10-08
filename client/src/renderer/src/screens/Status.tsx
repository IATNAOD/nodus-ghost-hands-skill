import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Download, History, Plug, PlugZap, Power, RefreshCw, ShieldCheck, WifiOff } from "lucide-react";
import type { ConnectionStatus, ParentalView, UiState } from "../../../shared/types";
import { fill, useTexts, type Texts } from "../i18n";
import { Button, Card, SwitchRow } from "../ui";

const time = (value: number) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export const statusText = (t: Texts, status: ConnectionStatus): string =>
  ({
    online: t.statusOnline,
    connecting: t.statusConnecting,
    offline: t.statusOffline,
    unpaired: t.statusUnpaired,
    "auth-failed": t.statusAuthFailed,
    removed: t.statusRemoved,
    "name-taken": t.statusNameTaken,
    "proto-unsupported": t.statusProto,
    "rate-limited": t.statusRateLimited,
  })[status];

export const statusTone = (status: ConnectionStatus): "online" | "connecting" | "error" | "" =>
  status === "online" ? "online" : status === "connecting" ? "connecting" : ["auth-failed", "removed", "name-taken", "proto-unsupported"].includes(status) ? "error" : "";

/** Seconds left of a countdown, ticking */
function useSecondsLeft(endsAt: number | null): number {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!endsAt) return undefined;

    const timer = setInterval(() => setNow(Date.now()), 250);

    return () => clearInterval(timer);
  }, [endsAt]);

  return endsAt ? Math.max(0, Math.ceil((endsAt - now) / 1000)) : 0;
}

const RELEASES_URL = "https://github.com/IATNAOD/nodus-ghost-hands-skill/releases/latest";

/** "1.2.0" newer than "1.1.9" */
const newer = (a: string, b: string): boolean => {
  const parts = (version: string) => version.split(/[.-]/).map((part) => Number(part) || 0);
  const [x, y] = [parts(a), parts(b)];

  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

const duration = (t: Texts, seconds: number): string => {
  const minutes = Math.max(0, Math.ceil(seconds / 60));

  if (minutes < 60) return fill(t.durM, { m: minutes });
  return fill(minutes % 60 ? t.durHM : t.durH, { h: Math.floor(minutes / 60), m: minutes % 60 });
};

/** Time left today on the PC and in games, or "limits lifted until 18:00". */
function ParentalCard({ parental }: { parental: ParentalView }) {
  const t = useTexts();
  const meter = (title: string, left: number | null) => (
    <div className={`meter${left !== null && left <= 0 ? " over" : ""}`}>
      <span className="hint">{title}</span>
      <strong>{left === null ? t.parentalNoLimit : left <= 0 ? t.parentalOver : fill(t.parentalLeft, { time: duration(t, left) })}</strong>
    </div>
  );

  return (
    <Card title={t.parentalTitle} icon={<ShieldCheck />} className="parental-card">
      {parental.granted && parental.grantUntil ? (
        <p className="hint">{fill(t.parentalGranted, { time: time(parental.grantUntil) })}</p>
      ) : (
        <div className="meters">
          {meter(t.parentalPc, parental.pcLeftSec)}
          {meter(t.parentalGames, parental.gamesLeftSec)}
        </div>
      )}
    </Card>
  );
}

export function Status({ state }: { state: UiState }) {
  const t = useTexts();
  const { connection } = state;
  const tone = statusTone(connection.status);
  const seconds = useSecondsLeft(state.countdown?.endsAt ?? null);
  const Icon = tone === "online" ? PlugZap : tone === "connecting" ? Plug : tone === "error" ? AlertTriangle : WifiOff;
  const countdownAction = state.countdown ? { shutdown: t.countdownShutdown, restart: t.countdownRestart, sleep: t.countdownSleep }[state.countdown.action] : "";
  const scheduledAction = state.scheduled
    ? ({ shutdown: t.scheduledShutdown, restart: t.scheduledRestart, sleep: t.scheduledSleep, lock: t.scheduledLock, display_off: t.scheduledDisplay } as Record<string, string>)[state.scheduled.action] ?? state.scheduled.action
    : "";

  return (
    <div className="page">
      <div className="status-card">
        <div className={`status-orb ${tone}`}>
          <Icon />
        </div>
        <div style={{ display: "grid", gap: 4 }}>
          <span className="status-title">{statusText(t, connection.status)}</span>
          <span className="hint">
            {[
              fill(t.statusPc, { name: state.device.name }),
              connection.owner && fill(t.statusOwner, { name: connection.owner }),
              connection.status === "online" && connection.since && fill(t.statusSince, { time: time(connection.since) }),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <span className="muted" style={{ fontSize: 12 }}>
            {[
              fill(t.statusAddress, { address: `${connection.host}:${connection.port}${connection.address && connection.address !== connection.host ? ` (${connection.address})` : ""}` }),
              state.skill.version && fill(t.statusSkill, { version: state.skill.version }),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <Button variant="secondary" onClick={() => window.gh.reconnect()}>
          <RefreshCw />
          {t.reconnect}
        </Button>
      </div>

      {state.countdown && (
        <div className="banner danger">
          <Power />
          <strong>{fill(t.countdownBanner, { action: countdownAction, seconds })}</strong>
          <span className="spacer" />
          <Button variant="danger" onClick={() => window.gh.cancelCountdown()}>
            {t.cancel}
          </Button>
        </div>
      )}

      {state.scheduled && !state.countdown && (
        <div className="banner">
          <Clock />
          <span>{fill(t.scheduledBanner, { action: scheduledAction, time: time(state.scheduled.at) })}</span>
          <span className="spacer" />
          <Button variant="secondary" onClick={() => window.gh.cancelCountdown()}>
            {t.cancel}
          </Button>
        </div>
      )}

      {state.skill.version && state.skill.version !== state.version && (
        <div className="banner">
          <AlertTriangle />
          <span>{fill(newer(state.version, state.skill.version) ? t.skillOlder : t.appOlder, { skill: state.skill.version, app: state.version })}</span>
          <span className="spacer" />
          <Button variant="secondary" onClick={() => window.gh.openExternal(RELEASES_URL)}>
            {t.openRelease}
          </Button>
        </div>
      )}

      {!state.helper.ok && state.helper.error && (
        <div className="banner danger">
          <AlertTriangle />
          <span>{t.helperBroken}</span>
        </div>
      )}

      {state.nameError === "name-taken" && (
        <div className="banner danger">
          <AlertTriangle />
          <span>{fill(t.nameError, { name: state.device.name })}</span>
        </div>
      )}

      {state.update.status === "ready" && (
        <div className="banner">
          <Download />
          <span>{fill(t.updateReady, { version: state.update.version ?? "" })}</span>
          <span className="spacer" />
          <Button variant="primary" onClick={() => window.gh.installUpdate()}>
            {t.updateInstall}
          </Button>
        </div>
      )}

      {state.parental.enabled && <ParentalCard parental={state.parental} />}

      <Card>
        <SwitchRow
          title={t.pause}
          hint={state.parental.enabled ? t.parentalPauseOff : t.pauseHint}
          disabled={state.parental.enabled}
          checked={state.prefs.paused}
          onChange={(paused) => window.gh.setPrefs({ paused })}
        />
      </Card>

      <Card title={t.recentTitle} icon={<History />}>
        {state.log.length ? (
          <div className="log">
            <ul>
              {state.log.map((entry) => (
                <li key={`${entry.at}-${entry.action}`}>
                  <span className="when">{time(entry.at)}</span>
                  <span>
                    {t.action[entry.action] ?? entry.action} {entry.target && <span className="muted">· {entry.target}</span>}
                  </span>
                  <span className={entry.ok ? "ok" : "fail"}>{entry.ok ? <CheckCircle2 size={16} /> : (entry.code && t.code[entry.code]) ?? entry.code}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="hint">{t.recentEmpty}</p>
        )}
      </Card>
    </div>
  );
}
