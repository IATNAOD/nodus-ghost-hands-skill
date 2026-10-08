import { createHash } from "crypto";
import type { Helper } from "../system/helper";
import type { StartPick } from "../settings/defaults";
import { emptyMatch, type CatalogApp } from "./types";

// documentation, uninstallers and links that are not apps
const NOISE =
  /uninstall|удал(ить|ение)|readme|read me|\bhelp\b|справк|documentation|документац|manual|руководств|license|лиценз|release notes|новости в последней|website|web site|веб-сайт|changelog|support center|поддержк|what's new|getting started|user guide|reference|sample|\.txt$|\.ini$/i;

export interface StartApp {
  name: string;
  appId: string;
  target: string | null;
}

/** Start menu apps worth offering: no docs, uninstallers, web links, Steam and Epic shortcuts (scanned anyway). */
export async function listStartApps(helper: Helper): Promise<StartApp[]> {
  const items = await helper.call<{ name: string; appId: string; target: string | null }[]>("startapps.list", {}, 15000);
  const seen = new Set<string>();

  return items
    .filter((item) => item.name && item.appId && !NOISE.test(item.name) && !/^(https?|steam|com\.epicgames\.launcher):/i.test(item.appId))
    .filter((item) => (seen.has(item.appId) ? false : (seen.add(item.appId), true)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const startId = (appId: string): string => `start:${createHash("sha1").update(appId.toLowerCase()).digest("hex").slice(0, 12)}`;

const isExePath = (value: string | null): value is string => Boolean(value && /^[a-z]:\\.*\.exe$/i.test(value));

/** A Start menu app the person picked → catalog app (launched through its AppUserModelID). */
export function startApp(pick: StartPick): CatalogApp {
  const exe = isExePath(pick.target) ? pick.target : isExePath(pick.appId) ? pick.appId : null;

  return {
    id: startId(pick.appId),
    name: pick.name,
    kind: "app",
    source: "start",
    launch: { type: "aumid", appId: pick.appId },
    match: { ...emptyMatch(), exes: exe ? [exe] : [], aumids: exe ? [] : [pick.appId] },
    defaultEnabled: true,
    suggested: [],
    detail: exe ?? pick.appId,
    removable: true,
  };
}
