/**
 * Skill events for scenarios: pc_online, pc_offline, app_started, app_stopped.
 * A personal PC's events go to its owner's scenarios, a shared PC's to everyone's.
 * Short breaks (Wi-Fi blips, NODUS restarts) produce no events.
 */
"use strict";

const { spokenName } = require("./names");

// the scenario engine is ready only after every skill's init(), and PCs reconnect
// with up to 30 s of backoff after a restart: these events are not real changes
const QUIET_MS = 90_000;
const OFFLINE_AFTER_MS = 60_000;

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
  }

  fire(event, device, payload) {
    const engine = this.ctx?.scenarioEngine;

    if (typeof engine?.fireSkillEvent !== "function") return;
    if (Date.now() - this.startedAt < QUIET_MS) return;

    const options = device.shared ? {} : { ownerId: device.userId };

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

  dispose() {
    for (const timer of this.offlineTimers.values()) clearTimeout(timer);
    this.offlineTimers.clear();
  }
}

module.exports = { ScenarioEvents, QUIET_MS, OFFLINE_AFTER_MS };
