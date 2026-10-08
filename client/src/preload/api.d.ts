import type { GhostApi, ParentalApi } from "../shared/types";

declare global {
  interface Window {
    gh: GhostApi;
    /** only on the parental pages (notice, lock) */
    ghp: ParentalApi;
  }
}

export {};
