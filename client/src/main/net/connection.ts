import { EventEmitter } from "events";
import { promises as dns } from "dns";
import { isIP } from "net";
import WebSocket from "ws";
import { PROTO, WS_PATH, MSG, CLOSE, LIMITS, encode, decode } from "@skill/protocol.js";
import log from "../log";
import type { ConnectionStatus } from "../../shared/types";

const BACKOFF_MS = [1000, 2000, 5000, 10000, 20000, 30000];
const STABLE_MS = 60_000;
const PING_TIMEOUT_MS = 75_000;
const HANDSHAKE_MS = 8000;
const RATE_LIMIT_WAIT_MS = 10 * 60_000;

export interface HelloDevice {
  name: string;
  aliases: string[];
  machineHash: string;
  os: string;
  host: string;
  client: string;
}

export interface ConnectionDeps {
  getKey: () => Promise<string | null>;
  getServer: () => { host: string; port: number; lastIp: string | null };
  getDeviceId: () => string | null;
  getDevice: () => Promise<HelloDevice>;
}

export interface Welcome {
  deviceId: string;
  name: string;
  owner: { name: string };
  server: { version: string; protoMin: number; protoMax: number };
  created: boolean;
}

/**
 * WebSocket connection to the Ghost Hands skill on NODUS. Emits:
 * "status", "welcome" (Welcome, address), "message" (decoded frame),
 * "removed" (unpaired on the personal page).
 */
export class Connection extends EventEmitter {
  status: ConnectionStatus = "unpaired";
  error: string | null = null;
  address: string | null = null;
  localAddress: string | null = null;
  owner = "";
  since: number | null = null;

  private ws: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(private deps: ConnectionDeps) {
    super();
  }

  start(): void {
    this.stopped = false;
    this.attempt = 0;
    this.connect().catch((error) => log.error(`connect: ${(error as Error).message}`));
  }

  stop(status: ConnectionStatus = "unpaired"): void {
    this.stopped = true;
    this.clearTimers();
    this.closeSocket(1000, "stop");
    this.setStatus(status, null);
  }

  /** Right now (after sleep, a changed address); keeps going if stopped by a fatal code. */
  reconnectNow(): void {
    this.stopped = false;
    this.attempt = 0;
    this.clearTimers();
    this.closeSocket(1000, "reconnect");
    this.connect().catch((error) => log.error(`connect: ${(error as Error).message}`));
  }

  isOnline(): boolean {
    return this.status === "online" && this.ws?.readyState === WebSocket.OPEN;
  }

