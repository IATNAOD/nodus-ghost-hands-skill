/**
 * Ghost Hands: voice control of Windows PCs.
 * The skill keeps its own WebSocket server for PCs (lib/server.js, lib/hub.js),
 * an in-memory index of PCs and apps for routing (lib/name-index.js) and the
 * command pipeline (lib/command.js) used by intents, the AI agent and blocks.
 */
"use strict";

const { NameIndex } = require("./lib/name-index");
const { Hub } = require("./lib/hub");
const { Server } = require("./lib/server");
const { createStore } = require("./lib/store");
const { readSettings, loadedConfigs } = require("./lib/settings");
const { ScenarioEvents } = require("./lib/events");
const { Deferred } = require("./lib/deferred");
const { RecentChoices } = require("./lib/select");
const { ParentalService } = require("./lib/parental");
const state = require("./lib/state");
const { trace } = require("./lib/trace");
const wol = require("./lib/wol");
const manifest = require("./skill.json");

let instance = null;

class GhostHands {
  /**
   * @param {object} ctx lifecycle ctx
   * @param {{ port?: number }} [options] tests and tools/dev-host.js: a port instead of the setting
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.options = options;
    /** tests and tools/dev-host.js put a memory store here before init() */
    this.store = null;
    this.index = null;
    this.hub = null;
    this.server = null;
    this.events = null;
    this.deferred = null;
    this.parental = null;
    this.recent = new RecentChoices();
    this.configs = [];
    this.settings = readSettings([]);
  }

  static getInstance() {
    return instance;
  }

  async init(ctx) {
    this.ctx = ctx;
    this.configs = loadedConfigs(ctx);
    this.settings = readSettings(this.configs);
    this.store = this.store ?? createStore(ctx.models);
    this.index = new NameIndex();

    for (const record of await this.store.devices.all()) {
      this.index.upsert({ ...record, config: record.config ?? { name: record.name }, online: false });
    }

    this.events = new ScenarioEvents({ ctx, log: trace });
    this.deferred = new Deferred({ log: trace });
    this.hub = new Hub({
      store: this.store,
      index: this.index,
      log: trace,
      version: manifest.version,
      onEvent: (type, data) => this.onHubEvent(type, data),
      parental: (deviceId) => this.parental?.payload(deviceId) ?? { enabled: false, rev: 0 },
    });
    this.parental = new ParentalService({
      store: this.store,
      hub: this.hub,
      index: this.index,
      events: this.events,
      log: trace,
      t: (key, vars) => this.ctx.t(key, vars),
      // the owner may be away: the alert waits for their voice up to a day
      notify: (userId, text) => this.notify(userId, text, { undeliveredAfterMin: 120, expiresInMin: 1440 }),
    });
    await this.parental.init();
    this.server = new Server({ hub: this.hub, log: trace });
    this.applyMatchSettings(this.settings);

    state.set({ skill: this, index: this.index, hub: this.hub });
    // listening is background work: a busy port must not stop the skill from loading
    this.serverStarted = this.server.start(this.options.port ?? this.settings.port).catch((error) => trace(`server: ${error.message}`));
    instance = this;
  }

  /** Synchronous: the core does not await it. */
  onConfigChange(configs) {
    try {
      const next = readSettings(configs);
      const portChanged = next.port !== this.settings.port;

      this.configs = configs;
      this.settings = next;
      this.applyMatchSettings(next);
      if (portChanged && this.server && this.options.port === undefined) this.server.restart(next.port).catch((error) => trace(`restart: ${error.message}`));
    } catch (error) {
      trace(`settings: ${error.message}`);
    }
  }

  /** The "run without asking" threshold: the name index and the PCs' phrase check use it. */
  applyMatchSettings(settings) {
    if (this.index?.setAccept(settings.acceptScore)) this.hub?.broadcastSettings();
  }

  onHubEvent(type, data) {
    try {
      switch (type) {
        case "online":
          this.events.online(data.device, data.lastSeenAt);
          this.parental.online(data.device);
          break;
        case "offline":
          this.events.offline(data.device);
          this.parental.offline(data.device, data.reason);
          break;
        case "removed":
          this.parental.remove(data.deviceId).catch((error) => trace(`parental: ${error.message}`));
          break;
        case "parental-usage":
          this.parental.usage(data.device, data.usage);
          break;
        case "parental-alert":
          this.parental.alert(data.device, data.kind, { until: data.until });
          break;
        case "config":
          this.deferred.ready(data.device.deviceId);
          break;
        case "app-started":
          this.events.app("app_started", data.device, data.app, data.item);
          break;
        case "app-stopped":
          this.events.app("app_stopped", data.device, data.app, data.item);
          break;
        default:
          break;
      }
    } catch (error) {
      trace(`event ${type}: ${error.message}`);
    }
  }

  /** Wake-on-LAN packet (replaced in tests). */
  wake(mac, broadcast) {
    return wol.wake(mac, broadcast);
  }

  /** ctx for work outside a command (a launch after Wake-on-LAN). */
  backgroundCtx() {
    return this.ctx;
  }

  /** Say something to a person when they can hear it (permission notify). */
  async notify(userId, text, options = {}) {
    if (typeof this.ctx?.notify !== "function" || !text) return;

    try {
      await this.ctx.notify({
        to: userId ? String(userId) : null,
        text: String(text).trim().replace(/[.!]+$/, ""),
        kind: "reminder",
        announce: true,
        source: this.ctx.skillId,
        undeliveredAfterMin: 10,
        expiresInMin: 30,
        ...options,
      });
    } catch (error) {
      trace(`notify: ${error.message}`);
    }
  }

  /** Also after a failed init(); safe to call twice. */
  async destroy() {
    if (instance === this) instance = null;
    if (state.get()?.skill === this) state.set(null);

    this.events?.dispose();
    this.deferred?.dispose();
    this.parental?.dispose();

    try {
      await this.hub?.dispose();
    } catch (error) {
      trace(`hub: ${error.message}`);
    }
    try {
      await this.server?.stop();
    } catch (error) {
      trace(`server: ${error.message}`);
    }
  }
}

module.exports = GhostHands;
