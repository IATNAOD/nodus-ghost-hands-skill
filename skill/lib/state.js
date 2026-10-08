/**
 * The loaded skill for code that gets no ctx of its own: match() of wildcard
 * intents, routes and scenario nodes. null while the skill is not loaded.
 */
"use strict";

let current = null;

module.exports = {
  set(value) {
    current = value;
  },
  /** @returns {{ skill: object, index: import("./name-index").NameIndex, hub: import("./hub").Hub } | null} */
  get() {
    return current;
  },
};
