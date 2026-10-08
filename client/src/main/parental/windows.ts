import path from "path";
import { app, BrowserWindow, screen, type WebContents } from "electron";
import { load, type Page } from "../windows";
import { PARENTAL_IPC } from "../../shared/types";

const BACKGROUND = "#120d1c";
const NOTICE_SIZE = { width: 380, height: 210 };

/** Pages of parental control get their own preload: three methods, none of the settings. */
const webPreferences = {
  preload: path.join(__dirname, "../preload/parental.js"),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: false,
  devTools: !app.isPackaged,
};

export interface ParentalWindows {
  readonly locked: boolean;
  /** the small window in the corner: a warning, "+N minutes", the PIN */
  showNotice(): void;
  hideNotice(): void;
  /** time is over: a window over everything on every display */
  lock(): void;
  unlock(): void;
  /** tell the open pages that the state changed */
  update(): void;
  /** a request from one of these pages (the IPC sender check) */
  owns(sender: WebContents): boolean;
  dispose(): void;
}

export function createParentalWindows({ language }: { language: () => string }): ParentalWindows {
  let notice: BrowserWindow | null = null;
  let locks: BrowserWindow[] = [];
  let locked = false;
  let refocus: NodeJS.Timeout | null = null;

  const all = () => [notice, ...locks].filter((window): window is BrowserWindow => Boolean(window && !window.isDestroyed()));

  const open = (page: Page, options: Electron.BrowserWindowConstructorOptions): BrowserWindow => {
    const window = new BrowserWindow({ frame: false, resizable: false, minimizable: false, maximizable: false, skipTaskbar: true, show: false, backgroundColor: BACKGROUND, webPreferences, ...options });

    window.setMenu(null);
    // links and navigation never leave the page
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    load(window, page, { lang: language() });

    return window;
  };

  const coverDisplays = () => {
    for (const window of locks) if (!window.isDestroyed()) window.destroy();

    locks = screen.getAllDisplays().map((display) => {
      const window = open("lock", { ...display.bounds, movable: false, closable: false, focusable: true, fullscreen: true, kiosk: true, alwaysOnTop: true });

      window.setAlwaysOnTop(true, "screen-saver");
      // Alt+F4, minimize: the lock stays
      window.on("close", (event) => {
        if (locked) event.preventDefault();
      });
      window.on("minimize", () => window.restore());
      window.once("ready-to-show", () => window.show());

      return window;
    });
  };

  const onDisplays = () => {
    if (locked) coverDisplays();
  };

  screen.on("display-added", onDisplays);
  screen.on("display-removed", onDisplays);
  screen.on("display-metrics-changed", onDisplays);

  return {
    get locked() {
      return locked;
    },

    showNotice() {
      if (notice && !notice.isDestroyed()) {
        notice.webContents.send(PARENTAL_IPC.state);
        notice.showInactive();
        return;
      }

      const { workArea } = screen.getPrimaryDisplay();

      notice = open("notice", {
        ...NOTICE_SIZE,
        x: workArea.x + workArea.width - NOTICE_SIZE.width - 16,
        y: workArea.y + workArea.height - NOTICE_SIZE.height - 16,
        movable: false,
        alwaysOnTop: true,
        focusable: true,
      });
      notice.setAlwaysOnTop(true, "screen-saver");
      notice.once("ready-to-show", () => notice?.showInactive());
      notice.on("closed", () => (notice = null));
    },

    hideNotice() {
      notice?.destroy();
      notice = null;
    },

    lock() {
      if (locked) return;
      locked = true;
      coverDisplays();
      // Alt+Tab, the Start menu: the lock takes the focus back
      refocus = setInterval(() => {
        const front = locks.find((window) => !window.isDestroyed());

        if (front && !locks.some((window) => !window.isDestroyed() && window.isFocused())) {
          front.moveTop();
          front.focus();
        }
      }, 700);
    },

    unlock() {
      if (!locked) return;
      locked = false;
      if (refocus) clearInterval(refocus);
      refocus = null;
      for (const window of locks) if (!window.isDestroyed()) window.destroy();
      locks = [];
    },

    update() {
      for (const window of all()) window.webContents.send(PARENTAL_IPC.state);
    },

    owns(sender) {
      return all().some((window) => window.webContents.id === sender.id);
    },

    dispose() {
      screen.off("display-added", onDisplays);
      screen.off("display-removed", onDisplays);
      screen.off("display-metrics-changed", onDisplays);
      locked = false;
      if (refocus) clearInterval(refocus);
      for (const window of all()) window.destroy();
      notice = null;
      locks = [];
    },
  };
}
