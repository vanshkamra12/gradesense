/**
 * Development tool: runs every evidence quote from a grading run through
 * locate.ts and prints what happened to it.
 *
 *   npm run print:locate --workspace server
 *   npm run print:locate --workspace server -- ../fixtures/student_answer_A.pdf badEvidence
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { gradeDocument } from "../grade/pipeline.js";
import { mockProvider, isMockMode } from "../grade/provider.js";
import { locateFigure, locateQuote, FUZZY_THRESHOLD, UNPLACED_RESULT } from "./locate.js";

const arg = process.argv[2] ?? path.join(config.fixturesDir, "student_answer_A.pdf");
const file = path.resolve(process.cwd(), arg);
const mode = process.argv[3] ?? "valid";

if (!fs.existsSync(file)) {
  console.error(`No such file: ${file}`);
  process.exit(1);
}
if (!isMockMode(mode)) {
  console.error(`Unknown mock mode: ${mode}`);
  process.exit(1);
}

const outcome = await gradeDocument(new Uint8Array(fs.readFileSync(file)), mockProvider(mode));
if (!outcome.ok) {
  console.error(`Grading failed: ${outcome.error.code} - ${outcome.error.message}`);
  process.exit(1);
}

const { student, result } = outcome.run;
const round = (n: number) => Math.round(n * 10) / 10;
const rect = (r: { x: number; y: number; w: number; h: number }) =>
  `x=${round(r.x)} y=${round(r.y)} w=${round(r.w)} h=${round(r.h)}`;

console.log(`${file}\nmock mode: ${mode}   fuzzy threshold: ${FUZZY_THRESHOLD}\n`);

let located = 0;
let unplaced = 0;
let figures = 0;

for (const criterion of result.criteria) {
  const quote = criterion.evidence;

  // A quote the model invented is left unplaced. Only a finding that never
  // offered a quote falls back to the figure.
  const found =
    quote !== null
      ? locateQuote(student, quote, criterion.page)
      : criterion.evidenceStatus === "unverifiable"
        ? UNPLACED_RESULT
        : locateFigure(student);

  if (found.unplaced) unplaced++;
  else if (found.anchor === "figure") figures++;
  else located++;

  const status = found.unplaced
    ? `UNPLACED${criterion.evidenceStatus === "unverifiable" ? " (quote was unverifiable)" : ""}`
    : `${found.method}${found.method === "fuzzy" ? ` ${found.score}` : ""}` +
      `${found.ambiguous ? " AMBIGUOUS" : ""}${found.needsPlacement ? " NEEDS-PLACEMENT" : ""}`;

  console.log(`${criterion.criterionId}  ${criterion.awarded}/${criterion.maxMarks}  [${status}]`);
  console.log(
    `  quote: ${
      quote !== null
        ? JSON.stringify(quote)
        : criterion.evidenceStatus === "unverifiable"
          ? "(removed - the model quoted text that is not in the answer)"
          : "(none offered - finding is about a drawing or a missing point)"
    }`,
  );

  if (found.rects.length === 0) {
    console.log("  rects: none - no box is drawn and the teacher places it by hand");
  } else {
    console.log(`  page ${found.page}, ${found.rects.length} rect(s):`);
    for (const r of found.rects) console.log(`    ${rect(r)}`);
  }
  console.log("");
}

console.log(
  `${located} located from text, ${figures} anchored to a figure, ${unplaced} unplaced, ` +
    `of ${result.criteria.length} criteria.`,
);
