/**
 * Wire protocol between the Ghost Hands skill (server) and the PC client.
 * Shared by the skill and the Electron client: plain CommonJS, no Node APIs.
 * A change here goes together with docs/protocol.md and both sides.
 */
"use strict";

const PROTO = 1;
const PROTO_MIN = 1;
const PROTO_MAX = 1;
const WS_PATH = "/gh";
const DEFAULT_PORT = 47300;
const DEFAULT_HOST = "project-nod.local";

const MSG = Object.freeze({
  HELLO: "hello",
  WELCOME: "welcome",
  CONFIG: "config",
  CONFIG_ACK: "config-ack",
  STATE: "state",
  CMD: "cmd",
  RESULT: "result",
  LEARN: "learn",
  SETTINGS: "settings",
  BYE: "bye",
});

const CLOSE = Object.freeze({
  GOING_AWAY: 1001,
  BAD_REQUEST: 4000,
  REPLACED: 4001,
  AUTH_FAILED: 4003,
  UNPAIRED: 4004,
  NAME_TAKEN: 4006,
  RATE_LIMITED: 4008,
  PROTO_UNSUPPORTED: 4010,
  SERVER_ERROR: 4011,
});

const FEATURES = Object.freeze(["launch", "close", "volume", "media", "power", "lock", "display", "search", "wake", "toast"]);

/** action → feature that must be enabled on the PC */
const ACTIONS = Object.freeze({
  "app.launch": "launch",
  "app.close": "close",
  "volume.get": "volume",
  "volume.set": "volume",
  "volume.change": "volume",
  "volume.mute": "volume",
  "media.key": "media",
  "power.shutdown": "power",
  "power.restart": "power",
  "power.sleep": "power",
  "power.cancel": "power",
  "power.lock": "lock",
  "display.off": "display",
  "web.search": "search",
  "toast.show": "toast",
});

const RESULT_CODES = Object.freeze([
  "app-not-found",
  "launcher-missing",
  "launch-failed",
  "needs-elevation",
  "cancelled",
  "not-running",
  "ambiguous",
  "close-timeout",
  "feature-disabled",
  "paused",
  "helper-unavailable",
  "no-audio-device",
  "invalid-args",
  "unknown-action",
  "busy",
  "internal",
  // produced by the server, never by the client
  "timeout",
  "disconnected",
  "offline",
]);

const MEDIA_KEYS = Object.freeze(["play_pause", "next", "prev"]);
const SEARCH_ENGINES = Object.freeze(["google", "yandex", "bing", "duckduckgo", "youtube"]);
const APP_KINDS = Object.freeze(["game", "app", "site"]);
const APP_SOURCES = Object.freeze(["steam", "epic", "gog", "start", "custom", "url", "virtual"]);
const WOL_ADAPTERS = Object.freeze(["ethernet", "wifi", "other"]);

const LIMITS = Object.freeze({
  apps: 600,
  appAliases: 16,
  aliasLength: 64,
  appName: 120,
  appId: 120,
  deviceName: 40,
  deviceAliases: 8,
  running: 100,
  runningKey: 300,
  searchQuery: 300,
  toastTitle: 80,
  toastText: 300,
  clientPayload: 1024 * 1024,
  serverPayload: 256 * 1024,
});

const DEFAULT_FEATURES = Object.freeze(Object.fromEntries(FEATURES.map((name) => [name, true])));

const DEFAULT_PREFS = Object.freeze({
  confirmPower: true,
  searchEngine: "google",
  volumeStep: 10,
  forceCloseSec: 0,
  shareRunning: true,
  paused: false,
});

const APP_ID_RE = /^(steam|epic|gog|start|custom|url|virtual):[A-Za-z0-9._~%:+-]{1,110}$/;
const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/* ── key format: GH-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX, Crockford base32, 120 bits ── */

const KEY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const KEY_BODY_LENGTH = 24;

