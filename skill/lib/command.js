/**
 * One pipeline for voice intents, the AI agent and scenario blocks:
 * speaker → PC → app → confirmations → command to the PC → answer.
 * Every heard word goes through ctx.t; answers are one or two short phrases.
 */
"use strict";

const state = require("./state");
const { classify } = require("./parse");
const { readSettings } = require("./settings");
const { resolveActor, choosePc, ASK_TIMEOUT_MS } = require("./select");
const { answerKind, isCancel } = require("./confirm");
const { spokenName, prepare, scoreApp, appKey } = require("./names");
const { ordinalOf } = require("./text");
const { pickApp } = require("./llm-pick");
const { wake } = require("./wol");
const { trace } = require("./trace");

const POWER_ACTIONS = {
  shutdown: "power.shutdown",
  restart: "power.restart",
  sleep: "power.sleep",
  lock: "power.lock",
  display_off: "display.off",
  cancel: "power.cancel",
};
const POWER_FEATURES = { lock: "lock", display_off: "display" };
const CONFIRMED_POWER = new Set(["shutdown", "restart"]);
const MAX_DELAY_SEC = 24 * 3600;
// a longer command is logged with its time: until it answers, NODUS does not hear its wake word
const SLOW_MS = 4000;

const ERROR_KEYS = new Set([
  "offline", "timeout", "disconnected", "feature-disabled", "paused", "app-not-found", "launcher-missing",
  "launch-failed", "needs-elevation", "cancelled", "not-running", "close-timeout", "helper-unavailable",
  "no-audio-device", "invalid-args", "unknown-action", "busy", "parental-limit",
]);

/* ── helpers ── */

const t = (env, key, vars) => env.ctx.t(key, vars);

/** Answer for a failed command: "errors.<code>" with the PC and app names. */
const failure = (env, device, result, name = "") =>
  t(env, `errors.${(ERROR_KEYS.has(result.code) ? result.code : "internal").replace(/-/g, "_")}`, { pc: device?.name ?? "", name });

/** Question to the person; null - silence or no permission. */
const ask = async (env, question) => {
  if (typeof env.ctx.askUser !== "function") return null;

  const answer = await env.ctx.askUser(question, { timeoutMs: ASK_TIMEOUT_MS }).catch(() => null);

  return answer?.text ? answer.text : null;
};

/** Yes/no question: "yes" | "no" | "silence". */
const confirm = async (env, question) => {
  const text = await ask(env, question);

  if (text === null) return "silence";

  return answerKind(text) === "yes" ? "yes" : "no";
};

/** Command to a PC with history and the "last PC" memory. */
const send = async (env, actor, device, action, args, target = "") => {
  const result = await env.hub.command(device.deviceId, action, args, env.settings.replyTimeoutMs);

  env.skill.recent.remember(actor.userId, device.deviceId);
  env.skill.store.history
    .add({ userId: actor.userId ?? device.userId, deviceId: device.deviceId, action, target: String(target).slice(0, 120), ok: result.ok, code: result.code ?? "", via: env.via })
    .catch((error) => trace(`history: ${error.message}`));
  if (!result.ok) trace(`${action} on ${device.deviceId}: ${result.code}`);

  return result;
};

/** "На компьютере «Игровой»" only when the person has more than one PC. */
const keyFor = (base, pool) => (pool.length > 1 ? `${base}_on_pc` : base);

/* ── apps ── */

/**
 * Resolve a spoken app name over PCs: certain match, confirmed weak match,
 * a question between close names, the AI pick as the last resort.
 * @returns {Promise<{ ok: true, key: string, name: string, byDevice: Map<string, object>, learn: string|null } | { ok: false, answer: string }>}
 */
