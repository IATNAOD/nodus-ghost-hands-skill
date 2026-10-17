/**
 * Runs of PC scenarios the skill waits for (the block «Выполнить сценарий на компьютере»).
 * The skill makes the runId and starts waiting before the command goes, so the PC's
 * "finished" cannot come first; a run that finished a moment ago is still answered.
 */
"use strict";

const { randomBytes } = require("node:crypto");

const RECENT_MS = 60_000;
const RECENT_MAX = 200;

const fail = (code) => Object.assign(new Error(code), { code });

/** 16 characters of base64url: fits the protocol's RUN_ID_RE */
const newRunId = () => randomBytes(12).toString("base64url");

const keyOf = (deviceId, runId) => `${deviceId}:${runId}`;

class ScenarioWaiters {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    /** key → [{ finish, fail }] */
    this.waiting = new Map();
    /** key → { event, at }: finished runs nobody waited for yet */
    this.recent = new Map();
  }

  /**
   * The "finished" event of a run of a PC.
   * @param {{ timeoutMs: number, signal?: AbortSignal }} options rejects with code "timeout" or "aborted"
   * @returns {Promise<object>} the sanitized `scenario` message
   */
  wait(deviceId, runId, { timeoutMs, signal } = {}) {
    const key = keyOf(deviceId, runId);
    const done = this.recent.get(key);

    if (done) return Promise.resolve(done.event);
    if (signal?.aborted) return Promise.reject(fail("aborted"));

    return new Promise((resolve, reject) => {
      const entry = {};
      const onAbort = () => entry.fail(fail("aborted"));
      const settle = (callback, value) => {
        clearTimeout(entry.timer);
        signal?.removeEventListener("abort", onAbort);
        this.drop(key, entry);
        callback(value);
      };

      entry.finish = (event) => settle(resolve, event);
      entry.fail = (error) => settle(reject, error);
      entry.timer = setTimeout(() => entry.fail(fail("timeout")), Math.max(100, Number(timeoutMs) || 0));
      entry.timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });

      const list = this.waiting.get(key) ?? [];

      list.push(entry);
      this.waiting.set(key, list);
    });
  }

  /** Stop waiting (the command failed, or the PC answered with another run). */
  cancel(deviceId, runId) {
    for (const entry of [...(this.waiting.get(keyOf(deviceId, runId)) ?? [])]) entry.fail(fail("cancelled"));
  }

  /** A `scenario` message of a PC. */
  handle(deviceId, event) {
    if (!event || event.status !== "finished") return;

    const key = keyOf(deviceId, event.runId);
    const list = this.waiting.get(key);

    if (list?.length) {
      for (const entry of [...list]) entry.finish(event);
      return;
    }

    this.prune();
    this.recent.set(key, { event, at: this.now() });
  }

  /** A PC went away: its runs will not report. */
  offline(deviceId) {
    for (const [key, list] of [...this.waiting]) if (key.startsWith(`${deviceId}:`)) for (const entry of [...list]) entry.fail(fail("disconnected"));
  }

  drop(key, entry) {
    const list = (this.waiting.get(key) ?? []).filter((item) => item !== entry);

    if (list.length) this.waiting.set(key, list);
    else this.waiting.delete(key);
  }

  prune() {
    const now = this.now();

    for (const [key, item] of this.recent) if (now - item.at > RECENT_MS) this.recent.delete(key);
    while (this.recent.size >= RECENT_MAX) this.recent.delete(this.recent.keys().next().value);
  }

  dispose() {
    for (const list of [...this.waiting.values()]) for (const entry of [...list]) entry.fail(fail("cancelled"));
    this.recent.clear();
  }
}

module.exports = { ScenarioWaiters, newRunId };
