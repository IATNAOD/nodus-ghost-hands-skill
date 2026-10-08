// dev-host.js - the skill in plain Node, without a NODUS device:
//   node tools/dev-host.js [--port 47300] [--panel 8080] [--female] [--en]
// - the real WebSocket server for PCs (the Electron client or tools/fake-client.js);
// - a mini panel at http://localhost:<panel>/ with the personal page ("Мои настройки")
//   and its routes for a dev user;
// - a console: type a phrase as if said to NODUS, answer its questions, see the reply.
// Data lives in memory: a restart forgets keys and PCs (the dev key is printed at start).
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const skillDir = path.join(__dirname, "../skill");
const GhostHands = require(path.join(skillDir, "index.js"));
const routes = require(path.join(skillDir, "routes/index.js"));
const { createMemoryStore } = require(path.join(skillDir, "lib/store.js"));
const { generateKey, hashKey } = require(path.join(skillDir, "lib/keys.js"));
const { classify } = require(path.join(skillDir, "lib/parse.js"));
const { runCommand } = require(path.join(skillDir, "lib/command.js"));
const { fakeCtx, captureRoutes } = require(path.join(skillDir, "test/fakes.js"));
const pcStatus = require(path.join(skillDir, "intents/pc_status/index.js"));
const { score } = require(path.join(skillDir, "lib/nodus-routing.js"));

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);

  return index >= 0 ? process.argv[index + 1] : fallback;
};
const port = Number(arg("port", 47300));
const panelPort = Number(arg("panel", 8080));
const language = process.argv.includes("--en") ? "en" : "ru";
const female = process.argv.includes("--female");
const USER = { id: "64b0000000000000000000d1", name: "Разработчик", role: "admin" };

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "скажи> " });
const question = (text) => new Promise((resolve) => rl.question(`NODUS: ${text}\nты> `, (answer) => resolve(answer.trim() || null)));

/** ctx of one voice command: askUser reads the console */
const commandCtx = (text) => {
  const ctx = fakeCtx({ language, female, text, userId: USER.id, userName: USER.name });

  ctx.askUser = async (text_) => {
    const answer = await question(text_);

    return answer === null ? null : { text: answer, speaker: USER.id };
  };
  ctx.synthesizeText = async (phrase) => (console.log(`NODUS (вслух): ${phrase}`), { success: true, request_id: "dev" });

  return ctx;
};