async function resolveApp(env, spoken, scope, { running = false, verb = "launch" } = {}) {
  const result = env.index.matchApps(spoken, scope, { running });
  const target = (key, learn = null) => {
    const byDevice = new Map();

    for (const candidate of result.candidates) {
      if (candidate.key !== key) continue;

      const known = byDevice.get(candidate.deviceId);

      if (!known || candidate.score > known.score) byDevice.set(candidate.deviceId, candidate);
    }

    const first = [...byDevice.values()].sort((a, b) => b.score - a.score)[0];

    return { ok: true, key, name: first?.app ? spokenName(first.app) : first?.name ?? spoken, byDevice, learn };
  };

  if (result.status === "match") return target(result.best.key);

  if (result.status === "weak") {
    const name = result.best.app ? spokenName(result.best.app) : result.best.name;
    const answer = await confirm(env, t(env, verb === "close" ? "intents.close_app.confirm" : "intents.launch_app.confirm", { name }));

    if (answer === "yes") return target(result.best.key);

    return { ok: false, answer: t(env, answer === "silence" ? "common.not_heard" : "common.cancelled") };
  }

  if (result.status === "ambiguous") {
    const options = result.options;
    const names = options.map((option) => (option.app ? spokenName(option.app) : option.name));
    const text = await ask(env, t(env, "common.which_app", { names }));

    if (text === null) return { ok: false, answer: t(env, "common.not_heard") };
    if (isCancel(text) || answerKind(text) === "no") return { ok: false, answer: t(env, "common.cancelled") };

    const ordinal = ordinalOf(text);

    if (ordinal && options[ordinal - 1]) return target(options[ordinal - 1].key);

    const tokens = prepare(text);
    const best = options
      .map((option) => ({ option, score: option.app ? scoreApp(tokens, option.app).score : 0 }))
      .sort((a, b) => b.score - a.score)[0];

    return best && best.score >= 0.75 ? target(best.option.key) : { ok: false, answer: t(env, "common.not_understood") };
  }

  // nobody matched: the AI may know that "ведьмак" is "The Witcher"
  if (env.settings.aiNames) {
    const choices = uniqueApps(scope, running);
    const started = Date.now();
    const picked = await pickApp(env.ctx, spoken, choices);

    trace(`ai pick "${spoken}": ${picked ? picked.name : "none"} in ${Date.now() - started} ms`);

    if (picked) {
      const answer = await confirm(env, t(env, verb === "close" ? "intents.close_app.confirm" : "intents.launch_app.confirm", { name: picked.name }));

      if (answer !== "yes") return { ok: false, answer: t(env, answer === "silence" ? "common.not_heard" : "common.cancelled") };

      const byDevice = new Map();

      for (const device of scope) {
        const app = device.apps.find((item) => appKey(item.name) === picked.key);
        const open = running ? device.running.find((item) => appKey(item.name) === picked.key) : null;

        if (app || open) byDevice.set(device.deviceId, { deviceId: device.deviceId, appId: app?.id ?? open?.appId ?? null, runningKey: open?.key ?? null, app: app ?? null, name: picked.name, score: 0.8 });
      }

      return { ok: true, key: picked.key, name: picked.name, byDevice, learn: spoken };
    }
  }

  return { ok: false, answer: t(env, verb === "close" ? "intents.close_app.not_found" : "intents.launch_app.not_found", { name: spoken }) };
}

/** Apps of the PCs as choices for the AI: one per name. */
function uniqueApps(devices, running) {
  const byKey = new Map();

  for (const device of devices) {
    for (const app of device.apps) {
      const key = appKey(app.name);

      if (!byKey.has(key)) byKey.set(key, { key, name: spokenName(app), app });
    }
    if (running) {
      for (const item of device.running) {
        const key = appKey(item.name);

        if (!byKey.has(key)) byKey.set(key, { key, name: item.name, app: item.prepared });
      }
    }
  }

  return [...byKey.values()];
}

/* ── flows ── */

