// «включи компьютер», «разбуди игровой» (Wake-on-LAN)
const { matchFor, handlerFor } = require("../../lib/intent");

module.exports = {
  id: "pc_wake",
  label: "intents.pc_wake.label",
  wildcard: true,
  // examples: the first two are shown to AI models; the first words let compound commands split
  phrases: ["включи компьютер", "разбуди компьютер", "turn on the computer", "wake up the pc"],
  errorResponse: "intents.pc_wake.error",
  match: matchFor("pc_wake"),
  handler: handlerFor("pc_wake"),
};
