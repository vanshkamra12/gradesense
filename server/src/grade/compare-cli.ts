/**
 * Grades a script with whatever provider is configured and compares the result
 * against the expected marks for it.
 *
 *   GRADE_PROVIDER=gemini npm run compare --workspace server
 *   GRADE_PROVIDER=gemini npm run compare --workspace server -- 3
 *   GRADE_PROVIDER=gemini npm run compare --workspace server -- 1 student_answer_B.pdf
 */
import fs from "node:fs";
import path from "node:path";
import { locateQuote } from "../annotate/locate.js";
import { config } from "../config.js";
import { gradeDocument } from "./pipeline.js";
import { createProvider } from "./provider.js";

const CRITERION_IDS = [
  "Q1.C1", "Q1.C2", "Q1.C3", "Q1.C4", "Q1.C5",
  "Q2.C1", "Q2.C2", "Q2.C3", "Q2.C4", "Q2.C5",
  "Q3.C1", "Q3.C2", "Q3.C3", "Q3.C4", "Q3.C5",
];

const allOnes = Object.fromEntries(CRITERION_IDS.map((id) => [id, 1]));

/**
 * What each script is expected to score. Script A comes from
 * fixtures/error_key_script_a.md. B, C and E are held-back scripts and were not
 * used while building the prompt.
 */
const EXPECTED: Record<
  string,
  { marks?: Record<string, number>; band: [number, number]; unambiguous?: string[]; note?: string }
> = {
  "student_answer_A.pdf": {
    marks: {
      "Q1.C1": 1, "Q1.C2": 0, "Q1.C3": 1, "Q1.C4": 0, "Q1.C5": 1,
      "Q2.C1": 1, "Q2.C2": 1, "Q2.C3": 1, "Q2.C4": 1, "Q2.C5": 0,
      "Q3.C1": 1, "Q3.C2": 0, "Q3.C3": 0, "Q3.C4": 1, "Q3.C5": 0,
    },
    band: [8, 10],
    unambiguous: ["Q1.C2", "Q1.C4", "Q2.C1", "Q2.C5", "Q3.C2", "Q3.C3"],
  },
  "student_answer_B.pdf": {
    // Q1.C5 expects 0: the prose claims a current-direction arrow that the
    // photographed diagram does not have. The key was corrected against the
    // grader, which caught the discrepancy on a blind run.
    marks: { ...allOnes, "Q1.C5": 0 },
    band: [14, 14],
    note: "fully correct prose worded unlike the model answer — any mark lost outside Q1.C5 means the grader is rewarding resemblance",
  },
  "student_answer_C.pdf": {
    marks: {
      "Q1.C1": 1, "Q1.C2": 0, "Q1.C3": 0, "Q1.C4": 0, "Q1.C5": 0,
      "Q2.C1": 1, "Q2.C2": 0, "Q2.C3": 0, "Q2.C4": 0, "Q2.C5": 0,
      "Q3.C1": 1, "Q3.C2": 0, "Q3.C3": 0, "Q3.C4": 0, "Q3.C5": 0,
    },
    band: [3, 3],
    note: "mostly incorrect — but C1 of each question is met, so a grader must not mark the whole question down",
  },
  "student_answer_E.pdf": {
    // Reuses B's diagrams, so it inherits B's Q1.C5 discrepancy.
    marks: { ...allOnes, "Q1.C5": 0 },
    band: [14, 14],
    note: "Script B's content with scanner-style corruption; any mark lost outside Q1.C5 is a spelling penalty",
  },
};

const runs = Number(process.argv[2] ?? 1);
const script = process.argv[3] ?? "student_answer_A.pdf";
const expected = EXPECTED[script] ?? { band: [0, 15] };
const ERROR_KEY = expected.marks;
const UNAMBIGUOUS = expected.unambiguous ?? [];

const file = path.join(config.fixturesDir, script);
const bytes = new Uint8Array(fs.readFileSync(file));

console.log(`script: ${script}`);
if (expected.note) console.log(`note:   ${expected.note}`);
console.log(`expected total: ${expected.band[0]}${expected.band[1] === expected.band[0] ? "" : `-${expected.band[1]}`}`);

const totals: number[] = [];
const marksByRun: Record<string, number>[] = [];

