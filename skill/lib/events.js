/**
 * Skill events for scenarios: pc_online, pc_offline, app_started, app_stopped, pc_scenario_finished.
 * A personal PC's events go to its owner's scenarios, a shared PC's to everyone's.
 * Short breaks (Wi-Fi blips, NODUS restarts) produce no events.
 */
"use strict";

const { spokenName } = require("./names");

// the scenario engine is ready only after every skill's init(), and PCs reconnect
// with up to 30 s of backoff after a restart: these events are not real changes
const QUIET_MS = 90_000;
const OFFLINE_AFTER_MS = 60_000;
// NODUS does not break "event → scenario → block → the same event": a looping pair of
// scenarios (a NODUS one starting a PC one) gets at most this many events a minute per PC
const SCENARIO_EVENTS_PER_MIN = 20;

class ScenarioEvents {
  /**
   * @param {{ ctx: object, log?: (message: string) => void, startedAt?: number }} deps ctx - lifecycle ctx from init()
   */
  constructor({ ctx, log = () => {}, startedAt = Date.now() }) {
    this.ctx = ctx;
    this.log = log;
    this.startedAt = startedAt;
    this.offlineTimers = new Map();
    /** PCs whose pc_offline has fired */
    this.offlineFired = new Set();
    /** deviceId → times of the last pc_scenario_finished */
    this.scenarioTimes = new Map();
  }

  /** @param {object} [options] whose scenarios: by default the owner's, everyone's for a shared PC */
  fire(event, device, payload, options = device.shared ? {} : { ownerId: device.userId }) {
    const engine = this.ctx?.scenarioEngine;

    if (typeof engine?.fireSkillEvent !== "function") return;
    if (Date.now() - this.startedAt < QUIET_MS) return;

    engine
      .fireSkillEvent(this.ctx.skillId, event, { from: device.userId, computer: device.name, ...payload }, options)
      .catch((error) => this.log(`event ${event}: ${error.message}`));
  }

  /** @param {number} lastSeenAt when the PC was seen before this connection, ms */
  online(device, lastSeenAt) {
    const timer = this.offlineTimers.get(device.deviceId);

    if (timer) {
      clearTimeout(timer);
      this.offlineTimers.delete(device.deviceId);
      return;
    }

    const wasOffline = this.offlineFired.has(device.deviceId) || !lastSeenAt || Date.now() - lastSeenAt >= OFFLINE_AFTER_MS;

    this.offlineFired.delete(device.deviceId);
    if (wasOffline) this.fire("pc_online", device, { text: device.name });
  }

  offline(device) {
    clearTimeout(this.offlineTimers.get(device.deviceId));

    const timer = setTimeout(() => {
      try {
        this.offlineTimers.delete(device.deviceId);
        this.offlineFired.add(device.deviceId);
        this.fire("pc_offline", device, { text: device.name });
      } catch (error) {
        this.log(`pc_offline: ${error.message}`);
      }
    }, OFFLINE_AFTER_MS);

    timer.unref?.();
    this.offlineTimers.set(device.deviceId, timer);
  }

  app(event, device, app, item) {
    const name = app ? spokenName(app) : item?.name ?? "";

    this.fire(event, device, { text: name, app: name, appId: app?.id ?? item?.appId ?? "", kind: app?.kind ?? (item?.game ? "game" : "app") });
  }

  /** A scenario run of the PC finished: success, error or stopped. */
  scenario(device, event) {
    const now = Date.now();
    const recent = (this.scenarioTimes.get(device.deviceId) ?? []).filter((at) => now - at < 60_000);

    if (recent.length >= SCENARIO_EVENTS_PER_MIN) {
      if (recent.length === SCENARIO_EVENTS_PER_MIN) this.log(`pc_scenario_finished of ${device.deviceId}: too many a minute, skipped`);
      recent.push(now);
      this.scenarioTimes.set(device.deviceId, recent);
      return;
    }
    recent.push(now);
    this.scenarioTimes.set(device.deviceId, recent);

    this.fire("pc_scenario_finished", device, {
      text: event.name,
      scenario: event.name,
      scenarioId: event.id,
      status: event.result ?? "error",
      output: event.output ?? "",
      error: event.error ?? "",
      trigger: event.trigger,
    });
  }

  dispose() {
    for (const timer of this.offlineTimers.values()) clearTimeout(timer);
    this.offlineTimers.clear();
  }
}

module.exports = { ScenarioEvents, QUIET_MS, OFFLINE_AFTER_MS };
