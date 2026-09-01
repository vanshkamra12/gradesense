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
import { buildPrompt } from "./prompt.js";
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

const prompt = buildPrompt(rubric, student);

if (process.argv.includes("--stats")) {
  console.error(
    `${prompt.length} characters, ${prompt.split("\n").length} lines, ` +
      `${student.pages.length} page images attached separately`,
  );
}

console.log(prompt);
