/**
 * Development tool: prints the parsed rubric so the 15 criteria and both
 * guidance blocks can be checked against the marking scheme by eye.
 *
 *   npm run print:rubric --workspace server
 */
import { loadRubric } from "./rubric.js";

const rubric = await loadRubric();

for (const question of rubric.questions) {
  console.log(`\n${"=".repeat(78)}`);
  console.log(`${question.id} — ${question.subject}  (${question.maxMarks} marks)`);
  console.log("=".repeat(78));

  console.log("\nCriteria:");
  for (const criterion of question.criteria) {
    console.log(`  ${criterion.id}  [${criterion.maxMarks}]  ${criterion.text}`);
  }

  console.log(`\nGuidance (${question.guidance.length} lines):`);
  if (question.guidance.length === 0) {
    console.log("  (none)");
  } else {
    for (const line of question.guidance) console.log(`  | ${line}`);
  }

  const modelAnswer = rubric.modelAnswers.find((m) => m.questionId === question.id);
  const words = modelAnswer?.text.split(/\s+/).length ?? 0;
  console.log(`\nModel answer reference text: ${words} words`);
}

console.log(`\n${"=".repeat(78)}`);
console.log(
  `TOTALS: ${rubric.questions.length} questions, ` +
    `${rubric.criteria.length} criteria, ${rubric.totalMarks} marks`,
);
