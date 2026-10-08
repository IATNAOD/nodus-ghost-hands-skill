import { EventEmitter } from "events";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { app, dialog, shell, powerMonitor } from "electron";
import { MSG, normalizeKey, LIMITS } from "@skill/protocol.js";
import { NameIndex } from "@skill/name-index.js";
import { classify } from "@skill/parse.js";
import log from "./log";
import { setLanguage, t } from "./i18n";
import { SettingsStore } from "./settings/store";
import { SecureStore } from "./settings/secure";
import type { Settings } from "./settings/defaults";
import { Helper } from "./system/helper";
import { machineHash, osName } from "./system/machine";
import { wolInfo, type WolInfo } from "./system/nic";
import { RunningMonitor } from "./system/running";
import { Catalog } from "./catalog";
import { listStartApps, startId, type StartApp } from "./catalog/startmenu";
import { Dispatcher, type Command } from "./exec";
import { launchApp } from "./exec/apps";
import { PowerControl, type OverlayHost } from "./exec/power";
import { Connection, type Welcome } from "./net/connection";
import type { Updater } from "./updater";
import type {
  AppPatch,
  CommandLogEntry,
  GhostApi,
  InvokeMethod,
  Language,
  NewApp,
  PairRequest,
  PairResult,
  PhraseCheck,
  PhraseMatch,
  Prefs,
  UiPrefs,
  UiState,
} from "../shared/types";
import { FEATURES } from "../shared/types";

const FATAL = new Set(["auth-failed", "removed", "name-taken", "proto-unsupported", "rate-limited"]);
const PAIR_TIMEOUT_MS = 20_000;
const LOG_SIZE = 20;

const cleanList = (list: unknown, max: number, length: number): string[] =>
  Array.isArray(list) ? [...new Set(list.filter((item) => typeof item === "string").map((item) => item.trim().slice(0, length)).filter(Boolean))].slice(0, max) : [];

const systemLanguage = (): Language => (app.getLocale().toLowerCase().startsWith("ru") ? "ru" : "en");

/**
 * Everything the client does, behind one object: the window, the tray and the
 * IPC handlers only call it and listen to "state".
 */
export class Core extends EventEmitter {
  store!: SettingsStore;
  secure!: SecureStore;
  helper = new Helper();
  catalog!: Catalog;
  running!: RunningMonitor;
  power!: PowerControl;
  dispatcher!: Dispatcher;
  connection!: Connection;
  updater: Updater | null = null;

  private warnings = new Map<string, { alias: string; code: string }[]>();
  private nameError: string | null = null;
  private log: CommandLogEntry[] = [];
  private wol: WolInfo | null = null;
  private machine: string | null = null;
  private volume: { level: number; muted: boolean } | null = null;
  private lastConfig = "";
  private configTimer: NodeJS.Timeout | null = null;
  private stateTimer: NodeJS.Timeout | null = null;
  private stateEmitTimer: NodeJS.Timeout | null = null;
  private startApps: StartApp[] = [];
  private scannedOnce = false;
  lastCommandAt = 0;

  constructor(private overlay: OverlayHost) {
    super();
  }

  async init(): Promise<void> {
    const dir = app.getPath("userData");

    this.store = new SettingsStore(dir, systemLanguage());
    await this.store.load();
    setLanguage(this.store.get().ui.language);
    this.secure = new SecureStore(dir);

    this.catalog = new Catalog(this.helper, this.store);
    this.running = new RunningMonitor(this.helper, this.catalog);
    this.power = new PowerControl(this.helper, this.store, this.overlay);
    this.dispatcher = new Dispatcher({ helper: this.helper, catalog: this.catalog, running: this.running, store: this.store }, this.power);
    this.connection = new Connection({
      getKey: () => this.secure.getKey(),
      getServer: () => this.store.get().server,
      getDeviceId: () => this.store.get().device.id,
      getDevice: async () => ({
        name: this.store.get().device.name,
        aliases: this.store.get().device.aliases,
        machineHash: (this.machine ??= await machineHash(this.helper)),
        os: osName(),
        host: os.hostname(),
        client: app.getVersion(),
      }),
    });

    this.wire();
    this.helper.start();

    if (await this.secure.getKey()) this.connection.start();
    else this.connection.stop("unpaired");
  }

