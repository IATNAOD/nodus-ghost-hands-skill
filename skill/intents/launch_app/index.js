// «запусти доту», «открой стим на ноутбуке», «давай поиграем в майнкрафт»
const { matchFor, handlerFor } = require("../../lib/intent");

module.exports = {
  id: "launch_app",
  label: "intents.launch_app.label",
  wildcard: true,
  llm: { uses: true },
  // examples: the first two are shown to AI models; the first words let compound commands split
  phrases: ["запусти игру на компьютере", "открой программу на компьютере", "запусти доту", "давай поиграем в майнкрафт", "launch steam", "open chrome on the laptop"],
  errorResponse: "intents.launch_app.error",
  match: matchFor("launch_app"),
  handler: handlerFor("launch_app"),
};
