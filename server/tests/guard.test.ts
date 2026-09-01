import { createCanvas } from "@napi-rs/canvas";
import fs from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { REVIEW_CONFIDENCE_THRESHOLD } from "../src/grade/enforce.js";
import {
  assessAnswerSheet,
  loadScaffolding,
  studentContribution,
  MIN_STUDENT_CHARS,
  UNCLEAR_CONFIDENCE_CEILING,
} from "../src/grade/guard.js";
import { gradeDocument } from "../src/grade/pipeline.js";
import { mockProvider, type GradeProvider, type PromptPart } from "../src/grade/provider.js";
import { extractPdf, type ExtractedDocument } from "../src/pdf/extract.js";

const fixture = (name: string) =>
  new Uint8Array(fs.readFileSync(path.join(config.fixturesDir, name)));

/** A provider that fails the test if the pipeline ever reaches it. */
function forbiddenProvider(): GradeProvider & { calls: number } {
  const provider = {
    calls: 0,
    name: "mock:forbidden",
    async grade(_input: { parts: PromptPart[] }): Promise<string> {
      provider.calls++;
      throw new Error("the provider must not be called for a blank answer sheet");
    },
  };
  return provider;
}

/**
 * A synthetic stand-in for a handwritten script: the pre-printed headings and a
 * drawing, with no machine-readable answer. Built here rather than committed so
 * it stays reproducible; a real handwritten fixture replaces it later.
 */
async function makeUnclearPdf(): Promise<Uint8Array> {
  const canvas = createCanvas(400, 300);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 400, 300);
  ctx.strokeStyle = "black";
  ctx.lineWidth = 3;
  ctx.strokeRect(40, 40, 320, 220);
  ctx.beginPath();
  ctx.moveTo(40, 260);
  ctx.lineTo(360, 40);
  ctx.stroke();

  const pdf = await PDFDocument.create();
  const page = pdf.addPage([596, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const image = await pdf.embedPng(canvas.encodeSync("png"));

  // Scaffolding only — character for character what the question paper carries,
  // em dash included, or the lines will not match and the sheet reads as answered.
  const headings = ["Question 1 — Science", "Question 2 — English", "Question 3 — Economics"];
  headings.forEach((text, index) => {
    page.drawText(text, { x: 72, y: 760 - index * 200, size: 12, font });
  });
  page.drawImage(image, { x: 72, y: 300, width: 300, height: 225 });

  return pdf.save();
}

describe("studentContribution", () => {
  const scaffolding = new Set(["question 1 — science", "question 2 — english"]);

  const doc = (text: string): ExtractedDocument => ({
    pages: [{ page: 1, width: 596, height: 842, text, items: [], images: [] }],
    text,
    items: [],
  });

  it("discards lines that also appear in the question paper", () => {
    const contributed = studentContribution(
      doc("Question 1 — Science\nA circuit is a closed path.\nQuestion 2 — English"),
      scaffolding,
    );
    expect(contributed).toBe("A circuit is a closed path.");
  });

  it("ignores case and spacing when matching scaffolding", () => {
    expect(studentContribution(doc("  QUESTION   1 — Science  "), scaffolding)).toBe("");
  });

  it("keeps a student line that merely resembles a heading", () => {
    expect(studentContribution(doc("Question 1 — Science is my best subject"), scaffolding)).toBe(
      "Question 1 — Science is my best subject",
    );
  });
});

describe("assessAnswerSheet on the real fixtures", () => {
  let scaffolding: ReadonlySet<string>;

  beforeAll(async () => {
    scaffolding = await loadScaffolding();
  }, 30_000);

  it("calls the blank fixture blank, despite its 53 characters of headings", async () => {
    const student = await extractPdf(fixture("student_answer_D.pdf"));

    // The raw count would sail past the threshold; the contribution does not.
    expect(student.text.replace(/\s/g, "").length).toBeGreaterThan(MIN_STUDENT_CHARS);

    const assessment = assessAnswerSheet(student, scaffolding);
    expect(assessment.kind).toBe("blank");
    expect(assessment.contributedChars).toBe(0);
    expect(assessment.imageCount).toBe(0);
  }, 30_000);

  it("calls a full script gradeable", async () => {
    const student = await extractPdf(fixture("student_answer_A.pdf"));
    const assessment = assessAnswerSheet(student, scaffolding);

    expect(assessment.kind).toBe("gradeable");
    expect(assessment.contributedChars).toBeGreaterThan(2000);
    expect(assessment.imageCount).toBe(2);
  }, 30_000);
});

describe("blank answer through the pipeline", () => {
  it("returns a zero result without calling the provider", async () => {
    const provider = forbiddenProvider();
    const outcome = await gradeDocument(fixture("student_answer_D.pdf"), provider);

    expect(provider.calls).toBe(0);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.run.providerCalled).toBe(false);
    expect(outcome.run.assessment.kind).toBe("blank");
  }, 30_000);

  // The point of routing it through enforce: a blank result must not be a
  // differently shaped object that something downstream trips over.
  it("comes out in the same shape and with the same invariants as a marked script", async () => {
    const blank = await gradeDocument(fixture("student_answer_D.pdf"), forbiddenProvider());
    const marked = await gradeDocument(fixture("student_answer_A.pdf"), mockProvider("valid"));

    expect(blank.ok && marked.ok).toBe(true);
    if (!blank.ok || !marked.ok) return;

    expect(Object.keys(blank.run.result).sort()).toEqual(Object.keys(marked.run.result).sort());
    expect(blank.run.result.criteria).toHaveLength(15);
    expect(blank.run.result.criteria.map((c) => c.criterionId)).toEqual(
      marked.run.result.criteria.map((c) => c.criterionId),
    );
    for (const criterion of blank.run.result.criteria) {
      expect(Object.keys(criterion).sort()).toEqual(
        Object.keys(marked.run.result.criteria[0]!).sort(),
      );
    }
  }, 30_000);

  it("scores zero at full confidence with no review flag", async () => {
    const outcome = await gradeDocument(fixture("student_answer_D.pdf"), forbiddenProvider());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const result = outcome.run.result;
    expect(result.total).toBe(0);
    expect(result.maxTotal).toBe(15);
    expect(result.confidence).toBe(1);
    expect(result.needsHumanReview).toBe(false);
    expect(result.reviewReasons).toEqual([]);
    expect(result.adjustments).toEqual([]);

    for (const criterion of result.criteria) {
      expect(criterion).toMatchObject({ awarded: 0, findingType: "missing", evidence: null });
      // Nothing to verify, so nothing claims to have been verified.
      expect(criterion.evidenceStatus).toBe("absent");
      expect(criterion.adjusted).toBe(false);
    }
    expect(result.overallNotes).toContain("blank");
  }, 30_000);
});

