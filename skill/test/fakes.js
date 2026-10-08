// test/fakes.js - what NODUS gives the skill, in memory (Node 22, no dependencies).
// Based on the fakes of docs/nodus-skills-guide.md §14, plus i18next list formatters,
// answers for askUser, secrets, notify and a model.
const fs = require("fs");
const path = require("path");
const manifest = require("../skill.json");

const LOCALES = Object.fromEntries(
  ["ru", "en"].map((language) => [language, JSON.parse(fs.readFileSync(path.join(__dirname, `../locales/${language}.json`), "utf8"))]),
);

/** ctx.t: dotted keys, {{name}}, {{list, list}} and {{list, list(type: disjunction)}}, count → plural forms, the _female pair. */
const fakeT = (bundle, { language = "ru", female = false } = {}) => {
  const rules = new Intl.PluralRules(language);
  const get = (key) => key.split(".").reduce((node, part) => node?.[part], bundle);
  const format = (value, spec) => {
    if (Array.isArray(value)) {
      const type = /disjunction/.test(spec ?? "") ? "disjunction" : "conjunction";

      return new Intl.ListFormat(language, { style: "long", type }).format(value.map(String));
    }

    return String(value ?? "");
  };

  return (key, options = {}) => {
    for (const gender of female ? ["_female", ""] : [""]) {
      for (const plural of options.count === undefined ? [""] : [`_${rules.select(options.count)}`, ""]) {
        const value = get(key + gender + plural);

        if (typeof value === "string") {
          return value.replace(/{{\s*(\w+)\s*(?:,\s*([^}]+))?}}/g, (_, name, spec) => format(options[name], spec));
        }
      }
    }

    return key;
  };
};

/**
 * Request ctx of a voice command.
 * @param {object} options
 * @param {string|null} [options.userId] speaker; null - not recognized
 * @param {string[]} [options.answers] answers to ctx.askUser in order; null - silence
 * @param {string|null} [options.requireAnswer] userId given by "Кто это?"
 */
const fakeCtx = ({
  language = "ru",
  female = false,
  userId = "64b000000000000000000001",
  userName = "Маша",
  audience = "member",
  answers = [],
  requireAnswer = null,
  verified = true,
  text = "",
  llm = null,
  canExternal = true,
} = {}) => {
  const calls = { asked: [], notify: [], events: [], spoken: [], require: 0, requireVerified: 0 };
  const queue = [...answers];
  const user = {
    id: userId,
    name: userId ? userName : null,
    identified: Boolean(userId),
    recognized: Boolean(userId),
    audience,
    can: (capability) => (capability === "external-ai" ? canExternal : true),
    require: async () => {
      calls.require++;
      if (userId) return { userId, name: userName };

      return requireAnswer ? { userId: requireAnswer, name: "Кто-то" } : null;
    },
    requireVerified: async () => {
      calls.requireVerified++;

      return verified ? { userId: userId ?? requireAnswer, name: userName, confidence: 0.9 } : null;
    },
  };
  const providers = {
    askUser: async (question) => {
      calls.asked.push(question);

      const answer = queue.length ? queue.shift() : null;

      return answer === null ? null : { text: answer, speaker: userId };
    },
    notify: async (note) => (calls.notify.push(note), { id: String(calls.notify.length), delivered: false }),
    scenarioEngine: { fireSkillEvent: async (...args) => (calls.events.push(args), 0) },
    synthesizeText: async (phrase) => (calls.spoken.push(phrase), { success: true, request_id: "r1" }),
    secrets: { encrypt: (value) => `enc:${value}`, decrypt: (value) => String(value).replace(/^enc:/, ""), isEncrypted: (value) => String(value).startsWith("enc:") },
  };

  return {
    calls,
    skillId: manifest.id,
    t: fakeT(LOCALES[language], { language, female }),
    llm,
    models: {},
    skillsService: { loadedSkills: [{ id: manifest.id, configs: [] }], builtinLlm: async () => llm },
    user,
    userId,
    speakerIdentified: Boolean(userId),
    text,
    secretAnswers: true,
    ...Object.fromEntries(manifest.permissions.filter((name) => providers[name]).map((name) => [name, providers[name]])),
  };
};

/** routes/index.js without Fastify: handlers by "GET /path". */
const captureRoutes = async (plugin) => {
  const routes = {};
  const app = {};

  for (const method of ["get", "post", "put", "patch", "delete", "head", "options"]) {
    app[method] = (route, opts, handler) => (routes[`${method.toUpperCase()} ${route}`] = handler || opts);
  }
  await plugin(app);
  return routes;
};

/** Fastify reply in the minimum: res.code(n).send(body). */
const reply = () => {
  const res = { statusCode: 200, body: undefined };

  res.code = (statusCode) => Object.assign(res, { statusCode });
  res.send = (body) => Object.assign(res, { body });
  return res;
};

/** Settings entries as the core gives them. */
const configs = (values = {}) => Object.entries(values).map(([key, value]) => ({ key, value }));

module.exports = { LOCALES, fakeT, fakeCtx, captureRoutes, reply, configs };
