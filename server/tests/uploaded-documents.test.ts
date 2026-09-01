/**
 * An uploaded question paper and marking scheme must actually be used.
 *
 * The failure this guards against is the quiet one: a run that accepts an
 * uploaded scheme, fails to read it, and marks against the bundled 15 criteria
 * anyway. The marks would look plausible and would be against the wrong rubric.
 */
import fs from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { gradeDocument } from "../src/grade/pipeline.js";
import { mockProvider, type GradeProvider } from "../src/grade/provider.js";
import { parseRubricFromPdf } from "../src/grade/rubric.js";

const fixture = (name: string) =>
  new Uint8Array(fs.readFileSync(path.join(config.fixturesDir, name)));

/** A provider that answers every criterion in whatever rubric it is given. */
function echoProvider(rubricIds: string[]): GradeProvider {
  return {
    name: "mock:echo",
    async grade() {
      return JSON.stringify({
        criteria: rubricIds.map((id) => ({
          criterionId: id,
          awarded: 1,
          maxMarks: 1,
          findingType: "correct",
          evidence: null,
          page: null,
          feedback: "Fine.",
          correction: null,
          confidence: 0.9,
          reasoning: "Because.",
        })),
      });
    },
  };
}

/**
 * Builds a marking scheme PDF from text. `dropCriterion` removes one row from
 * Q3; `fixTotals` decides whether the totals are corrected to match, which is
 * the difference between a smaller valid scheme and a broken one.
 */
async function makeScheme(options: { dropCriterion: boolean; fixTotals: boolean }): Promise<Uint8Array> {
  const question = (n: number, subject: string, rows: string[], total: number) => [
    `Q${n} — ${subject}`,
    `Model Answer — ${total} marks`,
    `Some model answer prose for question ${n} that is long enough to be reference material.`,
    "Marking rubric",
    "Criterion Marks",
    ...rows.map((r) => `${r} 1`),
    `Total ${total}`,
    "Important grading guidance",
    "The student does not need to reproduce the model answer word-for-word.",
  ];

  const five = (q: number) => [1, 2, 3, 4, 5].map((i) => `Q${q} criterion ${i} wording`);
  const q3rows = options.dropCriterion ? five(3).slice(0, 4) : five(3);
  const q3total = options.dropCriterion && options.fixTotals ? 4 : 5;

  const lines = [
    ...question(1, "Science", five(1), 5),
    ...question(2, "English", five(2), 5),
    ...question(3, "Economics", q3rows, q3total),
  ];

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  let page = pdf.addPage([595, 842]);
  let y = 800;

  for (const line of lines) {
    if (y < 40) {
      page = pdf.addPage([595, 842]);
      y = 800;
    }
    page.drawText(line, { x: 40, y, size: 9, font });
    y -= 14;
  }
  return pdf.save();
}

describe("an uploaded marking scheme replaces the bundled one", () => {
  let smaller: Uint8Array;
  let broken: Uint8Array;

  beforeAll(async () => {
    smaller = await makeScheme({ dropCriterion: true, fixTotals: true });
    broken = await makeScheme({ dropCriterion: true, fixTotals: false });
  }, 30_000);

  it("parses the uploaded scheme to 14 criteria, not the bundled 15", async () => {
    const rubric = await parseRubricFromPdf(smaller);
    expect(rubric.criteria).toHaveLength(14);
    expect(rubric.totalMarks).toBe(14);
  }, 30_000);

  // The requirement: grade against 14, or fail — never silently against 15.
  it("grades against the uploaded scheme's 14 criteria", async () => {
    const rubric = await parseRubricFromPdf(smaller);
    const outcome = await gradeDocument(
      { student: fixture("student_answer_A.pdf"), modelAnswer: smaller },
      echoProvider(rubric.criteria.map((c) => c.id)),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.run.result.criteria).toHaveLength(14);
    expect(outcome.run.result.maxTotal).toBe(14);
    expect(outcome.run.sources.modelAnswer).toBe("uploaded");

    // Q3.C5 exists only in the bundled scheme. Its presence would mean the
    // upload was ignored.
    expect(outcome.run.result.criteria.map((c) => c.criterionId)).not.toContain("Q3.C5");
    expect(outcome.run.result.criteria.map((c) => c.criterionId)).toContain("Q3.C4");
  }, 30_000);

  it("fails with a message naming the problem when the scheme does not add up", async () => {
    const outcome = await gradeDocument(
      { student: fixture("student_answer_A.pdf"), modelAnswer: broken },
      mockProvider("valid"),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;

    expect(outcome.error.code).toBe("rubric_unreadable");
    expect(outcome.error.message).toContain("could not be read");
    expect(outcome.error.message).toMatch(/criteria sum to 4 .*totals 5/);
    expect(outcome).not.toHaveProperty("run");
  }, 30_000);

  it("fails rather than falling back when the scheme is not a marking scheme at all", async () => {
    const outcome = await gradeDocument(
      {
        student: fixture("student_answer_A.pdf"),
        modelAnswer: fixture("question_paper.pdf"),
      },
      mockProvider("valid"),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("rubric_unreadable");
  }, 30_000);

  it("uses the bundled scheme when none is uploaded", async () => {
    const outcome = await gradeDocument(fixture("student_answer_A.pdf"), mockProvider("valid"));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.run.result.criteria).toHaveLength(15);
    expect(outcome.run.sources.modelAnswer).toBe("bundled");
  }, 30_000);
});

describe("an uploaded question paper feeds the blank guard", () => {
  it("strips the uploaded paper's lines rather than the bundled one's", async () => {
    // A question paper whose only line is the heading on the blank fixture.
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([595, 842]);
    page.drawText("Question 1 — Science", { x: 40, y: 780, size: 11, font });
    const paper = await pdf.save();

    const outcome = await gradeDocument(
      { student: fixture("student_answer_D.pdf"), questionPaper: paper },
      mockProvider("valid"),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.run.sources.questionPaper).toBe("uploaded");
    // Only one of the blank sheet's three headings is in this paper, so two
    // remain and are counted as the student's contribution.
    expect(outcome.run.assessment.contributedChars).toBeGreaterThan(0);
  }, 30_000);

  it("treats the sheet as blank when the full paper is uploaded", async () => {
    const outcome = await gradeDocument(
      {
        student: fixture("student_answer_D.pdf"),
        questionPaper: fixture("question_paper.pdf"),
      },
      mockProvider("valid"),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.run.sources.questionPaper).toBe("uploaded");
    expect(outcome.run.assessment.kind).toBe("blank");
    expect(outcome.run.assessment.contributedChars).toBe(0);
    expect(outcome.run.providerCalled).toBe(false);
  }, 30_000);
});