/** Canonical key or null: any case, spaces and dashes are allowed; I/L → 1, O → 0. */
const normalizeKey = (input) => {
  let body = String(input ?? "").toUpperCase().replace(/[\s\-_]/g, "");

  if (!body.startsWith("GH")) return null;
  body = body.slice(2).replace(/[IL]/g, "1").replace(/O/g, "0");
  if (body.length !== KEY_BODY_LENGTH || [...body].some((char) => !KEY_ALPHABET.includes(char))) return null;

  return `GH-${body.match(/.{4}/g).join("-")}`;
};

/* ── sanitizers: everything from the network is untrusted ── */

const CONTROL_RE = /[\u0000-\u001f\u007f]+/g;

const str = (value, max) => (typeof value === "string" ? value.replace(CONTROL_RE, " ").trim().slice(0, max) : "");
const bool = (value, fallback) => (typeof value === "boolean" ? value : fallback);
const int = (value, min, max, fallback) => {
  if (value === null || value === "" || typeof value === "boolean") return fallback;
  const number = Number(value);

  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
};
const strings = (value, maxItems, maxLength) =>
  Array.isArray(value) ? [...new Set(value.map((item) => str(item, maxLength)).filter(Boolean))].slice(0, maxItems) : [];
const oneOf = (value, list, fallback) => (list.includes(value) ? value : fallback);

const sanitizeApp = (raw) => {
  if (!raw || typeof raw !== "object") return null;

  const id = str(raw.id, LIMITS.appId);
  const name = str(raw.name, LIMITS.appName);

  if (!APP_ID_RE.test(id) || !name) return null;

  return {
    id,
    name,
    aliases: strings(raw.aliases, LIMITS.appAliases, LIMITS.aliasLength),
    spoken: str(raw.spoken, LIMITS.aliasLength),
    kind: oneOf(raw.kind, APP_KINDS, "app"),
    source: oneOf(raw.source, APP_SOURCES, id.split(":")[0]),
  };
};

const sanitizeWol = (raw) => {
  if (!raw || typeof raw !== "object") return null;

  const mac = str(raw.mac, 17).toLowerCase().replace(/-/g, ":");
  const broadcast = str(raw.broadcast, 15);

  if (!MAC_RE.test(mac) || mac === "00:00:00:00:00:00" || !IPV4_RE.test(broadcast)) return null;

  return { mac, broadcast, adapter: oneOf(raw.adapter, WOL_ADAPTERS, "other") };
};

/**
 * Full PC configuration sent by the client in `config.data`.
 * @returns {{ ok: true, config: object } | { ok: false, error: string }}
 */
const sanitizeConfig = (raw) => {
  if (!raw || typeof raw !== "object") return { ok: false, error: "config-invalid" };

  const name = str(raw.name, LIMITS.deviceName);

  if (!name) return { ok: false, error: "name-invalid" };

  const seen = new Set();
  const apps = [];

  for (const item of Array.isArray(raw.apps) ? raw.apps : []) {
    const app = sanitizeApp(item);

    if (!app || seen.has(app.id)) continue;
    seen.add(app.id);
    apps.push(app);
    if (apps.length >= LIMITS.apps) break;
  }

  const rawFeatures = raw.features && typeof raw.features === "object" ? raw.features : {};
  const rawPrefs = raw.prefs && typeof raw.prefs === "object" ? raw.prefs : {};
  const rawClient = raw.client && typeof raw.client === "object" ? raw.client : {};

  return {
    ok: true,
    config: {
      name,
      aliases: strings(raw.aliases, LIMITS.deviceAliases, LIMITS.deviceName),
      shared: bool(raw.shared, false),
      apps,
      features: Object.fromEntries(FEATURES.map((feature) => [feature, bool(rawFeatures[feature], DEFAULT_FEATURES[feature])])),
      prefs: {
        confirmPower: bool(rawPrefs.confirmPower, DEFAULT_PREFS.confirmPower),
        searchEngine: oneOf(rawPrefs.searchEngine, SEARCH_ENGINES, DEFAULT_PREFS.searchEngine),
        volumeStep: int(rawPrefs.volumeStep, 1, 50, DEFAULT_PREFS.volumeStep),
        forceCloseSec: int(rawPrefs.forceCloseSec, 0, 60, DEFAULT_PREFS.forceCloseSec),
        shareRunning: bool(rawPrefs.shareRunning, DEFAULT_PREFS.shareRunning),
        paused: bool(rawPrefs.paused, DEFAULT_PREFS.paused),
      },
      wol: sanitizeWol(raw.wol),
      client: { version: str(rawClient.version, 32), os: str(rawClient.os, 64) },
    },
  };
};

