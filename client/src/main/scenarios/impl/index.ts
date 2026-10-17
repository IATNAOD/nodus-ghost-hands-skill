// Implementations of the scenario nodes. Everything outside comes through ScenarioServices.
import { centerOf, isPoint, isRegion, type ImageRef, type KeyCombo, type MonitorSel, type Point, type Region, type RegionSel, type Value } from "../../../shared/scenarios/model";
import { compareValues, toBool, toNumber, toText } from "../../../shared/scenarios/pins";
import { NodeError, nowParts, type NodeCtx, type NodeImpl, type NodeResult } from "../engine";
import type { ActionResult, ScenarioServices, SearchArea } from "./services";

type Ctx = NodeCtx<ScenarioServices>;
type Impl = NodeImpl<ScenarioServices>;

const pure = (compute: (inputs: Record<string, Value>, ctx: Ctx) => Record<string, Value> | Promise<Record<string, Value>>): Impl => ({
  async run(ctx) {
    return { outputs: await compute(ctx.inputs, ctx) };
  },
});

/** An action of the protocol; a failed one is a node error with its code. */
async function act(ctx: Ctx, action: string, args: Record<string, unknown>): Promise<ActionResult> {
  const result = await ctx.services.perform(action, args);

  if (!result.ok) throw new NodeError(result.code ?? "failed");
  return result;
}

const appId = (value: Value): string => {
  const id = typeof value === "string" ? value : "";
  if (!id) throw new NodeError("app-not-found");
  return id;
};

const point = (value: Value, pin: string): Point => {
  if (isRegion(value)) return centerOf(value);
  if (isPoint(value)) return { x: Math.round(value.x), y: Math.round(value.y) };
  throw new NodeError("no-point", pin);
};

const area = (inputs: Record<string, Value>): SearchArea => ({
  monitors: (inputs.monitors as MonitorSel | null) ?? { mode: "all" },
  region: inputs.region && typeof inputs.region === "object" ? (inputs.region as RegionSel | Region) : null,
});

const image = (value: Value): ImageRef => {
  const ref = value as ImageRef | null;
  if (!ref || typeof ref.asset !== "string") throw new NodeError("no-image");
  return ref;
};

/** Probes until it finds something or the wait is over (0 - one probe). */
async function poll<T>(ctx: Ctx, waitSec: number, intervalMs: number, probe: () => Promise<T | null>): Promise<T | null> {
  const deadline = ctx.services.now() + Math.max(0, waitSec) * 1000;

  for (;;) {
    const began = ctx.services.now();
    const found = await probe();

    if (found) return found;
    if (waitSec <= 0 || ctx.services.now() >= deadline) return null;
    // a slow probe (a 4K screen) starts the next round at once
    await ctx.sleep(Math.max(0, Math.min(intervalMs - (ctx.services.now() - began), deadline - ctx.services.now())));
  }
}

const loop = (kind: "repeat" | "while" | "until"): Impl => ({
  async run(ctx) {
    const max = kind === "repeat" ? Math.max(0, Math.floor(toNumber(ctx.inputs.count))) : Math.max(1, Math.floor(toNumber(ctx.inputs.max)));

    for (let index = 1; index <= max; index++) {
      if (kind === "while" && !toBool(await ctx.evalInput("condition"))) break;
      ctx.setOutputs({ index });
      if ((await ctx.runBody("body")) === "break") break;
      if (kind === "until" && toBool(await ctx.evalInput("condition"))) break;
    }
    return { out: "done" };
  },
});

const MATH: Record<string, (a: number, b: number) => number> = {
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => (b === 0 ? 0 : a / b),
  mod: (a, b) => (b === 0 ? 0 : a % b),
  min: Math.min,
  max: Math.max,
  round: (a) => Math.round(a),
  floor: (a) => Math.floor(a),
  ceil: (a) => Math.ceil(a),
  abs: (a) => Math.abs(a),
};

