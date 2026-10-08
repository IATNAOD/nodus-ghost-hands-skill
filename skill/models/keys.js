// Personal connection key of a user: sha256 for lookup, the key itself encrypted with ctx.secrets
module.exports = {
  name: "Keys",
  schema: {
    userId: { type: String, required: true, unique: true },
    userName: { type: String, default: "" },
    keyHash: { type: String, required: true, unique: true },
    keyEnc: { type: String, default: "", select: false },
    createdAt: { type: Date, default: Date.now },
    lastUsedAt: { type: Date, default: null },
  },
};
