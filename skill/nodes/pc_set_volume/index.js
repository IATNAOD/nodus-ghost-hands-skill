// Block "Громкость компьютера"
const GhostHands = require("../../index.js");
const { pickDevice, runOn, loaded } = require("../../lib/blocks");

const key = (path) => `nodes.pc_set_volume.${path}`;

module.exports = {
  id: "pc_set_volume",
  label: key("label"),
  description: key("description"),
  summary: key("summary"),
  type: "action",
  category: "integrations",
  icon: "volume-2",
  inputs: [
    { id: "mode", label: key("inputs.mode"), type: "select", options: ["set", "up", "down", "mute", "unmute"], default: "set", required: true },
    { id: "level", label: key("inputs.level"), type: "number", widget: "slider", default: 30, min: 0, max: 100 },
    { id: "computer", label: key("inputs.computer"), type: "string" },
  ],
  outputs: [
    { id: "level", label: key("outputs.level"), type: "number" },
    { id: "muted", label: key("outputs.muted"), type: "boolean" },
    { id: "computer", label: key("outputs.computer"), type: "string" },
  ],
  async execute(data, ctx) {
    const skill = loaded(GhostHands);
    const device = pickDevice(skill, ctx.ownerId, data.computer);
    const level = Math.min(100, Math.max(0, Math.round(Number(data.level) || 0)));
    const step = Number(device.prefs?.volumeStep) || 10;
    const commands = {
      set: ["volume.set", { level }],
      up: ["volume.change", { delta: level || step }],
      down: ["volume.change", { delta: -(level || step) }],
      mute: ["volume.mute", { muted: true }],
      unmute: ["volume.mute", { muted: false }],
    };
    const [action, args] = commands[data.mode] ?? commands.set;
    const result = await runOn(skill, ctx.ownerId, device, action, args, data.mode);

    return { level: Number(result.level) || 0, muted: result.muted === true, computer: device.name };
  },
};
