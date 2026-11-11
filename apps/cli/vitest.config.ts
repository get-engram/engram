import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A temporary XDG_CONFIG_HOME for every test file (engram#615), and no
    // value from the shell's environment in what a child_process mock
    // records (engram#728).
    setupFiles: ["./src/__tests__/setup/config-home.ts", "./src/__tests__/setup/child-process-mocks.ts"],
  },
});
