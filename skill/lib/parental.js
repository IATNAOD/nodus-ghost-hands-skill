/**
 * Parental control of PCs, the skill's part. The owner of a PC sets the rules and the PIN on
 * the personal page, lifts the limits there or by voice; the client counts the time and
 * enforces the limits (offline too), and reports usage and alerts. The owner hears when the
 * client was killed or the PC vanished from the network without shutting down.
 */
"use strict";

const crypto = require("crypto");
const P = require("./protocol");

/** No reconnection for this long after a disconnect without "bye": the owner is told. */
const VANISH_MS = 3 * 60_000;
/** Disconnects that are fine: the PC sleeps or shuts down, the owner unpaired it. */
const CLEAN_BYE = new Set(["sleep", "shutdown", "unpair"]);
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 32 });

const scrypt = (pin, salt) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(pin, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (error, key) => (error ? reject(error) : resolve(key))),
  );

/** Why a PIN does not fit: "pin-format" (6-12 digits), "pin-weak" (111111, 123456, 987654), or null. */
const pinProblem = (pin) => {
  if (typeof pin !== "string" || !/^\d{6,12}$/.test(pin)) return "pin-format";

  const digits = [...pin].map(Number);
  // a run up or down, 9 → 0 included: 123456, 987654, 1234567890
  const step = (digits[1] - digits[0] + 10) % 10;

  if (digits.every((digit) => digit === digits[0])) return "pin-weak";
  if ((step === 1 || step === 9) && digits.every((digit, i) => i === 0 || (digit - digits[i - 1] + 10) % 10 === step)) return "pin-weak";

  return null;
};

const ms = (value) => (value ? new Date(value).getTime() || null : null);

/** The last moment of today in the NODUS time zone. */
const endOfDay = (now = new Date()) => {
  const end = new Date(now);

  end.setHours(23, 59, 59, 999);
  return end;
};

class ParentalService {
  /**
   * @param {object} deps
   * @param {ReturnType<import("./store").createStore>} deps.store
   * @param {import("./hub").Hub} deps.hub
   * @param {import("./name-index").NameIndex} deps.index
   * @param {(userId: string, text: string) => Promise<void>} deps.notify spoken to the owner
   * @param {{ fire: Function }} deps.events scenario events
   * @param {(key: string, vars?: object) => string} deps.t
   */
  constructor({ store, hub, index, notify, events, t, log = () => {} }) {
    this.store = store;
    this.hub = hub;
    this.index = index;
    this.notify = notify;
    this.events = events;
    this.t = t;
    this.log = log;
    /** deviceId → record */
    this.records = new Map();
    /** deviceId → timer of "vanished without shutting down" */
    this.vanish = new Map();
  }

  async init() {
    for (const record of await this.store.parental.all()) {
      this.records.set(record.deviceId, record);
      this.index.setParental(record.deviceId, Boolean(record.enabled));
    }
  }

  get(deviceId) {
    return this.records.get(deviceId) ?? null;
  }

  isEnabled(deviceId) {
    return Boolean(this.records.get(deviceId)?.enabled);
  }

  /** The `parental` message for the client: rules, the PIN hash, unlocks, what NODUS counted. */
  payload(deviceId) {
    const record = this.records.get(deviceId);

    if (!record?.enabled) return { enabled: false, rev: record?.rev ?? 0 };

    return {
      enabled: true,
      rev: record.rev ?? 0,
      rules: P.sanitizeParental(record.rules),
      pin: record.pin ?? null,
      grantUntil: ms(record.grantUntil),
      resetAt: ms(record.resetAt),
      usage: record.usage ?? null,
    };
  }

  /** The view for the personal page: never the PIN hash. */
  view(deviceId) {
    const record = this.records.get(deviceId);
    const grantUntil = ms(record?.grantUntil);

    return {
      enabled: Boolean(record?.enabled),
      rules: P.sanitizeParental(record?.rules),
      pinSet: Boolean(record?.pin?.hash),
      usage: record?.usage ?? null,
      grantUntil: grantUntil && grantUntil > Date.now() ? grantUntil : null,
    };
  }

  async save(deviceId, userId, fields, { bump = true } = {}) {
    await this.store.parental.save(deviceId, { userId: String(userId), ...fields }, { bump });

    const record = await this.store.parental.byDevice(deviceId);

    this.records.set(deviceId, record);
    this.index.setParental(deviceId, Boolean(record?.enabled));
    if (bump) this.hub.sendParental(deviceId, this.payload(deviceId));

    return record;
  }

  /** Turn on or off; turning on starts with the default rules when there are none. */
  setEnabled(device, enabled) {
    const record = this.records.get(device.deviceId);
    const fields = { enabled: Boolean(enabled) };

    if (enabled && !record?.rules) fields.rules = P.sanitizeParental({});
    if (!enabled) fields.grantUntil = null;

    return this.save(device.deviceId, device.userId, fields);
  }

