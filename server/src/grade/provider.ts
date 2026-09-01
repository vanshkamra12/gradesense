import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { extractPdf, type ExtractedDocument } from "../pdf/extract.js";
import { loadRubric } from "./rubric.js";

/** One piece of the request, in the order it should reach the model. */
export type PromptPart =
  | { kind: "text"; text: string }
  | { kind: "image"; png: Buffer };

export type GradeProvider = {
  name: string;
  grade(input: { parts: PromptPart[] }): Promise<string>;
};

export const MOCK_MODES = ["valid", "malformed", "overmax", "throws", "badEvidence"] as const;
export type MockMode = (typeof MOCK_MODES)[number];

export function isMockMode(value: string): value is MockMode {
  return (MOCK_MODES as readonly string[]).includes(value);
}

/**
 * How the mock decides each criterion for Script A: the mark, an anchor phrase
 * to lift the evidence quote from the real extracted text, and fixed prose.
 *
 * The marks mirror fixtures/error_key_script_a.md, so pipeline tests run against
 * a realistic 9/15 rather than a uniform result. That similarity is a
 * convenience for the tests, not evidence that grading works — see the note on
 * mock-backed tests in ARCHITECTURE.md.
 */
type MockCriterion = {
  awarded: number;
  findingType: "correct" | "incorrect" | "missing" | "partial";
  anchor: string;
  feedback: string;
  correction: string | null;
  confidence: number;
  reasoning: string;
};

const SCRIPT_A: Record<string, MockCriterion> = {
  "Q1.C1": {
    awarded: 1,
    findingType: "correct",
    anchor: "all joined one after another in series",
    feedback: "The main circuit is described as a single closed series path with the right components.",
    correction: null,
    confidence: 0.92,
    reasoning: "Battery, switch, resistor and bulb are all placed in one series loop.",
  },
  "Q1.C2": {
    awarded: 0,
    findingType: "incorrect",
    anchor: "voltmetre is also connected in series",
    feedback:
      "The ammeter is placed correctly, but the voltmeter is in series. A voltmeter must be connected in parallel across the bulb.",
    correction:
      "Connect the voltmeter in parallel across the bulb, since it measures the potential difference between the bulb's two ends.",
    confidence: 0.95,
    reasoning: "The marking guidance names a voltmeter in series as a substantive error.",
  },
  "Q1.C3": {
    awarded: 1,
    findingType: "correct",
    anchor: "battery is the source of energy",
    feedback: "Current flow and the role of each component are explained correctly.",
    correction: null,
    confidence: 0.9,
    reasoning: "The battery, switch and closed-path explanation are all sound.",
  },
  "Q1.C4": {
    awarded: 0,
    findingType: "incorrect",
    anchor: "more current will flow through the bulb",
    feedback:
      "The relationship is inverted. With the battery voltage constant, raising the resistance lowers the current, so the bulb grows dimmer.",
    correction: "By V = IR, increasing resistance at constant voltage decreases current.",
    confidence: 0.94,
    reasoning: "The answer states that more resistance produces more current, which reverses Ohm's law.",
  },
  "Q1.C5": {
    awarded: 1,
    findingType: "correct",
    anchor: "conventional current direction",
    feedback: "The explanation is structured and the diagram is labelled with the current direction.",
    correction: null,
    confidence: 0.55,
    reasoning: "Labelling and structure are clear, though the diagram also contains the miswired voltmeter.",
  },
  "Q2.C1": {
    awarded: 1,
    findingType: "correct",
    anchor: "more dependent on easy answers",
    feedback: "A clear position is stated in the opening sentence.",
    correction: null,
    confidence: 0.93,
    reasoning: "The position is explicit, and the guidance allows a stance opposite to the model answer.",
  },
  "Q2.C2": {
    awarded: 1,
    findingType: "correct",
    anchor: "habit of struggling with a question",
    feedback: "The argument is developed with a causal chain rather than assertion alone.",
    correction: null,
    confidence: 0.88,
    reasoning: "Dependence is linked to loss of practice and then to exam performance.",
  },
  "Q2.C3": {
    awarded: 1,
    findingType: "correct",
    anchor: "technology also give many benefits",
    feedback: "The opposing view is acknowledged and engaged with, not just mentioned.",
    correction: null,
    confidence: 0.9,
    reasoning: "A full paragraph concedes the benefits of video and digital libraries.",
  },
  "Q2.C4": {
    awarded: 1,
    findingType: "correct",
    anchor: "in my own class many students directly search",
    feedback: "A concrete, relevant example supports the argument.",
    correction: null,
    confidence: 0.91,
    reasoning: "The maths-solutions example is specific and tied to the claim.",
  },
  "Q2.C5": {
    awarded: 0,
    findingType: "incorrect",
    anchor: "making learning much better for students today",
    feedback:
      "The conclusion contradicts the argument. The body argues technology creates dependence, then the conclusion recommends maximal use.",
    correction:
      "Conclude in line with the argument — for example that technology harms learning when it substitutes for thinking, so its use should be deliberate.",
    confidence: 0.93,
    reasoning: "The final paragraph reverses the position held throughout.",
  },
  "Q3.C1": {
    awarded: 1,
    findingType: "correct",
    anchor: "demand curve is going downward",
    feedback: "Both curves are plotted with the right slopes and the axes are correctly assigned.",
    correction: null,
    confidence: 0.87,
    reasoning: "Downward demand and upward supply are stated and drawn.",
  },
  "Q3.C2": {
    awarded: 0,
    findingType: "incorrect",
    anchor: "the price of ₹40 and the quantity of 40 units",
    feedback: "The equilibrium is misidentified. It is at ₹30 and 60 units, where quantity demanded equals quantity supplied.",
    correction: "Equilibrium is at ₹30 and 60 units.",
    confidence: 0.93,
    reasoning: "The stated equilibrium does not match the schedule, nor the point where the drawn curves cross.",
  },
  "Q3.C3": {
    awarded: 0,
    findingType: "incorrect",
    anchor: "creates a surplus in the market",
    feedback: "Shortage and surplus are reversed. Below equilibrium there is a shortage; above it there is a surplus.",
    correction:
      "Below the equilibrium price, quantity demanded exceeds quantity supplied, so there is a shortage.",
    confidence: 0.94,
    reasoning: "Both halves of the comparison are stated the wrong way round.",
  },
  "Q3.C4": {
    awarded: 1,
    findingType: "correct",
    anchor: "supply less at every price and the supply curve will shift towards the left side",
    feedback: "The effect of higher production costs on the supply curve is correct.",
    correction: null,
    confidence: 0.92,
    reasoning: "Higher costs are linked to reduced supply at each price and a leftward shift.",
  },
  "Q3.C5": {
    awarded: 0,
    // Right about quantity, wrong about price: attempted, not met. Still 0.
    findingType: "partial",
    anchor: "come at a lower price and a lower quantity",
    feedback:
      "Half correct. Quantity does fall, but a leftward supply shift with demand unchanged raises the equilibrium price.",
    correction: "The new equilibrium is at a higher price and a lower quantity.",
    confidence: 0.6,
    reasoning: "The quantity claim is right and the price claim is wrong; the criterion resolves to 0.",
  },
};

