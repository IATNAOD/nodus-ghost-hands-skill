/**
 * The skill's own WebSocket server for PCs in the home network:
 * ws://<NODUS>:<port>/gh. Plain HTTP answers 426; browsers (requests with
 * an Origin header) are refused, so a web page cannot talk to it.
 */
"use strict";

const http = require("http");
const { WebSocketServer } = require("ws");
const P = require("./protocol");

const RETRY_MS = 10_000;
const MAX_UPGRADES = 64;

const reject = (socket, status, text) => {
  try {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    socket.destroy();
  }
};

class Server {
  /**
   * @param {{ hub: import("./hub").Hub, log?: (message: string) => void }} deps
   */
  constructor({ hub, log = () => {} }) {
    this.hub = hub;
    this.log = log;
    this.state = "stopped";
    this.port = null;
    this.error = null;
    this.http = null;
    this.wss = null;
    this.retryTimer = null;
    this.generation = 0;
  }

  /** For the personal page: { state: "listening"|"port-busy"|"error"|"stopped"|"starting", port, error } */
  status() {
    return { state: this.state, port: (this.state === "listening" && this.address()) || this.port, error: this.error };
  }

  async start(port) {
    await this.stop();

    const generation = ++this.generation;

    this.port = port;
    this.state = "starting";
    this.error = null;

    this.wss = new WebSocketServer({ noServer: true, maxPayload: P.LIMITS.clientPayload, perMessageDeflate: false, clientTracking: true });
    this.wss.on("error", (error) => this.log(`ws server: ${error.message}`));

    this.http = http.createServer((req, res) => {
      res.writeHead(426, { "content-type": "text/plain; charset=utf-8", upgrade: "websocket" });
      res.end("Ghost Hands: WebSocket only\n");
    });
    this.http.on("upgrade", (req, socket, head) => {
      try {
        this.upgrade(req, socket, head);
      } catch (error) {
        this.log(`upgrade: ${error.message}`);
        socket.destroy();
      }
    });
    this.http.on("clientError", (error, socket) => socket.destroy());
    this.http.on("error", (error) => this.log(`http server: ${error.message}`));

    await this.listen(port, generation);
  }

  upgrade(req, socket, head) {
    socket.on("error", () => {});

    let pathname = "";

    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      return reject(socket, 400, "Bad Request");
    }

    if (pathname !== P.WS_PATH) return reject(socket, 404, "Not Found");
    if (req.headers.origin) return reject(socket, 403, "Forbidden");
    if (!this.wss || this.wss.clients.size >= MAX_UPGRADES) return reject(socket, 503, "Service Unavailable");

    return this.wss.handleUpgrade(req, socket, head, (ws) => {
      try {
        this.hub.attach(ws, req);
      } catch (error) {
        this.log(`attach: ${error.message}`);
        ws.terminate();
      }
    });
  }

  listen(port, generation) {
    const attempt = (host) =>
      new Promise((resolve, reject) => {
        const onError = (error) => {
          this.http?.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          this.http?.off("error", onError);
          resolve();
        };

        this.http.once("error", onError);
        this.http.once("listening", onListening);
        this.http.listen({ port, host, ipv6Only: false });
      });

    return attempt("::")
      .catch((error) => {
        if (error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL") return attempt("0.0.0.0");
        throw error;
      })
      .then(
        () => {
          if (generation !== this.generation) return;
          this.state = "listening";
          this.log(`listening on port ${port}`);
        },
        (error) => {
          if (generation !== this.generation) return;
          this.error = error.code ?? error.message;
          this.state = error.code === "EADDRINUSE" ? "port-busy" : "error";
          this.log(`cannot listen on ${port}: ${this.error}, retrying in ${RETRY_MS / 1000} s`);
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (generation === this.generation && this.http) this.listen(port, generation).catch((err) => this.log(`retry: ${err.message}`));
          }, RETRY_MS);
          this.retryTimer.unref?.();
        },
      );
  }

  async stop() {
    this.generation++;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;

    const server = this.http;
    const wss = this.wss;

    this.http = null;
    this.wss = null;
    this.state = "stopped";

    if (wss) {
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {
          // already gone
        }
      }
      await new Promise((resolve) => wss.close(() => resolve()));
    }
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => (server.listening ? server.close(() => resolve()) : resolve()));
    }
  }

  restart(port) {
    return this.start(port);
  }

  /** Bound port (tests listen on port 0). */
  address() {
    return this.http?.address?.()?.port ?? null;
  }
}

module.exports = { Server };
