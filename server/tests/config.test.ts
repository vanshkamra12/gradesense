import path from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "../src/config.js";

describe("config", () => {
  it("defaults to the mock provider so tests need no API key", () => {
    expect(config.gradeProvider).toBe("mock");
    expect(config.geminiApiKey).toBe("");
  });

  it("keeps runtime storage outside the source tree", () => {
    for (const location of [config.storageDir, config.dbPath]) {
      expect(path.isAbsolute(location)).toBe(true);
      expect(location).not.toContain(`${path.sep}src${path.sep}`);
    }
  });

  it("finds the fixtures directory", () => {
    expect(config.fixturesDir).toMatch(/fixtures$/);
  });
});