export const IMPLS: Record<string, Impl> = {
  /* ── flow ── */
  "flow.if": { run: (ctx) => ({ out: toBool(ctx.inputs.condition) ? "then" : "else" }) },
  "flow.repeat": loop("repeat"),
  "flow.while": loop("while"),
  "flow.until": loop("until"),
  "flow.wait": {
    async run(ctx) {
      await ctx.sleep(Math.max(0, toNumber(ctx.inputs.seconds)) * 1000);
      return {};
    },
  },
  "flow.waitUntil": {
    async run(ctx) {
      const timeout = toNumber(ctx.inputs.timeout);
      const interval = Math.max(100, toNumber(ctx.inputs.interval) || 500);
      const met = await poll(ctx, timeout > 0 ? timeout : Number.MAX_SAFE_INTEGER / 1000, interval, async () => (toBool(await ctx.evalInput("condition")) ? true : null));

      return met ? { out: "next" } : { out: "timeout", code: "timeout" };
    },
  },
  "flow.runScenario": {
    async run(ctx) {
      const id = typeof ctx.inputs.scenario === "string" ? ctx.inputs.scenario : "";
      if (!id) throw new NodeError("scenario-not-found");

      const result = await ctx.services.scenarios.run(id, toText(ctx.inputs.text), toBool(ctx.inputs.wait), ctx.signal);
      return { outputs: { status: result.status, output: result.output } };
    },
  },
  "flow.log": {
    run(ctx) {
      const level = ctx.inputs.level === "warn" || ctx.inputs.level === "error" ? ctx.inputs.level : "info";
      ctx.log(level, toText(ctx.inputs.text));
      return {};
    },
  },

  /* ── apps ── */
  "apps.launch": {
    async run(ctx) {
      const result = await act(ctx, "app.launch", { appId: appId(ctx.inputs.app) });
      return { outputs: { already: Boolean(result.data?.already) } };
    },
  },
  "apps.close": {
    async run(ctx) {
      const target = ctx.inputs.target;
      const force = toBool(ctx.inputs.force);
      const args = target === "active" ? { target: "foreground", force } : target === "game" ? { target: "game", force } : { appId: appId(ctx.inputs.app), force };
      const result = await act(ctx, target === "active" ? "window.close" : "app.close", args);
      return { outputs: { name: String(result.data?.name ?? "") } };
    },
  },
  "apps.isRunning": pure((inputs, ctx) => ctx.services.apps.state(appId(inputs.app))),
  "apps.waitFor": {
    async run(ctx) {
      const id = appId(ctx.inputs.app);
      const want = ctx.inputs.state;
      const timeout = toNumber(ctx.inputs.timeout);
      const done = await poll(ctx, timeout > 0 ? timeout : Number.MAX_SAFE_INTEGER / 1000, 500, async () => {
        const state = ctx.services.apps.state(id);
        return (want === "stopped" ? !state.running : want === "front" ? state.front : state.running) ? true : null;
      });

      return done ? { out: "next" } : { out: "timeout", code: "timeout" };
    },
  },
  "apps.focus": {
    async run(ctx) {
      await ctx.services.apps.focus(appId(ctx.inputs.app));
      return {};
    },
  },
  "apps.open": {
    async run(ctx) {
      const path = toText(ctx.inputs.path).trim();
      if (!path) throw new NodeError("invalid-args", "path");
      await ctx.services.apps.open(path, toText(ctx.inputs.args));
      return {};
    },
  },
  "apps.openUrl": {
    async run(ctx) {
      const url = toText(ctx.inputs.url).trim();
      if (!/^https?:\/\//i.test(url)) throw new NodeError("bad-url");
      await ctx.services.apps.openUrl(url);
      return {};
    },
  },
  "apps.active": pure(async (_inputs, ctx) => {
    const active = await ctx.services.apps.active();
    return { name: active.name, app: active.app, region: active.region };
  }),

  /* ── system ── */
  "system.volume": {
    async run(ctx) {
      const mode = ctx.inputs.mode;
      const result =
        mode === "change"
          ? await act(ctx, "volume.change", { delta: Math.round(toNumber(ctx.inputs.delta)) })
          : mode === "mute" || mode === "unmute"
            ? await act(ctx, "volume.mute", { muted: mode === "mute" })
            : await act(ctx, "volume.set", { level: Math.round(toNumber(ctx.inputs.level)) });
      return { outputs: { level: toNumber((result.data?.level as number) ?? 0), muted: Boolean(result.data?.muted) } };
    },
  },
  "system.volumeGet": pure(async (_inputs, ctx) => ctx.services.system.volume()),
  "system.media": {
    async run(ctx) {
      await act(ctx, "media.control", { op: String(ctx.inputs.op ?? "toggle") });
      return {};
    },
  },
  "system.power": {
    async run(ctx) {
      const action = String(ctx.inputs.action ?? "lock");
      const delaySec = Math.max(0, Math.round(toNumber(ctx.inputs.delay)));
      const map: Record<string, string> = { lock: "power.lock", display: "display.off", sleep: "power.sleep", shutdown: "power.shutdown", restart: "power.restart" };

      await act(ctx, map[action] ?? "power.lock", { delaySec: action === "lock" || action === "display" ? 0 : delaySec });
      return {};
    },
  },
  "system.notify": {
    run(ctx) {
      ctx.services.system.notify(toText(ctx.inputs.title) || ctx.scenario.name, toText(ctx.inputs.text));
      return {};
    },
  },
  "system.say": {
    async run(ctx) {
      const text = toText(ctx.inputs.text).trim();
      if (!text) throw new NodeError("invalid-args", "text");
      await ctx.services.system.say(text.slice(0, 300));
      return {};
    },
  },
  "system.search": {
    async run(ctx) {
      const query = toText(ctx.inputs.query).trim();
      if (!query) throw new NodeError("invalid-args", "query");
      await ctx.services.system.search(query, String(ctx.inputs.engine ?? "default"));
      return {};
    },
  },
  "system.clipboardGet": pure(async (_inputs, ctx) => ({ text: await ctx.services.system.clipboardRead() })),
  "system.clipboardSet": {
    async run(ctx) {
      await ctx.services.system.clipboardWrite(toText(ctx.inputs.text));
      return {};
    },
  },

  /* ── input ── */
  "input.keys": {
    async run(ctx) {
      const combo = ctx.inputs.keys as KeyCombo | null;
      if (!combo || !Array.isArray(combo.codes) || combo.codes.length === 0) throw new NodeError("invalid-args", "keys");

      const mode = ctx.inputs.mode === "down" || ctx.inputs.mode === "up" ? ctx.inputs.mode : "press";
      await ctx.services.input.keys(combo, mode, toNumber(ctx.inputs.hold), Math.max(1, Math.round(toNumber(ctx.inputs.repeat))));
      return {};
    },
  },
  "input.text": {
    async run(ctx) {
      const mode = ctx.inputs.mode === "keys" || ctx.inputs.mode === "paste" ? ctx.inputs.mode : "unicode";
      await ctx.services.input.text(toText(ctx.inputs.text), mode, toNumber(ctx.inputs.interval));
      return {};
    },
  },
  "input.click": {
    async run(ctx) {
      await ctx.services.input.click(point(ctx.inputs.point, "point"), String(ctx.inputs.button ?? "left"), toBool(ctx.inputs.double), toNumber(ctx.inputs.hold), toBool(ctx.inputs.returnCursor));
      return {};
    },
  },
  "input.move": {
    async run(ctx) {
      await ctx.services.input.move(point(ctx.inputs.point, "point"), toNumber(ctx.inputs.smooth));
      return {};
    },
  },
  "input.drag": {
    async run(ctx) {
      await ctx.services.input.drag(point(ctx.inputs.from, "from"), point(ctx.inputs.to, "to"), String(ctx.inputs.button ?? "left"), toNumber(ctx.inputs.duration));
      return {};
    },
  },
  "input.scroll": {
    async run(ctx) {
      const at = isPoint(ctx.inputs.point) || isRegion(ctx.inputs.point) ? point(ctx.inputs.point, "point") : null;
      await ctx.services.input.scroll(Math.round(toNumber(ctx.inputs.amount)), toBool(ctx.inputs.horizontal), at);
      return {};
    },
  },
  "input.cursor": pure(async (_inputs, ctx) => ({ point: await ctx.services.input.cursor() })),
  "input.release": {
    async run(ctx) {
      await ctx.services.input.releaseAll();
      return {};
    },
  },

  /* ── screen ── */
  "vision.find": {
    async run(ctx): Promise<NodeResult> {
      const sample = image(ctx.inputs.image);
      const where = area(ctx.inputs);
      const match = await poll(ctx, toNumber(ctx.inputs.wait), toNumber(ctx.inputs.interval) || 300, () =>
        ctx.services.vision.find(sample, where, toNumber(ctx.inputs.threshold) || 0.85, ctx.signal),
      );

      return match ? { out: "found", outputs: { point: match.point, region: match.region, score: Math.round(match.score * 1000) / 1000 } } : { out: "notFound", code: "image-not-found" };
    },
  },
  "vision.click": {
    async run(ctx): Promise<NodeResult> {
      const sample = image(ctx.inputs.image);
      const where = area(ctx.inputs);
      const match = await poll(ctx, toNumber(ctx.inputs.wait), toNumber(ctx.inputs.interval) || 300, () =>
        ctx.services.vision.find(sample, where, toNumber(ctx.inputs.threshold) || 0.85, ctx.signal),
      );

      if (!match) return { out: "notFound", code: "image-not-found" };
      await ctx.services.input.click(match.point, String(ctx.inputs.button ?? "left"), toBool(ctx.inputs.double), 30, false);
      return { out: "next", outputs: { point: match.point } };
    },
  },
  "vision.waitGone": {
    async run(ctx): Promise<NodeResult> {
      const sample = image(ctx.inputs.image);
      const where = area(ctx.inputs);
      const timeout = toNumber(ctx.inputs.timeout);
      const gone = await poll(ctx, timeout > 0 ? timeout : Number.MAX_SAFE_INTEGER / 1000, toNumber(ctx.inputs.interval) || 300, async () =>
        (await ctx.services.vision.find(sample, where, toNumber(ctx.inputs.threshold) || 0.85, ctx.signal)) ? null : true,
      );

      return gone ? { out: "next" } : { out: "timeout", code: "timeout" };
    },
  },
  "vision.isVisible": pure(async (inputs, ctx) => {
    const match = await ctx.services.vision.find(image(inputs.image), area(inputs), toNumber(inputs.threshold) || 0.85, ctx.signal);
    return { visible: Boolean(match), point: match?.point ?? null };
  }),
  "vision.findText": {
    async run(ctx): Promise<NodeResult> {
      const text = toText(ctx.inputs.text).trim();
      if (!text) throw new NodeError("invalid-args", "text");

      const where = area(ctx.inputs);
      const match = await poll(ctx, toNumber(ctx.inputs.wait), toNumber(ctx.inputs.interval) || 300, () =>
        ctx.services.ocr.find(text, String(ctx.inputs.match ?? "contains"), where, String(ctx.inputs.lang ?? "auto"), ctx.signal),
      );

      return match ? { out: "found", outputs: { point: match.point, region: match.region, text: match.text } } : { out: "notFound", code: "text-not-found" };
    },
  },
  "vision.clickText": {
    async run(ctx): Promise<NodeResult> {
      const text = toText(ctx.inputs.text).trim();
      if (!text) throw new NodeError("invalid-args", "text");

      const where = area(ctx.inputs);
      const match = await poll(ctx, toNumber(ctx.inputs.wait), toNumber(ctx.inputs.interval) || 300, () =>
        ctx.services.ocr.find(text, String(ctx.inputs.match ?? "contains"), where, String(ctx.inputs.lang ?? "auto"), ctx.signal),
      );

      if (!match) return { out: "notFound", code: "text-not-found" };
      await ctx.services.input.click(match.point, String(ctx.inputs.button ?? "left"), toBool(ctx.inputs.double), 30, false);
      return { out: "next", outputs: { point: match.point } };
    },
  },
  "vision.readText": {
    async run(ctx) {
      return { outputs: { text: await ctx.services.ocr.read(area(ctx.inputs), String(ctx.inputs.lang ?? "auto"), ctx.signal) } };
    },
  },

  /* ── data ── */
  "data.compare": pure((inputs) => ({ result: compareValues(inputs.a, String(inputs.op ?? "eq"), inputs.b) })),
  "data.and": pure((inputs) => ({ result: toBool(inputs.a) && toBool(inputs.b) })),
  "data.or": pure((inputs) => ({ result: toBool(inputs.a) || toBool(inputs.b) })),
  "data.not": pure((inputs) => ({ result: !toBool(inputs.value) })),
  "data.math": pure((inputs) => {
    const result = (MATH[String(inputs.op)] ?? MATH.add)(toNumber(inputs.a), toNumber(inputs.b));
    return { result: Number.isFinite(result) ? result : 0 };
  }),
  "data.template": pure((inputs) => ({ result: toText(inputs.text) })),
  "data.toNumber": pure((inputs) => {
    const found = toText(inputs.text).replace(/\s/g, "").match(/-?\d+(?:[.,]\d+)?/);
    return found ? { number: Number(found[0].replace(",", ".")), ok: true } : { number: 0, ok: false };
  }),
  "data.random": pure((inputs) => {
    const min = toNumber(inputs.min);
    const max = toNumber(inputs.max);
    const [low, high] = min <= max ? [min, max] : [max, min];
    return { number: toBool(inputs.integer) ? Math.floor(low + Math.random() * (Math.floor(high) - Math.ceil(low) + 1)) : low + Math.random() * (high - low) };
  }),
  "data.now": pure((_inputs, ctx) => {
    const parts = nowParts(ctx.services.now());
    return { time: parts.time, date: parts.date, weekday: parts.weekday, hour: parts.hour, timestamp: parts.timestamp };
  }),
  "data.point": pure((inputs) => ({ point: { x: Math.round(toNumber(inputs.x)), y: Math.round(toNumber(inputs.y)) } })),
  "data.offset": pure((inputs) => {
    const base = isPoint(inputs.point) ? inputs.point : null;
    return { point: base ? { x: Math.round(base.x + toNumber(inputs.dx)), y: Math.round(base.y + toNumber(inputs.dy)) } : null };
  }),
  "data.center": pure((inputs) => {
    if (!isRegion(inputs.region)) return { point: null, x: 0, y: 0 };
    const center = centerOf(inputs.region);
    return { point: center, x: center.x, y: center.y };
  }),

  /* ── variables ── */
  "vars.set": {
    run(ctx) {
      ctx.variables.set(String(ctx.inputs.name), String(ctx.inputs.scope ?? "run"), ctx.inputs.value ?? null);
      return {};
    },
  },
  "vars.get": pure((inputs, ctx) => ctx.variables.get(String(inputs.name), String(inputs.scope ?? "auto"))),
  "vars.increment": {
    run(ctx) {
      const name = String(ctx.inputs.name);
      const scope = String(ctx.inputs.scope ?? "run");
      const value = toNumber(ctx.variables.get(name, scope).value) + toNumber(ctx.inputs.by);

      ctx.variables.set(name, scope, value);
      return { outputs: { value } };
    },
  },
};