async function launchFlow(env, params) {
  const { ctx, index } = env;
  const actor = await resolveActor(ctx, env.settings, { index });

  if (!actor.ok) return actor.answer;

  const pool = index.pool(actor.userId, { sharedOnly: actor.sharedOnly });

  if (!pool.length) return t(env, actor.sharedOnly ? "common.no_shared_pcs" : "common.no_pcs");

  let objects = (Array.isArray(params.objects) ? params.objects : []).filter((object) => typeof object === "string" && object.trim()).slice(0, 3);

  if (!objects.length) {
    const text = await ask(env, t(env, params.generic === "game" ? "intents.launch_app.which_game" : "intents.launch_app.what"));

    if (text === null) return t(env, "common.not_heard");
    if (isCancel(text) || answerKind(text) === "no") return t(env, "common.cancelled");
    objects = [text];
  }

  const scope = params.pc?.ids?.length ? pool.filter((device) => params.pc.ids.includes(device.deviceId)) : pool;
  const targets = [];

  for (const object of objects) {
    const resolved = await resolveApp(env, object, scope, { verb: "launch" });

    if (!resolved.ok) return resolved.answer;
    targets.push(resolved);
  }

  const has = (device) => targets.every((target) => target.byDevice.has(device.deviceId));
  const choice = await choosePc(ctx, {
    index,
    actor,
    pc: params.pc,
    feature: "launch",
    able: has,
    recent: env.skill.recent,
    askEveryTime: env.settings.askPcEveryTime,
  });

  if (!choice.ok) {
    if (choice.offline?.wol && has(choice.offline)) return offerWake(env, actor, choice.offline, targets);

    return choice.answer;
  }

  return launchOn(env, actor, choice.devices[0], targets, choice.pool);
}

async function launchOn(env, actor, device, targets, pool) {
  const started = [];

  for (const target of targets) {
    const candidate = target.byDevice.get(device.deviceId);

    if (!candidate?.appId) return t(env, "intents.launch_app.not_on_pc", { name: target.name, pc: device.name });

    const result = await send(env, actor, device, "app.launch", { appId: candidate.appId }, target.name);

    if (!result.ok) return failure(env, device, result, target.name);
    if (target.learn && candidate.appId) env.hub.learn(device.deviceId, candidate.appId, target.learn);
    started.push({ name: target.name, already: result.data?.already === true });
  }

  if (started.length === 1) {
    const [only] = started;

    return t(env, keyFor(only.already ? "intents.launch_app.already" : "intents.launch_app.done", pool), { name: only.name, pc: device.name });
  }

  return t(env, keyFor("intents.launch_app.done_many", pool), { names: started.map((item) => item.name), pc: device.name });
}

/** The PC with the app is off but can be woken: ask, wake it, launch when it is up. */
async function offerWake(env, actor, device, targets) {
  const answer = await confirm(env, t(env, "common.offer_wake", { pc: device.name }));

  if (answer !== "yes") return t(env, answer === "silence" ? "common.not_heard" : "common.kept_off", { pc: device.name });

  try {
    await (env.skill.wake ?? wake)(device.wol.mac, device.wol.broadcast);
  } catch (error) {
    trace(`wake ${device.deviceId}: ${error.message}`);
    return t(env, "intents.pc_wake.failed", { pc: device.name });
  }

  const names = targets.map((target) => target.name);
  const skill = env.skill;
  const say = (text) => skill.notify(actor.userId ?? device.userId, text);

  skill.deferred.add(
    device.deviceId,
    async () => {
      const current = env.index.get(device.deviceId) ?? device;
      const answer = await launchOn({ ...env, ctx: skill.backgroundCtx() }, actor, current, targets, env.index.pool(actor.userId, { sharedOnly: actor.sharedOnly }));

      await say(answer);
    },
    { onExpire: () => say(skill.ctx.t("intents.launch_app.deferred_failed", { pc: device.name, names })) },
  );

  return t(env, "intents.launch_app.deferred", { pc: device.name, names });
}

