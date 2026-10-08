import type { Language } from "../../shared/types";
import { emptyMatch, type CatalogApp } from "./types";

interface Builtin {
  id: string;
  names: Record<Language, string>;
  suggested: string[];
  launch: CatalogApp["launch"];
  exeNames: string[];
}

// Windows apps every PC has; their voice names come in both languages
const BUILTINS: Builtin[] = [
  { id: "virtual:browser", names: { ru: "Браузер", en: "Browser" }, suggested: ["браузер", "интернет", "browser"], launch: { type: "browser" }, exeNames: [] },
  { id: "virtual:explorer", names: { ru: "Проводник", en: "File Explorer" }, suggested: ["проводник", "файлы", "мой компьютер", "explorer"], launch: { type: "exe", path: "explorer.exe" }, exeNames: [] },
  { id: "virtual:taskmgr", names: { ru: "Диспетчер задач", en: "Task Manager" }, suggested: ["диспетчер задач", "диспетчер", "task manager"], launch: { type: "exe", path: "taskmgr.exe" }, exeNames: ["taskmgr.exe"] },
  { id: "virtual:calc", names: { ru: "Калькулятор", en: "Calculator" }, suggested: ["калькулятор", "calculator"], launch: { type: "exe", path: "calc.exe" }, exeNames: ["calculatorapp.exe", "calculator.exe", "calc.exe"] },
  { id: "virtual:notepad", names: { ru: "Блокнот", en: "Notepad" }, suggested: ["блокнот", "notepad"], launch: { type: "exe", path: "notepad.exe" }, exeNames: ["notepad.exe"] },
  { id: "virtual:paint", names: { ru: "Paint", en: "Paint" }, suggested: ["пэйнт", "паинт", "paint"], launch: { type: "exe", path: "mspaint.exe" }, exeNames: ["mspaint.exe"] },
  { id: "virtual:settings", names: { ru: "Параметры Windows", en: "Windows Settings" }, suggested: ["параметры", "настройки виндовс", "settings"], launch: { type: "url", url: "ms-settings:" }, exeNames: ["systemsettings.exe"] },
];

export function builtinApps(language: Language): CatalogApp[] {
  return BUILTINS.map((item) => ({
    id: item.id,
    name: item.names[language],
    kind: "app",
    source: "virtual",
    launch: item.launch,
    match: { ...emptyMatch(), names: item.exeNames },
    defaultEnabled: true,
    suggested: item.suggested,
    detail: item.launch.type === "exe" ? item.launch.path : item.launch.type === "url" ? item.launch.url : "",
    removable: false,
  }));
}
