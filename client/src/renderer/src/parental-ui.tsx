// Shared by the parental pages (notice.tsx, lock.tsx): texts, the "+N minutes" button, the PIN.
import { useEffect, useState } from "react";
import type { ParentalKind, ParentalPageState } from "../../shared/types";

const TEXTS = {
  ru: {
    gamesNear: "Игры: осталось {m} мин",
    gamesNearHint: "Сохранись: когда время выйдет, игры закроются.",
    pcNear: "Компьютер: осталось {m} мин",
    pcNearHint: "Когда время выйдет, экран закроется до завтра.",
    gamesOver: "Время игр на сегодня закончилось",
    gamesOverHint: "Игры закрываются. Остальным можно пользоваться.",
    pcOver: "Время за компьютером на сегодня закончилось",
    pcOverHint: "Компьютер не выключится: всё откроется завтра или после разрешения родителей.",
    extend: "+{n} мин",
    extendsLeft: "ещё {k}",
    noExtends: "Продлений на сегодня не осталось",
    parent: "Я родитель",
    pin: "PIN",
    unlock: "Снять ограничения",
    wrongPin: "Неверный PIN",
    wait: "Подождите {s} с",
    noPin: "PIN не задан: его задают в «Моих настройках» навыка в панели NODUS",
    hide: "Скрыть",
    ok: "Понятно",
    title: "Родительский контроль",
  },
  en: {
    gamesNear: "Games: {m} min left",
    gamesNearHint: "Save your game: when the time is over, games close.",
    pcNear: "Computer: {m} min left",
    pcNearHint: "When the time is over, the screen locks until tomorrow.",
    gamesOver: "Game time is over for today",
    gamesOverHint: "Games are closing. Everything else still works.",
    pcOver: "Computer time is over for today",
    pcOverHint: "The computer stays on: it opens tomorrow or when a parent allows.",
    extend: "+{n} min",
    extendsLeft: "{k} left",
    noExtends: "No extensions left today",
    parent: "I'm a parent",
    pin: "PIN",
    unlock: "Lift the limits",
    wrongPin: "Wrong PIN",
    wait: "Wait {s} s",
    noPin: "No PIN set: it is set in the skill's My settings in the NODUS panel",
    hide: "Hide",
    ok: "OK",
    title: "Parental control",
  },
};

export type ParentalTexts = (typeof TEXTS)["ru"];

export const texts: ParentalTexts = TEXTS[new URLSearchParams(location.search).get("lang") === "en" ? "en" : "ru"];

export const fill = (template: string, vars: Record<string, string | number>): string => template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ""));

/** The parental state, refreshed when the main process says it changed and every second. */
export function useParental(): ParentalPageState | null {
  const [state, setState] = useState<ParentalPageState | null>(null);

  useEffect(() => {
    const refresh = () => window.ghp.get().then(setState).catch(() => undefined);
    const timer = setInterval(refresh, 1000);
    const off = window.ghp.onState(refresh);

    refresh();
    return () => {
      clearInterval(timer);
      off();
    };
  }, []);

  return state;
}

export function ExtendButton({ kind, state }: { kind: ParentalKind; state: ParentalPageState }) {
  const status = state.status?.[kind];
  const [busy, setBusy] = useState(false);

  if (!status || status.limitSec === null) return null;
  if (status.extendsLeft <= 0) return <p className="hint">{texts.noExtends}</p>;

  return (
    <button
      type="button"
      className="primary"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await window.ghp.extend(kind).catch(() => false);
        setBusy(false);
      }}
    >
      {fill(texts.extend, { n: status.extendMinutes })} <span className="muted-on-accent">· {fill(texts.extendsLeft, { k: status.extendsLeft })}</span>
    </button>
  );
}

/** "I'm a parent": the PIN lifts the limits for the time the owner set. */
export function PinForm({ state, open, onOpen }: { state: ParentalPageState; open: boolean; onOpen: (open: boolean) => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button type="button" className="link" onClick={() => onOpen(true)}>
        {texts.parent}
      </button>
    );
  }

  if (!state.pinSet) return <p className="error">{texts.noPin}</p>;

  const wait = state.waitSec > 0 ? fill(texts.wait, { s: state.waitSec }) : null;

  return (
    <form
      className="pin"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!pin || busy) return;
        setBusy(true);

        const result = await window.ghp.unlock(pin).catch(() => ({ ok: false, waitSec: 0 }));

        setBusy(false);
        setPin("");
        setError(result.ok ? null : result.waitSec > 0 ? fill(texts.wait, { s: result.waitSec }) : texts.wrongPin);
      }}
    >
      <input
        autoFocus
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={12}
        placeholder={texts.pin}
        value={pin}
        disabled={Boolean(wait)}
        onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
      />
      <button type="submit" className="secondary" disabled={!pin || busy || Boolean(wait)}>
        {texts.unlock}
      </button>
      {(wait || error) && <p className="error">{wait ?? error}</p>}
    </form>
  );
}

export const minutesLeft = (seconds: number | null | undefined): number => Math.max(1, Math.ceil((seconds ?? 0) / 60));