  private wire(): void {
    this.store.on("change", ({ skill }: { skill: boolean }) => {
      if (skill) this.scheduleConfig();
      this.emitState();
    });
    this.catalog.on("change", () => {
      // a scan changed the apps: the skill must know
      if (this.configKey() !== this.lastConfig && this.connection.isOnline()) this.store.update(() => undefined);
      this.emitState();
    });
    this.running.on("change", () => {
      this.scheduleState();
      this.emitState();
    });
    this.power.on("change", () => {
      this.scheduleState();
      this.emitState();
    });
    this.helper.on("restart", () => {
      this.running.watch();
      if (!this.scannedOnce) {
        this.scannedOnce = true;
        this.catalog.scan().catch((error) => log.warn(`scan: ${(error as Error).message}`));
      }
      this.emitState();
    });
    this.helper.on("status", () => this.emitState());
    this.connection.on("status", () => this.emitState());
    this.connection.on("welcome", (welcome: Welcome, address: string) => this.onWelcome(welcome, address));
    this.connection.on("message", (message: Record<string, unknown>) => {
      this.onMessage(message).catch((error) => log.error(`message ${String(message.t)}: ${(error as Error).message}`));
    });
    this.connection.on("removed", () => {
      this.store.update((draft) => {
        draft.device.id = null;
        draft.paired = null;
      }, { skill: false });
    });

    const wake = () => {
      if (this.connection.status !== "unpaired") this.connection.reconnectNow();
    };

    powerMonitor.on("suspend", () => this.connection.bye("sleep"));
    powerMonitor.on("resume", wake);
    powerMonitor.on("unlock-screen", wake);
  }

  /* ── skill sync ── */

  private configData() {
    const settings = this.store.get();

    return {
      name: settings.device.name,
      aliases: settings.device.aliases,
      shared: settings.device.shared,
      apps: this.catalog.configApps(),
      features: settings.features,
      prefs: {
        confirmPower: settings.prefs.confirmPower,
        searchEngine: settings.prefs.searchEngine,
        volumeStep: settings.prefs.volumeStep,
        forceCloseSec: settings.prefs.forceCloseSec,
        shareRunning: settings.prefs.shareRunning,
        paused: settings.prefs.paused,
      },
      wol: settings.features.wake ? this.wol : null,
      client: { version: app.getVersion(), os: osName() },
    };
  }

  private configKey(): string {
    return JSON.stringify(this.configData());
  }

  private scheduleConfig(): void {
    if (this.configTimer) clearTimeout(this.configTimer);
    this.configTimer = setTimeout(() => this.sendConfig(), 500);
  }

  private sendConfig(): void {
    if (!this.connection.isOnline()) return;

    const data = this.configData();

    if (this.connection.send(MSG.CONFIG, { rev: this.store.get().configRev, data })) this.lastConfig = JSON.stringify(data);
  }

