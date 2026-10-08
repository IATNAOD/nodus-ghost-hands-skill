// Block "Запустить на компьютере": an app or a game of the scenario owner's PC
const GhostHands = require("../../index.js");
const { pickDevice, runOn, loaded, fail } = require("../../lib/blocks");
const { spokenName } = require("../../lib/names");

const key = (path) => `nodes.pc_run_app.${path}`;

module.exports = {
  id: "pc_run_app",
  label: key("label"),
  description: key("description"),
  summary: key("summary"),
  type: "action",
  category: "integrations",
  icon: "play",
  inputs: [
    { id: "app", label: key("inputs.app"), type: "string", required: true },
    { id: "computer", label: key("inputs.computer"), type: "string" },
  ],
  outputs: [
    { id: "app", label: key("outputs.app"), type: "string" },
    { id: "computer", label: key("outputs.computer"), type: "string" },
  ],
  async execute(data, ctx) {
    const skill = loaded(GhostHands);
    const device = pickDevice(skill, ctx.ownerId, data.computer);
    const found = skill.index.matchApps(String(data.app ?? ""), [device]);

    if (found.status !== "match" && found.status !== "weak") throw fail("app-not-found");

    await runOn(skill, ctx.ownerId, device, "app.launch", { appId: found.best.appId }, found.best.name);

    return { app: found.best.app ? spokenName(found.best.app) : found.best.name, computer: device.name };
  },
};
