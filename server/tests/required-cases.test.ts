/**
 * The eight cases the build spec requires, all offline against the mock.
 *
 * These verify the PIPELINE — enforcement, clamping, evidence verification,
 * locating, error handling. They cannot verify grading QUALITY, because the
 * answers are supplied by a mock. Where a case looks like an accuracy check,
 * the assertion is about what the system does with an answer, not about whether
 * the answer was right. Accuracy is checked separately, against the real
 * provider, in script-a-accuracy.test.ts.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAnnotations } from "../src/annotate/annotations.js";
import { locateQuote } from "../src/annotate/locate.js";
import { config } from "../src/config.js";
import { getResult, listHistory, saveGradeRun } from "../src/db.js";
import { gradeDocument } from "../src/grade/pipeline.js";
import { mockProvider, type GradeProvider } from "../src/grade/provider.js";
import type { GradeResponse } from "../src/grade/schema.js";

const fixture = (name: string) =>
  new Uint8Array(fs.readFileSync(path.join(config.fixturesDir, name)));

/** The mock's valid payload, which quotes the real extracted text of Script A. */
let template: GradeResponse;

beforeAll(async () => {
  template = JSON.parse(await mockProvider("valid").grade({ parts: [] })) as GradeResponse;
}, 30_000);

/** A provider returning a payload derived from that template. */
function providerReturning(build: (base: GradeResponse) => GradeResponse): GradeProvider {
  return {
    name: "mock:crafted",
    async grade() {
      return JSON.stringify(build(structuredClone(template)));
    },
  };
}

describe("1. a fully correct answer", () => {
  it("scores full marks with no criterion below its maximum", async () => {
    const provider = providerReturning((base) => ({
      ...base,
      criteria: base.criteria.map((c) => ({
        ...c,
        awarded: c.maxMarks,
        findingType: "correct" as const,
        correction: null,
        confidence: 0.95,
      })),
    }));

    const outcome = await gradeDocument(fixture("student_answer_A.pdf"), provider);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const { result } = outcome.run;
    expect(result.total).toBe(15);
    expect(result.maxTotal).toBe(15);
    for (const criterion of result.criteria) {
      expect(criterion.awarded).toBe(criterion.maxMarks);
    }
    expect(result.adjustments).toEqual([]);
    expect(result.needsHumanReview).toBe(false);
  }, 30_000);
});

