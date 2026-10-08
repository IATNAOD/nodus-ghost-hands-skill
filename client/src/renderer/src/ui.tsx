import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

/** The ghost hand: brand gradient, dark face */
export function Logo({ size = 34 }: { size?: number }) {
  const id = useId();

  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ad67ff" />
          <stop offset="1" stopColor="#ff9a4d" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${id})`}
        d="M10 42V20a14 14 0 0 1 28 0v22l-4.67-4-4.66 4-4.67-4-4.67 4-4.66-4z"
      />
      <circle cx="18.5" cy="21" r="3" fill="#140c20" />
      <circle cx="29.5" cy="21" r="3" fill="#140c20" />
      <path d="M19.67 28.5a5 5 0 0 0 8.66 0" stroke="#140c20" strokeWidth="2.4" fill="none" strokeLinecap="round" />
    </svg>
  );
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; small?: boolean };

export function Button({ variant = "secondary", small, className = "", ...props }: ButtonProps) {
  return <button type="button" className={`btn btn-${variant}${small ? " btn-sm" : ""} ${className}`} {...props} />;
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; label?: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className="switch" onClick={() => onChange(!checked)} />;
}

export function SwitchRow({ title, hint, checked, onChange, disabled }: { title: string; hint?: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return (
    <div className="switch-row">
      <div className="text">
        <span className="title">{title}</span>
        {hint && <span className="hint">{hint}</span>}
      </div>
      <Switch checked={checked} onChange={onChange} disabled={disabled} label={title} />
    </div>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small className="hint">{hint}</small>}
      {error && <small className="error">{error}</small>}
    </label>
  );
}

export function Card({ title, icon, children, className = "" }: { title?: string; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {title && (
        <h2>
          {icon}
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}

/** Number input that saves on blur or Enter, inside limits */
export function NumberInput({ value, min, max, onCommit }: { value: number; min: number; max: number; onCommit: (value: number) => void }) {
  const [text, setText] = useState(String(value));

  useEffect(() => setText(String(value)), [value]);

  const commit = () => {
    const number = Math.min(max, Math.max(min, Math.round(Number(text))));

    if (Number.isFinite(number) && number !== value) onCommit(number);
    else setText(String(value));
  };

  return (
    <input
      className="input"
      style={{ maxWidth: 120 }}
      inputMode="numeric"
      value={text}
      onChange={(event) => setText(event.target.value.replace(/[^\d]/g, ""))}
      onBlur={commit}
      onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
    />
  );
}

/** Voice names as chips: Enter or comma adds, × removes */
export function ChipsEditor({
  values,
  onChange,
  placeholder,
  learned = [],
  warnings = {},
}: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
  learned?: string[];
  warnings?: Record<string, string>;
}) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const parts = draft
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

    if (parts.length) onChange([...new Set([...values, ...parts])]);
    setDraft("");
  };

  return (
    <div className="chips">
      {values.map((value) => (
        <span key={value} className={`chip${learned.includes(value) ? " learned" : ""}${warnings[value] ? " warn" : ""}`} title={warnings[value]}>
          {warnings[value] ? "⚠ " : ""}
          {value}
          <button type="button" aria-label="×" onClick={() => onChange(values.filter((item) => item !== value))}>
            <X size={12} />
          </button>
        </span>
      ))}
      <input
        className="chip-input"
        value={draft}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            add();
          }
        }}
        onBlur={add}
      />
    </div>
  );
}

/** Native <dialog>: focus, Esc and the backdrop come from the browser */
export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;

    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={ref} className="modal" onClose={onClose} onClick={(event) => event.target === ref.current && onClose()}>
      <div className="modal-body">
        <div className="row">
          <h2 style={{ fontSize: 17 }}>{title}</h2>
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose} aria-label="×">
            <X />
          </Button>
        </div>
        {open && children}
      </div>
    </dialog>
  );
}

type Toast = { id: number; level: "success" | "error" | "info"; text: string };

const ToastContext = createContext<(level: Toast["level"], text: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const push = useCallback((level: Toast["level"], text: string) => {
    const id = ++counter.current;

    setToasts((list) => [...list, { id, level, text }]);
    setTimeout(() => setToasts((list) => list.filter((toast) => toast.id !== id)), 3500);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.level}`}>
            {toast.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
