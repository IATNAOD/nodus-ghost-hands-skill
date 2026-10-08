/**
 * Scenario blocks act for the scenario owner (ctx.ownerId) without questions:
 * an unclear PC or app is an error of the step, shown in the run history.
 */
"use strict";

const { wordsOf } = require("./text");
const { trace } = require("./trace");

const fail = (code) => Object.assign(new Error(code), { code });

/**
 * PC of the owner by name; empty name - the only suitable PC.
 * @param {object} skill instance of GhostHands
 * @param {string} ownerId
 * @param {string} computer name typed in the block
 * @param {{ online?: boolean }} options online - must be connected
 */
const pickDevice = (skill, ownerId, computer, { online = true } = {}) => {
  const pool = skill.index.pool(ownerId ? String(ownerId) : null);
  const name = String(computer ?? "").trim();
  let candidates = pool;

  if (name) {
    const words = wordsOf(name);
    let ids = null;

    for (let i = 0; i < words.length && !ids; i++) ids = skill.index.deviceNameAt(words, i, pool)?.ids ?? null;
    if (!ids) throw fail("computer-not-found");
    candidates = pool.filter((device) => ids.includes(device.deviceId));
  }
  if (!candidates.length) throw fail("no-computers");

  const usable = online ? candidates.filter((device) => device.online) : candidates;

  if (!usable.length) throw fail("computer-offline");
  if (usable.length > 1) throw fail("computer-ambiguous");

  return usable[0];
};

/** Command to a PC; a failure becomes an error of the step. */
const runOn = async (skill, ownerId, device, action, args, target = "") => {
  const result = await skill.hub.command(device.deviceId, action, args, skill.settings.replyTimeoutMs);

  skill.store.history
    .add({ userId: String(ownerId ?? device.userId), deviceId: device.deviceId, action, target: String(target).slice(0, 120), ok: result.ok, code: result.code ?? "", via: "node" })
    .catch((error) => trace(`history: ${error.message}`));
  if (!result.ok) throw fail(result.code ?? "internal");

  return result.data ?? {};
};

/** The loaded skill or an error of the step. */
const loaded = (GhostHands) => {
  const skill = GhostHands.getInstance();

  if (!skill || !skill.hub) throw fail("ghost_hands-not-loaded");

  return skill;
};

module.exports = { pickDevice, runOn, loaded, fail };
