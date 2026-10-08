// Block "Включить компьютер" (Wake-on-LAN)
const GhostHands = require("../../index.js");
const { pickDevice, loaded, fail } = require("../../lib/blocks");
const { wake } = require("../../lib/wol");

const key = (path) => `nodes.pc_wake_up.${path}`;

module.exports = {
  id: "pc_wake_up",
  label: key("label"),
  description: key("description"),
  summary: key("summary"),
  type: "action",
  category: "integrations",
  icon: "power",
  inputs: [{ id: "computer", label: key("inputs.computer"), type: "string" }],
  outputs: [
    { id: "computer", label: key("outputs.computer"), type: "string" },
    { id: "already", label: key("outputs.already"), type: "boolean" },
  ],
  async execute(data, ctx) {
    const skill = loaded(GhostHands);
    const device = pickDevice(skill, ctx.ownerId, data.computer, { online: false });

    if (skill.hub.isOnline(device.deviceId)) return { computer: device.name, already: true };
    if (!device.wol) throw fail("wol-not-configured");

    await wake(device.wol.mac, device.wol.broadcast);

    return { computer: device.name, already: false };
  },
};
