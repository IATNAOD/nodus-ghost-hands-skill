import { resolve } from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@skill": resolve(__dirname, "../skill/lib") } },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
