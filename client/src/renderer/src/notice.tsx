// The small parental window in the corner: 10 minutes left, game time over.
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Clock, Gamepad2 } from "lucide-react";
import "@fontsource-variable/inter";
import "./styles/tokens.css";
import "./styles/parental.css";
import { ExtendButton, PinForm, fill, minutesLeft, texts, useParental } from "./parental-ui";

function Notice() {
  const state = useParental();
  const [pinOpen, setPinOpen] = useState(false);

  if (!state?.notice || !state.status) return <div className="notice" />;

  const kind = state.notice === "pc-near" ? "pc" : "games";
  const status = state.status[kind];
  const title =
    state.notice === "games-over" ? texts.gamesOver : fill(state.notice === "pc-near" ? texts.pcNear : texts.gamesNear, { m: minutesLeft(status.leftSec) });
  const hint = state.notice === "games-over" ? texts.gamesOverHint : state.notice === "pc-near" ? texts.pcNearHint : texts.gamesNearHint;

  return (
    <div className="notice">
      <div className="notice-head">
        {kind === "pc" ? <Clock size={18} /> : <Gamepad2 size={18} />}
        <strong>{title}</strong>
      </div>
      <p className="hint">{hint}</p>
      <div className="row">
        <ExtendButton kind={kind} state={state} />
        <span className="spacer" />
        <button type="button" className="ghost" onClick={() => window.ghp.dismiss()}>
          {state.notice === "games-over" ? texts.ok : texts.hide}
        </button>
      </div>
      <PinForm state={state} open={pinOpen} onOpen={setPinOpen} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Notice />
  </StrictMode>,
);