async function closeFlow(env, params) {
  const { ctx, index } = env;
  const actor = await resolveActor(ctx, env.settings, { index });

  if (!actor.ok) return actor.answer;

  const pool = index.pool(actor.userId, { sharedOnly: actor.sharedOnly });

  if (!pool.length) return t(env, actor.sharedOnly ? "common.no_shared_pcs" : "common.no_pcs");

  if (params.generic) {
    const game = params.generic === "game";
    const choice = await choosePc(ctx, {
      index,
      actor,
      pc: params.pc,
      feature: "close",
      able: (device) => device.running.some((item) => (game ? item.game : item.fg)),
      recent: env.skill.recent,
      askEveryTime: env.settings.askPcEveryTime,
    });

    if (!choice.ok) return choice.answer;

    const device = choice.devices[0];
    // the window in front, like Alt+F4: a newer client closes exactly that window
    const action = !game && env.hub.supports?.(device.deviceId, "window.close") ? "window.close" : "app.close";
    const args = action === "window.close" ? {} : { target: game ? "game" : "foreground" };
    const result = await send(env, actor, device, action, args, params.generic);

    return closeAnswer(env, actor, device, choice.pool, result, args, null, { action, generic: game ? "game" : "active" });
  }

  const objects = (Array.isArray(params.objects) ? params.objects : []).filter((object) => typeof object === "string" && object.trim()).slice(0, 3);

  if (!objects.length) return t(env, "intents.close_app.what");

  const online = pool.filter((device) => device.online);
  const scope = (params.pc?.ids?.length ? online.filter((device) => params.pc.ids.includes(device.deviceId)) : online);

  if (!scope.length) return t(env, params.pc?.ids?.length === 1 ? "common.pc_offline" : "common.all_offline", { pc: pool.find((device) => params.pc?.ids?.includes(device.deviceId))?.name ?? "" });

  const target = await resolveApp(env, objects[0], scope, { running: true, verb: "close" });

  if (!target.ok) return target.answer;

  // a PC where it is open now goes first
  const choice = await choosePc(ctx, {
    index,
    actor,
    pc: params.pc,
    feature: "close",
    able: (device) => Boolean(target.byDevice.get(device.deviceId)?.runningKey) || device.running.some((item) => appKey(item.name) === target.key),
    recent: env.skill.recent,
    askEveryTime: env.settings.askPcEveryTime,
  });

  if (!choice.ok) return choice.answer;

  const device = choice.devices[0];
  const candidate = target.byDevice.get(device.deviceId);
  const args = candidate?.appId ? { appId: candidate.appId } : candidate?.runningKey ? { key: candidate.runningKey } : null;

  if (!args) return t(env, "intents.close_app.not_running", { name: target.name, pc: device.name });

  const result = await send(env, actor, device, "app.close", args, target.name);

  return closeAnswer(env, actor, device, choice.pool, result, args, target.name);
}

async function closeAnswer(env, actor, device, pool, result, args, name, { action = "app.close", generic = null } = {}) {
  if (!result.ok) {
    if (result.code === "not-running") {
      const key = name ? "intents.close_app.not_running" : generic === "active" ? "intents.close_app.no_active" : "intents.close_app.no_game";

      return t(env, key, { name: name ?? "", pc: device.name });
    }
    // the desktop or Explorer is in front: never closed
    if (result.code === "protected") return t(env, "intents.close_app.shell_active", { pc: device.name });

    if (result.code === "ambiguous" && Array.isArray(result.data?.options) && result.data.options.length) {
      const options = result.data.options.slice(0, 3).filter((option) => option && typeof option.key === "string");
      const text = await ask(env, t(env, "intents.close_app.which", { names: options.map((option) => String(option.name ?? "")) }));

      if (text === null) return t(env, "common.not_heard");
      if (isCancel(text) || answerKind(text) === "no") return t(env, "common.cancelled");

      const ordinal = ordinalOf(text);
      const tokens = prepare(text);
      const chosen = (ordinal && options[ordinal - 1]) ||
        options.map((option) => ({ option, score: scoreApp(tokens, { variants: [{ tokens: prepare(String(option.name ?? "")) }] }).score })).sort((a, b) => b.score - a.score).find((item) => item.score >= 0.75)?.option;

      if (!chosen) return t(env, "common.not_understood");

      const next = await send(env, actor, device, "app.close", { key: chosen.key }, chosen.name);

      return closeAnswer(env, actor, device, pool, next, { key: chosen.key }, String(chosen.name ?? ""));
    }

    return failure(env, device, result, name ?? "");
  }

  const closedName = name ?? (typeof result.data?.name === "string" ? result.data.name : "");

  if (Array.isArray(result.data?.pending) && result.data.pending.length) {
    // a window that stayed open, or a program with no window at all (in the tray)
    const question = result.data.background === true ? "intents.close_app.background" : "intents.close_app.stuck";
    const answer = await confirm(env, t(env, question, { name: closedName }));

    if (answer !== "yes") return t(env, answer === "silence" ? "common.not_heard" : "intents.close_app.kept", { name: closedName });

    // window.close forces only the process of that window
    const pid = Number.isInteger(result.data?.pid) ? { pid: result.data.pid } : {};
    const forced = await send(env, actor, device, action, { ...args, force: true, ...pid }, closedName);

    return forced.ok ? t(env, "intents.close_app.forced", { name: closedName, pc: device.name }) : failure(env, device, forced, closedName);
  }

  return t(env, keyFor("intents.close_app.done", pool), { name: closedName, pc: device.name });
}

