/**
 * Produces the submission deliverable: grade a fixture and write the annotated
 * PDF to outputs/. Reproducible, so the file in the repo can be regenerated
 * rather than being a one-off artefact nobody can rebuild.
 *
 *   npm run export:sample --workspace server
 *   npm run export:sample --workspace server -- ../fixtures/student_answer_F.pdf
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildAnnotations } from "./annotations.js";
import { buildAnnotatedPdf } from "./export.js";
import { config, repoRoot } from "../config.js";
import { getResult, saveGradeRun } from "../db.js";
import { gradeDocument } from "../grade/pipeline.js";
import { createProvider } from "../grade/provider.js";

const arg = process.argv[2] ?? path.join(config.fixturesDir, "student_answer_A.pdf");
const file = path.resolve(process.cwd(), arg);

if (!fs.existsSync(file)) {
  console.error(`No such file: ${file}`);
  process.exit(1);
}

const bytes = new Uint8Array(fs.readFileSync(file));
const outcome = await gradeDocument(bytes, createProvider());

if (!outcome.ok) {
  console.error(`Grading failed: ${outcome.error.code} - ${outcome.error.message}`);
  process.exit(1);
}

const resultId = randomUUID();
const filename = path.basename(file);
saveGradeRun({
  resultId,
  run: outcome.run,
  annotations: buildAnnotations(resultId, outcome.run.result, outcome.run.student),
  filename,
  bytes,
});

const stored = getResult(resultId)!;
const annotated = await buildAnnotatedPdf(stored, bytes);

const outDir = path.join(repoRoot, "outputs");
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `annotated_${path.basename(file, ".pdf")}.pdf`);
fs.writeFileSync(out, annotated);

const { result } = stored;
console.log(`${filename} -> ${result.total}/${result.maxTotal}, confidence ${result.confidence}`);
console.log(`${stored.annotations.length} annotations, ${result.adjustments.length} adjustments`);
console.log(`wrote ${out} (${(annotated.byteLength / 1024).toFixed(0)} KB)`);
