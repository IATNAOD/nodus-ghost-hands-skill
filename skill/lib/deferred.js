/**
 * Commands waiting for a PC that was just woken up ("включи компьютер и
 * запусти доту"): one per PC, run on its first config after it connects.
 */
"use strict";

const TTL_MS = 5 * 60_000;

class Deferred {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    /** deviceId → { run, expires, onExpire } */
    this.items = new Map();
    this.timers = new Map();
  }

  /**
   * @param {string} deviceId
   * @param {() => Promise<void>} run
   * @param {{ ttlMs?: number, onExpire?: () => Promise<void> }} options
   */
  add(deviceId, run, { ttlMs = TTL_MS, onExpire } = {}) {
    this.cancel(deviceId);
    this.items.set(deviceId, { run, expires: Date.now() + ttlMs });

    const timer = setTimeout(() => {
      this.timers.delete(deviceId);
      if (!this.items.delete(deviceId)) return;
      onExpire?.().catch((error) => this.log(`deferred expire: ${error.message}`));
    }, ttlMs);

    timer.unref?.();
    this.timers.set(deviceId, timer);
  }

  has(deviceId) {
    return this.items.has(deviceId);
  }

  /** The PC is connected and configured: run what waits for it. */
  ready(deviceId) {
    const item = this.items.get(deviceId);

    if (!item) return;
    this.cancel(deviceId);
    if (Date.now() > item.expires) return;
    item.run().catch((error) => this.log(`deferred run: ${error.message}`));
  }

  cancel(deviceId) {
    clearTimeout(this.timers.get(deviceId));
    this.timers.delete(deviceId);
    this.items.delete(deviceId);
  }

  dispose() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.items.clear();
  }
}

module.exports = { Deferred, TTL_MS };
