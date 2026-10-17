// A frozen picture of one monitor, or a picture from a file or the clipboard: the person draws
// a sample or an area, or clicks a point. Coordinates go back in the picture's pixels.
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
  /** a picture, not the screen: Enter takes all of it */
  whole?: boolean;
  lang: string;
}

type Result = { x: number; y: number; w?: number; h?: number };

declare global {
  interface Window {
    ghk: {
      init(): Promise<Frame>;
      done(result: Result): Promise<void>;
      cancel(): Promise<void>;
    };
  }
}

type Pos = { x: number; y: number };

/** at least this many pixels of the picture each way */
const MIN_SIZE = 4;

const viewport = () => ({ w: window.innerWidth, h: window.innerHeight });

function Picker() {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [view, setView] = useState(viewport);
  const [start, setStart] = useState<Pos | null>(null);
  const [at, setAt] = useState<Pos | null>(null);
  const finished = useRef(false);

  const finish = (result: Result | null) => {
    if (finished.current) return;
    finished.current = true;
    void (result ? window.ghk.done(result) : window.ghk.cancel());
  };

  useEffect(() => {
    window.ghk.init().then(setFrame).catch(() => undefined);
    const resize = () => setView(viewport());
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish(null);
      if (event.key === "Enter" && frame?.whole) finish({ x: 0, y: 0, w: frame.w, h: frame.h });
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [frame]);

  if (!frame) return <div className="picker" />;

  const texts = TEXTS[(frame.lang === "en" ? "en" : "ru") as Language].sc.picker;
  // the picture fits the window keeping its proportions (a monitor fills it exactly)
  const scale = Math.min(view.w / frame.w, view.h / frame.h);
  const shown = { left: (view.w - frame.w * scale) / 2, top: (view.h - frame.h * scale) / 2, width: frame.w * scale, height: frame.h * scale };
  const pos = (event: React.MouseEvent): Pos => ({
    x: Math.max(shown.left, Math.min(shown.left + shown.width, event.clientX)),
    y: Math.max(shown.top, Math.min(shown.top + shown.height, event.clientY)),
  });
  // window pixels -> pixels of the picture
  const px = (x: number) => Math.round((x - shown.left) / scale);
  const py = (y: number) => Math.round((y - shown.top) / scale);
  const box = start && at ? { left: Math.min(start.x, at.x), top: Math.min(start.y, at.y), width: Math.abs(at.x - start.x), height: Math.abs(at.y - start.y) } : null;

  return (
    <div
      className={`picker${frame.whole ? " windowed" : ""}`}
      onContextMenu={(event) => {
        event.preventDefault();
        setStart(null);
      }}
      onMouseDown={(event) => {
        if (event.button !== 0 || frame.mode === "point") return;
        setStart(pos(event));
        setAt(pos(event));
      }}
      onMouseMove={(event) => setAt(pos(event))}
      onMouseUp={(event) => {
        if (event.button !== 0) return;
        const end = pos(event);
        if (frame.mode === "point") {
          finish({ x: px(end.x), y: py(end.y) });
          return;
        }
        if (!start) return;
        const x = px(Math.min(start.x, end.x));
        const y = py(Math.min(start.y, end.y));
        const w = px(Math.max(start.x, end.x)) - x;
        const h = py(Math.max(start.y, end.y)) - y;
        setStart(null);
        if (w >= MIN_SIZE && h >= MIN_SIZE) finish({ x, y, w, h });
      }}
    >
      <img src={`data:image/jpeg;base64,${frame.image}`} alt="" draggable={false} style={{ ...shown, imageRendering: scale > 1 ? "pixelated" : "auto" }} />
      {box ? <div className="selection" style={box} /> : <div className="shade" />}
      {frame.mode === "point" && at && (
        <>
          <div className="cross-h" style={{ top: at.y }} />
          <div className="cross-v" style={{ left: at.x }} />
        </>
      )}
      {at && (box || frame.mode === "point") && (
        <div className="size" style={{ left: at.x + 14, top: at.y + 14 }}>
          {box ? `${px(box.left + box.width) - px(box.left)} × ${py(box.top + box.height) - py(box.top)}` : `${px(at.x)}, ${py(at.y)}`}
        </div>
      )}
      <div className="tip">
        <span>{texts[frame.mode]}</span>
        {frame.whole && (
          <span>
            <kbd>Enter</kbd> {texts.whole.toLowerCase()}
          </span>
        )}
        <span>
          <kbd>Esc</kbd> {texts.cancel}
        </span>
      </div>
      {frame.whole && (
        <button type="button" className="whole" onMouseDown={(event) => event.stopPropagation()} onClick={() => finish({ x: 0, y: 0, w: frame.w, h: frame.h })}>
          {texts.whole}
        </button>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Picker />
  </StrictMode>,
);
