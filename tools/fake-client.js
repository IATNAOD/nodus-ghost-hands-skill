// fake-client.js - a pretend PC for the skill's WebSocket server (Node 22, ws from the root package).
//   node tools/fake-client.js --key GH-XXXX-... [--host 127.0.0.1] [--port 47300] [--name Игровой] [--shared]
// Sends hello, a config with a few apps and the state; prints every command and answers it.
"use strict";

const os = require("os");
const crypto = require("crypto");
const WebSocket = require("ws");
const P = require("../skill/lib/protocol.js");

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);

  return index >= 0 ? process.argv[index + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const key = arg("key", "");
const host = arg("host", "127.0.0.1");
const port = Number(arg("port", P.DEFAULT_PORT));
const name = arg("name", "Игровой");
const machineHash = crypto.createHash("sha256").update(`${os.hostname()}:${name}`).digest("hex");

if (!P.normalizeKey(key)) {
  console.error("usage: node tools/fake-client.js --key GH-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX [--host ...] [--port ...] [--name ...]");
  process.exit(1);
}

const apps = [
  { id: "steam:570", name: "Dota 2", aliases: ["дота"], kind: "game", source: "steam" },
  { id: "steam:730", name: "Counter-Strike 2", aliases: ["кс", "контра"], kind: "game", source: "steam" },
  { id: "epic:Calluna", name: "Control", aliases: [], kind: "game", source: "epic" },
  { id: "start:chrome", name: "Google Chrome", aliases: ["хром"], kind: "app", source: "start" },
  { id: "start:discord", name: "Discord", aliases: [], kind: "app", source: "start" },
  { id: "virtual:browser", name: "Браузер", aliases: ["browser"], kind: "app", source: "virtual" },
];
const pc = { volume: 40, muted: false, running: new Map([["exe:discord", { key: "exe:discord", name: "Discord", appId: "start:discord", game: false, fg: false }]]), shutdownAt: null };
let deviceId = arg("device-id", null);
let rev = 1;
let backoff = 1000;

const state = () => ({ running: [...pc.running.values()], volume: pc.volume, muted: pc.muted, shutdownAt: pc.shutdownAt });

function handle(ws, message) {
  const { id, action, args = {} } = message;
  const reply = (fields) => ws.send(P.encode(P.MSG.RESULT, { id, ...fields }));
  const app = apps.find((item) => item.id === args.appId);

  console.log(`→ ${action} ${JSON.stringify(args)}`);

  switch (action) {
    case "app.launch":
      if (!app) return reply({ ok: false, code: "app-not-found" });
      pc.running.set(`exe:${app.id}`, { key: `exe:${app.id}`, name: app.name, appId: app.id, game: app.kind === "game", fg: true });
      ws.send(P.encode(P.MSG.STATE, { data: state() }));
      return reply({ ok: true, data: { already: false } });
    case "app.close": {
      const target = args.target === "game" ? [...pc.running.values()].find((item) => item.game) : [...pc.running.values()].find((item) => item.appId === args.appId || item.key === args.key);

      if (!target) return reply({ ok: false, code: "not-running" });
      pc.running.delete(target.key);
      ws.send(P.encode(P.MSG.STATE, { data: state() }));
      return reply({ ok: true, data: { name: target.name, closed: [1], pending: [] } });
    }
    case "volume.get":
      return reply({ ok: true, data: { level: pc.volume, muted: pc.muted } });
    case "volume.set":
      pc.volume = args.level;
      return reply({ ok: true, data: { level: pc.volume, muted: pc.muted } });
    case "volume.change":
      pc.volume = Math.min(100, Math.max(0, pc.volume + args.delta));
      return reply({ ok: true, data: { level: pc.volume, muted: pc.muted } });
    case "volume.mute":
      pc.muted = args.muted;
      return reply({ ok: true, data: { level: pc.volume, muted: pc.muted } });
    case "power.shutdown":
    case "power.restart":
      pc.shutdownAt = Date.now() + (args.delaySec || 15) * 1000;
      ws.send(P.encode(P.MSG.STATE, { data: state() }));
      return reply({ ok: true, data: { at: pc.shutdownAt } });
    case "power.cancel": {
      const cancelled = Boolean(pc.shutdownAt);

      pc.shutdownAt = null;
      ws.send(P.encode(P.MSG.STATE, { data: state() }));
      return reply({ ok: true, data: { cancelled } });
    }
    default:
      return reply({ ok: true, data: {} });
  }
}

function connect() {
  const url = `ws://${host}:${port}${P.WS_PATH}`;
  const ws = new WebSocket(url);

  ws.on("error", (error) => console.error(`! ${error.message}`));
  ws.on("open", () => {
    backoff = 1000;
    ws.send(P.encode(P.MSG.HELLO, { proto: P.PROTO, key, deviceId, device: { name, aliases: [], machineHash, os: "Windows 10 (fake)", host: os.hostname(), client: "0.0.0-fake" } }));
  });
  ws.on("message", (raw) => {
    const message = P.decode(raw);

    if (!message) return;
    switch (message.t) {
      case P.MSG.WELCOME:
        deviceId = message.deviceId;
        console.log(`✓ connected as ${message.name} (${deviceId}), owner ${message.owner.name}`);
        ws.send(P.encode(P.MSG.CONFIG, { rev: rev++, data: { name, shared: flag("shared"), apps, features: {}, prefs: { confirmPower: true, searchEngine: "google" }, wol: { mac: "02:00:00:00:00:01", broadcast: "192.168.0.255", adapter: "ethernet" }, client: { version: "0.0.0-fake", os: "Windows 10" } } }));
        ws.send(P.encode(P.MSG.STATE, { data: state() }));
        break;
      case P.MSG.CONFIG_ACK:
        console.log(`✓ config ${message.rev}${message.error ? ` error ${message.error}` : ""}${message.warnings?.length ? ` warnings ${JSON.stringify(message.warnings)}` : ""}`);
        break;
      case P.MSG.CMD:
        handle(ws, message);
        break;
      case P.MSG.LEARN:
        console.log(`✓ learned «${message.alias}» for ${message.appId}`);
        break;
      default:
        break;
    }
  });
  ws.on("close", (code, reason) => {
    console.log(`× closed ${code} ${String(reason)}`);
    if ([P.CLOSE.AUTH_FAILED, P.CLOSE.UNPAIRED, P.CLOSE.NAME_TAKEN, P.CLOSE.PROTO_UNSUPPORTED].includes(code)) process.exit(2);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  });
}

connect();