async function powerFlow(env, params) {
  const { ctx, index } = env;
  const op = POWER_ACTIONS[params.op] ? params.op : "shutdown";
  const actor = await resolveActor(ctx, env.settings, { power: CONFIRMED_POWER.has(op) || op === "sleep", index });

  if (!actor.ok) return actor.answer;

  if (op === "cancel") return cancelFlow(env, actor, params);

  const choice = await choosePc(ctx, {
    index,
    actor,
    pc: params.pc,
    feature: POWER_FEATURES[op] ?? "power",
    allowAll: true,
    recent: env.skill.recent,
    askEveryTime: env.settings.askPcEveryTime,
  });

  if (!choice.ok) return choice.answer;

  const delaySec = Math.min(MAX_DELAY_SEC, Math.max(0, Math.round(Number(params.delaySec) || 0)));
  const devices = choice.devices;
  const needsConfirm = CONFIRMED_POWER.has(op) && delaySec === 0 && devices.some((device) => device.prefs?.confirmPower !== false);

  if (needsConfirm) {
    const open = [...new Set(devices.flatMap((device) => device.running.map((item) => item.name)))].slice(0, 2);
    const names = devices.map((device) => device.name);
    const suffix = names.length > 1 ? "_many" : open.length ? "_open" : "";
    const question = t(env, `intents.pc_power.confirm_${op}${suffix}`, { pc: names[0], pcs: names.map((name) => `«${name}»`), apps: open });
    const answer = await confirm(env, question);

    if (answer !== "yes") return t(env, answer === "silence" ? "common.not_heard" : "intents.pc_power.kept");
  }

  const results = [];

  for (const device of devices) {
    results.push({ device, result: await send(env, actor, device, POWER_ACTIONS[op], { delaySec }, op) });
  }

  const failed = results.find((item) => !item.result.ok);

  if (failed) return failure(env, failed.device, failed.result);

  const vars = { pc: devices[0].name, pcs: devices.map((device) => `«${device.name}»`), ...delayVars(env, delaySec, params.at) };
  const several = devices.length > 1;

  if (delaySec > 0) return t(env, `intents.pc_power.${op}_later${several ? "_many" : ""}`, vars);

  return t(env, several ? `intents.pc_power.${op}_many` : keyFor(`intents.pc_power.${op}`, choice.pool), vars);
}

/** "через 1 час 30 минут" or "в 23:00" as variables for the answer. */
function delayVars(env, delaySec, at) {
  if (at) return { when: t(env, "time.at", { at }) };

  const hours = Math.floor(delaySec / 3600);
  const minutes = Math.round((delaySec % 3600) / 60);
  const parts = [];

  if (hours) parts.push(t(env, "time.hours", { count: hours }));
  if (minutes || !hours) parts.push(t(env, "time.minutes", { count: Math.max(1, minutes) }));

  return { when: t(env, "time.in", { span: parts.join(" ") }) };
}

async function cancelFlow(env, actor, params) {
  const pool = env.index.pool(actor.userId, { sharedOnly: actor.sharedOnly });
  let devices = pool.filter((device) => device.online && (!params.pc?.ids?.length || params.pc.ids.includes(device.deviceId)));

  if (!devices.length) return t(env, pool.length ? "common.all_offline" : "common.no_pcs");

  const scheduled = devices.filter((device) => device.state?.shutdownAt);

  if (scheduled.length) devices = scheduled;

  let cancelled = 0;

  for (const device of devices) {
    const result = await send(env, actor, device, "power.cancel", {}, "cancel");

    if (result.ok && result.data?.cancelled !== false) cancelled++;
  }

  return t(env, cancelled ? "intents.pc_power.cancelled" : "intents.pc_power.nothing_to_cancel");
}

