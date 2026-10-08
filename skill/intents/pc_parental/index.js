// «сними ограничения на детском компьютере на час», «верни ограничения на компьютере»,
// «сбрось лимиты на детском компьютере»: only the owner of the PC, checked by voice
const { matchFor, handlerFor } = require("../../lib/intent");

module.exports = {
  id: "pc_parental",
  label: "intents.pc_parental.label",
  wildcard: true,
  phrases: ["сними ограничения на детском компьютере", "верни ограничения на компьютере", "сбрось лимиты на компьютере", "lift the limits on the kids computer"],
  errorResponse: "intents.pc_parental.error",
  match: matchFor("pc_parental"),
  handler: handlerFor("pc_parental"),
};
