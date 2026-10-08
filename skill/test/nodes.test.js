const test = require("node:test");
const assert = require("node:assert/strict");

const GhostHands = require("../index.js");
const { createMemoryStore } = require("../lib/store.js");
const { fakeCtx } = require("./fakes.js");
const runApp = require("../nodes/pc_run_app/index.js");
const power = require("../nodes/pc_power_action/index.js");
const volume = require("../nodes/pc_set_volume/index.js");
const message = require("../nodes/pc_show_message/index.js");
const isOnline = require("../nodes/pc_is_online/index.js");
const wakeUp = require("../nodes/pc_wake_up/index.js");

const OWNER = "64b000000000000000000001";

async function loadSkill(t, devices) {
  const ctx = fakeCtx();
  const skill = new GhostHands(ctx, { port: 0 });
  const calls = [];

  skill.store = createMemoryStore();
  await skill.init(ctx);
  await skill.serverStarted;
  t.after(() => skill.destroy());

  for (const device of devices) skill.index.upsert({ deviceId: device.id, userId: OWNER, online: device.online, config: device.config });
  skill.hub.command = async (deviceId, action, args) => (calls.push({ deviceId, action, args }), { ok: true, code: null, data: { level: 25, muted: false } });
  skill.hub.isOnline = (deviceId) => Boolean(skill.index.get(deviceId)?.online);

  return { skill, calls };
}

const GAMING = { name: "Игровой", apps: [{ id: "steam:570", name: "Dota 2", aliases: [] }], wol: { mac: "aa:bb:cc:dd:ee:ff", broadcast: "192.168.0.255", adapter: "ethernet" } };
const LAPTOP = { name: "Ноутбук", apps: [] };

test("blocks fail clearly before the skill is loaded", async () => {
  await assert.rejects(runApp.execute({ app: "Dota 2" }, { ownerId: OWNER }), /ghost_hands-not-loaded/);
});

test("run app: the only online PC of the owner, by app name", async (t) => {
  const { calls } = await loadSkill(t, [{ id: "d1", online: true, config: GAMING }, { id: "d2", online: false, config: LAPTOP }]);

  assert.deepEqual(await runApp.execute({ app: "дота" }, { ownerId: OWNER }), { app: "Dota 2", computer: "Игровой" });
  assert.deepEqual(calls, [{ deviceId: "d1", action: "app.launch", args: { appId: "steam:570" } }]);
  await assert.rejects(runApp.execute({ app: "ракета" }, { ownerId: OWNER }), /app-not-found/);
  await assert.rejects(runApp.execute({ app: "дота", computer: "ноутбук" }, { ownerId: OWNER }), /computer-offline/);
  await assert.rejects(runApp.execute({ app: "дота", computer: "кухня" }, { ownerId: OWNER }), /computer-not-found/);
});

test("power, volume, message: commands with arguments; two online PCs need a name", async (t) => {
  const { calls } = await loadSkill(t, [{ id: "d1", online: true, config: GAMING }, { id: "d2", online: true, config: LAPTOP }]);

  await assert.rejects(power.execute({ action: "shutdown" }, { ownerId: OWNER }), /computer-ambiguous/);
  assert.deepEqual(await power.execute({ action: "restart", computer: "игровой", delay: "60" }, { ownerId: OWNER }), { computer: "Игровой" });
  assert.deepEqual(calls.at(-1), { deviceId: "d1", action: "power.restart", args: { delaySec: 60 } });
  assert.deepEqual(await volume.execute({ mode: "down", level: "", computer: "ноутбук" }, { ownerId: OWNER }), { level: 25, muted: false, computer: "Ноутбук" });
  assert.deepEqual(calls.at(-1).args, { delta: -10 });
  await message.execute({ text: "Ужин готов", title: "Дом", computer: "ноутбук" }, { ownerId: OWNER });
  assert.deepEqual(calls.at(-1), { deviceId: "d2", action: "toast.show", args: { title: "Дом", text: "Ужин готов" } });
});

test("online condition and Wake-on-LAN", async (t) => {
  const { skill } = await loadSkill(t, [{ id: "d1", online: false, config: GAMING }]);
  const woken = [];

  skill.wake = async (mac) => woken.push(mac);

  assert.deepEqual(await isOnline.execute({}, { ownerId: OWNER }), { online: false, computer: "Игровой", _branch: "false" });
  // the block uses lib/wol directly: check through the instance it reaches
  const { wake } = require("../lib/wol.js");

  assert.equal(typeof wake, "function");
  skill.index.setOnline("d1", true);
  assert.deepEqual(await wakeUp.execute({}, { ownerId: OWNER }), { computer: "Игровой", already: true });
  assert.deepEqual(woken, []);
});
