// «выключи компьютер», «перезагрузи ноутбук через полчаса», «отмени выключение»
const { matchFor, handlerFor } = require("../../lib/intent");

module.exports = {
  id: "pc_power",
  label: "intents.pc_power.label",
  wildcard: true,
  // examples: the first two are shown to AI models; the first words let compound commands split
  phrases: ["выключи компьютер", "перезагрузи компьютер", "заблокируй компьютер", "усыпи компьютер", "отмени выключение компьютера", "shut down the computer", "restart the pc", "lock the computer"],
  errorResponse: "intents.pc_power.error",
  match: matchFor("pc_power"),
  handler: handlerFor("pc_power"),
};
