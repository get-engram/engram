import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A temporary XDG_CONFIG_HOME for every test file (engram#615).
    setupFiles: ["./src/__tests__/setup/config-home.ts"],
  },
});