/** Live PC state sent by the client in `state.data`. */
const sanitizeState = (raw) => {
  const data = raw && typeof raw === "object" ? raw : {};
  const running = [];

  for (const item of Array.isArray(data.running) ? data.running : []) {
    if (!item || typeof item !== "object") continue;

    const key = str(item.key, LIMITS.runningKey);
    const name = str(item.name, LIMITS.appName);

    if (!key || !name) continue;
    running.push({
      key,
      name,
      appId: APP_ID_RE.test(str(item.appId, LIMITS.appId)) ? str(item.appId, LIMITS.appId) : null,
      game: bool(item.game, false),
      fg: bool(item.fg, false),
    });
    if (running.length >= LIMITS.running) break;
  }

  const shutdownAt = Number(data.shutdownAt);

  return {
    running,
    volume: int(data.volume, 0, 100, null),
    muted: typeof data.muted === "boolean" ? data.muted : null,
    shutdownAt: Number.isFinite(shutdownAt) && shutdownAt > 0 ? shutdownAt : null,
  };
};

/** Device part of `hello` (first message of every connection). */
const sanitizeHelloDevice = (raw) => {
  const data = raw && typeof raw === "object" ? raw : {};

  return {
    name: str(data.name, LIMITS.deviceName),
    aliases: strings(data.aliases, LIMITS.deviceAliases, LIMITS.deviceName),
    machineHash: /^[0-9a-f]{16,64}$/.test(str(data.machineHash, 64)) ? str(data.machineHash, 64) : "",
    os: str(data.os, 64),
    host: str(data.host, 64),
    client: str(data.client, 32),
  };
};

const isFeatureEnabled = (features, action) => {
  const feature = ACTIONS[action];

  return Boolean(feature) && features?.[feature] !== false;
};

/** JSON frame; unknown fields are ignored by the receiver. */
const encode = (type, fields = {}) => JSON.stringify({ t: type, ...fields });

/** Parsed frame or null (never throws). */
const decode = (raw) => {
  try {
    const text = typeof raw === "string" ? raw : typeof raw?.toString === "function" ? raw.toString("utf8") : "";
    const message = JSON.parse(text);

    return message && typeof message === "object" && typeof message.t === "string" ? message : null;
  } catch {
    return null;
  }
};

module.exports = {
  PROTO,
  PROTO_MIN,
  PROTO_MAX,
  WS_PATH,
  DEFAULT_PORT,
  DEFAULT_HOST,
  MSG,
  CLOSE,
  FEATURES,
  ACTIONS,
  RESULT_CODES,
  MEDIA_KEYS,
  SEARCH_ENGINES,
  APP_KINDS,
  APP_SOURCES,
  LIMITS,
  DEFAULT_FEATURES,
  DEFAULT_PREFS,
  APP_ID_RE,
  KEY_ALPHABET,
  KEY_BODY_LENGTH,
  normalizeKey,
  sanitizeApp,
  sanitizeConfig,
  sanitizeState,
  sanitizeHelloDevice,
  sanitizeWol,
  isFeatureEnabled,
  encode,
  decode,
};
