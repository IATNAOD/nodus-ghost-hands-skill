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
      // vision.js runs OpenCV in a utility process of its own
      rollupOptions: { input: { index: resolve(__dirname, "src/main/index.ts"), vision: resolve(__dirname, "src/main/scenarios/vision/process.ts") } },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts"), parental: resolve(__dirname, "src/preload/parental.ts"), picker: resolve(__dirname, "src/preload/picker.ts") },
      },
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
          picker: resolve(__dirname, "src/renderer/picker.html"),
        },
        // the graph editor stays out of the small pages (overlay, notice, lock, picker)
        output: { manualChunks: (id) => (id.includes("@xyflow") || id.includes("@dnd-kit") ? "flow" : id.includes("node_modules") ? "vendor" : undefined) },
      },
    },
  },
});
