import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type CapturedKey, type GhostApi, type InvokeMethod, type UiState } from "../shared/types";
import type { RunEvent } from "../shared/scenarios/model";

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
  getScenario: invoke("getScenario") as GhostApi["getScenario"],
  createScenario: invoke("createScenario") as GhostApi["createScenario"],
  saveScenario: invoke("saveScenario") as GhostApi["saveScenario"],
  deleteScenario: invoke("deleteScenario") as GhostApi["deleteScenario"],
  runScenario: invoke("runScenario") as GhostApi["runScenario"],
  stopScenario: invoke("stopScenario") as GhostApi["stopScenario"],
  getRuns: invoke("getRuns") as GhostApi["getRuns"],
  getRunLog: invoke("getRunLog") as GhostApi["getRunLog"],
  setRunEvents: invoke("setRunEvents") as GhostApi["setRunEvents"],
  getVariables: invoke("getVariables") as GhostApi["getVariables"],
  setVariable: invoke("setVariable") as GhostApi["setVariable"],
  deleteVariable: invoke("deleteVariable") as GhostApi["deleteVariable"],
  getAsset: invoke("getAsset") as GhostApi["getAsset"],
  exportScenario: invoke("exportScenario") as GhostApi["exportScenario"],
  importScenario: invoke("importScenario") as GhostApi["importScenario"],
  confirmImport: invoke("confirmImport") as GhostApi["confirmImport"],
  captureTemplate: invoke("captureTemplate") as GhostApi["captureTemplate"],
  loadTemplate: invoke("loadTemplate") as GhostApi["loadTemplate"],
  pickPoint: invoke("pickPoint") as GhostApi["pickPoint"],
  pickRegion: invoke("pickRegion") as GhostApi["pickRegion"],
  listDisplays: invoke("listDisplays") as GhostApi["listDisplays"],
  getOcrLanguages: invoke("getOcrLanguages") as GhostApi["getOcrLanguages"],
  checkHotkey: invoke("checkHotkey") as GhostApi["checkHotkey"],
  suspendHotkeys: invoke("suspendHotkeys") as GhostApi["suspendHotkeys"],
  checkScenarioName: invoke("checkScenarioName") as GhostApi["checkScenarioName"],
  onRunEvents: (listener) => subscribe<RunEvent[]>(IPC.runEvents, listener),
  onOpenScenario: (listener) => subscribe<{ id: string; nodeId?: string }>(IPC.openScenario, listener),
  captureKeys: invoke("captureKeys") as GhostApi["captureKeys"],
  onCapturedKey: (listener) => subscribe<CapturedKey>(IPC.capturedKey, listener),
};

contextBridge.exposeInMainWorld("gh", api);
