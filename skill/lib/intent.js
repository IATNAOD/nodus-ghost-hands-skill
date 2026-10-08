/**
 * Glue for wildcard intents: match() asks the shared classifier whether the
 * phrase is theirs, handler() runs the command pipeline.
 */
"use strict";

const state = require("./state");
const { classify } = require("./parse");
const { runCommand } = require("./command");

/** Synchronous, no I/O: the index lives in memory. */
const matchFor = (intent) => (text, info) => {
  try {
    const loaded = state.get();

    if (!loaded) return null;

    const result = classify(text, { index: loaded.index, userId: info?.userId ? String(info.userId) : null });

    return result && result.intent === intent ? { score: result.score, params: result.params } : null;
  } catch {
    return null;
  }
};

const handlerFor = (intent) => async (params, ctx, configs) => runCommand(ctx, configs, intent, params);

module.exports = { matchFor, handlerFor };
