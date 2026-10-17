// Block "Сценарий на компьютере": runs a scenario of the owner's PC, waits for it if asked.
// Stopping the NODUS run stops the scenario on the PC too.
const GhostHands = require("../../index.js");
const { pickDevice, runOn, loaded, fail } = require("../../lib/blocks");
const { newRunId } = require("../../lib/scenarios");
const { trace } = require("../../lib/trace");

const key = (path) => `nodes.pc_run_scenario.${path}`;

const TIMEOUT_DEFAULT = 300;
const TIMEOUT_MAX = 6 * 3600;

module.exports = {
  id: "pc_run_scenario",
  label: key("label"),
  description: key("description"),
  summary: key("summary"),
  type: "action",
  category: "integrations",
  icon: "workflow",
  inputs: [
    { id: "scenario", label: key("inputs.scenario"), type: "string", required: true },
    { id: "computer", label: key("inputs.computer"), type: "string" },
    { id: "text", label: key("inputs.text"), type: "string", widget: "text" },
    { id: "wait", label: key("inputs.wait"), type: "boolean", default: true },
    { id: "timeout", label: key("inputs.timeout"), type: "number", widget: "duration", default: TIMEOUT_DEFAULT, min: 5, max: TIMEOUT_MAX, showIf: { wait: true } },
  ],
  outputs: [
    { id: "status", label: key("outputs.status"), type: "string" },
    { id: "output", label: key("outputs.output"), type: "string" },
    { id: "scenario", label: key("outputs.scenario"), type: "string" },
    { id: "computer", label: key("outputs.computer"), type: "string" },
  ],
  async execute(data, ctx) {
    const skill = loaded(GhostHands);
    const device = pickDevice(skill, ctx.ownerId, data.computer);

    if (!skill.hub.supports?.(device.deviceId, "scenarios")) throw fail("unknown-action");

    // any scenario of the PC: the voice name is not needed here
    const found = skill.index.matchApps(String(data.scenario ?? ""), [device], { scenarios: "only", voiceOnly: false });

    if (found.status !== "match" && found.status !== "weak") throw fail("scenario-not-found");

    const scenario = found.best;
    const wait = data.wait !== false && data.wait !== "false";
    const timeoutMs = Math.min(TIMEOUT_MAX, Math.max(5, Number(data.timeout) || TIMEOUT_DEFAULT)) * 1000;
    const text = String(data.text ?? "").slice(0, 2000);
    const runId = newRunId();
    const options = { timeoutMs, signal: ctx.signal };
    // waiting starts before the command: "finished" of a short scenario may come right after "ok"
    const waiting = wait ? skill.waiters.wait(device.deviceId, runId, options) : null;

    waiting?.catch(() => null);

    let started;

    try {
      started = await runOn(skill, ctx.ownerId, device, "scenario.run", { id: scenario.scenarioId, runId, text, via: "nodus" }, scenario.name);
    } catch (error) {
      skill.waiters.cancel(device.deviceId, runId);
      throw error;
    }

    const base = { scenario: scenario.name, computer: device.name };

    if (!wait) return { ...base, status: "started", output: "" };

    // it was running already: wait for that run
    const actual = typeof started.runId === "string" && started.runId ? started.runId : runId;
    let event;

    try {
      if (actual !== runId) {
        skill.waiters.cancel(device.deviceId, runId);
        event = await skill.waiters.wait(device.deviceId, actual, options);
      } else {
        event = await waiting;
      }
    } catch (error) {
      if (error.code === "aborted") {
        skill.hub.command(device.deviceId, "scenario.stop", { runId: actual }, skill.settings.replyTimeoutMs).catch((stopError) => trace(`scenario.stop: ${stopError.message}`));
      }
      throw error;
    }

    if (event.result !== "success") throw fail(event.result === "stopped" ? "scenario-stopped" : event.error ? `scenario-failed: ${event.error}` : "scenario-failed");

    return { ...base, status: event.result, output: event.output ?? "" };
  },
};
