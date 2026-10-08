// A tool for the AI agent only: wildcard intents are not offered to it.
// No triggers and phrases: routing never picks it (score 0).
const { runCommand } = require("../../lib/command");
const state = require("../../lib/state");

const ACTIONS = {
  launch: ["launch_app", (target) => ({ op: "launch", objects: target ? [target] : [] })],
  close: ["close_app", (target) => (target ? { op: "close", objects: [target] } : { op: "close", objects: [], generic: "game" })],
  close_active: ["close_app", () => ({ op: "close", objects: [], generic: "active" })],
  shutdown: ["pc_power", () => ({ op: "shutdown" })],
  restart: ["pc_power", () => ({ op: "restart" })],
  sleep: ["pc_power", () => ({ op: "sleep" })],
  lock: ["pc_power", () => ({ op: "lock" })],
  display_off: ["pc_power", () => ({ op: "display_off" })],
  cancel_shutdown: ["pc_power", () => ({ op: "cancel" })],
  volume_up: ["pc_volume", () => ({ op: "up" })],
  volume_down: ["pc_volume", () => ({ op: "down" })],
  volume_set: ["pc_volume", () => ({ op: "set" })],
  mute: ["pc_volume", () => ({ op: "mute" })],
  unmute: ["pc_volume", () => ({ op: "unmute" })],
  media_play_pause: ["pc_media", () => ({ op: "toggle", key: "play_pause" })],
  media_pause: ["pc_media", () => ({ op: "pause", key: "play_pause" })],
  media_resume: ["pc_media", () => ({ op: "play", key: "play_pause" })],
  media_next: ["pc_media", () => ({ op: "next", key: "next" })],
  media_previous: ["pc_media", () => ({ op: "prev", key: "prev" })],
  search: ["pc_search", (target) => ({ op: "search", query: target, engine: "default" })],
  wake: ["pc_wake", () => ({ op: "wake" })],
  status: ["pc_status", () => ({})],
};

/** "игровой" → mention of that PC for the command pipeline */
const pcByName = (name, userId) => {
  const loaded = state.get();
  const text = String(name ?? "").trim().toLowerCase();

  if (!loaded || !text) return null;

  const words = text.split(/\s+/);
  const pool = loaded.index.pool(userId);

  if (["все", "всех", "all", "every"].includes(words[0])) return { ids: [], generic: true, all: true, words: text };

  for (let i = 0; i < words.length; i++) {
    const found = loaded.index.deviceNameAt(words, i, pool);

    if (found) return { ids: found.ids, generic: false, all: false, words: text };
  }

  return { ids: ["-"], generic: false, all: false, words: text };
};

module.exports = {
  id: "pc_control",
  label: "intents.pc_control.label",
  triggers: [],
  phrases: [],
  schema: {
    type: "object",
    required: ["action"],
    properties: {
      action: {
        type: "string",
        enum: Object.keys(ACTIONS),
        description: "What to do on the person's computer",
      },
      target: { type: "string", description: "App or game name for launch and close, the text to look up for search, otherwise empty" },
      computer: { type: "string", description: "Computer name if the person named it, otherwise empty" },
      value: { type: "string", description: "Volume percent for volume_set, delay in minutes for shutdown, restart, sleep; otherwise empty" },
    },
  },
  errorResponse: "intents.pc_control.error",
  handler: async (params, ctx, configs) => {
    const entry = Object.hasOwn(ACTIONS, String(params?.action)) ? ACTIONS[params.action] : null;

    if (!entry) return ctx.t("intents.pc_control.unknown");

    const [intent, build] = entry;
    const target = typeof params.target === "string" ? params.target.trim().slice(0, 200) : "";
    const value = Number(String(params.value ?? "").replace(",", "."));
    const userId = ctx.user?.id ? String(ctx.user.id) : null;
    const built = { ...build(target), pc: params.computer ? pcByName(params.computer, userId) : null };

    if (Number.isFinite(value) && String(params.value ?? "").trim()) {
      if (intent === "pc_volume") built.value = Math.min(100, Math.max(0, Math.round(value)));
      if (intent === "pc_power") built.delaySec = Math.max(0, Math.round(value * 60));
    }

    return runCommand(ctx, configs, intent, built, { via: "agent" });
  },
};
