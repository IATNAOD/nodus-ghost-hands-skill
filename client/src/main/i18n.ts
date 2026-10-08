import type { Language } from "../shared/types";

// Texts of the main process: tray, countdown window, notifications, dialogs.
const TEXTS = {
  ru: {
    trayOpen: "Открыть Ghost Hands",
    trayOnline: "Подключено к NODUS",
    trayConnecting: "Подключение к NODUS…",
    trayOffline: "Нет связи с NODUS",
    trayUnpaired: "Не привязан к NODUS",
    trayAttention: "Нужно внимание: откройте приложение",
    trayPause: "Приостановить управление",
    trayResume: "Возобновить управление",
    trayQuit: "Выйти",
    trayParental: "Под родительским контролем",
    countdownShutdown: "Компьютер выключится",
    countdownRestart: "Компьютер перезагрузится",
    countdownSleep: "Компьютер уснёт",
    countdownBy: "по голосовой команде NODUS",
    countdownCancel: "Отмена",
    countdownSeconds: "через {s} с",
    pickExecutable: "Выберите программу или ярлык",
    filterPrograms: "Программы и ярлыки",
    updateReady: "Обновление Ghost Hands {v} готово",
    updateReadyBody: "Оно установится при выходе из приложения.",
    notifyTitle: "NODUS",
    scheduledShutdown: "Компьютер выключится в {t}",
    scheduledRestart: "Компьютер перезагрузится в {t}",
    scheduledSleep: "Компьютер уснёт в {t}",
    scheduledBody: "По голосовой команде. Скажите NODUS «отмени выключение», чтобы отменить.",
  },
  en: {
    trayOpen: "Open Ghost Hands",
    trayOnline: "Connected to NODUS",
    trayConnecting: "Connecting to NODUS…",
    trayOffline: "No connection to NODUS",
    trayUnpaired: "Not paired with NODUS",
    trayAttention: "Needs attention: open the app",
    trayPause: "Pause control",
    trayResume: "Resume control",
    trayQuit: "Quit",
    trayParental: "Under parental control",
    countdownShutdown: "The computer will shut down",
    countdownRestart: "The computer will restart",
    countdownSleep: "The computer will go to sleep",
    countdownBy: "by a NODUS voice command",
    countdownCancel: "Cancel",
    countdownSeconds: "in {s} s",
    pickExecutable: "Choose a program or a shortcut",
    filterPrograms: "Programs and shortcuts",
    updateReady: "Ghost Hands {v} is ready",
    updateReadyBody: "It installs when you quit the app.",
    notifyTitle: "NODUS",
    scheduledShutdown: "The computer will shut down at {t}",
    scheduledRestart: "The computer will restart at {t}",
    scheduledSleep: "The computer will go to sleep at {t}",
    scheduledBody: "By a voice command. Say \"cancel shutdown\" to NODUS to cancel.",
  },
} as const;

export type TextKey = keyof (typeof TEXTS)["ru"];

let language: Language = "ru";

export const setLanguage = (value: Language): void => {
  language = value;
};

export const getLanguage = (): Language => language;

export const t = (key: TextKey, vars: Record<string, string | number> = {}): string =>
  TEXTS[language][key].replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ""));

/** Countdown window texts for the current language */
export const countdownTexts = () => ({
  shutdown: t("countdownShutdown"),
  restart: t("countdownRestart"),
  sleep: t("countdownSleep"),
  by: t("countdownBy"),
  cancel: t("countdownCancel"),
  seconds: t("countdownSeconds"),
});
