/**
 * Log lines: to the container log with the skill prefix and into memory for
 * GET /debug (admin only). No keys, tokens or personal settings here.
 */
"use strict";

const lines = [];

const trace = (...parts) => {
  const line = `${new Date().toISOString()} ${parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" ")}`;

  console.log(`[ghost_hands] ${line}`);
  lines.push(line);
  if (lines.length > 200) lines.shift();
};

module.exports = { trace, lines };
