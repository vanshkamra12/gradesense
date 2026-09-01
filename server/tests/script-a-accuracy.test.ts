/**
 * The one test that says anything about grading QUALITY.
 *
 * Everything else in this suite runs against the mock and can only verify the
 * pipeline. This grades Script A with the real provider and compares against
 * fixtures/error_key_script_a.md, so it is the only place where a passing test
 * means the marking itself was any good.
 *
 * It skips when GEMINI_API_KEY is absent, rather than being quietly satisfied
 * by a mock. A suite that appears to prove accuracy offline would be lying.
 *
 *   GRADE_PROVIDER=gemini npm test --workspace server
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { locateQuote } from "../src/annotate/locate.js";
import { config } from "../src/config.js";
import { gradeDocument } from "../src/grade/pipeline.js";
import { createProvider } from "../src/grade/provider.js";

const live = config.geminiApiKey !== "" && config.gradeProvider === "gemini";

/** The six the error key calls unambiguous. Every one must score 0. */
const MUST_BE_ZERO = ["Q1.C2", "Q1.C4", "Q2.C5", "Q3.C2", "Q3.C3", "Q3.C5"];

/**
 * Q1.C5 is deliberately absent from every assertion below. The error key names
 * it as genuinely arguable — the answer is well laid out but contains a
 * contradictory claim — and it is the one criterion that varies between runs.
 * Pinning it would make this test a record of one run rather than a check on
 * marking.
 */
describe.skipIf(!live)("Script A against the real provider", () => {
  it(
    "reproduces the error key: six criteria at zero, total in the 8-10 band",
    async () => {
      const bytes = new Uint8Array(
        fs.readFileSync(path.join(config.fixturesDir, "student_answer_A.pdf")),
      );

      const outcome = await gradeDocument(bytes, createProvider());
      expect(outcome.ok, "grading failed against the live provider").toBe(true);
      if (!outcome.ok) return;

      const { result, student } = outcome.run;
      const marks = new Map(result.criteria.map((c) => [c.criterionId, c.awarded]));

      // The substantive errors the key calls unambiguous.
      for (const id of MUST_BE_ZERO) {
        expect(marks.get(id), `${id} should score 0 but scored ${marks.get(id)}`).toBe(0);
      }

      // The controls: surface errors and a contrarian position cost nothing.
      // Q2.C1-C4 are the single most important check in the error key — a
      // grader marking by similarity to the model answer fails here.
      for (const id of ["Q2.C1", "Q2.C2", "Q2.C3", "Q2.C4"]) {
        expect(marks.get(id), `${id} lost a mark for arguing against the model answer`).toBe(1);
      }
      for (const id of ["Q1.C1", "Q1.C3", "Q3.C1", "Q3.C4"]) {
        expect(marks.get(id), `${id} lost a mark for spelling or layout`).toBe(1);
      }

      expect(result.criteria).toHaveLength(15);
      expect(result.maxTotal).toBe(15);
      expect(result.total).toBeGreaterThanOrEqual(8);
      expect(result.total).toBeLessThanOrEqual(10);

      // Every quote the model gave must be real and findable on the page.
      for (const criterion of result.criteria) {
        if (criterion.evidence === null) continue;
        expect(criterion.evidenceStatus, `${criterion.criterionId} quote was not verifiable`).toBe(
          "verified",
        );
        expect(
          locateQuote(student, criterion.evidence, criterion.page).unplaced,
          `${criterion.criterionId} quote could not be located`,
        ).toBe(false);
      }
    },
    240_000,
  );
});

describe.skipIf(live)("Script A accuracy check", () => {
  it("is skipped without a live provider, and says so", () => {
    // Deliberately not asserting anything about marking. With no API key there
    // is nothing here that could tell us whether the grading is any good.
    expect(live).toBe(false);
  });
});
