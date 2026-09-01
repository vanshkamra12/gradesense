/**
 * Development tool: prints the prompt exactly as it would be sent, so it can be
 * read before it reaches a real model.
 *
 *   npm run print:prompt --workspace server -- ../fixtures/student_answer_A.pdf
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { extractPdf } from "../pdf/extract.js";
import { buildPromptParts, promptText } from "./prompt.js";
import { loadRubric } from "./rubric.js";

const arg = process.argv[2] ?? path.join(config.fixturesDir, "student_answer_A.pdf");
const file = path.resolve(process.cwd(), arg);

if (!fs.existsSync(file)) {
  console.error(`No such file: ${file}`);
  process.exit(1);
}

const [rubric, student] = await Promise.all([
  loadRubric(),
  extractPdf(new Uint8Array(fs.readFileSync(file))),
]);

// Real PNGs are not needed to preview the text, only the right number of them.
const parts = buildPromptParts(rubric, student, student.pages.map(() => Buffer.alloc(0)));
const text = promptText(parts);

if (process.argv.includes("--stats")) {
  console.error(
    `${parts.length} parts (${parts.filter((p) => p.kind === "image").length} images), ` +
      `${text.length} characters of text, ${text.split("\n").length} lines`,
  );
}

for (const [index, part] of parts.entries()) {
  if (part.kind === "text") {
    console.log(part.text);
  } else {
    console.log(`\n[PROMPT PART ${index}: page image ${index}]\n`);
  }
}
