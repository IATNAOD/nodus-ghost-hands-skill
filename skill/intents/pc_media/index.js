// «пауза на компьютере», «следующий трек на ноутбуке»
const { matchFor, handlerFor } = require("../../lib/intent");

module.exports = {
  id: "pc_media",
  label: "intents.pc_media.label",
  wildcard: true,
  // examples: the first two are shown to AI models; the first words let compound commands split
  phrases: ["пауза на компьютере", "следующий трек на компьютере", "pause on the computer", "next track on the pc"],
  errorResponse: "intents.pc_media.error",
  match: matchFor("pc_media"),
  handler: handlerFor("pc_media"),
};
