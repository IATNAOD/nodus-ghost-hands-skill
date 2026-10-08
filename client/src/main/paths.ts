import path from "path";
import { app } from "electron";

/** A file shipped next to the app: extraResources when installed, client/resources in development. */
export const resourcePath = (...parts: string[]): string =>
  app.isPackaged ? path.join(process.resourcesPath, ...parts) : path.join(app.getAppPath(), "resources", ...parts);
