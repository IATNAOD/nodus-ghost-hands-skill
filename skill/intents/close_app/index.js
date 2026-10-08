// «закрой доту», «выключи игру», «закрой хром на ноутбуке»
const { matchFor, handlerFor } = require("../../lib/intent");

module.exports = {
  id: "close_app",
  label: "intents.close_app.label",
  wildcard: true,
  llm: { uses: true },
  // examples: the first two are shown to AI models; the first words let compound commands split
  phrases: ["закрой игру на компьютере", "закрой программу на компьютере", "закрой доту", "выйди из майнкрафта", "close discord", "quit the game"],
  errorResponse: "intents.close_app.error",
  match: matchFor("close_app"),
  handler: handlerFor("close_app"),
};
