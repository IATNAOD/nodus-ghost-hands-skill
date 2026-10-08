// Checks of the package without running it: locales, export types, what the portal scans.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const manifest = require("../skill.json");

const files = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) return entry.name === "test" || entry.name === "node_modules" ? [] : files(full);
    return [full];
  });

const sources = files(root).filter((file) => file.endsWith(".js"));
const locales = Object.fromEntries(["ru", "en"].map((language) => [language, JSON.parse(fs.readFileSync(path.join(root, `locales/${language}.json`), "utf8"))]));
const flatKeys = (node, prefix = "") =>
  Object.entries(node).flatMap(([key, value]) => (typeof value === "object" ? flatKeys(value, `${prefix}${key}.`) : [`${prefix}${key}`]));
const baseKey = (key) => key.replace(/(_female)?(_(zero|one|two|few|many|other))?$/, "");

test("every language has the same keys", () => {
  const sets = Object.fromEntries(Object.entries(locales).map(([language, bundle]) => [language, new Set(flatKeys(bundle).map(baseKey))]));

  for (const [language, set] of Object.entries(sets)) {
    for (const [other, otherSet] of Object.entries(sets)) assert.deepEqual([...otherSet].filter((key) => !set.has(key)), [], `${other} has keys that ${language} lacks`);
  }
});

test("keys used in the code exist", () => {
  const known = new Set(flatKeys(locales.ru).map(baseKey));
  const used = new Set();

  for (const file of sources) {
    const code = fs.readFileSync(file, "utf8");

    for (const match of code.matchAll(/\bt\((?:env,\s*)?"([a-z_]+(?:\.[a-z_]+)+)"/g)) used.add(match[1]);
    for (const match of code.matchAll(/"(intents\.[a-z_]+\.[a-z_]+)"/g)) used.add(match[1]);
    for (const match of code.matchAll(/key\("([a-z_.]+)"\)/g)) {
      const block = /nodes\.([a-z_]+)\./.exec(code)?.[1] ?? /`nodes\.([a-z_]+)\.\$\{/.exec(code)?.[1];

      if (block) used.add(`nodes.${block}.${match[1]}`);
    }
  }
  // keys built at run time
  for (const op of ["shutdown", "restart", "sleep", "lock", "display_off"]) {
    for (const suffix of ["", "_on_pc", "_many", "_later", "_later_many"]) used.add(`intents.pc_power.${op}${suffix}`);
  }
  for (const op of ["shutdown", "restart"]) for (const suffix of ["", "_open", "_many"]) used.add(`intents.pc_power.confirm_${op}${suffix}`);
  for (const code of ["offline", "timeout", "disconnected", "feature_disabled", "paused", "app_not_found", "launcher_missing", "launch_failed", "needs_elevation", "cancelled", "not_running", "close_timeout", "helper_unavailable", "no_audio_device", "invalid_args", "unknown_action", "busy", "internal"]) {
    used.add(`errors.${code}`);
  }
  for (const key of ["play_pause", "next", "prev"]) used.add(`intents.pc_media.${key}`);
  for (const field of manifest.configSchema) {
    used.add(baseKey(field.label));
    used.add(field.description);
    for (const option of field.options ?? []) used.add(option.label);
  }
  for (const event of manifest.events) used.add(event.label);

  assert.deepEqual([...used].filter((key) => !known.has(baseKey(key))).sort(), []);
});

test("export types: a class, functions, arrays (the core calls them without checks)", () => {
  const Skill = require("../index.js");

  assert.equal(typeof Skill, "function");
  assert.match(Function.prototype.toString.call(Skill), /^class /);
  assert.equal(typeof require("../routes/index.js"), "function");

  for (const dir of fs.readdirSync(path.join(root, "intents"))) {
    const intent = require(path.join(root, "intents", dir, "index.js"));

    assert.equal(intent.id, dir);
    assert.equal(typeof intent.handler, "function", `${dir}.handler`);
    assert.equal(typeof intent.errorResponse, "string", `${dir}.errorResponse`);
    for (const field of ["triggers", "phrases", "context", "antipatterns"]) {
      assert.ok(intent[field] === undefined || (Array.isArray(intent[field]) && intent[field].every((item) => typeof item === "string" && !item.includes(" ") || field === "phrases")), `${dir}.${field}`);
    }
    if (intent.wildcard) assert.equal(typeof intent.match, "function", `${dir}.match`);
  }

  for (const dir of fs.readdirSync(path.join(root, "nodes"))) {
    const node = require(path.join(root, "nodes", dir, "index.js"));

    assert.equal(node.id, dir);
    assert.ok(Array.isArray(node.inputs) && Array.isArray(node.outputs), `${dir} inputs/outputs`);
    assert.equal(typeof node.execute, "function");
  }
});

test("portal code flags: only the network of the WebSocket server and Wake-on-LAN", () => {
  // the same patterns as the portal scanner (guide, «Пометки для модератора»)
  const patterns = {
    "child_process": /child_process|execSync|execFileSync|spawn\(|exec\(/,
    eval: /eval\(|new Function\(/,
    "dynamic-require": /require\((?!["'`]|\s)/,
    "filesystem-write": /writeFile|writeFileSync|appendFile|unlink|unlinkSync|rmSync|rmdirSync|createWriteStream/,
    network: /fetch\(|http\.request|https\.request|net\.connect|net\.createConnection|dgram|new WebSocket|XMLHttpRequest/,
    "process-env": /process\.env|process\.exit|process\.kill/,
    obfuscation: /Buffer\.from\([^)]*base64|\\x[0-9a-f]{2}\\x[0-9a-f]{2}|globalThis\[/i,
  };
  const found = {};

  for (const file of sources) {
    const code = fs.readFileSync(file, "utf8");

    for (const [name, pattern] of Object.entries(patterns)) {
      if (pattern.test(code)) (found[name] ??= []).push(path.relative(root, file).replace(/\\/g, "/"));
    }
  }

  // ctx.user.require() ("Кто это?") looks like a dynamic require to the scanner: allowed only as that call
  for (const file of found["dynamic-require"] ?? []) {
    const code = fs.readFileSync(path.join(root, file), "utf8");
    const calls = [...code.matchAll(/(\S*)require\((?!["'`]|\s)/g)].map((match) => match[1]);

    assert.ok(calls.every((prefix) => prefix === "ctx.user."), `${file}: ${calls.join(", ")}`);
  }
  delete found["dynamic-require"];
  assert.deepEqual(found, { network: ["lib/server.js", "lib/wol.js"] });
});

test("no blocking calls in the shared process", () => {
  for (const file of sources) {
    const code = fs.readFileSync(file, "utf8");

    assert.doesNotMatch(code, /\b\w+Sync\(/, path.relative(root, file));
  }
});