async function wakeFlow(env, params) {
  const { ctx, index } = env;
  const actor = await resolveActor(ctx, env.settings, { index });

  if (!actor.ok) return actor.answer;

  const choice = await choosePc(ctx, {
    index,
    actor,
    pc: params.pc,
    needOnline: false,
    able: (device) => !device.online && Boolean(device.wol),
    recent: env.skill.recent,
    askEveryTime: env.settings.askPcEveryTime,
  });

  if (!choice.ok) return choice.answer;

  const device = choice.devices[0];

  if (device.online) return t(env, "intents.pc_wake.already_on", { pc: device.name });
  if (!device.wol) return t(env, "intents.pc_wake.no_wol", { pc: device.name });

  try {
    await (env.skill.wake ?? wake)(device.wol.mac, device.wol.broadcast);
  } catch (error) {
    trace(`wake ${device.deviceId}: ${error.message}`);
    return t(env, "intents.pc_wake.failed", { pc: device.name });
  }

  env.skill.store.history
    .add({ userId: actor.userId ?? device.userId, deviceId: device.deviceId, action: "wake", target: "", ok: true, code: "", via: env.via })
    .catch(() => null);

  return t(env, device.wol.adapter === "wifi" ? "intents.pc_wake.sent_wifi" : "intents.pc_wake.sent", { pc: device.name });
}

async function volumeFlow(env, params) {
  const { ctx, index } = env;
  const actor = await resolveActor(ctx, env.settings, { index });

  if (!actor.ok) return actor.answer;

  const choice = await choosePc(ctx, {
    index,
    actor,
    pc: params.pc,
    feature: "volume",
    allowAll: true,
    recent: env.skill.recent,
    askEveryTime: env.settings.askPcEveryTime,
  });

  if (!choice.ok) return choice.answer;

  let last = null;

  for (const device of choice.devices) {
    const step = Number(device.prefs?.volumeStep) || 10;
    const value = Number.isFinite(Number(params.value)) && params.value !== null ? Number(params.value) : null;
    let action;
    let args = {};

    switch (params.op) {
      case "set":
        action = "volume.set";
        args = { level: Math.min(100, Math.max(0, Math.round(value ?? 50))) };
        break;
      case "up":
      case "down": {
        const delta = Math.max(1, Math.round(value ?? step * (Number(params.factor) || 1)));

        action = "volume.change";
        args = { delta: params.op === "up" ? delta : -delta };
        break;
      }
      case "mute":
      case "unmute":
        action = "volume.mute";
        args = { muted: params.op === "mute" };
        break;
      default:
        action = "volume.get";
    }

    const result = await send(env, actor, device, action, args, params.op ?? "get");

    if (!result.ok) return failure(env, device, result);
    last = { device, data: result.data };
  }

  const { device, data } = last;
  const level = Math.round(Number(data?.level));
  const vars = { pc: device.name, level: Number.isFinite(level) ? level : 0 };
  const several = choice.devices.length > 1;

  if (params.op === "mute") return t(env, "intents.pc_volume.muted");
  if (params.op === "unmute") return t(env, "intents.pc_volume.unmuted");
  if (params.op === "get" || !params.op) return t(env, data?.muted ? keyFor("intents.pc_volume.is_muted", choice.pool) : keyFor("intents.pc_volume.level", choice.pool), vars);

  return t(env, several ? "intents.pc_volume.set_many" : keyFor("intents.pc_volume.set", choice.pool), vars);
}

