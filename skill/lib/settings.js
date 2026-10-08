/**
 * Device settings of the skill (configSchema) → typed values with defaults.
 * Values come as entries { key, value } and their types are not guaranteed.
 */
"use strict";

const { DEFAULT_PORT } = require("./protocol");
const { ACCEPT } = require("./names");

const valueOf = (configs, key) => (Array.isArray(configs) ? configs : []).find((entry) => entry?.key === key)?.value;
const oneOf = (value, list, fallback) => (list.includes(value) ? value : fallback);

/** @returns {{ port: number, unknownVoice: string, voiceCheck: string, children: string, guestsShared: boolean, askPcEveryTime: boolean, aiNames: boolean, acceptScore: number, replyTimeoutMs: number }} */
const readSettings = (configs) => {
  const port = Number(valueOf(configs, "port"));
  const timeout = Number(valueOf(configs, "reply_timeout"));
  const confidence = Number(valueOf(configs, "app_confidence"));

  return {
    port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PORT,
    unknownVoice: oneOf(valueOf(configs, "unknown_voice"), ["ask", "shared", "deny"], "ask"),
    voiceCheck: oneOf(valueOf(configs, "voice_check"), ["off", "power", "all"], "off"),
    children: oneOf(valueOf(configs, "children"), ["allow", "no_power", "deny"], "no_power"),
    guestsShared: valueOf(configs, "guests_shared") === true,
    askPcEveryTime: valueOf(configs, "ask_pc_every_time") === true,
    aiNames: valueOf(configs, "ai_names") !== false,
    // percent in the panel, 0..1 in the matcher
    acceptScore: (Number.isFinite(confidence) && confidence >= 60 && confidence <= 100 ? confidence : Math.round(ACCEPT * 100)) / 100,
    replyTimeoutMs: (Number.isFinite(timeout) && timeout >= 3 && timeout <= 20 ? timeout : 8) * 1000,
  };
};

/**
 * Settings outside a command (init, routes): the core keeps the decrypted entries
 * of loaded skills in ctx.skillsService.loadedSkills - working, but not a contract.
 */
const loadedConfigs = (ctx) => {
  try {
    return ctx?.skillsService?.loadedSkills?.find?.((skill) => skill.id === ctx.skillId)?.configs ?? [];
  } catch {
    return [];
  }
};

module.exports = { readSettings, loadedConfigs, valueOf };
