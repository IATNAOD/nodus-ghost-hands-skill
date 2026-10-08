import path from "path";
import { BrowserWindow, screen, shell } from "electron";
import { getLanguage } from "./i18n";
import { resourcePath } from "./paths";
import type { OverlayHost } from "./exec/power";

const BACKGROUND = "#120d1c";

const pageUrl = (page: "index" | "overlay", query: Record<string, string> = {}): { url?: string; file?: string; query: Record<string, string> } => {
  const devServer = process.env.ELECTRON_RENDERER_URL;

  if (devServer) {
    const url = new URL(`${devServer}/${page === "index" ? "" : "overlay.html"}`);

    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return { url: url.toString(), query };
  }

  return { file: path.join(__dirname, `../renderer/${page}.html`), query };
};

const load = (window: BrowserWindow, page: "index" | "overlay", query: Record<string, string> = {}): void => {
  const target = pageUrl(page, query);

  if (target.url) window.loadURL(target.url);
  else window.loadFile(target.file!, { query: target.query });
};

const secure = {
  preload: path.join(__dirname, "../preload/index.js"),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: false,
};

/** The main window: dark title bar with native buttons, hidden instead of closed when the tray is on. */
export function createMainWindow({ show, closeToTray }: { show: boolean; closeToTray: () => boolean }): BrowserWindow {
  const window = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 880,
    minHeight: 600,
    show: false,
    backgroundColor: BACKGROUND,
    titleBarStyle: "hidden",
    titleBarOverlay: { color: BACKGROUND, symbolColor: "#f6f1ff", height: 40 },
    autoHideMenuBar: true,
    title: "Ghost Hands",
    icon: resourcePath("icons", "icon.png"),
    webPreferences: secure,
  });

  let quitting = false;

  window.once("ready-to-show", () => {
    if (show) window.show();
  });
  window.on("close", (event) => {
    if (!quitting && closeToTray()) {
      event.preventDefault();
      window.hide();
    }
  });
  (window as BrowserWindow & { allowClose?: () => void }).allowClose = () => {
    quitting = true;
  };

  // links open in the browser, never inside the app
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());

  load(window, "index");

  return window;
}

/** Countdown before shutdown, restart, sleep: on top of everything, with "Cancel". */
export function createOverlayHost(): OverlayHost {
  let overlay: BrowserWindow | null = null;

  return {
    show(action, endsAt) {
      overlay?.destroy();

      const { workArea } = screen.getPrimaryDisplay();
      const width = 460;
      const height = 300;

      overlay = new BrowserWindow({
        width,
        height,
        x: Math.round(workArea.x + (workArea.width - width) / 2),
        y: Math.round(workArea.y + (workArea.height - height) / 3),
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        show: false,
        backgroundColor: "#00000000",
        webPreferences: secure,
      });
      overlay.setAlwaysOnTop(true, "screen-saver");
      overlay.once("ready-to-show", () => overlay?.showInactive());
      overlay.on("closed", () => (overlay = null));
      load(overlay, "overlay", { action, endsAt: String(endsAt), lang: getLanguage() });
    },
    hide() {
      overlay?.destroy();
      overlay = null;
    },
  };
}