async function mediaFlow(env, params) {
  const { ctx, index } = env;
  const actor = await resolveActor(ctx, env.settings, { index });

  if (!actor.ok) return actor.answer;

  const choice = await choosePc(ctx, { index, actor, pc: params.pc, feature: "media", recent: env.skill.recent, askEveryTime: env.settings.askPcEveryTime });

  if (!choice.ok) return choice.answer;

  const device = choice.devices[0];
  // older params (the AI agent, blocks) know only keys: play_pause is a toggle
  const op = MEDIA_OPS.includes(params.op) ? params.op : params.key === "next" || params.key === "prev" ? params.key : "toggle";

  // a client with media sessions plays and pauses for real, an older one presses the toggle key
  if (!env.hub.supports?.(device.deviceId, "media.control")) {
    const key = op === "next" || op === "prev" ? op : "play_pause";
    const result = await send(env, actor, device, "media.key", { key }, key);

    return result.ok ? t(env, `intents.pc_media.${key}`) : failure(env, device, result);
  }

  const result = await send(env, actor, device, "media.control", { op }, op);

  if (!result.ok) {
    if (result.code === "no-session") return t(env, op === "play" ? "intents.pc_media.nothing_to_resume" : "intents.pc_media.nothing_playing", { pc: device.name });

    return failure(env, device, result);
  }

  const already = result.data?.already === true;

  // the player ignored media sessions and got the toggle key: the state is unknown
  if (result.data?.fallback === true || op === "toggle") return t(env, "intents.pc_media.play_pause");
  if (op === "play") return t(env, already ? "intents.pc_media.already_playing" : "intents.pc_media.resumed");
  if (op === "pause") return t(env, already ? "intents.pc_media.already_paused" : "intents.pc_media.paused");

  return t(env, `intents.pc_media.${op}`);
}

const MEDIA_OPS = ["play", "pause", "toggle", "next", "prev"];

async function searchFlow(env, params) {
  const { ctx, index } = env;
  const query = typeof params.query === "string" ? params.query.trim().slice(0, 300) : "";

  if (!query) return t(env, "intents.pc_search.what");

  const actor = await resolveActor(ctx, env.settings, { index });

  if (!actor.ok) return actor.answer;

  const choice = await choosePc(ctx, { index, actor, pc: params.pc, feature: "search", recent: env.skill.recent, askEveryTime: env.settings.askPcEveryTime });

  if (!choice.ok) return choice.answer;

  const device = choice.devices[0];
  const engine = ["google", "yandex", "bing", "duckduckgo", "youtube"].includes(params.engine) ? params.engine : device.prefs?.searchEngine ?? "google";
  const result = await send(env, actor, device, "web.search", { query, engine }, query);

  if (!result.ok) return failure(env, device, result);

  return t(env, keyFor(engine === "youtube" ? "intents.pc_search.done_youtube" : "intents.pc_search.done", choice.pool), { query, pc: device.name });
}

/**
 * Parental control by voice. Not "an adult speaks" but "the owner of that PC speaks", confirmed
 * by voice: an older brother who owns the PC may lift the limits for a younger one.
 */
async function parentalFlow(env, params) {
  const { ctx, index, skill } = env;
  const verified = typeof ctx.user?.requireVerified === "function" ? await ctx.user.requireVerified().catch(() => null) : null;

  // NODUS has said why
  if (!verified) return "";

  const userId = String(verified.userId);
  const controlled = index.all().filter((device) => device.parental);
  const named = params.pc?.ids?.length ? controlled.filter((device) => params.pc.ids.includes(device.deviceId)) : controlled;

  if (!named.length) return t(env, "intents.pc_parental.none");
  if (!named.some((device) => device.userId === userId)) return t(env, "intents.pc_parental.not_owner", { pc: named[0].name });

  const choice = await choosePc(ctx, {
    index,
    actor: { userId, sharedOnly: false },
    pc: params.pc,
    needOnline: false,
    able: (device) => device.parental && device.userId === userId,
    recent: skill.recent,
    askEveryTime: env.settings.askPcEveryTime,
  });

  if (!choice.ok) return choice.answer;

  const device = choice.devices[0];

  if (!device.parental || device.userId !== userId) return t(env, "intents.pc_parental.not_owner", { pc: device.name });

  const target = { deviceId: device.deviceId, userId };
  const vars = { pc: device.name };

  skill.store.history.add({ userId, deviceId: device.deviceId, action: `parental.${params.op}`, target: String(params.minutes ?? ""), ok: true, code: "", via: env.via }).catch(() => null);

  if (params.op === "revoke") {
    await skill.parental.revoke(target);
    return t(env, "intents.pc_parental.revoked", vars);
  }
  if (params.op === "reset") {
    await skill.parental.resetToday(target);
    return t(env, "intents.pc_parental.reset", vars);
  }

  const minutes = params.minutes ?? skill.parental.view(device.deviceId).rules.unlockMinutes;
  const until = await skill.parental.grant(target, minutes);

  if (minutes === "day") return t(env, "intents.pc_parental.granted_day", vars);

  return t(env, "intents.pc_parental.granted", { ...vars, until: `${until.getHours()}:${String(until.getMinutes()).padStart(2, "0")}` });
}

