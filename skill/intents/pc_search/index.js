// «найди в интернете рецепт борща», «загугли погоду», «найди на ютубе обзор»
const { matchFor, handlerFor } = require("../../lib/intent");

module.exports = {
  id: "pc_search",
  label: "intents.pc_search.label",
  wildcard: true,
  // the query is free text: "найди рецепт пиццы и пасты" is one command
  greedy: true,
  // examples: the first two are shown to AI models; the first words let compound commands split
  phrases: ["найди в интернете на компьютере", "загугли на компьютере", "найди на ютубе", "search the web for", "google on the computer"],
  errorResponse: "intents.pc_search.error",
  match: matchFor("pc_search"),
  handler: handlerFor("pc_search"),
};
