// Block "Сообщение на компьютере": a Windows notification on the PC
const GhostHands = require("../../index.js");
const { pickDevice, runOn, loaded, fail } = require("../../lib/blocks");

const key = (path) => `nodes.pc_show_message.${path}`;

module.exports = {
  id: "pc_show_message",
  label: key("label"),
  description: key("description"),
  summary: key("summary"),
  type: "output",
  category: "integrations",
  icon: "message-circle",
  inputs: [
    { id: "text", label: key("inputs.text"), type: "string", widget: "textarea", required: true },
    { id: "title", label: key("inputs.title"), type: "string" },
    { id: "computer", label: key("inputs.computer"), type: "string" },
  ],
  outputs: [{ id: "computer", label: key("outputs.computer"), type: "string" }],
  async execute(data, ctx) {
    const skill = loaded(GhostHands);
    const text = String(data.text ?? "").trim().slice(0, 300);

    if (!text) throw fail("text-required");

    const device = pickDevice(skill, ctx.ownerId, data.computer);

    await runOn(skill, ctx.ownerId, device, "toast.show", { title: String(data.title ?? "").trim().slice(0, 80), text }, "toast");

    return { computer: device.name };
  },
};
