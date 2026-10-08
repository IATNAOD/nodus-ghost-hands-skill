import { contextBridge, ipcRenderer } from "electron";
import type { ParentalApi, PARENTAL_IPC as Channels } from "../shared/types";

// PARENTAL_IPC of shared/types, written out: a value imported by both preloads would go to a
// shared chunk, and a sandboxed preload cannot require it (window.gh would be gone)
const PARENTAL_IPC: typeof Channels = { invoke: "gh:parental", state: "gh:parental-state" };

// The parental pages (the notice and the lock) get only this: the state, "+N minutes",
// the PIN and "hide". No settings: the main process also checks the sender of every call.
const api: ParentalApi = {
  get: () => ipcRenderer.invoke(PARENTAL_IPC.invoke, "get"),
  extend: (kind) => ipcRenderer.invoke(PARENTAL_IPC.invoke, "extend", kind),
  unlock: (pin) => ipcRenderer.invoke(PARENTAL_IPC.invoke, "unlock", pin),
  dismiss: () => ipcRenderer.invoke(PARENTAL_IPC.invoke, "dismiss"),
  onState: (listener) => {
    const handler = () => listener();

    ipcRenderer.on(PARENTAL_IPC.state, handler);
    return () => {
      ipcRenderer.off(PARENTAL_IPC.state, handler);
    };
  },
};

contextBridge.exposeInMainWorld("ghp", api);
