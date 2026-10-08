/**
 * Last resort for a spoken name nobody could match ("запусти ведьмака" with no
 * alias): the AI picks one app from the list. Rules first, the model only after
 * them; its pick is always confirmed by voice before anything runs.
 * Only app names go to the model, no personal data.
 */
"use strict";

const { prepare, scoreApp } = require("./names");

const MAX_CHOICES = 60;
// the built-in model reads a long prompt slowly (about a minute for a few thousand tokens)
const LOCAL_CHOICES = 20;
// the whole pick, queue included: the built-in model may also stand in for an unreachable
// provider, and then timeoutMs is not applied (up to 60 s). Past it NODUS answers without the AI.
const DEADLINE_MS = { local: 12_000, remote: 8_000 };

/** The value of a promise that never rejects, or null after `ms`. The timer is not unref'd: it is awaited. */
const withDeadline = (promise, ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);

    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });

/**
 * @param {object} ctx request ctx (its llm is the model chosen for the skill or intent)
 * @param {string} spoken what was said: "ведьмака"
 * @param {{ key: string, name: string, app: object }[]} choices unique apps of the PCs in scope
 * @param {{ deadlineMs?: number }} [options]
 * @returns {Promise<object|null>} the chosen element of `choices` or null
 */
async function pickApp(ctx, spoken, choices, { deadlineMs } = {}) {
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
    .slice(0, llm.isLocal ? LOCAL_CHOICES : MAX_CHOICES)
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
  const deadline = deadlineMs ?? (llm.isLocal ? DEADLINE_MS.local : DEADLINE_MS.remote);
  const request = Promise.resolve()
    .then(() =>
      llm.structured(ctx.t("prompts.app_pick", { phrase: spoken }), schema, {
        system: ctx.t("prompts.app_pick_system"),
        temperature: 0,
        maxTokens: 60,
        timeoutMs: deadline,
      }),
    )
    .catch(() => null);
  const result = await withDeadline(request, deadline);
  const name = typeof result?.app === "string" ? result.app : "";

  if (!name || name === "none") return null;

  return ranked.find((choice) => choice.name === name) ?? null;
}

module.exports = { pickApp, MAX_CHOICES, LOCAL_CHOICES, DEADLINE_MS };
