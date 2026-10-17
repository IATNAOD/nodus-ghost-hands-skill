// The interpreter of scenarios. Pure: time, sleeping, node implementations, variables and
// events come from the host, so vitest runs it without Electron.
//
// One flow per run: from Start along exec wires. A loop runs its body in a frame until the
// chain ends. Data inputs: a wire from a pure node evaluates it (once per pass), a wire from
// an action reads what that action produced last in this run, no wire - the literal with
// {{variables}}. Errors: the node's "error" output when wired, otherwise the run fails.
import { defOf, isConnectable, type NodeDef, type PinDef } from "../../shared/scenarios/defs";
import { execTarget } from "../../shared/scenarios/cfg";
import { LIMITS, type GraphNode, type RunEvent, type RunInfo, type RunStatus, type RunTrigger, type Scenario, type Value } from "../../shared/scenarios/model";
import { coerce, isEmpty, preview } from "../../shared/scenarios/pins";
import { resolveTemplate } from "../../shared/scenarios/template";

export class NodeError extends Error {
  constructor(
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** Why a run was cut short: "stopped" by a person, or an error code (run-timeout, parental-limit...). */
export class RunAbort extends Error {
  constructor(public code: string) {
    super(code);
  }
}

class BreakSignal {}

class StopSignal {
  constructor(
    public status: "success" | "error",
    public output: Value,
    public message: string,
  ) {}
}

export interface NodeResult {
  /** the exec output to follow; the first next/branch one by default */
  out?: string;
  outputs?: Record<string, Value>;
  /** for a "fail" output left unconnected: the error code and text */
  code?: string;
  message?: string;
}

export interface NodeCtx<S = unknown> {
  node: GraphNode;
  def: NodeDef;
  inputs: Record<string, Value>;
  signal: AbortSignal;
  scenario: Scenario;
  run: RunScope;
  services: S;
  log(level: "info" | "warn" | "error", text: string): void;
  /** outputs a loop body can read before the loop ends (the round number) */
  setOutputs(outputs: Record<string, Value>): void;
  /** runs the chain wired to an exec output; "break" when Break ended it */
  runBody(out?: string): Promise<"end" | "break">;
  /** an input evaluated again (a loop condition) */
  evalInput(pin: string): Promise<Value>;
  sleep(ms: number): Promise<void>;
  /** variables by scope: run, scenario, global; "auto" reads run → scenario → global */
  variables: {
    get(name: string, scope: string): { value: Value; exists: boolean };
    set(name: string, scope: string, value: Value): void;
  };
}

export interface NodeImpl<S = unknown> {
  run(ctx: NodeCtx<S>): Promise<NodeResult> | NodeResult;
}

export interface VariableAccess {
  get(scope: "scenario" | "global", scenarioId: string, name: string): Value | undefined;
  set(scope: "scenario" | "global", scenarioId: string, name: string, value: Value): void;
}

export interface EngineHost<S = unknown> {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** lets the event loop breathe in long runs */
  yield(): Promise<void>;
  impl(type: string): NodeImpl<S> | undefined;
  variables: VariableAccess;
  emit(event: RunEvent): void;
  services: S;
}

export interface RunOptions {
  runId: string;
  trigger: RunTrigger;
  text: string;
  signal: AbortSignal;
  parentRunId?: string;
  /** debugging: start at this node; outputs of earlier steps come from `seed` */
  fromNodeId?: string;
  seed?: Map<string, Record<string, Value>>;
}

/** What a run keeps while it goes. */
export class RunScope {
  /** node id → its outputs of the latest execution */
  outputs = new Map<string, Record<string, Value>>();
  vars = new Map<string, Value>();
  steps = 0;

  constructor(
    public readonly runId: string,
    public readonly trigger: RunTrigger,
    public readonly text: string,
  ) {}
}

type Pass = Map<string, Record<string, Value>>;

const VAR_SCOPES = ["run", "scenario", "global"] as const;

export class ScenarioRun<S = unknown> {
  readonly scope: RunScope;
  private depth = 0;
  private info: RunInfo;

  constructor(
    private scenario: Scenario,
    private host: EngineHost<S>,
    private options: RunOptions,
  ) {
    this.scope = new RunScope(options.runId, options.trigger, options.text);
    for (const [id, outputs] of options.seed ?? []) this.scope.outputs.set(id, outputs);
    for (const decl of scenario.variables) {
      if (decl.scope === "run") this.scope.vars.set(decl.name, decl.initial);
      else if (host.variables.get(decl.scope, scenario.id, decl.name) === undefined) host.variables.set(decl.scope, scenario.id, decl.name, decl.initial);
    }
    this.info = {
      runId: options.runId,
      scenarioId: scenario.id,
      name: scenario.name,
      trigger: options.trigger,
      parentRunId: options.parentRunId,
      startedAt: host.now(),
      status: "running",
    };
  }

  /** Runs to the end; never throws. */
  async start(): Promise<RunInfo> {
    this.host.emit({ t: "run", run: { ...this.info } });

    let status: RunStatus = "success";
    let output: Value | undefined;
    let error: RunInfo["error"];

    try {
      const start = this.scenario.graph.nodes.find((node) => node.type === "flow.start");
      if (!start) throw new NodeError("scenario-invalid", "no Start");

      this.scope.outputs.set(start.id, { trigger: this.options.trigger, text: this.options.text });

      const first = this.options.fromNodeId ?? execTarget(this.scenario.graph.edges, start.id, "next");
      await this.chain(first);
    } catch (thrown) {
      if (thrown instanceof StopSignal) {
        output = thrown.output;
        if (thrown.status === "error") {
          status = "error";
          error = { code: "stopped-with-error", message: thrown.message || undefined };
        }
      } else if (thrown instanceof RunAbort || this.options.signal.aborted) {
        const code = thrown instanceof RunAbort ? thrown.code : abortCode(this.options.signal);
        status = code === "stopped" ? "stopped" : "error";
        if (status === "error") error = { code };
      } else if (thrown instanceof BreakSignal) {
        // Break outside a loop just ends the run
      } else {
        const failure = thrown as NodeError & { nodeId?: string };
        status = "error";
        error = { code: failure.code ?? "internal", message: failure.message !== failure.code ? failure.message : undefined, nodeId: failure.nodeId };
      }
    }

    this.info = { ...this.info, status, endedAt: this.host.now(), output, error };
    this.host.emit({ t: "run", run: { ...this.info } });
    return this.info;
  }

  /** Follows exec wires from `id` until a path ends. */
  private async chain(id: string | null): Promise<void> {
    let current = id;

    while (current) {
      this.checkAbort();
      if (++this.scope.steps > LIMITS.steps) throw Object.assign(new NodeError("step-limit"), { nodeId: current });
      if (this.scope.steps % 50 === 0) await this.host.yield();

      const node = this.scenario.graph.nodes.find((n) => n.id === current);
      if (!node) return;
      current = await this.step(node);
    }
  }

  /** One exec node; the next node id, or null when this path ends. */
  private async step(node: GraphNode): Promise<string | null> {
    const def = defOf(node.type);
    const startedAt = this.host.now();

    if (!def) throw Object.assign(new NodeError("unknown-type", node.type), { nodeId: node.id });
    this.host.emit({ t: "node", runId: this.scope.runId, nodeId: node.id, phase: "start", at: startedAt });

    let inputs: Record<string, Value> = {};

    try {
      inputs = await this.inputsOf(node, def, new Map());

      const result = await this.execute(node, def, inputs);
      const out = result.out ?? defaultOut(def);
      const outDef = def.execOuts.find((o) => o.id === out);
      const target = out ? execTarget(this.scenario.graph.edges, node.id, out) : null;
      const outputs = result.outputs ?? {};

      this.scope.outputs.set(node.id, { ...(this.scope.outputs.get(node.id) ?? {}), ...outputs });
      if (!target && outDef?.kind === "fail") throw new NodeError(result.code ?? failCode(out), result.message);

      this.endEvent(node, startedAt, inputs, outputs, out);
      return target;
    } catch (thrown) {
      if (thrown instanceof BreakSignal || thrown instanceof StopSignal || thrown instanceof RunAbort) {
        this.endEvent(node, startedAt, inputs, {}, undefined);
        throw thrown;
      }
      if (this.options.signal.aborted) throw new RunAbort(abortCode(this.options.signal));

      const failure = toNodeError(thrown);
      const errorOutputs = { errorCode: failure.code, errorMessage: failure.message !== failure.code ? failure.message : "" };
      const handler = def.execOuts.some((o) => o.id === "error") ? execTarget(this.scenario.graph.edges, node.id, "error") : null;

      // an error already raised deeper (a body step) keeps its own node
      const nodeId = (thrown as { nodeId?: string }).nodeId ?? node.id;

      this.scope.outputs.set(node.id, { ...(this.scope.outputs.get(node.id) ?? {}), ...errorOutputs });
      this.endEvent(node, startedAt, inputs, errorOutputs, handler ? "error" : undefined, failure);
      if (handler && nodeId === node.id) return handler;
      throw Object.assign(failure, { nodeId });
    }
  }

  private async execute(node: GraphNode, def: NodeDef, inputs: Record<string, Value>): Promise<NodeResult> {
    switch (node.type) {
      case "flow.break":
        throw new BreakSignal();
      case "flow.stop": {
        const status = inputs.status === "error" ? "error" : "success";
        throw new StopSignal(status, inputs.result ?? null, String(inputs.message ?? ""));
      }
    }

    const impl = this.host.impl(node.type);
    if (!impl) throw new NodeError("unknown-type", node.type);

    if (def.kind === "loop" && ++this.depth > LIMITS.nesting) throw new NodeError("nesting-too-deep");
    try {
      return await impl.run(this.ctx(node, def, inputs));
    } finally {
      if (def.kind === "loop") this.depth--;
    }
  }

  private ctx(node: GraphNode, def: NodeDef, inputs: Record<string, Value>): NodeCtx<S> {
    let rounds = 0;

    return {
      node,
      def,
      inputs,
      signal: this.options.signal,
      scenario: this.scenario,
      run: this.scope,
      services: this.host.services,
      log: (level, text) => this.host.emit({ t: "log", runId: this.scope.runId, at: this.host.now(), level, text: String(text).slice(0, 2000), nodeId: node.id }),
      setOutputs: (outputs) => this.scope.outputs.set(node.id, { ...(this.scope.outputs.get(node.id) ?? {}), ...outputs }),
      runBody: async (out = "body") => {
        if (++rounds > LIMITS.loopIterations) throw new NodeError("loop-limit");
        await this.host.yield();
        try {
          await this.chain(execTarget(this.scenario.graph.edges, node.id, out));
          return "end";
        } catch (thrown) {
          if (thrown instanceof BreakSignal) return "break";
          throw thrown;
        }
      },
      evalInput: async (pin) => {
        const pinDef = def.inputs.find((p) => p.id === pin);
        return pinDef ? this.inputValue(node, pinDef, new Map(), []) : null;
      },
      sleep: (ms) => this.host.sleep(ms, this.options.signal),
      variables: {
        get: (name, scope) => this.getVariable(name, scope),
        set: (name, scope, value) => this.setVariable(name, scope, value),
      },
    };
  }

  /* ── data ── */

  private async inputsOf(node: GraphNode, def: NodeDef, pass: Pass, stack: string[] = []): Promise<Record<string, Value>> {
    const inputs: Record<string, Value> = {};

    for (const pin of def.inputs) inputs[pin.id] = await this.inputValue(node, pin, pass, stack);
    return inputs;
  }

  private async inputValue(node: GraphNode, pin: PinDef, pass: Pass, stack: string[]): Promise<Value> {
    const edge = isConnectable(pin) ? this.scenario.graph.edges.find((e) => e.target === node.id && e.targetHandle === pin.id) : undefined;
    let value: Value;

    if (edge) {
      const source = this.scenario.graph.nodes.find((n) => n.id === edge.source);
      const sourceDef = source && defOf(source.type);

      if (!source || !sourceDef) {
        value = pin.default ?? null;
      } else if (sourceDef.kind === "pure") {
        value = (await this.evalPure(source, sourceDef, pass, stack))[edge.sourceHandle] ?? null;
      } else {
        const outputs = this.scope.outputs.get(source.id);
        if (!outputs || !(edge.sourceHandle in outputs)) {
          if (pin.required) throw new NodeError("value-unavailable", `${source.id}.${edge.sourceHandle}`);
          this.host.emit({ t: "log", runId: this.scope.runId, at: this.host.now(), level: "warn", text: `value-unavailable ${source.id}.${edge.sourceHandle}`, nodeId: node.id });
          value = pin.default ?? null;
        } else {
          value = outputs[edge.sourceHandle];
        }
      }
    } else {
      value = node.data[pin.id] ?? pin.default ?? null;
      if (pin.template && typeof value === "string") value = resolveTemplate(value, (name) => this.lookup(name));
    }

    // literal-only pins (apps, images, keys, monitors) keep their shape
    return isConnectable(pin) || pin.type === "option" ? coerce(value, pin.type) : value;
  }

  private async evalPure(node: GraphNode, def: NodeDef, pass: Pass, stack: string[]): Promise<Record<string, Value>> {
    const cached = pass.get(node.id);
    if (cached) return cached;
    if (stack.includes(node.id)) throw new NodeError("pure-cycle", node.id);

    const impl = this.host.impl(node.type);
    if (!impl) throw new NodeError("unknown-type", node.type);

    const inputs = await this.inputsOf(node, def, pass, [...stack, node.id]);
    const result = await impl.run(this.ctx(node, def, inputs));
    const outputs = result.outputs ?? {};

    pass.set(node.id, outputs);
    this.scope.outputs.set(node.id, outputs);
    this.host.emit({ t: "node", runId: this.scope.runId, nodeId: node.id, phase: "end", at: this.host.now(), inputs: shrink(inputs), outputs: shrink(outputs) });
    return outputs;
  }

  /** {{name}}: run → scenario → global; prefixed names look in one scope. */
  lookup(name: string): Value | undefined {
    const dot = name.indexOf(".");
    const prefix = dot > 0 ? name.slice(0, dot) : "";
    const rest = dot > 0 ? name.slice(dot + 1) : name;

    if (prefix === "trigger") return rest === "text" ? this.scope.text : rest === "type" ? this.scope.trigger : undefined;
    if (prefix === "now") return nowParts(this.host.now())[rest as keyof ReturnType<typeof nowParts>];
    if (prefix === "run") return this.scope.vars.get(rest);
    if (prefix === "scenario" || prefix === "global") return this.host.variables.get(prefix, this.scenario.id, rest);

    if (this.scope.vars.has(name)) return this.scope.vars.get(name);
    return this.host.variables.get("scenario", this.scenario.id, name) ?? this.host.variables.get("global", this.scenario.id, name);
  }

  /** The variables nodes: get, set, increment (here, they touch the run scope). */
  getVariable(name: string, scope: string): { value: Value; exists: boolean } {
    if (scope === "run" || scope === "scenario" || scope === "global") {
      const value = scope === "run" ? this.scope.vars.get(name) : this.host.variables.get(scope, this.scenario.id, name);
      return { value: value ?? null, exists: value !== undefined };
    }
    const value = this.lookup(name);
    return { value: value ?? null, exists: value !== undefined };
  }

  setVariable(name: string, scope: string, value: Value): void {
    const where = VAR_SCOPES.includes(scope as (typeof VAR_SCOPES)[number]) ? scope : "run";

    if (where === "run") this.scope.vars.set(name, value);
    else this.host.variables.set(where as "scenario" | "global", this.scenario.id, name, value);
  }

  private checkAbort(): void {
    if (this.options.signal.aborted) throw new RunAbort(abortCode(this.options.signal));
  }

  private endEvent(node: GraphNode, startedAt: number, inputs: Record<string, Value>, outputs: Record<string, Value>, out: string | undefined, error?: NodeError): void {
    const at = this.host.now();

    this.host.emit({
      t: "node",
      runId: this.scope.runId,
      nodeId: node.id,
      phase: "end",
      at,
      ms: at - startedAt,
      out,
      inputs: shrink(inputs),
      outputs: shrink(outputs),
      error: error ? { code: error.code, message: error.message !== error.code ? error.message : undefined } : undefined,
    });
  }
}

function defaultOut(def: NodeDef): string | undefined {
  return def.execOuts.find((out) => out.kind === "next" || out.kind === "branch" || out.kind === "done")?.id;
}

const failCode = (out: string | undefined): string => (out === "timeout" ? "timeout" : out === "notFound" ? "not-found" : "failed");

function toNodeError(thrown: unknown): NodeError {
  if (thrown instanceof NodeError) return thrown;

  const error = thrown as { code?: unknown; message?: unknown } | null;
  return new NodeError(typeof error?.code === "string" ? error.code : "internal", typeof error?.message === "string" ? error.message : String(thrown));
}

export const abortCode = (signal: AbortSignal): string => (signal.reason instanceof RunAbort ? signal.reason.code : "stopped");

const shrink = (values: Record<string, Value>): Record<string, Value> =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, preview(value, LIMITS.eventValueBytes)]));

export function nowParts(time: number) {
  const date = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");

  return {
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    weekday: date.getDay() === 0 ? 7 : date.getDay(),
    hour: date.getHours(),
    timestamp: time,
  };
}

export { isEmpty };
