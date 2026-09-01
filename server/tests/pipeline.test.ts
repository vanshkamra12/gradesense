import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { gradeDocument } from "../src/grade/pipeline.js";
import { buildPromptParts, promptText, MAX_EVIDENCE_CHARS } from "../src/grade/prompt.js";
import { mockProvider, type PromptPart } from "../src/grade/provider.js";
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
  let parts: PromptPart[];
  let prompt: string;
  let rubric: Rubric;

  beforeAll(async () => {
    rubric = await loadRubric();
    const student = await extractPdf(scriptA());
    parts = buildPromptParts(rubric, student, [Buffer.from("page-1"), Buffer.from("page-2")]);
    prompt = promptText(parts);
  }, 30_000);

  it("returns ordered parts with the images between the two text blocks", () => {
    expect(parts.map((part) => part.kind)).toEqual(["text", "image", "image", "text"]);
  });

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
    const first = parts[0]!;
    const last = parts.at(-1)!;
    expect(first.kind).toBe("text");
    expect(last.kind).toBe("text");
    if (first.kind !== "text" || last.kind !== "text") return;

    const at = (needle: string) => first.text.indexOf(needle);
    expect(at("## HOW TO MARK")).toBeGreaterThan(-1);
    expect(at("## MARKING SCHEME")).toBeGreaterThan(at("## HOW TO MARK"));
    expect(at("## MODEL ANSWER — REFERENCE ONLY")).toBeGreaterThan(at("## MARKING SCHEME"));
    expect(at("## STUDENT ANSWER — EXTRACTED TEXT")).toBeGreaterThan(
      at("## MODEL ANSWER — REFERENCE ONLY"),
    );

    // The output contract is in the part after the images, so it is the last
    // thing the model reads.
    expect(last.text).toContain("## OUTPUT");
    expect(first.text).not.toContain("## OUTPUT");
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

  it("defines partial as scoring zero, so the model does not invent a fraction", () => {
    expect(says(prompt, "partial the student attempted the point and did not meet it")).toBe(true);
    expect(says(prompt, '"partial" scores 0, exactly as "incorrect" does')).toBe(true);
    expect(says(prompt, "The difference is for the feedback the student reads, not for the mark")).toBe(true);
    expect(says(prompt, "never a fraction of a mark")).toBe(true);
  });

  it("scopes the guidance override to the criteria it speaks about", () => {
    expect(says(prompt, "authoritative for the criteria it speaks about")).toBe(true);
    expect(
      says(prompt, "apply it to the criterion that error belongs to, and not to the whole question"),
    ).toBe(true);
    expect(prompt).not.toContain("overrides your own judgement wherever the two differ");
  });

  it("tells the model to fail loudly when the page images are absent", () => {
    expect(says(prompt, "If no page images actually reach you, do not carry on as though they had")).toBe(true);
    expect(says(prompt, 'mark those criteria as "missing" with a low confidence')).toBe(true);
    expect(says(prompt, "do not infer what a diagram shows from the written text alone")).toBe(true);
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
    expect(promptText(outcome.run.parts)).toContain("## MARKING SCHEME");
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

  it("accepts a repaired second attempt and appends the correction as a part", async () => {
    const good = await mockProvider("valid").grade({ parts: [] });
    const seen: PromptPart[][] = [];
    const flaky = {
      name: "mock:flaky",
      async grade(input: { parts: PromptPart[] }) {
        seen.push(input.parts);
        return seen.length === 1 ? "not json at all" : good;
      },
    };

    const outcome = await gradeDocument(scriptA(), flaky);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.run.repaired).toBe(true);
    expect(outcome.run.response.criteria).toHaveLength(15);

    // The retry is the original parts plus one appended correction.
    expect(seen[1]).toHaveLength(seen[0]!.length + 1);
    expect(promptText(seen[1]!)).toContain("## CORRECTION");
    expect(promptText(seen[0]!)).not.toContain("## CORRECTION");
  }, 30_000);

  it("passes one image part per page, carrying real PNG bytes", async () => {
    const seen: PromptPart[][] = [];
    const good = await mockProvider("valid").grade({ parts: [] });

    await gradeDocument(scriptA(), {
      name: "mock:spy",
      async grade(input) {
        seen.push(input.parts);
        return good;
      },
    });

    expect(seen).toHaveLength(1);
    const images = seen[0]!.filter((part) => part.kind === "image");
    expect(images).toHaveLength(2);
    for (const image of images) {
      if (image.kind !== "image") continue;
      expect(image.png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }
  }, 30_000);
});
