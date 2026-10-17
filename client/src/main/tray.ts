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

    // scenarios: run from the tray (also under parental control: running them is allowed)
    const runs = core.scenarios?.runs() ?? [];
    const shown = (core.scenarios?.summaries() ?? []).filter((scenario) => scenario.inTray);
    const scenarios: Electron.MenuItemConstructorOptions[] = shown.length
      ? [
          {
            label: t("trayScenarios"),
            submenu: [
              ...shown.map((scenario) => {
                const running = runs.some((run) => run.scenarioId === scenario.id);
                return {
                  label: running ? t("trayRunning", { name: scenario.name }) : scenario.name,
                  enabled: !scenario.invalid,
                  click: () => (running ? core.scenarios.stop({ scenarioId: scenario.id }) : core.scenarios.start(scenario.id, { trigger: "tray" })),
                };
              }),
              ...(runs.length ? [{ type: "separator" as const }, { label: t("trayStopAll"), click: () => core.scenarios.stop({ all: true }) }] : []),
            ],
          },
        ]
      : [];

    tray.setContextMenu(
      Menu.buildFromTemplate(
        // under parental control there is nothing to pause or quit
        core.parental?.enabled
          ? [{ label: t("trayOpen"), click: showWindow }, { label, enabled: false }, { label: t("trayParental"), enabled: false }, ...scenarios]
          : [
              { label: t("trayOpen"), click: showWindow },
              { label, enabled: false },
              ...(scenarios.length ? [{ type: "separator" as const }, ...scenarios] : []),
              { type: "separator" },
              { label: core.paused ? t("trayResume") : t("trayPause"), click: () => core.togglePause(), enabled: status !== "unpaired" },
              { type: "separator" },
              { label: t("trayQuit"), click: quit },
            ],
      ),
    );
  };

  tray.on("click", showWindow);
  core.on("state", refresh);
  core.on("ui", refresh);
  refresh();

  return tray;
}
