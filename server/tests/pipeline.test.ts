import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { gradeDocument } from "../src/grade/pipeline.js";
import { buildPrompt, PAGE_IMAGES_MARKER, MAX_EVIDENCE_CHARS } from "../src/grade/prompt.js";
import { mockProvider } from "../src/grade/provider.js";
import { loadRubric, type Rubric } from "../src/grade/rubric.js";
import { parseModelOutput, stripFences } from "../src/grade/schema.js";
import { extractPdf } from "../src/pdf/extract.js";

const scriptA = () =>
  new Uint8Array(fs.readFileSync(path.join(config.fixturesDir, "student_answer_A.pdf")));

/**
 * The prompt is hard-wrapped for readability, so a phrase may straddle a line
 * break. Assert on meaning, not on where the wrapping happens to fall.
 */
const says = (haystack: string, phrase: string) =>
  haystack.replace(/\s+/g, " ").includes(phrase.replace(/\s+/g, " "));

describe("prompt", () => {
  let prompt: string;
  let rubric: Rubric;

  beforeAll(async () => {
    rubric = await loadRubric();
    prompt = buildPrompt(rubric, await extractPdf(scriptA()));
  }, 30_000);

  it("tells the model to mark each criterion independently", () => {
    expect(says(prompt, "Judge each criterion separately, on its own merits")).toBe(true);
    expect(says(prompt, "does not lose marks because a different criterion was answered badly")).toBe(true);
  });

  it("includes every criterion with its ID and maximum", () => {
    for (const criterion of rubric.criteria) {
      expect(prompt).toContain(`${criterion.id} [${criterion.maxMarks} mark] ${criterion.text}`);
    }
  });

  it("includes every guidance line verbatim", () => {
    for (const question of rubric.questions) {
      for (const line of question.guidance) {
        expect(prompt).toContain(line);
      }
    }
  });

  it("labels the guidance as authoritative marking instruction", () => {
    expect(prompt).toContain("AUTHORITATIVE MARKING INSTRUCTIONS FOR Q1");
    expect(prompt).toContain("AUTHORITATIVE MARKING INSTRUCTIONS FOR Q2");
    expect(prompt).toContain("quoted verbatim from the marking scheme");
  });

  it("labels the model answer as reference only and disclaims similarity", () => {
    expect(prompt).toContain("MODEL ANSWER — REFERENCE ONLY");
    expect(says(prompt, "Similarity to this text is not evidence that an answer is correct")).toBe(true);
    expect(says(prompt, "difference from it is not evidence that an answer is wrong")).toBe(true);
    expect(says(prompt, "reaches the opposite conclusion, can earn full marks")).toBe(true);
    expect(says(prompt, "Never mark by resemblance")).toBe(true);
  });

  it("orders the sections so marking material precedes the student's work", () => {
    const at = (needle: string) => prompt.indexOf(needle);
    expect(at("## HOW TO MARK")).toBeGreaterThan(-1);
    expect(at("## MARKING SCHEME")).toBeGreaterThan(at("## HOW TO MARK"));
    expect(at("## MODEL ANSWER — REFERENCE ONLY")).toBeGreaterThan(at("## MARKING SCHEME"));
    expect(at("## STUDENT ANSWER — EXTRACTED TEXT")).toBeGreaterThan(
      at("## MODEL ANSWER — REFERENCE ONLY"),
    );
    expect(at(PAGE_IMAGES_MARKER)).toBeGreaterThan(at("## STUDENT ANSWER — EXTRACTED TEXT"));
    expect(at("## OUTPUT")).toBeGreaterThan(at(PAGE_IMAGES_MARKER));
  });

  it("forbids totals, coordinates and fences", () => {
    expect(says(prompt, "You are not given one and you must not return one")).toBe(true);
    expect(says(prompt, "Do not add a total field")).toBe(true);
    expect(says(prompt, "Do not report coordinates")).toBe(true);
    expect(says(prompt, "no markdown code fences")).toBe(true);
  });

  it("states the evidence rules, including the length limit", () => {
    expect(says(prompt, "character for character")).toBe(true);
    expect(says(prompt, "Do not correct spelling")).toBe(true);
    expect(says(prompt, "Do not tidy punctuation")).toBe(true);
    expect(says(prompt, `no more than ${MAX_EVIDENCE_CHARS} characters`)).toBe(true);
    expect(says(prompt, 'set "evidence" to null')).toBe(true);
    expect(says(prompt, '"findingType" to "missing"')).toBe(true);
  });

  it("covers text/image conflict and struck-out spans", () => {
    expect(says(prompt, "do not silently pick one")).toBe(true);
    expect(says(prompt, "disregard any span the student struck out")).toBe(true);
  });

  // The model has to find Script A's specific errors itself. The marking scheme
  // legitimately states the correct equilibrium and the student's text
  // legitimately states the wrong one — what must not appear is an instruction
  // pointing at the discrepancy. So this checks our own prose, not the material
  // it quotes.
  it("does not tell the model where this script's errors are", () => {
    const instructions = prompt.slice(0, prompt.indexOf("## MARKING SCHEME"));
    expect(instructions).not.toMatch(/₹|equilibrium|voltmeter|ammeter|resistance|conclusion/i);
    expect(instructions).not.toMatch(/Q\d\.C\d/);
  });

  it("says spelling and grammar cost no marks on their own", () => {
    expect(says(prompt, "must not by themselves cost a criterion mark")).toBe(true);
    expect(says(prompt, "Misspelling a technical term is not the same as misunderstanding it")).toBe(true);
    expect(says(prompt, "criterion whose own wording is about clarity of communication")).toBe(true);
  });

  it("asks for per-criterion confidence and treats uncertainty as valid", () => {
    expect(says(prompt, '"confidence" between 0 and 1')).toBe(true);
    expect(says(prompt, "one line of \"reasoning\"")).toBe(true);
    expect(
      says(prompt, "Low confidence on a genuinely arguable criterion is the correct answer, not a failure"),
    ).toBe(true);
  });

  it("contains the student's text and both pages", () => {
    expect(prompt).toContain("--- PAGE 1 ---");
    expect(prompt).toContain("--- PAGE 2 ---");
    expect(prompt).toContain("The voltmetre is also connected in series");
  });
});

