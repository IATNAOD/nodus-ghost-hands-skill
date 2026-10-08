/**
 * Who gives a command and which PC it goes to.
 *
 * The speaker is the person whose voice profile matched (or the only user);
 * an unknown voice is asked "Кто это?" (setting unknown_voice). PCs belong to
 * the person whose key paired them; shared PCs belong to everyone.
 * A PC is chosen without a question when it is named, when it is the only one
 * that can do the command, or when it was chosen in the last 2 minutes.
 */
"use strict";

const { wordsOf, ordinalOf } = require("./text");
const { answerKind, isCancel } = require("./confirm");

const RECENT_MS = 120_000;
// a question waits 20 s by default, and game sounds keep the microphone open that long:
// while a command runs, NODUS does not listen for its wake word
const ASK_TIMEOUT_MS = 10_000;
const ALL_ANSWERS = new Set(["все", "всех", "оба", "обоих", "обе", "везде", "all", "both", "everywhere"]);

const denied = (answer) => ({ ok: false, answer });

/** Last PC chosen by each person: a series of commands goes to the same PC. */
class RecentChoices {
  constructor() {
    this.items = new Map();
  }

  remember(userId, deviceId) {
    this.items.set(String(userId ?? ""), { deviceId, at: Date.now() });
  }

  recent(userId) {
    const item = this.items.get(String(userId ?? ""));

    return item && Date.now() - item.at < RECENT_MS ? item.deviceId : null;
  }
}

/**
 * @param {object} ctx request ctx of handler
 * @param {ReturnType<import("./settings").readSettings>} settings
 * @param {{ power?: boolean, index: import("./name-index").NameIndex }} options power - shutdown, restart, sleep
 * @returns {Promise<{ ok: true, userId: string|null, sharedOnly: boolean } | { ok: false, answer: string }>}
 */
async function resolveActor(ctx, settings, { power = false, index }) {
  const audience = ctx.user?.audience;

  if (audience === "child" && (settings.children === "deny" || (power && settings.children === "no_power"))) {
    return denied(ctx.t("common.child_denied"));
  }
  if (audience === "guest") {
    return settings.guestsShared ? { ok: true, userId: null, sharedOnly: true } : denied(ctx.t("common.guest_denied"));
  }

  let userId = ctx.user?.id ? String(ctx.user.id) : null;

  if (!userId) {
    if (settings.unknownVoice === "deny") return denied(ctx.t("common.unknown_denied"));
    if (settings.unknownVoice === "shared") return { ok: true, userId: null, sharedOnly: true };

    const devices = index.all();

    // "Кто это?" only when someone's personal PC can be meant
    if (devices.some((device) => !device.shared)) {
      const who = typeof ctx.user?.require === "function" ? await ctx.user.require().catch(() => null) : null;

      if (who?.userId) userId = String(who.userId);
    }
    if (!userId) {
      return devices.some((device) => device.shared) ? { ok: true, userId: null, sharedOnly: true } : denied(ctx.t("common.who_unknown"));
    }
  }

  if (settings.voiceCheck === "all" || (power && settings.voiceCheck === "power")) {
    const verified = typeof ctx.user?.requireVerified === "function" ? await ctx.user.requireVerified().catch(() => null) : null;

    // NODUS has already said why
    if (!verified) return { ok: false, answer: "" };
    userId = String(verified.userId);
  }

  return { ok: true, userId, sharedOnly: false };
}

/** Which PCs of the list the answer names: by name, "второй", "все", or none. */
function pcsFromAnswer(text, candidates, index, allowAll) {
  const words = wordsOf(text);

  if (allowAll && words.some((word) => ALL_ANSWERS.has(word))) return candidates;

  for (let i = 0; i < words.length; i++) {
    const named = index.deviceNameAt(words, i, candidates);

    if (named) return candidates.filter((device) => named.ids.includes(device.deviceId)).slice(0, 1);
  }

  const ordinal = ordinalOf(text);

  if (ordinal && candidates[ordinal - 1]) return [candidates[ordinal - 1]];

  return [];
}