describe("2. a partially correct answer — Script A", () => {
  // NOTE: the marks here come from the mock, which was written to mirror the
  // error key. This asserts the pipeline carries per-criterion marks through
  // to a total and locates their evidence. Whether a model actually awards
  // these marks is asserted in script-a-accuracy.test.ts against the real API.
  it("carries the per-criterion marks through to a total in the 8-10 band", async () => {
    const outcome = await gradeDocument(fixture("student_answer_A.pdf"), mockProvider("valid"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const { result } = outcome.run;
    const marks = new Map(result.criteria.map((c) => [c.criterionId, c.awarded]));

    for (const id of ["Q1.C2", "Q1.C4", "Q2.C5", "Q3.C2", "Q3.C3", "Q3.C5"]) {
      expect(marks.get(id), `${id} should score 0`).toBe(0);
    }

    expect(result.total).toBeGreaterThanOrEqual(8);
    expect(result.total).toBeLessThanOrEqual(10);
    expect(result.maxTotal).toBe(15);
    expect(result.total).toBe(result.criteria.reduce((sum, c) => sum + c.awarded, 0));
  }, 30_000);

  it("locates every piece of evidence on the page", async () => {
    const outcome = await gradeDocument(fixture("student_answer_A.pdf"), mockProvider("valid"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    for (const criterion of outcome.run.result.criteria) {
      expect(criterion.evidence).not.toBeNull();
      const found = locateQuote(outcome.run.student, criterion.evidence!, criterion.page);
      expect(found.unplaced, `${criterion.criterionId} did not locate`).toBe(false);
      expect(found.rects.length).toBeGreaterThan(0);
    }
  }, 30_000);
});

describe("3. an incorrect answer", () => {
  it("scores near zero while still carrying evidence for what was found", async () => {
    const provider = providerReturning((base) => ({
      ...base,
      criteria: base.criteria.map((c) => ({
        ...c,
        awarded: 0,
        findingType: "incorrect" as const,
        correction: "This is what would have been correct.",
        confidence: 0.9,
      })),
    }));

    const outcome = await gradeDocument(fixture("student_answer_A.pdf"), provider);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const { result, student } = outcome.run;
    expect(result.total).toBe(0);

    // Zero marks is not zero evidence: every finding still points at the page.
    for (const criterion of result.criteria) {
      expect(criterion.evidence).not.toBeNull();
      expect(criterion.evidenceStatus).toBe("verified");
      expect(locateQuote(student, criterion.evidence!, criterion.page).unplaced).toBe(false);
    }
  }, 30_000);
});

describe("4. a blank answer", () => {
  it("scores zero with high confidence and no review, without calling the model", async () => {
    let called = 0;
    const forbidden: GradeProvider = {
      name: "mock:forbidden",
      async grade() {
        called++;
        throw new Error("the provider must not be called for a blank answer");
      },
    };

    const outcome = await gradeDocument(fixture("student_answer_D.pdf"), forbidden);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(called).toBe(0);
    expect(outcome.run.providerCalled).toBe(false);
    expect(outcome.run.assessment.kind).toBe("blank");

    const { result } = outcome.run;
    expect(result.total).toBe(0);
    expect(result.confidence).toBe(1);
    expect(result.needsHumanReview).toBe(false);
    expect(result.reviewReasons).toEqual([]);
    for (const criterion of result.criteria) {
      expect(criterion).toMatchObject({ awarded: 0, findingType: "missing" });
    }
  }, 30_000);
});

describe("5. OCR-like spelling errors", () => {
  /** What a model that disobeyed "do not correct spelling" would return. */
  const respell = (text: string) =>
    text
      .replace(/resistence/g, "resistance")
      .replace(/amether/g, "ammeter")
      .replace(/voltmetre/g, "voltmeter")
      .replace(/equilibrum/g, "equilibrium");

  it("locates evidence through fuzzy matching despite corrected spelling", async () => {
    const provider = providerReturning((base) => ({
      ...base,
      criteria: base.criteria.map((c) => ({
        ...c,
        evidence: c.evidence === null ? null : respell(c.evidence),
      })),
    }));

    const outcome = await gradeDocument(fixture("student_answer_A.pdf"), provider);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const { result, student } = outcome.run;
    const changed = result.criteria.filter((c) => c.evidence !== null && /resistance|ammeter|voltmeter|equilibrium/.test(c.evidence));
    expect(changed.length).toBeGreaterThan(0);

    let fuzzy = 0;
    for (const criterion of result.criteria) {
      expect(criterion.evidence, `${criterion.criterionId} evidence was stripped`).not.toBeNull();
      const found = locateQuote(student, criterion.evidence!, criterion.page);
      expect(found.unplaced, `${criterion.criterionId} did not locate`).toBe(false);
      if (found.method === "fuzzy") fuzzy++;
    }

    // The respelled quotes cannot match exactly, so fuzzy matching is what
    // rescued them rather than the exact pass happening to succeed.
    expect(fuzzy).toBeGreaterThan(0);
  }, 30_000);

  it("does not cost marks for spelling alone", async () => {
    const clean = await gradeDocument(fixture("student_answer_A.pdf"), mockProvider("valid"));
    const respelled = await gradeDocument(
      fixture("student_answer_A.pdf"),
      providerReturning((base) => ({
        ...base,
        criteria: base.criteria.map((c) => ({
          ...c,
          evidence: c.evidence === null ? null : respell(c.evidence),
        })),
      })),
    );

    expect(clean.ok && respelled.ok).toBe(true);
    if (!clean.ok || !respelled.ok) return;

    expect(respelled.run.result.total).toBe(clean.run.result.total);
    expect(respelled.run.result.criteria.map((c) => c.awarded)).toEqual(
      clean.run.result.criteria.map((c) => c.awarded),
    );
  }, 30_000);
});

describe("6. malformed model output", () => {
  it("retries once, then fails cleanly without throwing or returning a partial result", async () => {
    const outcome = await gradeDocument(fixture("student_answer_A.pdf"), mockProvider("malformed"));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;

    expect(outcome.error.code).toBe("invalid_output");
    expect(outcome.error.message).toMatch(/json:/);
    expect(outcome.error.message).toMatch(/then schema:/);
    expect(outcome.error.attempts).toHaveLength(2);
    expect(outcome).not.toHaveProperty("run");
  }, 30_000);

  it("accepts a repaired second attempt and flags it for review", async () => {
    let calls = 0;
    const flaky: GradeProvider = {
      name: "mock:flaky",
      async grade() {
        calls++;
        return calls === 1 ? "{ this is not json" : JSON.stringify(template);
      },
    };

    const outcome = await gradeDocument(fixture("student_answer_A.pdf"), flaky);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.run.repaired).toBe(true);
    expect(outcome.run.result.criteria).toHaveLength(15);
    expect(outcome.run.result.needsHumanReview).toBe(true);
    expect(outcome.run.result.adjustments.some((a) => a.includes("second, corrected attempt"))).toBe(
      true,
    );
  }, 30_000);
});

describe("7. a model or API failure", () => {
  it("surfaces a structured error and persists nothing", async () => {
    const before = listHistory().length;

    const outcome = await gradeDocument(fixture("student_answer_A.pdf"), mockProvider("throws"));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;

    expect(outcome.error.code).toBe("provider_failed");
    expect(outcome.error.message).toMatch(/simulated API failure/);
    expect(outcome).not.toHaveProperty("run");

    // A failed grade has nothing to save, and the route only saves on success.
    expect(listHistory().length).toBe(before);
  }, 30_000);
});

describe("8. a score exceeding the maximum", () => {
  it("clamps it, recomputes the total, records an adjustment and flags for review", async () => {
    const outcome = await gradeDocument(fixture("student_answer_A.pdf"), mockProvider("overmax"));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const { result } = outcome.run;

    // The mock awarded 2 on a 1-mark criterion and reported a total of 99.
    const clamped = result.criteria.find((c) => c.criterionId === "Q1.C1")!;
    expect(clamped.awarded).toBe(1);
    expect(clamped.maxMarks).toBe(1);

    expect(result.total).toBe(result.criteria.reduce((sum, c) => sum + c.awarded, 0));
    expect(result.total).not.toBe(99);
    expect(result.maxTotal).toBe(15);

    expect(result.adjustments).toContain("Q1.C1: awarded 2 of a maximum 1 — clamped to 1.");
    expect(
      result.adjustments.some((a) => a.includes("Totals are never taken from the model")),
    ).toBe(true);

    expect(result.needsHumanReview).toBe(true);
    expect(result.reviewReasons.join(" ")).toContain("Q1.C1");

    for (const criterion of result.criteria) {
      expect(criterion.awarded).toBeLessThanOrEqual(criterion.maxMarks);
      expect(criterion.awarded).toBeGreaterThanOrEqual(0);
    }
  }, 30_000);

  it("persists the clamped result rather than the model's numbers", async () => {
    const outcome = await gradeDocument(fixture("student_answer_A.pdf"), mockProvider("overmax"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const id = randomUUID();
    saveGradeRun({
      resultId: id,
      run: outcome.run,
      annotations: buildAnnotations(id, outcome.run.result, outcome.run.student),
      filename: "student_answer_A.pdf",
      bytes: fixture("student_answer_A.pdf"),
    });

    const stored = getResult(id)!;
    expect(stored.result.total).toBe(outcome.run.result.total);
    expect(stored.result.criteria.find((c) => c.criterionId === "Q1.C1")!.awarded).toBe(1);
    expect(stored.result.adjustments).toEqual(outcome.run.result.adjustments);
  }, 30_000);
});