  send(type: string, fields: Record<string, unknown>): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(encode(type, fields), (error) => error && log.warn(`send ${type}: ${error.message}`));
    return true;
  }

  /** Polite goodbye before sleep or unpairing. */
  bye(reason: "quit" | "sleep" | "unpair"): void {
    this.send(MSG.BYE, { reason });
  }

  private setStatus(status: ConnectionStatus, error: string | null): void {
    const changed = status !== this.status || error !== this.error;

    this.status = status;
    this.error = error;
    if (status === "online") this.since = Date.now();
    if (changed) this.emit("status");
  }

  private async addresses(host: string, lastIp: string | null): Promise<string[]> {
    if (isIP(host)) return [host];

    try {
      // getaddrinfo: resolves project-nod.local through mDNS on Windows 10/11
      const found = await dns.lookup(host, { all: true });
      const list = found.sort((a, b) => a.family - b.family).map((item) => item.address);

      return [...new Set([...list, ...(lastIp ? [lastIp] : [])])];
    } catch (error) {
      log.warn(`resolve ${host}: ${(error as Error).message}`);
      return lastIp ? [lastIp] : [];
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    const key = await this.deps.getKey();

    if (!key) {
      this.setStatus("unpaired", null);
      return;
    }

    const server = this.deps.getServer();

    this.setStatus("connecting", null);

    const addresses = await this.addresses(server.host, server.lastIp);

    if (this.stopped) return;
    if (!addresses.length) {
      this.setStatus("offline", "not-found");
      this.retry();
      return;
    }

    const address = addresses[this.attempt % addresses.length];
    const host = address.includes(":") ? `[${address}]` : address;
    const ws = new WebSocket(`ws://${host}:${server.port}${WS_PATH}`, { handshakeTimeout: HANDSHAKE_MS, perMessageDeflate: false, maxPayload: LIMITS.serverPayload });

    this.ws = ws;

    ws.on("open", async () => {
      try {
        this.localAddress = (ws as unknown as { _socket?: { localAddress?: string } })._socket?.localAddress ?? null;
        this.watchPing();
        ws.send(encode(MSG.HELLO, { proto: PROTO, key, deviceId: this.deps.getDeviceId(), device: await this.deps.getDevice() }));
      } catch (error) {
        log.error(`hello: ${(error as Error).message}`);
        ws.terminate();
      }
    });
    ws.on("ping", () => this.watchPing());
    ws.on("message", (raw) => {
      const message = decode(raw);

      if (!message) return;
      if (message.t === MSG.WELCOME) {
        this.address = address;
        this.owner = String((message as unknown as Welcome).owner?.name ?? "");
        this.setStatus("online", null);
        this.stableTimer = setTimeout(() => (this.attempt = 0), STABLE_MS);
        this.emit("welcome", message as unknown as Welcome, address);
        return;
      }
      this.emit("message", message);
    });
    ws.on("error", (error) => log.warn(`ws ${address}: ${error.message}`));
    ws.on("close", (code, reason) => this.onClose(ws, code, String(reason)));
  }

  private onClose(ws: WebSocket, code: number, reason: string): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.clearTimers();
    if (this.stopped) return;

    log.info(`closed ${code} ${reason}`);

    switch (code) {
      case CLOSE.AUTH_FAILED:
        this.stopped = true;
        this.setStatus("auth-failed", reason || null);
        return;
      case CLOSE.UNPAIRED:
        this.stopped = true;
        this.setStatus("removed", null);
        this.emit("removed");
        return;
      case CLOSE.NAME_TAKEN:
        this.stopped = true;
        this.setStatus("name-taken", null);
        return;
      case CLOSE.PROTO_UNSUPPORTED:
        this.setStatus("proto-unsupported", reason || null);
        this.retry(RATE_LIMIT_WAIT_MS);
        return;
      case CLOSE.RATE_LIMITED:
        this.setStatus("rate-limited", null);
        this.retry(RATE_LIMIT_WAIT_MS);
        return;
      case CLOSE.REPLACED:
        this.setStatus("offline", "replaced");
        this.retry(5000);
        return;
      default:
        this.setStatus("offline", code === 1006 ? "unreachable" : `closed-${code}`);
        this.retry();
    }
  }

  private retry(delay?: number): void {
    if (this.stopped) return;

    const base = delay ?? BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    const jitter = delay ? 0 : base * (Math.random() * 0.4 - 0.2);

    this.attempt++;
    this.retryTimer = setTimeout(() => this.connect().catch((error) => log.error(`connect: ${(error as Error).message}`)), Math.round(base + jitter));
  }

  /** No ping from the server for 75 s: the connection is dead. */
  private watchPing(): void {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = setTimeout(() => {
      log.warn("no ping from the server, reconnecting");
      this.ws?.terminate();
    }, PING_TIMEOUT_MS);
  }

  private closeSocket(code: number, reason: string): void {
    const ws = this.ws;

    this.ws = null;
    if (!ws) return;
    try {
      ws.removeAllListeners("close");
      ws.on("error", () => undefined);
      if (ws.readyState === WebSocket.OPEN) ws.close(code, reason);
      else ws.terminate();
    } catch {
      // already gone
    }
  }

  private clearTimers(): void {
    for (const timer of [this.retryTimer, this.stableTimer, this.pingTimer]) if (timer) clearTimeout(timer);
    this.retryTimer = this.stableTimer = this.pingTimer = null;
  }
}