/** A quote that is deliberately absent from the student answer. */
const HALLUCINATED_QUOTE =
  "The voltmeter is connected in parallel across the bulb as required by the marking scheme.";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds the sentence containing `anchor` and returns it exactly as it appears,
 * line breaks and misspellings included. Anchors are matched whitespace-
 * insensitively because the extracted text keeps the PDF's hard wrapping, so a
 * phrase may straddle a newline.
 */
function sentenceContaining(text: string, anchor: string): string | null {
  const pattern = new RegExp(anchor.trim().split(/\s+/).map(escapeRegExp).join("\\s+"));
  const match = pattern.exec(text);
  if (!match) return null;

  const before = text.slice(0, match.index);
  // A pre-printed question heading has no full stop, so a plain search for the
  // previous terminator would run back past it and pull the heading into the
  // quote. Treat it as a hard boundary, as the blank guard does.
  const headings = [...before.matchAll(/^Question \d+ .*$/gm)];
  const afterHeading = headings.at(-1);
  const floor = afterHeading ? afterHeading.index + afterHeading[0].length : 0;

  const start = Math.max(
    floor,
    ...[...before.matchAll(/[.!?]\s/g)].map((m) => m.index + 2),
  );

  const afterIndex = match.index + match[0].length;
  const terminator = /[.!?]/.exec(text.slice(afterIndex));
  const end = terminator ? afterIndex + terminator.index + 1 : text.length;

  return text.slice(start, end).trim();
}

type Located = { evidence: string; page: number };

function locateAnchor(doc: ExtractedDocument, anchor: string): Located {
  for (const page of doc.pages) {
    const evidence = sentenceContaining(page.text, anchor);
    if (evidence) return { evidence, page: page.page };
  }
  // Loud rather than silent: if the fixture changes, the mock must be updated
  // rather than quietly emitting a quote that no longer exists.
  throw new Error(`mock provider: anchor not found in student_answer_A: ${JSON.stringify(anchor)}`);
}

