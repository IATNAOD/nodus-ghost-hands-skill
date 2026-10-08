import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type GhostApi, type InvokeMethod, type UiState } from "../shared/types";

const invoke =
  (method: InvokeMethod) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(IPC.invoke, method, ...args);

const subscribe = <T>(channel: string, listener: (value: T) => void) => {
  const handler = (_event: IpcRendererEvent, value: T) => listener(value);

  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.off(channel, handler);
  };
};

// the window gets only these methods, no Node.js and no raw IPC
const api: GhostApi = {
  getState: invoke("getState") as GhostApi["getState"],
  onState: (listener) => subscribe<UiState>(IPC.state, listener),
  pair: invoke("pair") as GhostApi["pair"],
  unpair: invoke("unpair") as GhostApi["unpair"],
  reconnect: invoke("reconnect") as GhostApi["reconnect"],
  setDevice: invoke("setDevice") as GhostApi["setDevice"],
  setServer: invoke("setServer") as GhostApi["setServer"],
  setApp: invoke("setApp") as GhostApi["setApp"],
  addApp: invoke("addApp") as GhostApi["addApp"],
  removeApp: invoke("removeApp") as GhostApi["removeApp"],
  listStartApps: invoke("listStartApps") as GhostApi["listStartApps"],
  addStartApps: invoke("addStartApps") as GhostApi["addStartApps"],
  pickExecutable: invoke("pickExecutable") as GhostApi["pickExecutable"],
  rescan: invoke("rescan") as GhostApi["rescan"],
  testLaunch: invoke("testLaunch") as GhostApi["testLaunch"],
  setFeatures: invoke("setFeatures") as GhostApi["setFeatures"],
  setPrefs: invoke("setPrefs") as GhostApi["setPrefs"],
  setUi: invoke("setUi") as GhostApi["setUi"],
  checkPhrase: invoke("checkPhrase") as GhostApi["checkPhrase"],
  checkUpdates: invoke("checkUpdates") as GhostApi["checkUpdates"],
  installUpdate: invoke("installUpdate") as GhostApi["installUpdate"],
  openLogs: invoke("openLogs") as GhostApi["openLogs"],
  openExternal: invoke("openExternal") as GhostApi["openExternal"],
  cancelCountdown: invoke("cancelCountdown") as GhostApi["cancelCountdown"],
  takePairLink: invoke("takePairLink") as GhostApi["takePairLink"],
  onPairLink: (listener) => subscribe<void>(IPC.pairLink, () => listener()),
};

contextBridge.exposeInMainWorld("gh", api);
