import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { extractPdf } from "../pdf/extract.js";

export type Criterion = {
  id: string; // "Q1.C2"
  questionId: string; // "Q1"
  text: string;
  maxMarks: number;
};

export type QuestionRubric = {
  id: string;
  subject: string;
  maxMarks: number;
  criteria: Criterion[];
  /** Verbatim lines of the "Important grading guidance" block. Never reworded. */
  guidance: string[];
};

/** Reference material for the prompt. Deliberately not part of the rubric. */
export type ModelAnswer = {
  questionId: string;
  subject: string;
  text: string;
};

export type Rubric = {
  questions: QuestionRubric[];
  modelAnswers: ModelAnswer[];
  criteria: Criterion[];
  totalMarks: number;
};

const QUESTION_HEADING = /^(Q\d+)\s+—\s+(.+)$/;
const MODEL_ANSWER_HEADING = /^Model Answer\s+—\s+(\d+)\s+marks?$/i;
const RUBRIC_HEADING = /^Marking rubric$/i;
const TABLE_HEADING = /^Criterion\s+Marks$/i;
const TOTAL_ROW = /^Total\s+(\d+)$/i;
const GUIDANCE_HEADING = /^Important grading guidance$/i;
/** A rubric row ends with its mark: "...across the bulb 1". */
const CRITERION_ROW = /^(.*\S)\s+(\d)$/;

/** Thrown when the marking scheme cannot be read. The message names what was missing. */
export class RubricParseError extends Error {}

type Section = { id: string; subject: string; lines: string[] };

function splitIntoQuestionSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  for (const line of lines) {
    const heading = QUESTION_HEADING.exec(line);
    if (heading) {
      sections.push({ id: heading[1]!, subject: heading[2]!.trim(), lines: [] });
    } else {
      sections.at(-1)?.lines.push(line); // anything before Q1 is the cover heading
    }
  }
  return sections;
}

/**
 * Rows wrap: a long criterion runs onto a second line and only the final line
 * carries the mark. So accumulate lines until one ends in a digit, and treat
 * everything gathered as the criterion text.
 */
function parseCriteriaRows(rows: string[], questionId: string): Criterion[] {
  const criteria: Criterion[] = [];
  let pending: string[] = [];

  for (const row of rows) {
    const match = CRITERION_ROW.exec(row);
    if (!match) {
      pending.push(row);
      continue;
    }

    pending.push(match[1]!);
    criteria.push({
      id: `${questionId}.C${criteria.length + 1}`,
      questionId,
      text: pending.join(" ").replace(/\s+/g, " ").trim(),
      maxMarks: Number(match[2]),
    });
    pending = [];
  }

  if (pending.length > 0) {
    throw new RubricParseError(
      `${questionId}: rubric row with no mark: ${JSON.stringify(pending.join(" "))}`,
    );
  }
  return criteria;
}

function parseSection(section: Section): { question: QuestionRubric; modelAnswer: ModelAnswer } {
  const { id, subject, lines } = section;

  const answerStart = lines.findIndex((l) => MODEL_ANSWER_HEADING.test(l));
  const rubricStart = lines.findIndex((l) => RUBRIC_HEADING.test(l));
  const tableStart = lines.findIndex((l) => TABLE_HEADING.test(l));
  const totalRow = lines.findIndex((l) => TOTAL_ROW.test(l));
  const guidanceStart = lines.findIndex((l) => GUIDANCE_HEADING.test(l));

  if (answerStart === -1) throw new RubricParseError(`${id}: no "Model Answer" heading`);
  if (rubricStart === -1) throw new RubricParseError(`${id}: no "Marking rubric" heading`);
  if (tableStart === -1) throw new RubricParseError(`${id}: no "Criterion / Marks" table header`);
  if (totalRow === -1) throw new RubricParseError(`${id}: no "Total" row`);

  const declaredMarks = Number(MODEL_ANSWER_HEADING.exec(lines[answerStart]!)![1]);
  const totalMarks = Number(TOTAL_ROW.exec(lines[totalRow]!)![1]);
  if (declaredMarks !== totalMarks) {
    throw new RubricParseError(
      `${id}: heading says ${declaredMarks} marks but the table totals ${totalMarks}`,
    );
  }

  const criteria = parseCriteriaRows(lines.slice(tableStart + 1, totalRow), id);
  const awarded = criteria.reduce((sum, c) => sum + c.maxMarks, 0);
  if (awarded !== totalMarks) {
    throw new RubricParseError(
      `${id}: criteria sum to ${awarded} but the table totals ${totalMarks}`,
    );
  }

  // Verbatim, to the end of the section. Reworded guidance is the failure mode
  // this whole structure exists to prevent.
  const guidance = guidanceStart === -1 ? [] : lines.slice(guidanceStart + 1);

  return {
    question: { id, subject, maxMarks: totalMarks, criteria, guidance },
    modelAnswer: {
      questionId: id,
      subject,
      text: lines.slice(answerStart + 1, rubricStart).join("\n").trim(),
    },
  };
}

export function parseRubric(documentText: string): Rubric {
  const lines = documentText
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l !== "" && l !== "\f");

  const sections = splitIntoQuestionSections(lines);
  if (sections.length === 0) throw new RubricParseError("no question headings found");

  const parsed = sections.map(parseSection);
  const questions = parsed.map((p) => p.question);
  const criteria = questions.flatMap((q) => q.criteria);

  return {
    questions,
    modelAnswers: parsed.map((p) => p.modelAnswer),
    criteria,
    totalMarks: criteria.reduce((sum, c) => sum + c.maxMarks, 0),
  };
}

export async function parseRubricFromPdf(data: Uint8Array): Promise<Rubric> {
  const extracted = await extractPdf(data);
  return parseRubric(extracted.pages.map((p) => p.text).join("\n"));
}

// The marking scheme is fixed input, so parse it once per process rather than
// per grade run.
let cached: Promise<Rubric> | null = null;

export function loadRubric(): Promise<Rubric> {
  cached ??= fs
    .readFile(path.join(config.fixturesDir, "model_answer.pdf"))
    .then((buf) => parseRubricFromPdf(new Uint8Array(buf)));
  return cached;
}
