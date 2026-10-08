/**
 * Personal connection keys: GH-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX (Crockford base32, 120 bits).
 * The database keeps sha256 for lookup and the key itself encrypted with the
 * device key (ctx.secrets) to show it again on the personal page.
 */
"use strict";

const crypto = require("crypto");
const { KEY_ALPHABET, KEY_BODY_LENGTH, normalizeKey } = require("./protocol");

const generateKey = () => {
  const bytes = crypto.randomBytes((KEY_BODY_LENGTH * 5) / 8);
  let value = 0;
  let bits = 0;
  let body = "";

  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      body += KEY_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  return normalizeKey(`GH${body}`);
};

/** sha256 of the canonical key, "" for anything that is not a key. */
const hashKey = (key) => {
  const canonical = normalizeKey(key);

  return canonical ? crypto.createHash("sha256").update(canonical).digest("hex") : "";
};

/** "GH-7K3M-••••-••••-••••-••••-Q2ZX" */
const maskKey = (key) => {
  const canonical = normalizeKey(key);

  return canonical ? `${canonical.slice(0, 7)}-••••-••••-••••-••••-${canonical.slice(-4)}` : "";
};

/** Short random id for PCs: route-safe [A-Za-z0-9_-]. */
const newDeviceId = () => crypto.randomBytes(9).toString("base64url");

module.exports = { generateKey, hashKey, maskKey, newDeviceId };
