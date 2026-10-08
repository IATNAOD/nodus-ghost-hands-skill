import path from "path";
import { app, ipcMain, Menu, type BrowserWindow } from "electron";
import log, { pruneLogs } from "./log";
import { Core } from "./core";
import { Updater, IDLE_MS } from "./updater";
import { createMainWindow, createOverlayHost } from "./windows";
import { createTray } from "./tray";
import { Guard } from "./parental/guard";
import { IPC, PARENTAL_IPC, type InvokeMethod, type PairLink } from "../shared/types";

const PROTOCOL = "ghosthands";
const DAY_MS = 24 * 3600_000;
// a link not taken by the pairing screen (the PC is paired) is forgotten after this
const LINK_TTL_MS = 10 * 60_000;
const METHODS = new Set<InvokeMethod>([
  "getState", "pair", "unpair", "reconnect", "setDevice", "setServer", "setApp", "addApp", "removeApp", "listStartApps",
  "addStartApps", "pickExecutable", "rescan", "testLaunch", "setFeatures", "setPrefs", "setUi", "checkPhrase",
  "checkUpdates", "installUpdate", "openLogs", "openExternal", "cancelCountdown", "takePairLink",
]);

/** ghosthands://pair?key=GH-...&host=project-nod.local&port=47300 from the personal page */
const pairLinkOf = (argv: string[]): PairLink | null => {
  const raw = argv.find((arg) => arg.toLowerCase().startsWith(`${PROTOCOL}://`));

  if (!raw) return null;

  try {
    const url = new URL(raw);
    const key = url.searchParams.get("key") ?? "";

    return key ? { key, host: url.searchParams.get("host") ?? "", port: Number(url.searchParams.get("port")) || 0 } : null;
  } catch {
    return null;
  }
};

// a run from the sources has its own settings and single-instance lock: the installed app may
// work at the same time, and a second instance would hand it the deep link and quit
if (!app.isPackaged) app.setPath("userData", path.join(app.getPath("appData"), `${app.getName()} (dev)`));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId("space.iatnaod.ghosthands");
  if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);

  const core = new Core(createOverlayHost());
  const guard = new Guard(app.getPath("userData"));
  let window: BrowserWindow | null = null;
  /** under parental control only these end the client: Windows ends the session, an update */
  let allowedQuit: "session" | "update" | null = null;
  let pendingLink = pairLinkOf(process.argv);
  let pendingLinkAt = Date.now();

  const showWindow = () => {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };

  // the pairing screen takes the link itself: it may mount after the page has loaded
  const sendLink = () => {
    if (!pendingLink || !window || window.isDestroyed() || window.webContents.isLoading()) return;
    window.webContents.send(IPC.pairLink);
  };

  const quit = () => {
    (window as (BrowserWindow & { allowClose?: () => void }) | null)?.allowClose?.();
    app.quit();
  };

  app.on("second-instance", (_event, argv) => {
    const link = pairLinkOf(argv);

    if (link) {
      pendingLink = link;
      pendingLinkAt = Date.now();
    }
    showWindow();
    sendLink();
  });

  app.whenReady().then(async () => {
    if (app.isPackaged) Menu.setApplicationMenu(null);

    const uncleanBefore = await guard.start();

    await core.init();

    // the owner hears it when the client was closed against parental control
    if (core.parental.enabled) {
      if (process.argv.includes("--restarted=killed")) core.parental.alert("killed");
      else if (uncleanBefore) core.parental.alert("unclean-exit");
    }
    // the watchdog and the autostart follow parental control; someone may switch the autostart off
    // in Windows settings, so it is set again every hour
    const protect = () => {
      guard.protect(core.parental.enabled);
      core.applyAutostart();
    };

    protect();
    core.parental.on("change", protect);
    setInterval(() => core.parental.enabled && core.applyAutostart(), 3600_000).unref();

    const updater = new Updater(
      () => core.store.get().ui,
      () => Date.now() - core.lastCommandAt > IDLE_MS && !core.power.countdown && !core.power.scheduled,
    );

    core.updater = updater;
    updater.on("change", () => core.emitState());
    updater.on("install", () => (allowedQuit = "update"));
    updater.start();

    ipcMain.handle(IPC.invoke, (event, method: InvokeMethod, ...args: unknown[]) => {
      if (!METHODS.has(method)) throw new Error(`unknown method ${String(method)}`);
      if (method === "takePairLink") {
        const link = pendingLink && Date.now() - pendingLinkAt < LINK_TTL_MS ? pendingLink : null;

        pendingLink = null;
        return link;
      }
      return core.invoke(method, args);
    });

    // the parental pages: only they, only these calls
    ipcMain.handle(PARENTAL_IPC.invoke, async (event, method: string, ...args: unknown[]) => {
      if (!core.parentalWindows.owns(event.sender)) throw new Error("forbidden");

      switch (method) {
        case "get":
          return core.parental.pageState();
        case "extend":
          return core.parental.extend(args[0] === "pc" ? "pc" : "games");
        case "unlock":
          return core.parental.unlockWithPin(String(args[0] ?? ""));
        case "dismiss":
          return core.parental.hide();
        default:
          throw new Error(`unknown method ${String(method)}`);
      }
    });

    // autostart passes --hidden, the watchdog --restarted; an unpaired client always shows the pairing screen
    const restarted = process.argv.includes("--restarted=killed");
    const hidden = ((process.argv.includes("--hidden") && core.store.get().ui.startHidden) || restarted) && Boolean(core.store.get().paired);

    window = createMainWindow({ show: !hidden || Boolean(pendingLink), closeToTray: () => core.store.get().ui.closeToTray || core.parental.enabled });
    window.webContents.on("did-finish-load", sendLink);
    // Windows logs off or shuts down: a clean exit, not one to report to the owner. before-quit
    // does not come then, and the process ends right after this handler: the mark is synchronous
    window.on("session-end", () => {
      allowedQuit = "session";
      guard.markCleanSync();
      core.connection.bye("shutdown");
    });
    core.on("state", (state) => {
      if (window && !window.isDestroyed()) window.webContents.send(IPC.state, state);
    });
    createTray(core, showWindow, quit);
    core.applyAutostart();

    // journals are pruned at start and once a day: the app runs for weeks in the tray
    const prune = () => pruneLogs(app.getPath("crashDumps")).catch((error) => log.warn(`prune logs: ${(error as Error).message}`));

    prune();
    setInterval(prune, DAY_MS).unref();
    log.info(`Ghost Hands ${app.getVersion()} started${hidden ? " hidden" : ""}`);
  });

  // the tray keeps the app alive
  app.on("window-all-closed", () => undefined);

  app.on("before-quit", (event) => {
    if ((app as unknown as { ghQuitting?: boolean }).ghQuitting) return;

    // under parental control the client stays: no tray Quit, and other ways are refused here
    if (core.parental?.enabled && !allowedQuit) {
      event.preventDefault();
      log.warn("parental: quitting refused");
      return;
    }

    (app as unknown as { ghQuitting?: boolean }).ghQuitting = true;
    event.preventDefault();
    (window as (BrowserWindow & { allowClose?: () => void }) | null)?.allowClose?.();
    core
      .shutdown(allowedQuit === "session" ? "shutdown" : "quit")
      .then(() => guard.markClean())
      .catch((error) => log.error(`shutdown: ${(error as Error).message}`))
      .finally(() => app.quit());
  });
}
