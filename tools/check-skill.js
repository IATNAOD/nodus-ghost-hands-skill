// check-skill.js - node check-skill.js <папка скилла>; код возврата 1 - есть проблемы
const fs = require("fs");
const path = require("path");

const dir = path.resolve(process.argv[2] || ".");
const PERMISSIONS = ["socketTTS", "socketSTT", "synthesizeText", "homeSkill", "secrets",
  "verifyIdentity", "askUser", "scenarioEngine", "notify"];
const PROVIDERS = ["local", "ollama", "anthropic", "openai", "gemini"];
const TAKEN = ["base", "translation", "home_automation", "media", "youtube_music", "yandex_music",
  "telegram", "telegram_bot", "discord_bot", "lists", "briefing", "ambience"];
const problems = [];
const check = (ok, text) => ok || problems.push(text);
const has = (rel) => fs.existsSync(path.join(dir, String(rel).replace(/^\/+/, "")));
const readJson = (rel) => {
  if (!has(rel)) return check(false, `нет ${rel}`), {};
  const raw = fs.readFileSync(path.join(dir, rel), "utf8");
  check(raw.charCodeAt(0) !== 0xfeff, `${rel}: BOM`);
  try { return JSON.parse(raw.replace(/^\uFEFF/, "")); } catch (e) { return check(false, `${rel}: ${e.message}`), {}; }
};

const m = readJson("skill.json");
for (const key of ["id", "llm", "name", "version", "description", "permissions"]) check(key in m, `нет ${key}`);
check(typeof m.id === "string" && /^[a-z0-9_-]+$/.test(m.id) && !TAKEN.includes(m.id), "id: [a-z0-9_-]+, не занятый");
check(typeof m.version === "string" && /^\d+\.\d+\.\d+$/.test(m.version), "version: X.Y.Z");
for (const key of ["name", "description"]) check(typeof m[key] === "string" && m[key].trim(), `${key}: непустая строка`);
check(Array.isArray(m.permissions) && m.permissions.every((p) => PERMISSIONS.includes(p)), "permissions: из 9 значений");
const providers = m.llm?.providers === undefined ? [] : m.llm.providers;
check(m.llm?.constructor === Object && Array.isArray(providers) && providers.every((p) => PROVIDERS.includes(p)),
  "llm: объект, providers из 5 типов");
for (const file of ["index.js", m.settingsPath, m.userSettingsPath, m.mediaProvider?.accountPath])
  check(typeof file !== "string" || !file || has(file), `нет ${file}`);
for (const name of has("locales") ? fs.readdirSync(path.join(dir, "locales")) : [])
  if (name.endsWith(".json")) readJson(`locales/${name}`);

console.log(problems.join("\n") || "ok");
process.exitCode = problems.length ? 1 : 0;
