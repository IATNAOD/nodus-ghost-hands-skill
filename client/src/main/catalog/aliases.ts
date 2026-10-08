import { appKey } from "@skill/names.js";
import dictionary from "../../../resources/aliases.json";

/** Voice names from resources/aliases.json: by id, or by the name, its start or its end. */
export function dictionaryAliases(app: { id: string; name: string }): string[] {
  const ids = (dictionary.ids as Record<string, string[]>)[app.id] ?? [];
  const key = appKey(app.name);
  const byName = Object.entries(dictionary.names as Record<string, string[]>)
    .filter(([name]) => key === name || key.startsWith(`${name} `) || key.endsWith(` ${name}`))
    .flatMap(([, list]) => list);

  return [...new Set([...ids, ...byName].map((item) => item.trim()).filter(Boolean))];
}