let scriptA: Promise<ExtractedDocument> | null = null;

function loadScriptA(): Promise<ExtractedDocument> {
  scriptA ??= fs
    .readFile(path.join(config.fixturesDir, "student_answer_A.pdf"))
    .then((buf) => extractPdf(new Uint8Array(buf)));
  return scriptA;
}

type MockResult = {
  criterionId: string;
  awarded: number;
  maxMarks: number;
  findingType: string;
  evidence: string | null;
  page: number | null;
  feedback: string;
  correction: string | null;
  confidence: number;
  reasoning: string;
};

async function buildResults(): Promise<MockResult[]> {
  const [rubric, doc] = await Promise.all([loadRubric(), loadScriptA()]);

  return rubric.criteria.map((criterion) => {
    const spec = SCRIPT_A[criterion.id];
    if (!spec) throw new Error(`mock provider: no mock result for criterion ${criterion.id}`);

    const { evidence, page } = locateAnchor(doc, spec.anchor);
    return {
      criterionId: criterion.id,
      awarded: spec.awarded,
      maxMarks: criterion.maxMarks,
      findingType: spec.findingType,
      evidence,
      page,
      feedback: spec.feedback,
      correction: spec.correction,
      confidence: spec.confidence,
      reasoning: spec.reasoning,
    };
  });
}

async function validPayload(): Promise<string> {
  return JSON.stringify(
    {
      criteria: await buildResults(),
      overallNotes:
        "Strong on circuit description and essay structure. Errors in voltmeter placement, the resistance relationship, the essay conclusion and the equilibrium analysis.",
    },
    null,
    2,
  );
}

async function badEvidencePayload(): Promise<string> {
  const criteria = await buildResults();
  return JSON.stringify(
    {
      criteria: criteria.map((c) =>
        c.criterionId === "Q1.C2"
          ? { ...c, awarded: 1, findingType: "correct", evidence: HALLUCINATED_QUOTE }
          : c,
      ),
      overallNotes: "Contains a quote that never appears in the student answer.",
    },
    null,
    2,
  );
}

async function overmaxPayload(): Promise<string> {
  const criteria = await buildResults();

  const tampered = criteria
    // One criterion omitted entirely, so enforce.ts has to fill it in.
    .filter((c) => c.criterionId !== "Q2.C3")
    // Two marks awarded on a one-mark criterion.
    .map((c) => (c.criterionId === "Q1.C1" ? { ...c, awarded: 2 } : c));

  // A criterion that is not in the rubric at all.
  tampered.push({
    ...criteria[0]!,
    criterionId: "Q4.C1",
    awarded: 1,
    feedback: "A criterion the marking scheme does not contain.",
    reasoning: "Invented by the model.",
  });

  return JSON.stringify(
    {
      criteria: tampered,
      // Not the sum of anything above.
      total: 99,
      maxTotal: 15,
      overallNotes: "Exercises clamping, filling, dropping and total recomputation at once.",
    },
    null,
    2,
  );
}

/** Valid JSON, wrong shape: `criteria` is an object and fields are missing. */
const WRONG_SHAPE = JSON.stringify(
  { criteria: { Q1: "full marks" }, notes: "not the agreed schema" },
  null,
  2,
);

export function mockProvider(mode: MockMode): GradeProvider {
  // "malformed" has to cover both a parse failure and a schema failure, so it
  // returns truncated JSON first and a wrong-shaped payload on the repair
  // retry. Determinism here means the same sequence of calls yields the same
  // sequence of bytes, which is what the pipeline tests depend on.
  let calls = 0;

  return {
    name: `mock:${mode}`,
    async grade() {
      const call = calls++;

      switch (mode) {
        case "valid":
          return validPayload();
        case "badEvidence":
          return badEvidencePayload();
        case "overmax":
          return overmaxPayload();
        case "malformed":
          return call === 0 ? (await validPayload()).slice(0, 400) : WRONG_SHAPE;
        case "throws":
          throw new Error("mock provider: simulated API failure");
      }
    },
  };
}

export function createProvider(): GradeProvider {
  const name = config.gradeProvider;

  if (name === "mock") {
    const mode = config.mockMode;
    if (!isMockMode(mode)) {
      throw new Error(`MOCK_MODE must be one of ${MOCK_MODES.join(", ")} (got ${JSON.stringify(mode)})`);
    }
    return mockProvider(mode);
  }

  throw new Error(`GRADE_PROVIDER must be "mock" (got ${JSON.stringify(name)})`);
}
