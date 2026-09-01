import { extractPdf, type ExtractedDocument } from "../pdf/extract.js";
import { renderPdfPages, type RenderedPage } from "../pdf/render.js";
import { enforce, type Caveat, type EnforcedResult } from "./enforce.js";
import {
  assessAnswerSheet,
  blankResponse,
  loadScaffolding,
  scaffoldingFromPdf,
  unclearReason,
  UNCLEAR_CONFIDENCE_CEILING,
  type SheetAssessment,
} from "./guard.js";
import { buildPromptParts } from "./prompt.js";
import type { GradeProvider, PromptPart } from "./provider.js";
import { loadRubric, parseRubricFromPdf, RubricParseError, type Rubric } from "./rubric.js";
import { parseModelOutput, type GradeResponse } from "./schema.js";

export type GradeErrorCode =
  | "provider_failed"
  | "invalid_output"
  | "rubric_unreadable"
  | "question_paper_unreadable";

/**
 * What a run is marked against. Only the student answer is required; supplying
 * a marking scheme or question paper replaces the bundled one for that run.
 */
export type GradeInputs = {
  student: Uint8Array;
  /** The marking scheme. Parsed per run; a parse failure fails the run. */
  modelAnswer?: Uint8Array;
  /** Feeds the blank guard's scaffolding strip. */
  questionPaper?: Uint8Array;
};

export type GradeError = {
  code: GradeErrorCode;
  message: string;
  /** What the model actually returned, for debugging a bad run. */
  attempts: string[];
};

export type GradeRun = {
  response: GradeResponse;
  /** The response after the hard rules are applied. This is what callers use. */
  result: EnforcedResult;
  rubric: Rubric;
  student: ExtractedDocument;
  pages: RenderedPage[];
  parts: PromptPart[];
  provider: string;
  /** What the blank/unclear guard decided about the sheet. */
  assessment: SheetAssessment;
  /** Whether the marking scheme and question paper were uploaded or bundled. */
  sources: { modelAnswer: "uploaded" | "bundled"; questionPaper: "uploaded" | "bundled" };
  /** False when the guard answered without asking the model. */
  providerCalled: boolean;
  /** True when the first response failed to parse and the retry succeeded. */
  repaired: boolean;
};

export type GradeOutcome = { ok: true; run: GradeRun } | { ok: false; error: GradeError };

const REPAIR_INSTRUCTION = `## CORRECTION

Your previous response could not be used: %REASON%

Return the same marking as one JSON object matching the schema above exactly.
Output only the JSON object. No prose, no explanation, no markdown code fences.`;

export async function gradeDocument(
  // A bare Uint8Array is the common case — grade this answer against the
  // bundled scheme — so it is accepted directly rather than forcing every
  // caller to wrap it.
  input: Uint8Array | GradeInputs,
  provider: GradeProvider,
): Promise<GradeOutcome> {
  const inputs: GradeInputs = input instanceof Uint8Array ? { student: input } : input;
  const pdfBytes = inputs.student;

  const sources = {
    modelAnswer: inputs.modelAnswer ? ("uploaded" as const) : ("bundled" as const),
    questionPaper: inputs.questionPaper ? ("uploaded" as const) : ("bundled" as const),
  };

  // An uploaded marking scheme is parsed for this run. If it cannot be read the
  // run fails and says what was missing — falling back to the bundled scheme
  // would mark the paper against a rubric nobody asked for.
  let rubric: Rubric;
  try {
    rubric = inputs.modelAnswer ? await parseRubricFromPdf(inputs.modelAnswer) : await loadRubric();
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "rubric_unreadable",
        message:
          error instanceof RubricParseError
            ? `The uploaded marking scheme could not be read: ${error.message}`
            : `The uploaded marking scheme could not be read: ${(error as Error).message}`,
        attempts: [],
      },
    };
  }

  let scaffolding: ReadonlySet<string>;
  try {
    scaffolding = inputs.questionPaper
      ? await scaffoldingFromPdf(inputs.questionPaper)
      : await loadScaffolding();
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "question_paper_unreadable",
        message: `The uploaded question paper could not be read: ${(error as Error).message}`,
        attempts: [],
      },
    };
  }

  const [student, pages] = await Promise.all([extractPdf(pdfBytes), renderPdfPages(pdfBytes)]);

  const assessment = assessAnswerSheet(student, scaffolding);
  const parts = buildPromptParts(rubric, student, pages.map((page) => page.png));

  // A blank sheet is answered here, without a model call. The zero result still
  // goes through enforce, so it comes out in the same shape with the same
  // invariants as any marked script.
  if (assessment.kind === "blank") {
    const response = blankResponse(rubric);
    return {
      ok: true,
      run: {
        response,
        result: enforce({ response, rubric, studentText: student.text, repaired: false }),
        rubric, student, pages, parts, provider: provider.name,
        repaired: false, assessment, providerCalled: false, sources,
      },
    };
  }

  const caveat: Caveat | undefined =
    assessment.kind === "unclear"
      ? { confidenceCeiling: UNCLEAR_CONFIDENCE_CEILING, reason: unclearReason(assessment) }
      : undefined;
  const attempts: string[] = [];

  let raw: string;
  try {
    raw = await provider.grade({ parts });
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "provider_failed",
        message: (error as Error).message,
        attempts,
      },
    };
  }
  attempts.push(raw);

  const first = parseModelOutput(raw);
  if (first.ok) {
    return {
      ok: true,
      run: {
        response: first.value,
        result: enforce({ response: first.value, rubric, studentText: student.text, repaired: false, caveat }),
        rubric, student, pages, parts, provider: provider.name,
        repaired: false, assessment, providerCalled: true, sources,
      },
    };
  }

  // One repair attempt, telling the model what was wrong with the last answer.
  const repairParts: PromptPart[] = [
    ...parts,
    { kind: "text", text: REPAIR_INSTRUCTION.replace("%REASON%", first.message) },
  ];

  let retryRaw: string;
  try {
    retryRaw = await provider.grade({ parts: repairParts });
  } catch (error) {
    return {
      ok: false,
      error: { code: "provider_failed", message: (error as Error).message, attempts },
    };
  }
  attempts.push(retryRaw);

  const second = parseModelOutput(retryRaw);
  if (second.ok) {
    return {
      ok: true,
      run: {
        response: second.value,
        result: enforce({ response: second.value, rubric, studentText: student.text, repaired: true, caveat }),
        rubric, student, pages, parts, provider: provider.name,
        repaired: true, assessment, providerCalled: true, sources,
      },
    };
  }

  return {
    ok: false,
    error: {
      code: "invalid_output",
      message: `model output could not be used after one repair attempt (${first.stage}: ${first.message}; then ${second.stage}: ${second.message})`,
      attempts,
    },
  };
}
