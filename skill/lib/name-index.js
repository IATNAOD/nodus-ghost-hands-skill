/**
 * In-memory index of PCs and their apps for routing and command handling.
 * match() of wildcard intents is synchronous and runs on every phrase, so
 * everything spoken is compared with names prepared here in advance.
 * Shared by the skill and the client ("check a phrase"): pure CommonJS.
 */
"use strict";

const { stemWord } = require("./nodus-routing");
const { prepare, prepareApp, scoreApp, decide, appKey } = require("./names");
const { PC_WORDS } = require("./text");

const EMPTY_STATE = Object.freeze({ running: [], volume: null, muted: null, shutdownAt: null });

const levenshtein = (a, b) => {
  let previous = [...Array(b.length + 1).keys()];

  for (let i = 1; i <= a.length; i++) {
    const current = [i];

    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0));
    }
    previous = current;
  }

  return previous[b.length];
};

/** A spoken word against a word of a PC name: same stem, a typo in a long stem. */
const sameWord = (spoken, token) => {
  if (token.num !== null) return Number(spoken) === token.num;

  const stem = stemWord(spoken);

  return stem === token.stem || spoken === token.word || (token.stem.length >= 5 && levenshtein(stem, token.stem) <= 1);
};

/** Words of a PC name to look for: "Игровой компьютер" → [игровой] (+ optional "компьютер"). */
const nameVariant = (text) => {
  const tokens = prepare(text);
  const required = tokens.filter((token) => !PC_WORDS.has(token.word));

  // a PC called just "Ноутбук" is found by that word
  return tokens.length ? { text, tokens: required.length ? required : tokens } : null;
};

class NameIndex {
  constructor() {
    /** @type {Map<string, object>} */
    this.devices = new Map();
    this.version = 0;
  }

  /**
   * Add or replace a PC from its stored record or a fresh config.
   * @param {{ deviceId: string, userId: string, userName?: string, config?: object, online?: boolean, lastSeenAt?: Date|number }} record
   */
  upsert(record) {
    const previous = this.devices.get(record.deviceId);
    const config = record.config ?? {};
    const apps = (config.apps ?? []).map(prepareApp);

    dropSharedAutoAliases(apps);

    const entry = {
      deviceId: record.deviceId,
      userId: String(record.userId),
      userName: record.userName ?? previous?.userName ?? "",
      name: config.name || previous?.name || "",
      aliases: config.aliases ?? [],
      shared: Boolean(config.shared),
      features: config.features ?? {},
      prefs: config.prefs ?? {},
      wol: config.wol ?? null,
      client: config.client ?? {},
      apps,
      appById: new Map(apps.map((app) => [app.id, app])),
      names: [config.name, ...(config.aliases ?? [])].filter(Boolean).map(nameVariant).filter(Boolean),
      online: record.online ?? previous?.online ?? false,
      lastSeenAt: record.lastSeenAt ? new Date(record.lastSeenAt).getTime() : previous?.lastSeenAt ?? 0,
      state: previous?.state ?? EMPTY_STATE,
      running: previous?.running ?? [],
    };

    this.devices.set(record.deviceId, entry);
    this.version++;

    return entry;
  }

  setOnline(deviceId, online) {
    const entry = this.devices.get(deviceId);

    if (!entry) return;
    entry.online = online;
    entry.lastSeenAt = Date.now();
    if (!online) {
      entry.state = EMPTY_STATE;
      entry.running = [];
    }
    this.version++;
  }

  /** Live state: running apps are prepared for "закрой <name>". */
  setState(deviceId, state) {
    const entry = this.devices.get(deviceId);

    if (!entry) return;
    entry.state = state ?? EMPTY_STATE;
    entry.running = (state?.running ?? []).map((item) => ({
      ...item,
      prepared: item.appId && entry.appById.has(item.appId) ? entry.appById.get(item.appId) : prepareApp({ id: `run:${item.key}`, name: item.name }),
    }));
    this.version++;
  }

  remove(deviceId) {
    if (this.devices.delete(deviceId)) this.version++;
  }

  get(deviceId) {
    return this.devices.get(deviceId) ?? null;
  }

  all() {
    return [...this.devices.values()];
  }

  /**
   * PCs a person may use: own first, then shared ones of others.
   * @param {string|null} userId null - everyone's PCs (the speaker is not known yet)
   * @param {{ sharedOnly?: boolean }} options
   */
  pool(userId, { sharedOnly = false } = {}) {
    const all = this.all();

    if (sharedOnly) return all.filter((device) => device.shared);
    if (userId === null || userId === undefined) return all;

    const id = String(userId);

    return [...all.filter((device) => device.userId === id), ...all.filter((device) => device.userId !== id && device.shared)];
  }

  /**
   * PC named at words[from]: the longest name of a PC from the pool.
   * @returns {{ end: number, ids: string[] } | null}
   */
  deviceNameAt(words, from, pool) {
    let best = null;

    for (const device of pool) {
      for (const variant of device.names) {
        const { tokens } = variant;
        let ok = true;

        for (let k = 0; k < tokens.length; k++) {
          if (!words[from + k] || !sameWord(words[from + k], tokens[k])) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;

        const end = from + tokens.length;

        if (!best || end > best.end) best = { end, ids: [device.deviceId] };
        else if (end === best.end && !best.ids.includes(device.deviceId)) best.ids.push(device.deviceId);
      }
    }

    return best;
  }

  /**
   * Apps that match a spoken object on the given PCs.
   * @param {string} spoken "доту", "ведьмака три"
   * @param {object[]} devices
   * @param {{ running?: boolean, configured?: boolean }} options running - also apps open now
   * @returns {{ status: string, best: object|null, options: object[], candidates: object[] }}
   */
  matchApps(spoken, devices, { running = false, configured = true } = {}) {
    const tokens = prepare(spoken);
    const candidates = [];

    if (!tokens.length) return { status: "none", best: null, options: [], candidates };

    for (const device of devices) {
      if (configured) {
        for (const app of device.apps) {
          const { score, coverage } = scoreApp(tokens, app);

          if (score >= 0.6) candidates.push({ key: appKey(app.name), deviceId: device.deviceId, appId: app.id, runningKey: null, name: app.name, app, score, coverage, kind: app.kind });
        }
      }
      if (running) {
        for (const item of device.running) {
          const { score, coverage } = scoreApp(tokens, item.prepared);

          if (score < 0.6) continue;
          candidates.push({
            key: appKey(item.appId ? (device.appById.get(item.appId)?.name ?? item.name) : item.name),
            deviceId: device.deviceId,
            appId: item.appId,
            runningKey: item.key,
            name: item.appId ? (device.appById.get(item.appId)?.name ?? item.name) : item.name,
            app: item.appId ? device.appById.get(item.appId) ?? null : null,
            // an app that is open right now is a better guess for "закрой"
            score: Math.min(1, score + 0.02),
            coverage,
            kind: item.game ? "game" : "app",
            running: true,
          });
        }
      }
    }

    return { ...decide(candidates), candidates };
  }
}

/** Automatic aliases shared by two apps of one PC say nothing ("Deep Rock Galactic" ×2). */
function dropSharedAutoAliases(apps) {
  const count = new Map();
  const keyOf = (variant) => variant.tokens.map((token) => token.word).join(" ");

  for (const app of apps) for (const variant of app.variants) if (variant.source === "auto") count.set(keyOf(variant), (count.get(keyOf(variant)) ?? 0) + 1);
  for (const app of apps) app.variants = app.variants.filter((variant) => variant.source !== "auto" || count.get(keyOf(variant)) === 1);
}

module.exports = { NameIndex, sameWord, levenshtein };
