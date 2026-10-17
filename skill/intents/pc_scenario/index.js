// «запусти сценарий утро на компьютере», «останови сценарий на компьютере»,
// «останови все сценарии на компьютере», «останови режим стрима» while it runs.
// «запусти режим стрима» (a voice name of a scenario) goes to launch_app, like an app.
const { matchFor, handlerFor } = require("../../lib/intent");

module.exports = {
  id: "pc_scenario",
  label: "intents.pc_scenario.label",
  wildcard: true,
  phrases: ["запусти сценарий утро на компьютере", "останови сценарий на компьютере", "run the morning scenario on the computer", "stop the scenario on the pc"],
  errorResponse: "intents.pc_scenario.error",
  match: matchFor("pc_scenario"),
  handler: handlerFor("pc_scenario"),
};
