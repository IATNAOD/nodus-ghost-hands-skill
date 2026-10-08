/**
 * Last resort for a spoken name nobody could match ("запусти ведьмака" with no
 * alias): the AI picks one app from the list. Rules first, the model only after
 * them; its pick is always confirmed by voice before anything runs.
 * Only app names go to the model, no personal data.
 */
"use strict";

const { prepare, scoreApp } = require("./names");

const MAX_CHOICES = 60;

/**
 * @param {object} ctx request ctx (its llm is the model chosen for the skill or intent)
 * @param {string} spoken what was said: "ведьмака"
 * @param {{ key: string, name: string, app: object }[]} choices unique apps of the PCs in scope
 * @returns {Promise<object|null>} the chosen element of `choices` or null
 */
async function pickApp(ctx, spoken, choices) {
  if (!choices.length || !spoken) return null;

  let llm = ctx.llm;

  // a child gets only the model of the device; the same when the external AI is not allowed
  if (llm && !llm.isPrivate && ctx.user?.can?.("external-ai") === false) {
    llm = await ctx.skillsService?.builtinLlm?.().catch(() => null);
  }
  if (!llm || typeof llm.structured !== "function") return null;

  // the closest names first: a long list makes the built-in model slow
  const tokens = prepare(spoken);
  const ranked = choices
    .map((choice) => ({ choice, score: tokens.length ? scoreApp(tokens, choice.app).score : 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CHOICES)
    .map(({ choice }) => choice);
  const names = [...new Set(ranked.map((choice) => choice.name))];

  if (llm.isLocal && typeof ctx.synthesizeText === "function") ctx.synthesizeText(ctx.t("common.one_moment")).catch(() => null);

  const schema = {
    type: "object",
    properties: {
      app: { type: "string", enum: [...names, "none"], description: "The app from the list the person means, or none" },
    },
    required: ["app"],
  };
  const result = await llm
    .structured(ctx.t("prompts.app_pick", { phrase: spoken }), schema, {
      system: ctx.t("prompts.app_pick_system"),
      temperature: 0,
      maxTokens: 60,
      timeoutMs: llm.isLocal ? 20000 : 8000,
    })
    .catch(() => null);
  const name = typeof result?.app === "string" ? result.app : "";

  if (!name || name === "none") return null;

  return ranked.find((choice) => choice.name === name) ?? null;
}

module.exports = { pickApp, MAX_CHOICES };
