// Block "Питание компьютера": shut down, restart, sleep, lock, monitor off, cancel
const GhostHands = require("../../index.js");
const { pickDevice, runOn, loaded } = require("../../lib/blocks");
const { POWER_ACTIONS } = require("../../lib/command");

const key = (path) => `nodes.pc_power_action.${path}`;

module.exports = {
  id: "pc_power_action",
  label: key("label"),
  description: key("description"),
  summary: key("summary"),
  type: "action",
  category: "integrations",
  icon: "power",
  inputs: [
    { id: "action", label: key("inputs.action"), type: "select", options: ["shutdown", "restart", "sleep", "lock", "display_off", "cancel"], default: "shutdown", required: true },
    { id: "computer", label: key("inputs.computer"), type: "string" },
    { id: "delay", label: key("inputs.delay"), type: "number", widget: "duration", default: 0, min: 0, max: 86400 },
  ],
  outputs: [{ id: "computer", label: key("outputs.computer"), type: "string" }],
  async execute(data, ctx) {
    const skill = loaded(GhostHands);
    const action = POWER_ACTIONS[data.action] ?? POWER_ACTIONS.shutdown;
    const device = pickDevice(skill, ctx.ownerId, data.computer);
    const delaySec = Math.min(86400, Math.max(0, Math.round(Number(data.delay) || 0)));

    await runOn(skill, ctx.ownerId, device, action, { delaySec }, data.action);

    return { computer: device.name };
  },
};
