// dev-install.js - заменить скилл на устройстве архивом и включить (Node 22, без зависимостей)
//   NODUS_URL=http://192.168.1.50 NODUS_USER=admin NODUS_PASSWORD=... node dev-install.js dist/my_skill-1.0.0.zip [id]
const fs = require("fs");
const path = require("path");

const BASE = String(process.env.NODUS_URL || "").replace(/\/+$/, "");
const zipPath = process.argv[2];
const id = process.argv[3] || path.basename(zipPath).replace(/-\d+\.\d+\.\d+\.zip$/, "");
let cookie = "";

const call = async (method, url, { json, form } = {}) => {
  const res = await fetch(BASE + url, {
    method,
    headers: { cookie, ...(json && { "content-type": "application/json" }) },
    body: json ? JSON.stringify(json) : form,
  });
  const body = await res.json().catch(() => ({}));

  if (url.endsWith("/login")) cookie = res.headers.getSetCookie().map((line) => line.split(";")[0]).join("; ");
  return { status: res.status, ...body };
};

(async () => {
  const login = await call("POST", "/api/v1/user/login", { json: { username: process.env.NODUS_USER, password: process.env.NODUS_PASSWORD } });

  if (login.status !== 200) throw new Error(`вход: HTTP ${login.status}`);

  // выгрузить старую версию, в том числе загруженную наполовину; у нового скилла - "Skill not found"
  await call("PATCH", "/api/v1/skills", { json: { id, enabled: false } });

  const form = new FormData();

  form.append("file", new Blob([fs.readFileSync(zipPath)]), path.basename(zipPath));

  const installed = await call("POST", "/api/v1/skills", { form });

  if (!installed.success) throw new Error(`установка: ${installed.message}`);

  // здесь выполняется init(): его исключение придёт текстом
  const enabled = await call("PATCH", "/api/v1/skills", { json: { id: installed.result.id, enabled: true } });

  if (!enabled.success) throw new Error(`включение: ${enabled.message}`);

  const { skill } = (await call("GET", `/api/v1/skills/${installed.result.id}/info`)).result;

  console.log(`${skill.id} ${skill.version} loaded=${skill.loaded}`);
  console.log(`интенты: ${skill.intents.map((intent) => intent.id).join(", ") || "-"}; блоки: ${skill.nodes.map((node) => node.id).join(", ") || "-"}`);
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
