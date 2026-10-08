// Condition "Компьютер в сети?"
const GhostHands = require("../../index.js");
const { pickDevice, loaded } = require("../../lib/blocks");

const key = (path) => `nodes.pc_is_online.${path}`;

module.exports = {
  id: "pc_is_online",
  label: key("label"),
  description: key("description"),
  summary: key("summary"),
  type: "action",
  category: "logic",
  icon: "git-branch",
  inputs: [{ id: "computer", label: key("inputs.computer"), type: "string" }],
  outputs: [
    { id: "exec_out_true", label: key("outputs.exec_out_true"), type: "exec" },
    { id: "exec_out_false", label: key("outputs.exec_out_false"), type: "exec" },
    { id: "online", label: key("outputs.online"), type: "boolean" },
    { id: "computer", label: key("outputs.computer"), type: "string" },
  ],
  async execute(data, ctx) {
    const skill = loaded(GhostHands);
    const device = pickDevice(skill, ctx.ownerId, data.computer, { online: false });
    const online = skill.hub.isOnline(device.deviceId);

    return { online, computer: device.name, _branch: online ? "true" : "false" };
  },
};
