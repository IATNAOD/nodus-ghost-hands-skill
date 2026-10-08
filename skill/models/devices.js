// A paired PC. Everything that changes between versions lives in `config` (Mixed):
// a new model schema applies only after the skills process restarts.
module.exports = {
  name: "Devices",
  schema: {
    deviceId: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },
    userName: { type: String, default: "" },
    name: { type: String, default: "" },
    machineHash: { type: String, default: "" },
    config: { type: Object, default: null },
    configRev: { type: Number, default: 0 },
    lastSeenAt: { type: Date, default: null },
    lastIp: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
  },
};
