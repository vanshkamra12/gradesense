import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { enforce, REVIEW_CONFIDENCE_THRESHOLD } from "../src/grade/enforce.js";
import { gradeDocument } from "../src/grade/pipeline.js";
import { mockProvider } from "../src/grade/provider.js";
import { loadRubric, type Rubric } from "../src/grade/rubric.js";
import type { CriterionResult, GradeResponse } from "../src/grade/schema.js";

const STUDENT_TEXT =
  "The voltmetre is also connected in series in the same loop so that it can measure\nthe voltage of the circuit.";

const scriptA = () =>
  new Uint8Array(fs.readFileSync(path.join(config.fixturesDir, "student_answer_A.pdf")));

describe("enforce", () => {
  let rubric: Rubric;

  beforeAll(async () => {
    rubric = await loadRubric();
  }, 30_000);

  /** A well-formed result for every criterion, before any tampering. */
  function fullResponse(overrides: Partial<CriterionResult> & { criterionId?: string } = {}): GradeResponse {
    return {
      criteria: rubric.criteria.map((criterion) => ({
        criterionId: criterion.id,
        awarded: 1,
        maxMarks: 1,
        findingType: "correct" as const,
        evidence: "The voltmetre is also connected in series",
        page: 1,
        feedback: "Fine.",
        correction: null,
        confidence: 0.9,
        reasoning: "Because.",
        ...(overrides.criterionId === criterion.id ? overrides : {}),
      })),
    };
  }

  const run = (response: GradeResponse, repaired = false) =>
    enforce({ response, rubric, studentText: STUDENT_TEXT, repaired });

  describe("marks", () => {
    it("clamps an award above the criterion maximum and records it by name", () => {
      const result = run(fullResponse({ criterionId: "Q1.C1", awarded: 2 }));

      expect(result.criteria.find((c) => c.criterionId === "Q1.C1")!.awarded).toBe(1);
      expect(result.adjustments).toContain(
        "Q1.C1: awarded 2 of a maximum 1 — clamped to 1.",
      );
    });

    it("clamps a negative award to zero", () => {
      const result = run(fullResponse({ criterionId: "Q2.C2", awarded: -3 }));

      expect(result.criteria.find((c) => c.criterionId === "Q2.C2")!.awarded).toBe(0);
      expect(result.adjustments).toContain("Q2.C2: awarded -3, below zero — clamped to 0.");
    });

    // The prompt says a half-met criterion scores 0. Rounding 0.5 up here would
    // contradict the rule the model was told to mark under.
    it("floors a fractional award rather than rounding it up", () => {
      const result = run(fullResponse({ criterionId: "Q3.C5", awarded: 0.5 }));

      expect(result.criteria.find((c) => c.criterionId === "Q3.C5")!.awarded).toBe(0);
      expect(result.adjustments).toContain(
        "Q3.C5: awarded 0.5, which is not a whole mark — floored to 0, since a criterion that is only partly met earns nothing.",
      );
    });

    it("floors a fraction that is nearly the full mark", () => {
      const result = run(fullResponse({ criterionId: "Q3.C5", awarded: 0.9 }));
      expect(result.criteria.find((c) => c.criterionId === "Q3.C5")!.awarded).toBe(0);
    });

    it("recomputes the total as the sum of clamped awards", () => {
      const response = fullResponse({ criterionId: "Q1.C1", awarded: 7 });
      response.total = 99;
      response.maxTotal = 99;

      const result = run(response);

      expect(result.total).toBe(15); // 14 ones plus the clamped one
      expect(result.maxTotal).toBe(15);
      expect(result.adjustments).toContain(
        "The model returned a total of 99. Totals are never taken from the model — recomputed from the criterion marks as 15 of 15.",
      );
    });

    it("uses the marking scheme's maximum, not the model's", () => {
      const result = run(fullResponse({ criterionId: "Q1.C3", maxMarks: 5, awarded: 1 }));

      expect(result.criteria.find((c) => c.criterionId === "Q1.C3")!.maxMarks).toBe(1);
      expect(result.adjustments).toContain(
        "Q1.C3: the model reported a maximum of 5 marks; the marking scheme says 1. The marking scheme was used.",
      );
    });
  });

  describe("criterion set", () => {
    it("fills in an omitted criterion as zero and missing", () => {
      const response = fullResponse();
      response.criteria = response.criteria.filter((c) => c.criterionId !== "Q2.C3");

      const result = run(response);
      const filled = result.criteria.find((c) => c.criterionId === "Q2.C3")!;

      expect(result.criteria).toHaveLength(15);
      expect(filled).toMatchObject({ awarded: 0, findingType: "missing", confidence: 0, evidence: null });
      expect(result.adjustments).toContain(
        "Q2.C3: the model returned no result for this criterion — recorded as 0 of 1, missing, with no confidence.",
      );
    });

    it("drops a criterion that is not in the marking scheme", () => {
      const response = fullResponse();
      response.criteria.push({ ...response.criteria[0]!, criterionId: "Q4.C1" });

      const result = run(response);

      expect(result.criteria.map((c) => c.criterionId)).not.toContain("Q4.C1");
      expect(result.criteria).toHaveLength(15);
      expect(result.adjustments).toContain(
        "Q4.C1: not a criterion in the marking scheme — the model's result for it was discarded.",
      );
    });

    it("keeps the first of duplicated criteria", () => {
      const response = fullResponse();
      response.criteria.push({ ...response.criteria[0]!, awarded: 0, feedback: "second copy" });

      const result = run(response);

      expect(result.criteria.find((c) => c.criterionId === "Q1.C1")!.feedback).toBe("Fine.");
      expect(result.adjustments).toContain(
        "Q1.C1: the model returned more than one result for this criterion — the first was kept and the rest discarded.",
      );
    });

    it("returns criteria in marking-scheme order however the model ordered them", () => {
      const response = fullResponse();
      response.criteria.reverse();

      expect(run(response).criteria.map((c) => c.criterionId)).toEqual(
        rubric.criteria.map((c) => c.id),
      );
    });
  });

  describe("evidence", () => {
    it("strips a quote that does not occur in the student's answer", () => {
      const result = run(
        fullResponse({ criterionId: "Q1.C2", evidence: "A sentence the student never wrote." }),
      );
      const stripped = result.criteria.find((c) => c.criterionId === "Q1.C2")!;

      expect(stripped.evidence).toBeNull();
      expect(stripped.page).toBeNull();
      expect(stripped.evidenceVerified).toBe(false);
      expect(stripped.confidence).toBeLessThanOrEqual(0.2);
      expect(result.adjustments).toContain(
        "Q1.C2: the quoted evidence does not appear anywhere in the student's answer — the quote was removed as unverifiable and confidence lowered from 0.9 to 0.2.",
      );
    });

    // These two failures must not read the same. One is the model saying
    // nothing; the other is the model saying something untrue.
    it("words a filled-in criterion differently from a hallucinated quote", () => {
      const omitted = fullResponse();
      omitted.criteria = omitted.criteria.filter((c) => c.criterionId !== "Q2.C3");
      const omittedLine = run(omitted).adjustments.find((a) => a.startsWith("Q2.C3"))!;

      const hallucinated = run(
        fullResponse({ criterionId: "Q2.C3", evidence: "Never written by anyone." }),
      ).adjustments.find((a) => a.startsWith("Q2.C3"))!;

      expect(omittedLine).toContain("returned no result");
      expect(hallucinated).toContain("does not appear anywhere");
      expect(omittedLine).not.toBe(hallucinated);
    });

    it("accepts a quote that differs from the source only in whitespace", () => {
      // The extracted text wraps mid-sentence; a faithful quote carries that.
      const result = run(
        fullResponse({
          criterionId: "Q1.C2",
          evidence: "connected in series in the same loop so that it can measure the voltage",
        }),
      );
      const criterion = result.criteria.find((c) => c.criterionId === "Q1.C2")!;

      expect(criterion.evidence).not.toBeNull();
      expect(criterion.evidenceVerified).toBe(true);
    });

    it("leaves a missing finding's null evidence alone", () => {
      const result = run(
        fullResponse({ criterionId: "Q3.C4", findingType: "missing", evidence: null, awarded: 0 }),
      );
      const criterion = result.criteria.find((c) => c.criterionId === "Q3.C4")!;

      expect(criterion.adjusted).toBe(false);
      expect(criterion.evidenceVerified).toBe(false);
      expect(result.adjustments.some((a) => a.startsWith("Q3.C4"))).toBe(false);
    });

    it("allows a diagram finding to carry no quote without being called a hallucination", () => {
      const result = run(
        fullResponse({ criterionId: "Q1.C5", findingType: "incorrect", evidence: null, awarded: 0 }),
      );
      const criterion = result.criteria.find((c) => c.criterionId === "Q1.C5")!;

      expect(criterion.adjusted).toBe(false);
      expect(criterion.evidenceVerified).toBe(false);
    });
  });

  describe("confidence and review", () => {
    it("accepts a clean, confident result without review", () => {
      const result = run(fullResponse());

      expect(result.adjustments).toEqual([]);
      expect(result.needsHumanReview).toBe(false);
      expect(result.reviewReasons).toEqual([]);
      expect(result.confidence).toBeCloseTo(0.9, 5);
    });

    it("flags for review when any criterion was adjusted, even at high confidence", () => {
      const result = run(fullResponse({ criterionId: "Q1.C1", awarded: 2 }));

      expect(result.confidence).toBeGreaterThan(REVIEW_CONFIDENCE_THRESHOLD);
      expect(result.needsHumanReview).toBe(true);
      expect(result.reviewReasons[0]).toContain("Q1.C1");
    });

    it("flags for review on low confidence alone, with nothing adjusted", () => {
      const response = fullResponse();
      response.criteria = response.criteria.map((c) => ({ ...c, confidence: 0.4 }));

      const result = run(response);

      expect(result.adjustments).toEqual([]);
      expect(result.confidence).toBeLessThan(REVIEW_CONFIDENCE_THRESHOLD);
      expect(result.needsHumanReview).toBe(true);
      expect(result.reviewReasons.join(" ")).toContain("below the 0.7 threshold");
    });

    it("penalises a repaired response and says so", () => {
      const clean = run(fullResponse()).confidence;
      const repaired = run(fullResponse(), true);

      expect(repaired.confidence).toBeLessThan(clean);
      expect(repaired.needsHumanReview).toBe(true);
      expect(repaired.adjustments).toContain(
        "The model's first response could not be used. This result came from a second, corrected attempt.",
      );
    });

    it("keeps confidence inside 0..1 however many adjustments pile up", () => {
      const response = fullResponse();
      response.criteria = response.criteria.map((c) => ({ ...c, awarded: 9, confidence: 0 }));

      const result = run(response);

      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });
});

// Spec test case 8, end to end rather than on a synthetic response.
describe("overmax mode through the whole pipeline", () => {
  it("clamps, refills, drops, recomputes the total and flags for review", async () => {
    const outcome = await gradeDocument(scriptA(), mockProvider("overmax"));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const result = outcome.run.result;

    expect(result.criteria).toHaveLength(15);
    expect(result.criteria.find((c) => c.criterionId === "Q1.C1")!.awarded).toBe(1);
    expect(result.criteria.find((c) => c.criterionId === "Q2.C3")).toMatchObject({
      awarded: 0,
      findingType: "missing",
    });
    expect(result.criteria.map((c) => c.criterionId)).not.toContain("Q4.C1");

    expect(result.total).toBe(result.criteria.reduce((sum, c) => sum + c.awarded, 0));
    expect(result.maxTotal).toBe(15);
    expect(result.needsHumanReview).toBe(true);

    for (const criterion of result.criteria) {
      expect(criterion.awarded).toBeLessThanOrEqual(criterion.maxMarks);
      expect(criterion.awarded).toBeGreaterThanOrEqual(0);
    }
  }, 30_000);

  it("verifies evidence against the real extracted text", async () => {
    const outcome = await gradeDocument(scriptA(), mockProvider("badEvidence"));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const hallucinated = outcome.run.result.criteria.find((c) => c.criterionId === "Q1.C2")!;
    expect(hallucinated.evidence).toBeNull();
    expect(hallucinated.evidenceVerified).toBe(false);
    expect(outcome.run.result.needsHumanReview).toBe(true);

    // Every genuine quote survived.
    const others = outcome.run.result.criteria.filter((c) => c.criterionId !== "Q1.C2");
    for (const criterion of others) {
      expect(criterion.evidence).not.toBeNull();
      expect(criterion.evidenceVerified).toBe(true);
    }
  }, 30_000);

  it("leaves a clean run unadjusted and unflagged", async () => {
    const outcome = await gradeDocument(scriptA(), mockProvider("valid"));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.run.result.adjustments).toEqual([]);
    expect(outcome.run.result.needsHumanReview).toBe(false);
    expect(outcome.run.result.total).toBe(9);
    expect(outcome.run.result.maxTotal).toBe(15);
  }, 30_000);
});