for (let run = 1; run <= runs; run++) {
  const provider = createProvider();
  const started = Date.now();
  const outcome = await gradeDocument(bytes, provider);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\n${"=".repeat(100)}`);
  console.log(`RUN ${run} of ${runs}   provider ${provider.name}   ${elapsed}s`);
  console.log("=".repeat(100));

  if (!outcome.ok) {
    console.log(`FAILED: ${outcome.error.code} — ${outcome.error.message}`);
    continue;
  }

  const { result, student } = outcome.run;
  const marks: Record<string, number> = {};
  let located = 0;
  let stripped = 0;
  let noQuote = 0;

  console.log(
    "\ncriterion  mark  key  findingType  conf   evidence",
  );
  console.log("-".repeat(100));

  for (const criterion of result.criteria) {
    marks[criterion.criterionId] = criterion.awarded;
    const want = ERROR_KEY?.[criterion.criterionId];
    const agrees = want === undefined || criterion.awarded === want;

    if (criterion.evidenceStatus === "unverifiable") stripped++;
    else if (criterion.evidence === null) noQuote++;
    else if (!locateQuote(student, criterion.evidence, criterion.page).unplaced) located++;

    const quote =
      criterion.evidence === null
        ? criterion.evidenceStatus === "unverifiable"
          ? "<stripped: not in the answer>"
          : "<none offered>"
        : JSON.stringify(criterion.evidence.replace(/\s+/g, " ").slice(0, 96));

    console.log(
      [
        criterion.criterionId.padEnd(9),
        String(criterion.awarded).padStart(4),
        (want === undefined ? "?" : String(want)).padStart(5),
        agrees ? "  " : " !",
        criterion.findingType.padEnd(11),
        criterion.confidence.toFixed(2),
        " ",
        quote,
      ].join(" "),
    );
  }

  totals.push(result.total);
  marksByRun.push(marks);

  const disagreements = ERROR_KEY
    ? result.criteria.filter((c) => c.awarded !== ERROR_KEY[c.criterionId])
    : [];

  console.log("-".repeat(100));
  const inBand = result.total >= expected.band[0] && result.total <= expected.band[1];
  console.log(
    `total ${result.total}/${result.maxTotal} (expected ${expected.band[0]}-${expected.band[1]}, ` +
      `${inBand ? "IN BAND" : "OUT OF BAND"})   confidence ${result.confidence}   ` +
      `review ${result.needsHumanReview}   repaired ${outcome.run.repaired}`,
  );
  console.log(
    `evidence: ${located} located, ${stripped} stripped as unverifiable, ${noQuote} offered no quote`,
  );

  if (ERROR_KEY) {
    console.log(`\ndisagreements with the expected key: ${disagreements.length}`);
    for (const c of disagreements) {
      console.log(
        `  ${c.criterionId}: gave ${c.awarded}, expected ${ERROR_KEY[c.criterionId]} — ${c.reasoning}`,
      );
    }
  } else {
    console.log("\nno per-criterion key supplied for this script; total only");
  }

  if (UNAMBIGUOUS.length > 0) {
    const missedHard = UNAMBIGUOUS.filter((id) => marks[id] !== ERROR_KEY?.[id]);
    console.log(
      missedHard.length === 0
        ? "all unambiguous criteria agree with the key"
        : `UNAMBIGUOUS CRITERIA WRONG: ${missedHard.join(", ")}`,
    );
  }

  if (result.adjustments.length > 0) {
    console.log("\nadjustments:");
    for (const line of result.adjustments) console.log(`  - ${line}`);
  }
}

if (runs > 1) {
  console.log(`\n${"=".repeat(100)}`);
  console.log(`VARIATION ACROSS ${runs} RUNS`);
  console.log("=".repeat(100));
  console.log(`totals: ${totals.join(", ")}   (expected ${expected.band[0]}-${expected.band[1]})`);

  console.log("\ncriterion  key  " + marksByRun.map((_, i) => `run${i + 1}`).join("  ") + "   stable");
  for (const id of CRITERION_IDS) {
    const marks = marksByRun.map((m) => m[id] ?? -1);
    const stable = new Set(marks).size === 1;
    console.log(
      `${id.padEnd(9)} ${String(ERROR_KEY?.[id] ?? "?").padStart(4)}  ` +
        marks.map((m) => String(m).padStart(4)).join("  ") +
        `   ${stable ? "yes" : "NO"}`,
    );
  }
}
