// Commands sent to PCs, for the personal page; removed after 30 days
module.exports = {
  name: "History",
  schema: {
    userId: { type: String, default: "", index: true },
    deviceId: { type: String, default: "" },
    action: { type: String, default: "" },
    target: { type: String, default: "" },
    ok: { type: Boolean, default: false },
    code: { type: String, default: "" },
    via: { type: String, default: "voice" },
    at: { type: Date, default: Date.now, expires: "30d" },
  },
};
