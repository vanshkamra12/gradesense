import path from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "../src/config.js";

describe("config", () => {
  // The point is that the suite does not depend on a key, not that no key
  // exists. A developer with server/.env filled in still runs the offline
  // suite against the mock unless they ask for the live provider.
  it("defaults to the mock provider, whether or not a key is configured", () => {
    expect(config.gradeProvider).toBe("mock");
    expect(config.mockMode).toBe("valid");
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
