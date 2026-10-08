import { useEffect, useState, type ReactNode } from "react";
import { Activity, Gamepad2, Settings as SettingsIcon, SlidersHorizontal } from "lucide-react";
import type { UiState } from "../../shared/types";
import { TEXTS, TextsContext } from "./i18n";
import { Logo, ToastProvider } from "./ui";
import { Pairing } from "./screens/Pairing";
import { Status, statusText, statusTone } from "./screens/Status";
import { Apps } from "./screens/Apps";
import { Commands } from "./screens/Commands";
import { Settings } from "./screens/Settings";

type Page = "status" | "apps" | "commands" | "settings";

export function App() {
  const [state, setState] = useState<UiState | null>(null);
  const [page, setPage] = useState<Page>("status");

  useEffect(() => {
    window.gh.getState().then(setState);
    return window.gh.onState(setState);
  }, []);

  if (!state) return <div className="titlebar" />;

  const t = TEXTS[state.ui.language];
  const nav: [Page, string, ReactNode][] = [
    ["status", t.navStatus, <Activity key="s" />],
    ["apps", t.navApps, <Gamepad2 key="a" />],
    ["commands", t.navCommands, <SlidersHorizontal key="c" />],
    ["settings", t.navSettings, <SettingsIcon key="o" />],
  ];

  return (
    <TextsContext.Provider value={t}>
      <ToastProvider>
        <div className="titlebar" />
        {!state.paired ? (
          <Pairing state={state} />
        ) : (
          <div className="shell">
            <aside className="sidebar">
              <div className="brand">
                <Logo />
                <span className="brand-name">Ghost Hands</span>
              </div>
              <nav className="nav">
                {nav.map(([id, label, icon]) => (
                  <button key={id} type="button" className={page === id ? "active" : ""} onClick={() => setPage(id)}>
                    {icon}
                    {label}
                  </button>
                ))}
              </nav>
              <div className="sidebar-footer">
                <div className="line">
                  <span className={`dot ${statusTone(state.connection.status)}`} />
                  <span>{statusText(t, state.connection.status)}</span>
                </div>
                <span className="muted">«{state.device.name}»</span>
              </div>
            </aside>
            <main className="main">
              {page === "status" && <Status state={state} />}
              {page === "apps" && <Apps state={state} />}
              {page === "commands" && <Commands state={state} />}
              {page === "settings" && <Settings state={state} />}
            </main>
          </div>
        )}
      </ToastProvider>
    </TextsContext.Provider>
  );
}
