// Parental control of a PC, set by its owner on the personal page and enforced by the client.
// A model of its own: Devices.config is replaced by every config from the client. What may
// change between versions lives in Mixed fields (a new schema applies only after a restart).
module.exports = {
  name: "Parental",
  schema: {
    deviceId: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },
    enabled: { type: Boolean, default: false },
    // limits, "+N minutes" buttons, unlock time, games (sanitizeParental in lib/protocol.js)
    rules: { type: Object, default: null },
    // scrypt of the PIN: { hash, salt, N, r, p, keylen }; the PIN itself is never stored
    pin: { type: Object, default: null },
    // what the client counted today: { day, pcSec, gameSec, extended, locked }
    usage: { type: Object, default: null },
    grantUntil: { type: Date, default: null },
    // "reset the counters for today" pressed at this moment
    resetAt: { type: Date, default: null },
    rev: { type: Number, default: 0 },
    updatedAt: { type: Date, default: Date.now },
  },
};