describe("stripFences", () => {
  const body = '{"criteria":[]}';

  it("leaves bare JSON alone", () => {
    expect(stripFences(body)).toBe(body);
  });

  it("removes ```json fences", () => {
    expect(stripFences("```json\n" + body + "\n```")).toBe(body);
  });

  it("removes bare fences and surrounding whitespace", () => {
    expect(stripFences("\n\n```\n" + body + "\n```\n\n")).toBe(body);
  });
});

describe("parseModelOutput", () => {
  it("reports a JSON failure distinctly from a schema failure", () => {
    const truncated = parseModelOutput('{"criteria": [');
    expect(truncated).toMatchObject({ ok: false, stage: "json" });

    const wrongShape = parseModelOutput('{"criteria": {"Q1": "full marks"}}');
    expect(wrongShape).toMatchObject({ ok: false, stage: "schema" });
  });

  it("rejects a confidence outside 0..1", () => {
    const result = parseModelOutput(
      JSON.stringify({
        criteria: [
          {
            criterionId: "Q1.C1", awarded: 1, maxMarks: 1, findingType: "correct",
            evidence: "x", page: 1, feedback: "f", correction: null,
            confidence: 1.5, reasoning: "r",
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("gradeDocument against the mock", () => {
  it("grades end to end and returns all 15 criteria", async () => {
    const outcome = await gradeDocument(scriptA(), mockProvider("valid"));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.run.response.criteria).toHaveLength(15);
    expect(outcome.run.repaired).toBe(false);
    expect(outcome.run.provider).toBe("mock:valid");
    expect(outcome.run.pages).toHaveLength(2);
    expect(outcome.run.student.pages).toHaveLength(2);
    expect(outcome.run.prompt).toContain("## MARKING SCHEME");
  }, 30_000);

  it("surfaces a structured error when the provider fails, with nothing partial", async () => {
    const outcome = await gradeDocument(scriptA(), mockProvider("throws"));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;

    expect(outcome.error.code).toBe("provider_failed");
    expect(outcome.error.message).toMatch(/simulated API failure/);
    expect(outcome.error).not.toHaveProperty("run");
  }, 30_000);

  it("retries once on malformed output and then fails cleanly, recording both attempts", async () => {
    const outcome = await gradeDocument(scriptA(), mockProvider("malformed"));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;

    expect(outcome.error.code).toBe("invalid_output");
    expect(outcome.error.message).toMatch(/json:/);
    expect(outcome.error.message).toMatch(/then schema:/);
    expect(outcome.error.attempts).toHaveLength(2);
  }, 30_000);

  it("accepts a repaired second attempt", async () => {
    // First call unparseable, second call good — the repair path succeeding.
    const good = await mockProvider("valid").grade({ prompt: "", images: [] });
    let calls = 0;
    const flaky = {
      name: "mock:flaky",
      async grade() {
        return calls++ === 0 ? "not json at all" : good;
      },
    };

    const outcome = await gradeDocument(scriptA(), flaky);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.run.repaired).toBe(true);
    expect(outcome.run.response.criteria).toHaveLength(15);
  }, 30_000);

  it("passes one image per page to the provider", async () => {
    const seen: { prompt: string; images: Buffer[] }[] = [];
    const good = await mockProvider("valid").grade({ prompt: "", images: [] });

    await gradeDocument(scriptA(), {
      name: "mock:spy",
      async grade(input) {
        seen.push(input);
        return good;
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.images).toHaveLength(2);
    for (const image of seen[0]!.images) {
      expect(image.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }
  }, 30_000);
});
