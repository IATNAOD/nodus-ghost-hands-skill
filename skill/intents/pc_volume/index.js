// «сделай громче на компьютере», «громкость ноутбука тридцать», «выключи звук на компьютере»
const { matchFor, handlerFor } = require("../../lib/intent");

module.exports = {
  id: "pc_volume",
  label: "intents.pc_volume.label",
  wildcard: true,
  // examples: the first two are shown to AI models; the first words let compound commands split
  phrases: ["сделай громче на компьютере", "убавь звук на компьютере", "громкость на компьютере", "turn up the volume on the computer", "mute the pc"],
  errorResponse: "intents.pc_volume.error",
  match: matchFor("pc_volume"),
  handler: handlerFor("pc_volume"),
};
