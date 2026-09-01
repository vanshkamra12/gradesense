import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { extractPdf } from "../src/pdf/extract.js";
import { MOCK_MODES, mockProvider, type MockMode } from "../src/grade/provider.js";
import { loadRubric } from "../src/grade/rubric.js";

// A fresh instance per call. "malformed" counts calls, and a shared instance
// would leak that counter between tests as order-dependent flakiness.
const call = (mode: MockMode) => mockProvider(mode).grade({ prompt: "", images: [] });

/** Whitespace-insensitive containment, matching how evidence is verified. */
const normalise = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

describe("mock provider", () => {
  let studentText: string;
  let criterionIds: string[];

  beforeAll(async () => {
    const file = path.join(config.fixturesDir, "student_answer_A.pdf");
    studentText = normalise((await extractPdf(new Uint8Array(fs.readFileSync(file)))).text);
    criterionIds = (await loadRubric()).criteria.map((c) => c.id);
  }, 30_000);

  it("offers exactly the five modes", () => {
    expect([...MOCK_MODES]).toEqual(["valid", "malformed", "overmax", "throws", "badEvidence"]);
  });

  it("is deterministic — the same mode returns the same bytes", async () => {
    for (const mode of ["valid", "overmax", "badEvidence"] as const) {
      expect(await call(mode)).toBe(await call(mode));
    }
  });

  it("contains no timestamps or other varying values", async () => {
    const payload = await call("valid");
    expect(payload).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(payload).not.toMatch(/"(timestamp|generatedAt|id)"/);
  });

  describe("valid mode", () => {
    it("returns all 15 criteria, with IDs taken from the parsed rubric", async () => {
      const parsed = JSON.parse(await call("valid"));
      expect(parsed.criteria.map((c: { criterionId: string }) => c.criterionId)).toEqual(criterionIds);
    });

    // This is what lets stage 9 exercise locate.ts against realistic input.
    it("quotes evidence verbatim from the extracted student answer", async () => {
      const parsed = JSON.parse(await call("valid"));
      for (const criterion of parsed.criteria) {
        expect(criterion.evidence).toBeTypeOf("string");
        expect(studentText).toContain(normalise(criterion.evidence));
        expect([1, 2]).toContain(criterion.page);
      }
    });

    it("keeps the student's misspellings in the quotes rather than fixing them", async () => {
      const payload = await call("valid");
      expect(payload).toContain("voltmetre");
      expect(payload).toContain("equilibrum");
    });

    it("awards marks within range on every criterion", async () => {
      const parsed = JSON.parse(await call("valid"));
      for (const criterion of parsed.criteria) {
        expect(criterion.awarded).toBeGreaterThanOrEqual(0);
        expect(criterion.awarded).toBeLessThanOrEqual(criterion.maxMarks);
      }
    });
  });

  describe("malformed mode", () => {
    it("returns unparseable JSON first, then a parseable payload of the wrong shape", async () => {
      const provider = mockProvider("malformed");

      const truncated = await provider.grade({ prompt: "", images: [] });
      expect(() => JSON.parse(truncated)).toThrow();

      const wrongShape = await provider.grade({ prompt: "", images: [] });
      const parsed = JSON.parse(wrongShape);
      expect(Array.isArray(parsed.criteria)).toBe(false);
    });
  });

  describe("overmax mode", () => {
    it("exercises every enforcement path at once", async () => {
      const parsed = JSON.parse(await call("overmax"));
      const ids = parsed.criteria.map((c: { criterionId: string }) => c.criterionId);

      const overAwarded = parsed.criteria.find((c: { criterionId: string }) => c.criterionId === "Q1.C1");
      expect(overAwarded.awarded).toBe(2);
      expect(overAwarded.maxMarks).toBe(1);

      expect(ids).not.toContain("Q2.C3"); // omitted, must be filled in
      expect(ids).toContain("Q4.C1"); // invented, must be dropped

      const sum = parsed.criteria.reduce((n: number, c: { awarded: number }) => n + c.awarded, 0);
      expect(parsed.total).toBe(99);
      expect(parsed.total).not.toBe(sum);
    });
  });

  describe("badEvidence mode", () => {
    it("returns well-formed output whose quote is absent from the student answer", async () => {
      const parsed = JSON.parse(await call("badEvidence"));
      expect(parsed.criteria).toHaveLength(15);

      const hallucinated = parsed.criteria.find(
        (c: { criterionId: string }) => c.criterionId === "Q1.C2",
      );
      expect(studentText).not.toContain(normalise(hallucinated.evidence));

      // Every other quote is still real, so tests can isolate the bad one.
      const others = parsed.criteria.filter(
        (c: { criterionId: string }) => c.criterionId !== "Q1.C2",
      );
      for (const criterion of others) {
        expect(studentText).toContain(normalise(criterion.evidence));
      }
    });
  });

  describe("throws mode", () => {
    it("rejects rather than returning a payload", async () => {
      await expect(call("throws")).rejects.toThrow(/simulated API failure/);
    });
  });
});