// student_answer_F.pdf is a real handwritten page: ruled notebook paper, one
// full-page scan, no extractable text at all. It is the case the guard exists
// for — the system has to decline to fake confidence about handwriting rather
// than pretend it read the page.
describe("a real handwritten answer through the pipeline", () => {
  const handwritten = () => fixture("student_answer_F.pdf");

  it("has no extractable text and a single page image", async () => {
    const student = await extractPdf(handwritten());

    expect(student.text.trim()).toBe("");
    expect(student.pages).toHaveLength(1);
    expect(student.pages[0]!.images).toHaveLength(1);
  }, 30_000);

  it("is classified unclear rather than blank, because the page carries an image", async () => {
    const assessment = assessAnswerSheet(await extractPdf(handwritten()), await loadScaffolding());

    expect(assessment.kind).toBe("unclear");
    expect(assessment.contributedChars).toBeLessThan(MIN_STUDENT_CHARS);
    expect(assessment.imageCount).toBe(1);
  }, 30_000);

  it("is graded rather than zeroed, with confidence capped and review required", async () => {
    const outcome = await gradeDocument(handwritten(), mockProvider("valid"));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.run.providerCalled).toBe(true);
    expect(outcome.run.result.criteria).toHaveLength(15);
    expect(outcome.run.result.confidence).toBeLessThanOrEqual(UNCLEAR_CONFIDENCE_CEILING);
    expect(outcome.run.result.needsHumanReview).toBe(true);
  }, 30_000);

  it("names the machine-readable-text cause rather than the generic threshold message", async () => {
    const outcome = await gradeDocument(handwritten(), mockProvider("valid"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const [first] = outcome.run.result.reviewReasons;
    expect(first).toContain("characters of machine-readable text");
    expect(first).toContain("may rest on the images alone");
    expect(first).not.toBe(
      `Overall confidence is ${outcome.run.result.confidence}, below the ${REVIEW_CONFIDENCE_THRESHOLD} threshold for automatic acceptance.`,
    );
  }, 30_000);
});

// Kept for the edge the real fixture does not cover: a sheet that carries the
// pre-printed headings as extractable text and a drawing, rather than being a
// scan of the whole page.
describe("a synthetic part-scanned sheet", () => {
  it("is classified unclear once the headings are discounted", async () => {
    const student = await extractPdf(await makeUnclearPdf());
    const assessment = assessAnswerSheet(student, await loadScaffolding());

    expect(student.text).toContain("Question 1");
    expect(assessment.kind).toBe("unclear");
    expect(assessment.contributedChars).toBeLessThan(MIN_STUDENT_CHARS);
  }, 30_000);
});