  private scheduleState(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.sendState();
    }, 1000);
  }

  private sendState(): void {
    if (!this.connection.isOnline()) return;

    this.connection.send(MSG.STATE, {
      data: {
        running: this.running.forSkill(this.store.get().prefs.shareRunning),
        volume: this.volume?.level ?? null,
        muted: this.volume?.muted ?? null,
        shutdownAt: this.power.shutdownAt(),
      },
    });
  }

  private async onWelcome(welcome: Welcome, address: string): Promise<void> {
    this.store.update(
      (draft) => {
        draft.device.id = welcome.deviceId;
        draft.paired = { owner: welcome.owner?.name ?? "", at: draft.paired?.at ?? Date.now() };
        draft.server.lastIp = address;
      },
      { skill: false },
    );
    this.nameError = null;
    this.wol = await wolInfo(this.helper, this.connection.localAddress);
    this.sendConfig();
    this.sendState();
    this.emit("welcome");
  }

  private async onMessage(message: Record<string, unknown>): Promise<void> {
    switch (message.t) {
      case MSG.CMD: {
        const command = message as unknown as Command;
        const result = await this.dispatcher.handle(command);

        this.connection.send(MSG.RESULT, { id: command.id, ok: result.ok, code: result.ok ? null : result.code, data: result.data ?? {} });
        if (command.action.startsWith("volume.") && result.ok && result.data && typeof result.data.level === "number") {
          this.volume = { level: result.data.level as number, muted: Boolean(result.data.muted) };
        }
        this.lastCommandAt = Date.now();
        this.addLog(command, result.ok, result.ok ? null : result.code);
        return;
      }
      case MSG.CONFIG_ACK: {
        const warnings = new Map<string, { alias: string; code: string }[]>();

        for (const warning of Array.isArray(message.warnings) ? (message.warnings as { appId: string; alias: string; code: string }[]) : []) {
          warnings.set(warning.appId, [...(warnings.get(warning.appId) ?? []), { alias: warning.alias, code: warning.code }]);
        }
        this.warnings = warnings;
        this.nameError = typeof message.error === "string" ? message.error : null;
        this.emitState();
        return;
      }
      case MSG.LEARN: {
        const appId = String(message.appId ?? "");
        const alias = String(message.alias ?? "").trim().slice(0, LIMITS.aliasLength);
        const target = this.catalog.all().find((item) => item.id === appId);

        if (!target || !alias) return;
        this.store.update((draft) => {
          const override = (draft.apps.overrides[appId] ??= {});
          const current = override.aliases ?? target.aliases;

          if (!current.some((item) => item.toLowerCase() === alias.toLowerCase())) override.aliases = [...current, alias].slice(0, LIMITS.appAliases);
        });
        log.info(`learned "${alias}" for ${appId}`);
        return;
      }
      default:
        return;
    }
  }

  private addLog(command: Command, ok: boolean, code: string | null): void {
    const args = command.args ?? {};
    const appName = typeof args.appId === "string" ? this.catalog.all().find((item) => item.id === args.appId)?.name : undefined;
    const target = appName ?? (typeof args.query === "string" ? args.query : typeof args.level === "number" ? `${args.level}%` : typeof args.delta === "number" ? `${args.delta > 0 ? "+" : ""}${args.delta}` : typeof args.key === "string" ? args.key : typeof args.target === "string" ? args.target : "");

    this.log = [{ at: Date.now(), action: command.action, target: String(target), ok, code }, ...this.log].slice(0, LOG_SIZE);
    this.emitState();
  }

  /* ── UI state ── */

  emitState(): void {
    if (this.stateEmitTimer) return;
    this.stateEmitTimer = setTimeout(() => {
      this.stateEmitTimer = null;
      this.emit("state", this.uiState());
    }, 80);
  }

  uiState(): UiState {
    const settings = this.store.get();

    return {
      version: app.getVersion(),
      paired: Boolean(settings.paired) && !["auth-failed", "removed"].includes(this.connection.status),
      connection: {
        status: this.connection.status,
        host: settings.server.host,
        port: settings.server.port,
        address: this.connection.address,
        owner: settings.paired?.owner ?? this.connection.owner,
        error: this.connection.error,
        since: this.connection.since,
      },
      device: { ...settings.device },
      nameError: this.nameError,
      apps: this.catalog.views(this.running.runningIds(), this.warnings),
      scanning: this.catalog.scanning,
      features: settings.features,
      prefs: settings.prefs,
      ui: settings.ui,
      wol: { mac: this.wol?.mac ?? null, adapter: this.wol?.adapter ?? null },
      countdown: this.power.countdown ? { action: this.power.countdown.action, endsAt: this.power.countdown.endsAt } : null,
      scheduled: this.power.scheduled ? { action: this.power.scheduled.action, at: this.power.scheduled.at } : null,
      update: this.updater?.state ?? { status: "disabled", version: null, percent: null, error: null },
      log: this.log,
      helper: { ok: this.helper.ok, error: this.helper.lastError },
    };
  }

  /* ── API for the window ── */

  // deep links live in index.ts: takePairLink is answered there
  private api: Omit<GhostApi, "onState" | "onPairLink" | "takePairLink"> = {
    getState: async () => this.uiState(),

    pair: (request) => this.pair(request),

    unpair: async () => {
      this.connection.bye("unpair");
      await new Promise((resolve) => setTimeout(resolve, 300));
      this.connection.stop("unpaired");
      await this.secure.setKey(null);
      this.store.update(
        (draft) => {
          draft.device.id = null;
          draft.paired = null;
        },
        { skill: false },
      );
    },

    reconnect: async () => this.connection.reconnectNow(),

    setDevice: async (patch) => {
      this.store.update((draft) => {
        if (typeof patch.name === "string" && patch.name.trim()) draft.device.name = patch.name.trim().slice(0, LIMITS.deviceName);
        if (patch.aliases) draft.device.aliases = cleanList(patch.aliases, LIMITS.deviceAliases, LIMITS.deviceName);
        if (typeof patch.shared === "boolean") draft.device.shared = patch.shared;
      });
    },

    setServer: async ({ host, port }) => {
      this.store.update(
        (draft) => {
          draft.server.host = String(host || "").trim() || draft.server.host;
          draft.server.port = Number.isInteger(port) && port > 0 && port < 65536 ? port : draft.server.port;
          draft.server.lastIp = null;
        },
        { skill: false },
      );
      if (this.connection.status !== "unpaired") this.connection.reconnectNow();
    },

    setApp: async (id, patch: AppPatch) => {
      this.store.update((draft) => {
        const override = (draft.apps.overrides[id] ??= {});

        if (typeof patch.enabled === "boolean") override.enabled = patch.enabled;
        if (patch.aliases) override.aliases = cleanList(patch.aliases, LIMITS.appAliases, LIMITS.aliasLength);
        if (typeof patch.spoken === "string") override.spoken = patch.spoken.trim().slice(0, LIMITS.aliasLength);
      });
    },

    addApp: (newApp) => this.addApp(newApp),

    removeApp: async (id) => {
      this.store.update((draft) => {
        draft.apps.custom = draft.apps.custom.filter((item) => item.id !== id);
        draft.apps.start = draft.apps.start.filter((item) => startId(item.appId) !== id);
        delete draft.apps.overrides[id];
      });
    },

    listStartApps: async () => {
      this.startApps = await listStartApps(this.helper);

      const added = new Set(this.store.get().apps.start.map((item) => item.appId));

      return this.startApps.map((item) => ({ appId: item.appId, name: item.name, added: added.has(item.appId) }));
    },

    addStartApps: async (appIds) => {
      const picks = this.startApps.filter((item) => appIds.includes(item.appId));

      this.store.update((draft) => {
        for (const pick of picks) {
          if (!draft.apps.start.some((item) => item.appId === pick.appId)) draft.apps.start.push({ appId: pick.appId, name: pick.name, target: pick.target });
        }
      });
    },

    pickExecutable: async () => {
      const result = await dialog.showOpenDialog({ title: t("pickExecutable"), properties: ["openFile"], filters: [{ name: t("filterPrograms"), extensions: ["exe", "lnk", "url", "bat", "cmd"] }] });
      const file = result.filePaths[0];

      if (result.canceled || !file) return null;

      let name = path.basename(file).replace(/\.(exe|lnk|url|bat|cmd)$/i, "");

      if (/\.exe$/i.test(file)) {
        const info = await this.helper.call<{ product?: string; description?: string }>("file.info", { path: file }).catch(() => null);

        name = info?.description || info?.product || name;
      }

      return { path: file, name };
    },

    rescan: async () => this.catalog.scan(),

    testLaunch: async (id) => {
      const target = this.catalog.all().find((item) => item.id === id);

      if (!target) return { ok: false, code: "app-not-found" };

      const result = await launchApp({ helper: this.helper, catalog: this.catalog, running: this.running, store: this.store }, target);

      return { ok: result.ok, code: result.ok ? null : result.code };
    },

    setFeatures: async (patch) => {
      this.store.update((draft) => {
        for (const feature of FEATURES) if (typeof patch[feature] === "boolean") draft.features[feature] = patch[feature] as boolean;
      });
    },

    setPrefs: async (patch: Partial<Prefs>) => {
      this.store.update((draft) => {
        const prefs = draft.prefs;

        if (typeof patch.confirmPower === "boolean") prefs.confirmPower = patch.confirmPower;
        if (patch.searchEngine && ["google", "yandex", "bing", "duckduckgo"].includes(patch.searchEngine)) prefs.searchEngine = patch.searchEngine;
        if (Number.isFinite(patch.volumeStep)) prefs.volumeStep = Math.min(50, Math.max(1, Math.round(patch.volumeStep!)));
        if (Number.isFinite(patch.forceCloseSec)) prefs.forceCloseSec = Math.min(60, Math.max(0, Math.round(patch.forceCloseSec!)));
        if (Number.isFinite(patch.countdownSec)) prefs.countdownSec = Math.min(60, Math.max(0, Math.round(patch.countdownSec!)));
        if (typeof patch.shareRunning === "boolean") prefs.shareRunning = patch.shareRunning;
        if (typeof patch.paused === "boolean") prefs.paused = patch.paused;
      });
    },

    setUi: async (patch: Partial<UiPrefs>) => {
      const before = this.store.get().ui;

      this.store.update(
        (draft) => {
          Object.assign(draft.ui, Object.fromEntries(Object.entries(patch).filter(([key, value]) => key in draft.ui && typeof value === typeof (draft.ui as unknown as Record<string, unknown>)[key])));
        },
        // the language renames built-in apps for the skill
        { skill: patch.language !== undefined && patch.language !== before.language },
      );
      setLanguage(this.store.get().ui.language);
      if (patch.autostart !== undefined) this.applyAutostart();
      if (patch.autoUpdate !== undefined) this.updater?.applyPrefs();
      this.emit("ui");
    },

    checkPhrase: async (text) => this.checkPhrase(text),

    checkUpdates: async () => this.updater?.check(),

    installUpdate: async () => this.updater?.install(),

    openLogs: async () => {
      await shell.openPath(path.dirname(log.transports.file.getFile().path));
    },

    openExternal: async (url) => {
      if (/^https:\/\//i.test(url)) await shell.openExternal(url);
    },

    cancelCountdown: async () => {
      await this.power.cancel();
    },
  };

  async invoke(method: InvokeMethod, args: unknown[]): Promise<unknown> {
    const handler = this.api[method as keyof typeof this.api] as ((...values: unknown[]) => Promise<unknown>) | undefined;

    if (typeof handler !== "function") throw new Error(`unknown method ${String(method)}`);

    return handler(...args);
  }

  private async pair(request: PairRequest): Promise<PairResult> {
    const key = normalizeKey(request.key);
    const name = String(request.name ?? "").trim();

    if (!key) return { ok: false, code: "bad-key" };
    if (!name || name.length > LIMITS.deviceName) return { ok: false, code: "bad-name" };

    this.store.update(
      (draft: Settings) => {
        draft.device.name = name;
        draft.device.shared = Boolean(request.shared);
        draft.device.id = null;
        draft.paired = null;
        draft.server.host = String(request.host || "").trim() || draft.server.host;
        draft.server.port = Number.isInteger(request.port) && request.port > 0 ? request.port : draft.server.port;
        draft.server.lastIp = null;
        draft.ui.autostart = Boolean(request.autostart);
      },
      { skill: true },
    );
    await this.secure.setKey(key);
    this.applyAutostart();

    const outcome = new Promise<PairResult>((resolve) => {
      const timer = setTimeout(() => finish({ ok: false, code: this.connection.error === "not-found" ? "not-found" : "unreachable" }), PAIR_TIMEOUT_MS);
      const onWelcome = () => finish({ ok: true });
      const onStatus = () => {
        if (FATAL.has(this.connection.status)) finish({ ok: false, code: this.connection.status });
      };
      const finish = (result: PairResult) => {
        clearTimeout(timer);
        this.off("welcome", onWelcome);
        this.connection.off("status", onStatus);
        resolve(result);
      };

      this.on("welcome", onWelcome);
      this.connection.on("status", onStatus);
    });

    this.connection.reconnectNow();

    const result = await outcome;

    if (!result.ok && result.code !== "unreachable" && result.code !== "not-found") {
      this.connection.stop(this.connection.status);
    }

    return result;
  }

  private async addApp(newApp: NewApp): Promise<{ ok: boolean; code?: string }> {
    const name = String(newApp.name ?? "").trim().slice(0, LIMITS.appName);
    const aliases = cleanList(newApp.aliases ?? [], LIMITS.appAliases, LIMITS.aliasLength);

    if (!name) return { ok: false, code: "bad-name" };

    if (newApp.type === "site") {
      let url: URL;

      try {
        url = new URL(String(newApp.url ?? "").trim().replace(/^(?!https?:\/\/)/i, "https://"));
      } catch {
        return { ok: false, code: "bad-url" };
      }
      if (!/^https?:$/.test(url.protocol)) return { ok: false, code: "bad-url" };

      const id = `url:${randomUUID()}`;

      this.store.update((draft) => {
        draft.apps.custom.push({ id, type: "site", name, url: url.toString() });
        if (aliases.length) draft.apps.overrides[id] = { aliases };
      });
      return { ok: true };
    }

    const file = String(newApp.path ?? "");

    if (!/\.(exe|lnk|url|bat|cmd)$/i.test(file)) return { ok: false, code: "bad-path" };

    let target: string | undefined;

    if (/\.lnk$/i.test(file)) {
      try {
        target = shell.readShortcutLink(file).target;
      } catch {
        target = undefined;
      }
    }

    const id = `custom:${randomUUID()}`;

    this.store.update((draft) => {
      draft.apps.custom.push({ id, type: "exe", name, path: file, target });
      if (aliases.length) draft.apps.overrides[id] = { aliases };
    });
    return { ok: true };
  }

  private checkPhrase(text: string): PhraseCheck {
    const index = new NameIndex();

    index.upsert({ deviceId: "this-pc", userId: "me", config: this.configData(), online: true });
    index.setState("this-pc", { running: this.running.forSkill(true), volume: null, muted: null, shutdownAt: null });

    const result = classify(String(text ?? "").slice(0, 300), { index, userId: "me" });

    if (!result) return { intent: null, score: null, params: null, apps: [] };

    const params = result.params as { objects?: string[]; generic?: string | null };
    const devices = index.all();
    const apps = (params.generic ? [] : (params.objects ?? [])).map((spoken): PhraseMatch => {
      const found = index.matchApps(spoken, devices, { running: result.intent === "close_app" }) as {
        status: PhraseMatch["status"];
        best: { name: string; score: number } | null;
        options: { name: string }[];
      };
      const names = found.status === "none" ? [] : found.status === "ambiguous" ? found.options.map((option) => option.name) : [found.best!.name];

      return { spoken, status: found.status, names, score: found.best ? Math.round(found.best.score * 100) / 100 : null };
    });

    return { intent: result.intent, score: result.score, params: result.params as Record<string, unknown>, apps };
  }

  applyAutostart(): void {
    if (!app.isPackaged) return;

    app.setLoginItemSettings({ openAtLogin: this.store.get().ui.autostart, path: process.execPath, args: ["--hidden"] });
  }

  /** Feature flags and prefs for the tray menu */
  get paused(): boolean {
    return this.store.get().prefs.paused;
  }

  togglePause(): void {
    this.api.setPrefs({ paused: !this.paused }).catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    this.connection.bye("quit");
    this.connection.stop(this.connection.status);
    this.power.dispose();
    this.catalog.dispose();
    this.helper.stop();
    await this.store.flush();
  }
}

