import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { extractPdf, type ExtractedDocument } from "../pdf/extract.js";
import type { Rubric } from "./rubric.js";
import type { GradeResponse } from "./schema.js";

/**
 * Below this many non-whitespace characters of the student's own writing, the
 * sheet is not worth sending to a model. It is a backstop rather than the
 * primary signal — what decides the question is how much the student
 * contributed once the pre-printed scaffolding is discounted.
 */
export const MIN_STUDENT_CHARS = 40;

/** Overall confidence cannot exceed this when barely any text was extracted. */
export const UNCLEAR_CONFIDENCE_CEILING = 0.5;

export type SheetAssessment = {
  kind: "blank" | "unclear" | "gradeable";
  /** Non-whitespace characters written by the student, scaffolding excluded. */
  contributedChars: number;
  imageCount: number;
};

const normaliseLine = (line: string) => line.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The answer sheet is printed from the question paper, so its question headings
 * are on the page before the student writes anything. Counting them as the
 * student's work makes a blank sheet look answered — the blank fixture carries
 * 53 characters of headings, comfortably past any plain character threshold.
 */
export function studentContribution(
  student: ExtractedDocument,
  scaffolding: ReadonlySet<string>,
): string {
  return student.pages
    .flatMap((page) => page.text.split("\n"))
    .filter((line) => {
      const normalised = normaliseLine(line);
      return normalised !== "" && !scaffolding.has(normalised);
    })
    .join("\n");
}

export function assessAnswerSheet(
  student: ExtractedDocument,
  scaffolding: ReadonlySet<string>,
): SheetAssessment {
  const contributedChars = studentContribution(student, scaffolding).replace(/\s/g, "").length;
  const imageCount = student.pages.reduce((sum, page) => sum + page.images.length, 0);

  if (contributedChars >= MIN_STUDENT_CHARS) {
    return { kind: "gradeable", contributedChars, imageCount };
  }
  // Little text but a drawing on the page: the answer may be handwritten, so it
  // still has to be graded — just not trusted as far.
  return {
    kind: imageCount > 0 ? "unclear" : "blank",
    contributedChars,
    imageCount,
  };
}

export function unclearReason(assessment: SheetAssessment): string {
  return (
    `Only ${assessment.contributedChars} characters of machine-readable text were found in this ` +
    `answer, across ${assessment.imageCount} page image${assessment.imageCount === 1 ? "" : "s"}. ` +
    `The marking may rest on the images alone rather than on the student's written words, so it ` +
    `needs a human to confirm it.`
  );
}

/**
 * The zero result for a blank sheet, in exactly the shape a model would have
 * returned. It goes through enforce() like any other response, so a blank
 * answer cannot end up with different invariants from a marked one.
 */
export function blankResponse(rubric: Rubric): GradeResponse {
  return {
    criteria: rubric.criteria.map((criterion) => ({
      criterionId: criterion.id,
      awarded: 0,
      maxMarks: criterion.maxMarks,
      findingType: "missing" as const,
      evidence: null,
      page: null,
      feedback: "Nothing was written for this criterion.",
      correction: null,
      // Certain, not uncertain: an empty page is not an ambiguous one.
      confidence: 1,
      reasoning: "The answer sheet is blank.",
    })),
    overallNotes:
      "This answer sheet is blank — it carries only the pre-printed question headings and no " +
      "written answer or drawing. Every criterion scores zero. No grading model was called.",
  };
}

/** The set of lines a question paper puts on the page before the student writes. */
export function scaffoldingFrom(paper: ExtractedDocument): ReadonlySet<string> {
  return new Set(
    paper.pages
      .flatMap((page) => page.text.split("\n"))
      .map(normaliseLine)
      .filter((line) => line !== ""),
  );
}

export async function scaffoldingFromPdf(data: Uint8Array): Promise<ReadonlySet<string>> {
  return scaffoldingFrom(await extractPdf(data));
}

// The bundled question paper is fixed input, so it is read once per process.
// An uploaded one is parsed per run instead.
let bundled: Promise<ReadonlySet<string>> | null = null;

export function loadScaffolding(): Promise<ReadonlySet<string>> {
  bundled ??= fs
    .readFile(path.join(config.fixturesDir, "question_paper.pdf"))
    .then((buf) => scaffoldingFromPdf(new Uint8Array(buf)));
  return bundled;
}
