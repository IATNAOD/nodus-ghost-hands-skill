import { contextBridge, ipcRenderer } from "electron";

// The picker windows (a sample, a point or an area taken from the frozen screen) get only this.
// The channel is written out: a value imported from src/shared would go to a shared chunk,
// and a sandboxed preload cannot load it.
const CHANNEL = "gh:picker";

contextBridge.exposeInMainWorld("ghk", {
  init: () => ipcRenderer.invoke(CHANNEL, "init"),
  done: (result: { x: number; y: number; w?: number; h?: number }) => ipcRenderer.invoke(CHANNEL, "done", result),
  cancel: () => ipcRenderer.invoke(CHANNEL, "cancel"),
});
