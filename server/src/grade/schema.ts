import { z } from "zod";

export const FINDING_TYPES = ["correct", "incorrect", "missing", "partial"] as const;

export const CriterionResult = z.object({
  criterionId: z.string(),
  awarded: z.number(),
  maxMarks: z.number(),
  findingType: z.enum(FINDING_TYPES),
  evidence: z.string().nullable(),
  page: z.number().nullable(),
  feedback: z.string(),
  correction: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

export const GradeResponse = z.object({
  criteria: z.array(CriterionResult),
  overallNotes: z.string().optional(),
  // The prompt forbids a total. These are accepted only so enforcement can
  // report having ignored one, rather than zod silently dropping the field.
  total: z.number().optional(),
  maxTotal: z.number().optional(),
});

export type CriterionResult = z.infer<typeof CriterionResult>;
export type GradeResponse = z.infer<typeof GradeResponse>;

/**
 * The prompt forbids markdown fences, but models add them anyway, so strip them
 * rather than failing a response that is otherwise perfectly good.
 */
export function stripFences(raw: string): string {
  const text = raw.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(text);
  return (fenced?.[1] ?? text).trim();
}

export type ParseFailure = { ok: false; stage: "json" | "schema"; message: string };
export type ParseSuccess = { ok: true; value: GradeResponse };

export function parseModelOutput(raw: string): ParseSuccess | ParseFailure {
  let json: unknown;
  try {
    json = JSON.parse(stripFences(raw));
  } catch (error) {
    return { ok: false, stage: "json", message: (error as Error).message };
  }

  const result = GradeResponse.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, stage: "schema", message: issues };
  }

  return { ok: true, value: result.data };
}
