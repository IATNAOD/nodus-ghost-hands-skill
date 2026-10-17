// A frozen picture of one monitor: the person draws a sample or an area, or clicks a point.
// Coordinates go back in the frame's physical pixels.
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "./styles/tokens.css";
import "./styles/picker.css";
import { TEXTS } from "./i18n";
import type { Language } from "../../shared/types";

type Mode = "image" | "point" | "region";

interface Frame {
  mode: Mode;
  image: string;
  w: number;
  h: number;
  lang: string;
}

declare global {
  interface Window {
    ghk: {
      init(): Promise<Frame>;
      done(result: { x: number; y: number; w?: number; h?: number }): Promise<void>;
      cancel(): Promise<void>;
    };
  }
}

type Pos = { x: number; y: number };

/** at least this many physical pixels each way */
const MIN_SIZE = 4;

function Picker() {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [start, setStart] = useState<Pos | null>(null);
  const [at, setAt] = useState<Pos | null>(null);
  const finished = useRef(false);

  useEffect(() => {
    window.ghk.init().then(setFrame).catch(() => undefined);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !finished.current) {
        finished.current = true;
        void window.ghk.cancel();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);

  if (!frame) return <div className="picker" />;

  const texts = TEXTS[(frame.lang === "en" ? "en" : "ru") as Language].sc.picker;
  // CSS pixels of the window -> physical pixels of the frame
  const kx = frame.w / window.innerWidth;
  const ky = frame.h / window.innerHeight;
  const pos = (event: React.MouseEvent): Pos => ({ x: Math.max(0, Math.min(window.innerWidth, event.clientX)), y: Math.max(0, Math.min(window.innerHeight, event.clientY)) });
  const box = start && at ? { left: Math.min(start.x, at.x), top: Math.min(start.y, at.y), width: Math.abs(at.x - start.x), height: Math.abs(at.y - start.y) } : null;

  const finish = (result: { x: number; y: number; w?: number; h?: number }) => {
    if (finished.current) return;
    finished.current = true;
    void window.ghk.done(result);
  };

  return (
    <div
      className="picker"
      onContextMenu={(event) => {
        event.preventDefault();
        setStart(null);
      }}
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        if (frame.mode === "point") return;
        setStart(pos(event));
        setAt(pos(event));
      }}
      onMouseMove={(event) => setAt(pos(event))}
      onMouseUp={(event) => {
        if (event.button !== 0) return;
        const end = pos(event);
        if (frame.mode === "point") {
          finish({ x: Math.round(end.x * kx), y: Math.round(end.y * ky) });
          return;
        }
        if (!start) return;
        const x = Math.round(Math.min(start.x, end.x) * kx);
        const y = Math.round(Math.min(start.y, end.y) * ky);
        const w = Math.round(Math.abs(end.x - start.x) * kx);
        const h = Math.round(Math.abs(end.y - start.y) * ky);
        if (w < MIN_SIZE || h < MIN_SIZE) {
          setStart(null);
          return;
        }
        finish({ x, y, w, h });
      }}
    >
      <img src={`data:image/jpeg;base64,${frame.image}`} alt="" draggable={false} />
      {box ? <div className="selection" style={box} /> : <div className="shade" />}
      {frame.mode === "point" && at && (
        <>
          <div className="cross-h" style={{ top: at.y }} />
          <div className="cross-v" style={{ left: at.x }} />
        </>
      )}
      {at && (box || frame.mode === "point") && (
        <div className="size" style={{ left: at.x + 14, top: at.y + 14 }}>
          {box ? `${Math.round(box.width * kx)} × ${Math.round(box.height * ky)}` : `${Math.round(at.x * kx)}, ${Math.round(at.y * ky)}`}
        </div>
      )}
      <div className="tip">
        <span>{texts[frame.mode]}</span>
        <span>
          <kbd>Esc</kbd> {texts.cancel}
        </span>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Picker />
  </StrictMode>,
);
