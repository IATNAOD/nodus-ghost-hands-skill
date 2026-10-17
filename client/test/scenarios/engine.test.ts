import { describe, expect, it } from "vitest";
import { RunAbort } from "../../src/main/scenarios/engine";
import { run, scenarioOf, world } from "./helpers";

describe("scenario engine", () => {
  it("runs a chain, keeps run variables and returns the Stop result", async () => {
    const { info } = await run(
      scenarioOf(
        [
          ["set", "vars.set", { name: "x", value: "5" }],
          ["inc", "vars.increment", { name: "x", by: 2 }],
          ["stop", "flow.stop", { result: "{{x}}" }],
        ],
        [
          ["start", "next", "set"],
          ["set", "next", "inc"],
          ["inc", "next", "stop"],
        ],
      ),
    );

    expect(info.status).toBe("success");
    expect(info.output).toBe(7);
  });

  it("If follows the branch of its condition; an unconnected branch ends the path", async () => {
    const scenario = scenarioOf(
      [
        ["cmp", "data.compare", { a: "{{trigger.text}}", op: "eq", b: "да" }],
        ["if", "flow.if"],
        ["yes", "system.notify", { text: "yes" }],
        ["no", "system.notify", { text: "no" }],
      ],
      [
        ["start", "next", "if"],
        ["cmp", "result", "if", "condition"],
        ["if", "then", "yes"],
        ["if", "else", "no"],
      ],
    );

    const yes = await run(scenario, world(), { text: "ДА" });
    expect(yes.w.calls.map((c) => c.args.text)).toEqual(["yes"]);

    const no = await run(scenario, world(), { text: "нет" });
    expect(no.w.calls.map((c) => c.args.text)).toEqual(["no"]);
  });

  it("Repeat sets the round number, Break leaves the loop, the flow goes on through Done", async () => {
    const { info, w } = await run(
      scenarioOf(
        [
          ["loop", "flow.repeat", { count: 5 }],
          ["cmp", "data.compare", { op: "eq", b: 3 }],
          ["if", "flow.if"],
          ["brk", "flow.break"],
          ["note", "system.notify", { text: "round {{n}}" }],
          ["setn", "vars.set", { name: "n" }],
          ["after", "system.notify", { text: "after" }],
        ],
        [
          ["start", "next", "loop"],
          ["loop", "body", "setn"],
          ["loop", "index", "setn", "value"],
          ["setn", "next", "if"],
          ["loop", "index", "cmp", "a"],
          ["cmp", "result", "if", "condition"],
          ["if", "then", "brk"],
          ["if", "else", "note"],
          ["loop", "done", "after"],
        ],
      ),
    );

    expect(info.status).toBe("success");
    expect(w.calls.map((c) => c.args.text)).toEqual(["round 1", "round 2", "after"]);
  });

  it("While re-evaluates its condition before every round", async () => {
    const { w } = await run(
      scenarioOf(
        [
          ["init", "vars.set", { name: "i", value: "0" }],
          ["get", "vars.get", { name: "i" }],
          ["cmp", "data.compare", { op: "lt", b: 3 }],
          ["loop", "flow.while"],
          ["inc", "vars.increment", { name: "i" }],
          ["stop", "flow.stop", { result: "{{i}}" }],
        ],
        [
          ["start", "next", "init"],
          ["init", "next", "loop"],
          ["get", "value", "cmp", "a"],
          ["cmp", "result", "loop", "condition"],
          ["loop", "body", "inc"],
          ["loop", "done", "stop"],
        ],
      ),
    );

    const runEvent = w.events.filter((e) => e.t === "run").at(-1);
    expect(runEvent?.t === "run" && runEvent.run.output).toBe(3);
  });

  it("an unconnected fail output fails the run at that node; a wired one is followed", async () => {
    const w = world();
    w.found.image = false;

    const unwired = await run(scenarioOf([["find", "vision.find", { image: { asset: "a".repeat(64), w: 10, h: 10, scale: 1 } }]], [["start", "next", "find"]]), w);
    expect(unwired.info.status).toBe("error");
    expect(unwired.info.error).toMatchObject({ code: "image-not-found", nodeId: "find" });

    const wired = await run(
      scenarioOf(
        [
          ["find", "vision.find", { image: { asset: "a".repeat(64), w: 10, h: 10, scale: 1 } }],
          ["miss", "system.notify", { text: "missing" }],
        ],
        [
          ["start", "next", "find"],
          ["find", "notFound", "miss"],
        ],
      ),
      w,
    );
    expect(wired.info.status).toBe("success");
    expect(w.calls.at(-1)?.args.text).toBe("missing");
  });

  it("a found image feeds its point into a click", async () => {
    const { w } = await run(
      scenarioOf(
        [
          ["find", "vision.find", { image: { asset: "a".repeat(64), w: 10, h: 10, scale: 1 } }],
          ["click", "input.click"],
        ],
        [
          ["start", "next", "find"],
          ["find", "found", "click"],
          ["find", "point", "click", "point"],
        ],
      ),
    );

    expect(w.calls).toContainEqual({ action: "click", args: { x: 110, y: 220, button: "left" } });
  });

  it("a failing action goes through its Error output with the code, else the run fails", async () => {
    const w = world();
    w.failActions.set("app.launch", "app-not-found");

    const handled = await run(
      scenarioOf(
        [
          ["launch", "apps.launch", { app: "steam:570" }],
          ["report", "system.notify", { text: "x" }],
          ["code", "data.template", { text: "" }],
        ],
        [
          ["start", "next", "launch"],
          ["launch", "error", "report"],
          ["launch", "errorCode", "report", "text"],
        ],
      ),
      w,
    );
    expect(handled.info.status).toBe("success");
    expect(w.calls.at(-1)).toEqual({ action: "notify", args: { title: "Test", text: "app-not-found" } });

    const failed = await run(scenarioOf([["launch", "apps.launch", { app: "steam:570" }]], [["start", "next", "launch"]]), w);
    expect(failed.info.error).toMatchObject({ code: "app-not-found", nodeId: "launch" });
  });

  it("a required value from a step that never ran is an error", async () => {
    const { info } = await run(
      scenarioOf(
        [
          ["find", "vision.find", { image: { asset: "a".repeat(64), w: 10, h: 10, scale: 1 } }],
          ["click", "input.click"],
        ],
        [
          ["start", "next", "click"],
          ["find", "point", "click", "point"],
        ],
      ),
    );

    expect(info.error).toMatchObject({ code: "value-unavailable", nodeId: "click" });
  });

  it("a pure node is evaluated once per pass", async () => {
    const { info } = await run(
      scenarioOf(
        [
          ["rnd", "data.random", { min: 1, max: 1_000_000 }],
          ["cmp", "data.compare", { op: "eq" }],
          ["stop", "flow.stop"],
        ],
        [
          ["start", "next", "stop"],
          ["rnd", "number", "cmp", "a"],
          ["rnd", "number", "cmp", "b"],
          ["cmp", "result", "stop", "result"],
        ],
      ),
    );

    expect(info.output).toBe(true);
  });

  it("a one-variable template keeps the value type", async () => {
    const { w } = await run(
      scenarioOf(
        [
          ["set", "vars.set", { name: "p", value: "" }],
          ["pt", "data.point", { x: 7, y: 8 }],
          ["click", "input.click", { point: null }],
          ["get", "vars.get", { name: "p" }],
        ],
        [
          ["start", "next", "set"],
          ["pt", "point", "set", "value"],
          ["set", "next", "click"],
          ["get", "value", "click", "point"],
        ],
      ),
    );

    expect(w.calls).toContainEqual({ action: "click", args: { x: 7, y: 8, button: "left" } });
  });

  it("scenario and global variables live in the store", async () => {
    const w = world();
    const scenario = scenarioOf(
      [
        ["a", "vars.increment", { name: "count", scope: "scenario" }],
        ["b", "vars.set", { name: "last", scope: "global", value: "{{scenario.count}}" }],
      ],
      [
        ["start", "next", "a"],
        ["a", "next", "b"],
      ],
    );

    await run(scenario, w);
    await run(scenario, w);
    expect(w.vars.get("scenario:testscenario:count")).toBe(2);
    expect(w.vars.get("global::last")).toBe(2);
  });

  it("stopping ends the run as stopped; a run abort with a code is an error", async () => {
    const scenario = scenarioOf([["wait", "flow.wait", { seconds: 10 }]], [["start", "next", "wait"]]);
    const stopped = new AbortController();
    stopped.abort(new RunAbort("stopped"));
    expect((await run(scenario, world(), { signal: stopped.signal })).info.status).toBe("stopped");

    const timeout = new AbortController();
    timeout.abort(new RunAbort("run-timeout"));
    expect((await run(scenario, world(), { signal: timeout.signal })).info).toMatchObject({ status: "error", error: { code: "run-timeout" } });
  });

  it("Stop with the Error status fails the run with its message", async () => {
    const { info } = await run(scenarioOf([["stop", "flow.stop", { status: "error", message: "nope" }]], [["start", "next", "stop"]]));

    expect(info).toMatchObject({ status: "error", error: { code: "stopped-with-error", message: "nope" } });
  });

  it("Wait until polls its condition and times out through its fail output", async () => {
    const w = world();
    const { info } = await run(
      scenarioOf(
        [
          ["get", "vars.get", { name: "never" }],
          ["wait", "flow.waitUntil", { timeout: 2, interval: 500 }],
        ],
        [
          ["start", "next", "wait"],
          ["get", "exists", "wait", "condition"],
        ],
      ),
      w,
    );

    expect(info.error?.code).toBe("timeout");
    expect(w.clock.now - 1_000_000).toBeGreaterThanOrEqual(2000);
  });

  it("runs from a step with the outputs of the previous run", async () => {
    const seed = new Map([["find", { point: { x: 1, y: 2 } }]]);
    const { w } = await run(
      scenarioOf(
        [
          ["find", "vision.find", { image: { asset: "a".repeat(64), w: 10, h: 10, scale: 1 } }],
          ["click", "input.click"],
        ],
        [
          ["start", "next", "find"],
          ["find", "found", "click"],
          ["find", "point", "click", "point"],
        ],
      ),
      world(),
      { fromNodeId: "click", seed },
    );

    expect(w.calls).toEqual([{ action: "click", args: { x: 1, y: 2, button: "left" } }]);
  });

  it("events: start and end of every step, inputs and outputs in the end", async () => {
    const { w } = await run(scenarioOf([["v", "system.volume", { mode: "set", level: 30 }]], [["start", "next", "v"]]));
    const ends = w.events.filter((e) => e.t === "node" && e.phase === "end" && e.nodeId === "v");

    expect(w.calls).toContainEqual({ action: "volume.set", args: { level: 30 } });
    expect(ends[0]).toMatchObject({ out: "next", outputs: { level: 40, muted: false } });
  });
});
