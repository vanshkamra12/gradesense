import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Points config.ts at a scratch database and storage directory before any
    // module reads process.env, so tests never touch a real run's data.
    setupFiles: ["./tests/setup.ts"],
  },
});