async function main() {
  const ctx = fakeCtx({ language, female });

  ctx.notify = async (note) => (console.log(`\nNODUS (уведомление для ${note.to ?? "дома"}): ${note.text}`), { id: "1", delivered: true });
  ctx.scenarioEngine = { fireSkillEvent: async (...args) => (console.log(`\n[событие] ${args[1]} ${JSON.stringify(args[2])}`), 0) };

  const skill = new GhostHands(ctx, { port });

  skill.store = createMemoryStore();

  const key = generateKey();

  await skill.store.keys.put(USER.id, { userName: USER.name, keyHash: hashKey(key), keyEnc: ctx.secrets.encrypt(key) });
  await skill.init(ctx);
  await skill.serverStarted;

  const handlers = await captureRoutes(routes);
  const page = fs.readFileSync(path.join(skillDir, "account/index.html"), "utf8");
  const shell = `<!DOCTYPE html><meta charset="utf-8"><title>Ghost Hands dev panel</title>
<body style="margin:0;background:#171021;font:14px system-ui;color:#f8f6fc">
<div style="padding:12px 16px;border-bottom:1px solid #2b2140">dev panel · ${USER.name} · <a style="color:#ad67ff" href="#" onclick="lang('ru')">ru</a> / <a style="color:#ad67ff" href="#" onclick="lang('en')">en</a></div>
<iframe id="f" src="/api/v1/skills/ghost_hands/user-page" style="width:100%;border:0;height:480px"></iframe>
<script>
  const f = document.getElementById("f");
  let language = "${language}";
  const init = () => f.contentWindow.postMessage({ type: "init", data: { configs: {}, language, theme: "dark" } }, location.origin);
  function lang(value) { language = value; init(); return false; }
  f.addEventListener("load", init);
  addEventListener("message", (event) => {
    if (event.source !== f.contentWindow) return;
    const { type, data } = event.data || {};
    if (type === "resize") f.style.height = Math.max(240, Number(data.height) || 480) + "px";
    if (type === "notify") console.log("[notify]", data.level, data.message);
  });
</script>`;

  const panel = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");

      if (url.pathname === "/") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(shell);
      if (url.pathname === "/api/v1/skills/ghost_hands/user-page") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);

      const match = /^\/api\/v1\/skills\/ghost_hands\/routes(\/.*)$/.exec(url.pathname);

      if (!match) return res.writeHead(404).end();

      const body = await new Promise((resolve) => {
        let data = "";

        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data ? JSON.parse(data) : undefined));
      });
      const segments = match[1].split("/").filter(Boolean);
      const entry = Object.entries(handlers).find(([routeKey]) => {
        const [method, pattern] = routeKey.split(" ");
        const parts = pattern.split("/").filter(Boolean);

        return method === req.method && parts.length === segments.length && parts.every((part, i) => part.startsWith(":") || part === segments[i]);
      });

      if (!entry) return res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ success: false, message: "route-not-found", result: {} }));

      const params = {};

      entry[0].split(" ")[1].split("/").filter(Boolean).forEach((part, i) => part.startsWith(":") && (params[part.slice(1)] = decodeURIComponent(segments[i])));

      const reply = { statusCode: 200, body: {} };

      reply.code = (code) => Object.assign(reply, { statusCode: code });
      reply.send = (value) => Object.assign(reply, { body: value });

      const returned = await entry[1]({ params, body: body ?? {}, url: req.url, headers: { "x-nod-user-id": USER.id, "x-nod-user-role": USER.role, "x-nod-user-name": encodeURIComponent(USER.name) } }, reply);
      const result = returned && returned !== reply && !returned.statusCode ? returned : reply.body;

      res.writeHead(reply.statusCode, { "content-type": "application/json" }).end(JSON.stringify(result ?? {}));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ success: false, message: error.message, result: {} }));
    }
  });

  panel.on("error", (error) => console.error(`panel: ${error.message}`));
  panel.listen(panelPort, () => {
    console.log(`Ghost Hands dev host
  PC server:  ws://<this computer>:${skill.server.address()}/gh   (${skill.server.status().state})
  panel:      http://localhost:${panelPort}/
  key:        ${key}
  fake PC:    node tools/fake-client.js --key ${key} --port ${skill.server.address()}
Say a phrase; ":set <setting> <value>" changes a skill setting (":set app_confidence 80"); empty line - exit:`);
    rl.prompt();
  });

  // device settings of the skill, as the panel would save them
  let devConfigs = [];

  rl.on("line", async (line) => {
    const text = line.trim();
    const setting = text.match(/^:set\s+(\w+)\s+(.+)$/);

    if (setting) {
      const [, key, raw] = setting;
      const value = raw === "true" ? true : raw === "false" ? false : Number.isFinite(Number(raw)) ? Number(raw) : raw;

      devConfigs = [...devConfigs.filter((entry) => entry.key !== key), { key, value }];
      skill.onConfigChange(devConfigs);
      console.log(`settings: ${JSON.stringify(Object.fromEntries(devConfigs.map((entry) => [entry.key, entry.value])))}`);
      rl.prompt();
      return;
    }

    if (!text) {
      await skill.destroy();
      panel.close();
      rl.close();
      return;
    }

    rl.pause();

    try {
      const parsed = classify(text, { index: skill.index, userId: USER.id });
      const statusScore = score(pcStatus, text);
      const intent = parsed?.intent ?? (statusScore !== null && statusScore >= 3 ? "pc_status" : null);

      if (!intent) {
        console.log("(не наша фраза: NODUS отдал бы её другому навыку или ИИ)");
      } else {
        console.log(`[${intent}${parsed ? ` ${parsed.score}` : ""}] ${parsed ? JSON.stringify(parsed.params) : ""}`);
        console.log(`NODUS: ${(await runCommand(commandCtx(text), devConfigs, intent, parsed?.params ?? {})) || "(молчит)"}`);
      }
    } catch (error) {
      console.error(`! ${error.stack}`);
    }

    rl.resume();
    rl.prompt();
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
