import { extractPdf, type ExtractedDocument } from "../pdf/extract.js";
import { renderPdfPages, type RenderedPage } from "../pdf/render.js";
import { buildPrompt } from "./prompt.js";
import type { GradeProvider } from "./provider.js";
import { loadRubric, type Rubric } from "./rubric.js";
import { parseModelOutput, type GradeResponse } from "./schema.js";

export type GradeErrorCode = "provider_failed" | "invalid_output";

export type GradeError = {
  code: GradeErrorCode;
  message: string;
  /** What the model actually returned, for debugging a bad run. */
  attempts: string[];
};

export type GradeRun = {
  response: GradeResponse;
  rubric: Rubric;
  student: ExtractedDocument;
  pages: RenderedPage[];
  prompt: string;
  provider: string;
  /** True when the first response failed to parse and the retry succeeded. */
  repaired: boolean;
};

export type GradeOutcome = { ok: true; run: GradeRun } | { ok: false; error: GradeError };

const REPAIR_INSTRUCTION = `

## CORRECTION

Your previous response could not be used: %REASON%

Return the same marking as one JSON object matching the schema above exactly.
Output only the JSON object. No prose, no explanation, no markdown code fences.`;

export async function gradeDocument(
  pdfBytes: Uint8Array,
  provider: GradeProvider,
): Promise<GradeOutcome> {
  const [rubric, student, pages] = await Promise.all([
    loadRubric(),
    extractPdf(pdfBytes),
    renderPdfPages(pdfBytes),
  ]);

  const prompt = buildPrompt(rubric, student);
  const images = pages.map((page) => page.png);
  const attempts: string[] = [];

  let raw: string;
  try {
    raw = await provider.grade({ prompt, images });
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
      run: { response: first.value, rubric, student, pages, prompt, provider: provider.name, repaired: false },
    };
  }

  // One repair attempt, telling the model what was wrong with the last answer.
  const repairPrompt = prompt + REPAIR_INSTRUCTION.replace("%REASON%", first.message);

  let retryRaw: string;
  try {
    retryRaw = await provider.grade({ prompt: repairPrompt, images });
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
      run: { response: second.value, rubric, student, pages, prompt, provider: provider.name, repaired: true },
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