async function statusFlow(env) {
  const { ctx, index } = env;
  const actor = await resolveActor(ctx, env.settings, { index });

  if (!actor.ok) return actor.answer;

  const pool = index.pool(actor.userId, { sharedOnly: actor.sharedOnly });

  if (!pool.length) return t(env, actor.sharedOnly ? "common.no_shared_pcs" : "common.no_pcs");

  const online = pool.filter((device) => device.online);
  const text = String(ctx.text ?? "").toLowerCase();

  if (/запущ|открыт|работает|running|open/.test(text)) {
    const choice = await choosePc(ctx, { index, actor, pc: classify(ctx.text ?? "", { index, userId: actor.userId })?.params?.pc ?? null, recent: env.skill.recent, askEveryTime: env.settings.askPcEveryTime });

    if (!choice.ok) return choice.answer;

    const device = choice.devices[0];
    const names = [...new Set(device.running.map((item) => item.name))].slice(0, 5);

    if (!device.prefs?.shareRunning) return t(env, "intents.pc_status.running_hidden", { pc: device.name });

    return t(env, names.length ? "intents.pc_status.running" : "intents.pc_status.nothing_running", { pc: device.name, names });
  }

  if (!online.length) return t(env, "intents.pc_status.none_online");
  if (pool.length === 1) return t(env, "intents.pc_status.single_online", { pc: online[0].name });

  return t(env, "intents.pc_status.online", { names: online.map((device) => `«${device.name}»`), count: online.length });
}

/* ── entry ── */

/**
 * @param {object} ctx request ctx (or a lifecycle ctx for scenario blocks)
 * @param {Array|null} configs device settings (3rd argument of handler)
 * @param {string} intent launch_app | close_app | pc_power | pc_wake | pc_volume | pc_media | pc_search | pc_status
 * @param {object} rawParams params from match(), the AI agent or a block
 * @param {{ via?: "voice"|"agent"|"node" }} options
 * @returns {Promise<string>} the answer to say
 */
async function runCommand(ctx, configs, intent, rawParams, { via = "voice" } = {}) {
  const loaded = state.get();

  if (!loaded) return ctx.t("common.not_ready");

  const { skill, index, hub } = loaded;
  const settings = readSettings(Array.isArray(configs) && configs.length ? configs : skill.configs);

  // the settings of this command: onConfigChange may not have come yet
  if (index.setAccept(settings.acceptScore)) hub.broadcastSettings?.();
  let params = rawParams && typeof rawParams === "object" && !Array.isArray(rawParams) ? rawParams : {};

  // chosen by the built-in model or matched without params: parse the phrase here
  if (!params.op && intent !== "pc_status") {
    const parsed = classify(ctx.text ?? "", { index, userId: ctx.user?.id ? String(ctx.user.id) : null });

    if (parsed?.intent === intent) params = parsed.params;
  }

  const env = { ctx, settings, index, hub, skill, via };
  const started = Date.now();

  try {
    // a string in every case: any other value leaves NODUS silent and deaf for 15 s or more
    const flow = Object.hasOwn(FLOWS, intent) ? FLOWS[intent] : null;
    const answer = flow ? await flow(env, params) : null;

    return typeof answer === "string" ? answer : ctx.t("common.failed");
  } finally {
    const ms = Date.now() - started;

    if (ms > SLOW_MS) trace(`${intent} (${via}) answered in ${ms} ms`);
  }
}

const FLOWS = {
  launch_app: launchFlow,
  close_app: closeFlow,
  pc_power: powerFlow,
  pc_wake: wakeFlow,
  pc_volume: volumeFlow,
  pc_media: mediaFlow,
  pc_search: searchFlow,
  pc_status: statusFlow,
  pc_parental: parentalFlow,
};

module.exports = { runCommand, resolveApp, delayVars, POWER_ACTIONS };
