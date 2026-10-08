// The parental lock over everything: the PC's time is over for today.
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "./styles/tokens.css";
import "./styles/parental.css";
import { Logo } from "./ui";
import { ExtendButton, PinForm, texts, useParental } from "./parental-ui";

function Lock() {
  const state = useParental();
  const [pinOpen, setPinOpen] = useState(false);

  return (
    <div className="lock">
      <div className="lock-card">
        <Logo size={72} />
        <h1>{texts.pcOver}</h1>
        <p className="hint">{texts.pcOverHint}</p>
        {state && (
          <>
            <ExtendButton kind="pc" state={state} />
            <PinForm state={state} open={pinOpen} onOpen={setPinOpen} />
          </>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Lock />
  </StrictMode>,
);
