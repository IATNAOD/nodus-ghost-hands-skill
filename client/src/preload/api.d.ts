import type { GhostApi } from "../shared/types";

declare global {
  interface Window {
    gh: GhostApi;
  }
}

export {};