  setRules(device, rules) {
    return this.save(device.deviceId, device.userId, { rules: P.sanitizeParental(rules) });
  }

  /** @returns {Promise<string|null>} an error code or null */
  async setPin(device, pin) {
    const problem = pinProblem(pin);

    if (problem) return problem;

    const salt = crypto.randomBytes(16).toString("hex");
    const hash = (await scrypt(pin, salt)).toString("hex");

    await this.save(device.deviceId, device.userId, { pin: { hash, salt, ...SCRYPT } });
    return null;
  }

  /** Lift the limits for `minutes`, or till the end of the day ("day"). */
  async grant(device, minutes) {
    const until = minutes === "day" ? endOfDay() : new Date(Date.now() + Math.max(1, Math.round(Number(minutes) || 0)) * 60_000);

    await this.save(device.deviceId, device.userId, { grantUntil: until });
    return until;
  }

  revoke(device) {
    return this.save(device.deviceId, device.userId, { grantUntil: null });
  }

  /** Today's counters back to zero: the client resets its own on `resetAt`. */
  resetToday(device) {
    return this.save(device.deviceId, device.userId, { resetAt: new Date(), usage: null });
  }

  async remove(deviceId) {
    this.records.delete(deviceId);
    this.cancelVanish(deviceId);
    await this.store.parental.remove(deviceId);
  }

  /** Usage from the client's `state`: kept for the page and for a client that lost its file. */
  usage(device, usage) {
    const record = this.records.get(device?.deviceId);

    if (!record?.enabled || !usage) return;

    const previous = record.usage;

    record.usage = usage;
    if (usage.locked && usage.locked !== previous?.locked) {
      this.events.fire("parental_limit", device, { text: device.name, limit: usage.locked }, { ownerId: record.userId });
    }

    // the store gets it about once a minute: state comes every second while something changes
    const changed = !previous || previous.day !== usage.day || previous.locked !== usage.locked || Math.abs((previous.pcSec ?? 0) - usage.pcSec) >= 60 || Math.abs((previous.gameSec ?? 0) - usage.gameSec) >= 60;

    if (changed) this.store.parental.save(device.deviceId, { userId: record.userId, usage }, { bump: false }).catch((error) => this.log(`parental usage: ${error.message}`));
  }

  /** An alert from the client. */
  alert(device, kind, { until = null } = {}) {
    const record = this.records.get(device?.deviceId);

    if (!record || !P.ALERT_KINDS.includes(kind)) return;

    // unlocked with the PIN on the PC: NODUS keeps the time, so new rules do not cut it short
    if (kind === "pin-unlock" && Number.isFinite(until) && until > Date.now() && until < Date.now() + 13 * 3600_000) {
      record.grantUntil = new Date(until);
      this.store.parental.save(device.deviceId, { userId: record.userId, grantUntil: record.grantUntil }, { bump: false }).catch((error) => this.log(`parental grant: ${error.message}`));
    }

    if (kind === "extended") {
      this.events.fire("parental_extended", device, { text: device.name }, { ownerId: record.userId });
      return;
    }

    const texts = { killed: "parental.killed", "unclean-exit": "parental.unclean_exit", "pin-failed": "parental.pin_failed", "pin-unlock": "parental.pin_unlock" };

    if (!texts[kind]) return;
    this.events.fire("parental_alert", device, { text: device.name, alert: kind }, { ownerId: record.userId });
    this.notify(record.userId, this.t(texts[kind], { pc: device.name })).catch((error) => this.log(`parental notify: ${error.message}`));
  }

  online(device) {
    this.cancelVanish(device?.deviceId);
  }

  /** A PC under control disconnected: without "bye" it may have been killed or unplugged. */
  offline(device, reason) {
    const record = this.records.get(device?.deviceId);

    if (!record?.enabled || CLEAN_BYE.has(reason)) return;
    this.cancelVanish(device.deviceId);

    const timer = setTimeout(() => {
      try {
        this.vanish.delete(device.deviceId);
        if (this.hub.isOnline(device.deviceId)) return;
        this.events.fire("parental_alert", device, { text: device.name, alert: "vanished" }, { ownerId: record.userId });
        this.notify(record.userId, this.t("parental.vanished", { pc: device.name })).catch((error) => this.log(`parental notify: ${error.message}`));
      } catch (error) {
        this.log(`parental vanish: ${error.message}`);
      }
    }, VANISH_MS);

    timer.unref?.();
    this.vanish.set(device.deviceId, timer);
  }

  cancelVanish(deviceId) {
    clearTimeout(this.vanish.get(deviceId));
    this.vanish.delete(deviceId);
  }

  dispose() {
    for (const timer of this.vanish.values()) clearTimeout(timer);
    this.vanish.clear();
  }
}

module.exports = { ParentalService, pinProblem, endOfDay, VANISH_MS, SCRYPT };
