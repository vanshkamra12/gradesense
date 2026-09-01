import { describe, expect, it } from "vitest";
import { config } from "../src/config.js";

describe("config", () => {
  it("defaults to the mock provider so tests need no API key", () => {
    expect(config.gradeProvider).toBe("mock");
    expect(config.geminiApiKey).toBe("");
  });

  it("keeps runtime storage outside the source tree", () => {
    expect(config.storageDir).toMatch(/server\/storage$/);
    expect(config.dbPath).toMatch(/server\/data\/gradesense\.sqlite$/);
  });
});
