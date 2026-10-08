import { resolve } from "path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

// shared with the NODUS skill: protocol, phrase parsing, name matching (CommonJS)
const skillLib = resolve(__dirname, "../skill/lib");

export default defineConfig({
  main: {
    resolve: { alias: { "@skill": skillLib } },
    build: {
      commonjsOptions: { include: [/node_modules/, /skill[\\/]lib/] },
      rollupOptions: { input: { index: resolve(__dirname, "src/main/index.ts") } },
    },
  },
  preload: {
    build: {
      rollupOptions: { input: { index: resolve(__dirname, "src/preload/index.ts"), parental: resolve(__dirname, "src/preload/parental.ts") } },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    build: {
      minify: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          overlay: resolve(__dirname, "src/renderer/overlay.html"),
          notice: resolve(__dirname, "src/renderer/notice.html"),
          lock: resolve(__dirname, "src/renderer/lock.html"),
        },
        output: { manualChunks: (id) => (id.includes("node_modules") ? "vendor" : undefined) },
      },
    },
  },
});
