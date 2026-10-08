import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Power } from "lucide-react";
import "@fontsource-variable/inter";
import "./styles/tokens.css";
import "./styles/overlay.css";

const TEXTS = {
  ru: { shutdown: "Компьютер выключится", restart: "Компьютер перезагрузится", sleep: "Компьютер уснёт", by: "по голосовой команде NODUS", cancel: "Отмена", seconds: "через {s} с" },
  en: { shutdown: "The computer will shut down", restart: "The computer will restart", sleep: "The computer will go to sleep", by: "by a NODUS voice command", cancel: "Cancel", seconds: "in {s} s" },
};

const query = new URLSearchParams(location.search);
const action = (query.get("action") ?? "shutdown") as "shutdown" | "restart" | "sleep";
const endsAt = Number(query.get("endsAt")) || Date.now() + 15000;
const texts = TEXTS[query.get("lang") === "en" ? "en" : "ru"];
const total = Math.max(1, Math.round((endsAt - Date.now()) / 1000));
const RADIUS = 52;
const CIRCLE = 2 * Math.PI * RADIUS;

function Countdown() {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100);

    return () => clearInterval(timer);
  }, []);

  const left = Math.max(0, (endsAt - now) / 1000);
  const progress = Math.min(1, left / total);

  return (
    <div className="overlay">
      <svg className="ring" viewBox="0 0 120 120" width="120" height="120" aria-hidden="true">
        <defs>
          <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ad67ff" />
            <stop offset="1" stopColor="#ff9a4d" />
          </linearGradient>
        </defs>
        <circle cx="60" cy="60" r={RADIUS} stroke="#2e2345" strokeWidth="8" fill="none" />
        <circle
          cx="60"
          cy="60"
          r={RADIUS}
          stroke="url(#ring)"
          strokeWidth="8"
          fill="none"
          strokeLinecap="round"
          strokeDasharray={CIRCLE}
          strokeDashoffset={CIRCLE * (1 - progress)}
          transform="rotate(-90 60 60)"
        />
        <text x="60" y="68" textAnchor="middle" fontSize="30" fontWeight="700" fill="#f6f1ff">
          {Math.ceil(left)}
        </text>
      </svg>
      <div className="text">
        <div className="title">
          <Power size={18} /> {texts[action]}
        </div>
        <div className="hint">{texts.seconds.replace("{s}", String(Math.ceil(left)))}</div>
        <div className="hint">{texts.by}</div>
      </div>
      <button type="button" className="cancel" autoFocus onClick={() => window.gh.cancelCountdown()}>
        {texts.cancel}
      </button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Countdown />
  </StrictMode>,
);
