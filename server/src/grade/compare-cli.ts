/**
 * Grades Script A with whatever provider is configured and compares the result
 * against fixtures/error_key_script_a.md.
 *
 *   GRADE_PROVIDER=gemini npm run compare --workspace server
 *   GRADE_PROVIDER=gemini npm run compare --workspace server -- 3   (three runs)
 */
import fs from "node:fs";
import path from "node:path";
import { locateQuote } from "../annotate/locate.js";
import { config } from "../config.js";
import { gradeDocument } from "./pipeline.js";
import { createProvider } from "./provider.js";

/** The expected marks from the error key, which is the ground truth for A. */
const ERROR_KEY: Record<string, number> = {
  "Q1.C1": 1, "Q1.C2": 0, "Q1.C3": 1, "Q1.C4": 0, "Q1.C5": 1,
  "Q2.C1": 1, "Q2.C2": 1, "Q2.C3": 1, "Q2.C4": 1, "Q2.C5": 0,
  "Q3.C1": 1, "Q3.C2": 0, "Q3.C3": 0, "Q3.C4": 1, "Q3.C5": 0,
};

/** The five the key calls unambiguous; these should be asserted exactly. */
const UNAMBIGUOUS = ["Q1.C2", "Q1.C4", "Q2.C1", "Q2.C5", "Q3.C2", "Q3.C3"];

const runs = Number(process.argv[2] ?? 1);
const file = path.join(config.fixturesDir, "student_answer_A.pdf");
const bytes = new Uint8Array(fs.readFileSync(file));

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
    const expected = ERROR_KEY[criterion.criterionId]!;
    const agrees = criterion.awarded === expected;

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
        String(expected).padStart(5),
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

  const disagreements = result.criteria.filter(
    (c) => c.awarded !== ERROR_KEY[c.criterionId],
  );

  console.log("-".repeat(100));
  console.log(
    `total ${result.total}/${result.maxTotal} (key says 9)   confidence ${result.confidence}   ` +
      `review ${result.needsHumanReview}   repaired ${outcome.run.repaired}`,
  );
  console.log(
    `evidence: ${located} located, ${stripped} stripped as unverifiable, ${noQuote} offered no quote`,
  );

  console.log(`\ndisagreements with the error key: ${disagreements.length}`);
  for (const c of disagreements) {
    console.log(
      `  ${c.criterionId}: gave ${c.awarded}, key says ${ERROR_KEY[c.criterionId]} — ${c.reasoning}`,
    );
  }

  const missedHard = UNAMBIGUOUS.filter((id) => marks[id] !== ERROR_KEY[id]);
  console.log(
    missedHard.length === 0
      ? "all six unambiguous criteria agree with the key"
      : `UNAMBIGUOUS CRITERIA WRONG: ${missedHard.join(", ")}`,
  );

  if (result.adjustments.length > 0) {
    console.log("\nadjustments:");
    for (const line of result.adjustments) console.log(`  - ${line}`);
  }
}

if (runs > 1) {
  console.log(`\n${"=".repeat(100)}`);
  console.log(`VARIATION ACROSS ${runs} RUNS`);
  console.log("=".repeat(100));
  console.log(`totals: ${totals.join(", ")}   (key says 9, acceptable band 8-10)`);

  console.log("\ncriterion  key  " + marksByRun.map((_, i) => `run${i + 1}`).join("  ") + "   stable");
  for (const id of Object.keys(ERROR_KEY)) {
    const marks = marksByRun.map((m) => m[id] ?? -1);
    const stable = new Set(marks).size === 1;
    console.log(
      `${id.padEnd(9)} ${String(ERROR_KEY[id]).padStart(4)}  ` +
        marks.map((m) => String(m).padStart(4)).join("  ") +
        `   ${stable ? "yes" : "NO"}`,
    );
  }
}
