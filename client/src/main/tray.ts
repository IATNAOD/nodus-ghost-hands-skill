import { Menu, Tray, nativeImage } from "electron";
import { t } from "./i18n";
import { resourcePath } from "./paths";
import type { Core } from "./core";

type TrayState = "online" | "connecting" | "offline" | "error";

// ICO holds 16-48 px, Windows takes the size for the screen scale
const icon = (state: TrayState) => nativeImage.createFromPath(resourcePath("icons", `tray-${state}.ico`));

const stateOf = (core: Core): TrayState => {
  const status = core.connection.status;

  if (status === "online") return core.helper.ok ? "online" : "error";
  if (status === "connecting") return "connecting";
  if (["auth-failed", "removed", "name-taken", "proto-unsupported"].includes(status)) return "error";
  return "offline";
};

/** Tray icon: orange - connected, purple - connecting, grey - offline, red dot - needs attention. */
export function createTray(core: Core, showWindow: () => void, quit: () => void): Tray {
  const tray = new Tray(icon(stateOf(core)));

  const refresh = () => {
    const state = stateOf(core);
    const status = core.connection.status;
    const label =
      status === "online" ? t("trayOnline") : status === "connecting" ? t("trayConnecting") : status === "unpaired" ? t("trayUnpaired") : state === "error" ? t("trayAttention") : t("trayOffline");

    tray.setImage(icon(state));
    tray.setToolTip(`Ghost Hands · ${label}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: t("trayOpen"), click: showWindow },
        { label, enabled: false },
        { type: "separator" },
        { label: core.paused ? t("trayResume") : t("trayPause"), click: () => core.togglePause(), enabled: status !== "unpaired" },
        { type: "separator" },
        { label: t("trayQuit"), click: quit },
      ]),
    );
  };

  tray.on("click", showWindow);
  core.on("state", refresh);
  core.on("ui", refresh);
  refresh();

  return tray;
}