/**
 * Choose PCs for a command.
 * @param {object} ctx request ctx
 * @param {object} options
 * @param {import("./name-index").NameIndex} options.index
 * @param {{ userId: string|null, sharedOnly: boolean }} options.actor
 * @param {object|null} options.pc PC mention from the phrase: { ids, generic, all, words }
 * @param {boolean} [options.needOnline] false - offline PCs too (Wake-on-LAN)
 * @param {string} [options.feature] feature the PC must have enabled
 * @param {(device: object) => boolean} [options.able] only PCs that can do it (have the app)
 * @param {boolean} [options.allowAll] "на всех компьютерах" is allowed
 * @param {RecentChoices} [options.recent]
 * @param {boolean} [options.askEveryTime]
 * @returns {Promise<{ ok: true, devices: object[], pool: object[] } | { ok: false, answer: string, offline?: object, pool?: object[] }>}
 */
async function choosePc(ctx, { index, actor, pc, needOnline = true, feature, able, allowAll = false, recent, askEveryTime = false }) {
  const pool = index.pool(actor.userId, { sharedOnly: actor.sharedOnly });

  if (!pool.length) return { ok: false, answer: ctx.t(actor.sharedOnly ? "common.no_shared_pcs" : "common.no_pcs"), pool };

  let candidates = pool;

  if (pc?.ids?.length) {
    const named = pool.filter((device) => pc.ids.includes(device.deviceId));
    const own = named.filter((device) => device.userId === actor.userId);

    candidates = own.length ? own : named;
    if (!candidates.length) return { ok: false, answer: ctx.t("common.pc_not_found", { name: pc.words ?? "" }), pool };
  }

  if (needOnline) {
    const online = candidates.filter((device) => device.online);

    if (!online.length) {
      if (candidates.length === 1) return { ok: false, answer: ctx.t("common.pc_offline", { pc: candidates[0].name }), offline: candidates[0], pool };

      return { ok: false, answer: ctx.t("common.all_offline"), pool };
    }
    candidates = online;
  }

  if (feature) {
    const enabled = candidates.filter((device) => device.features?.[feature] !== false && !device.prefs?.paused);

    if (!enabled.length) {
      const device = candidates[0];

      return { ok: false, answer: ctx.t(device.prefs?.paused ? "common.paused" : "common.feature_off", { pc: device.name }), pool };
    }
    candidates = enabled;
  }

  if (able) {
    const capable = candidates.filter(able);

    if (capable.length) candidates = capable;
  }

  if ((pc?.all && allowAll) || candidates.length === 1) return { ok: true, devices: pc?.all && allowAll ? candidates : [candidates[0]], pool };

  if (!askEveryTime && recent) {
    const last = recent.recent(actor.userId);
    const device = candidates.find((item) => item.deviceId === last);

    if (device) return { ok: true, devices: [device], pool };
  }

  if (typeof ctx.askUser !== "function") return { ok: false, answer: ctx.t("common.name_the_pc", { names: candidates.map((device) => device.name) }), pool };

  const answer = await ctx.askUser(ctx.t("common.which_pc", { names: candidates.map((device) => `«${device.name}»`) }), { timeoutMs: ASK_TIMEOUT_MS }).catch(() => null);

  if (!answer?.text) return { ok: false, answer: ctx.t("common.not_heard"), pool };
  if (isCancel(answer.text) || answerKind(answer.text) === "no") return { ok: false, answer: ctx.t("common.cancelled"), pool };

  const chosen = pcsFromAnswer(answer.text, candidates, index, allowAll);

  if (!chosen.length) return { ok: false, answer: ctx.t("common.pc_not_understood"), pool };
  if (chosen.length === 1 && recent) recent.remember(actor.userId, chosen[0].deviceId);

  return { ok: true, devices: chosen, pool };
}

module.exports = { resolveActor, choosePc, pcsFromAnswer, RecentChoices, RECENT_MS, ASK_TIMEOUT_MS };
