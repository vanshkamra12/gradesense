import type { ExtractedDocument } from "../pdf/extract.js";
import type { PromptPart } from "./provider.js";
import { FINDING_TYPES } from "./schema.js";
import type { Rubric } from "./rubric.js";

export const MAX_EVIDENCE_CHARS = 200;

function markingScheme(rubric: Rubric): string {
  return rubric.questions
    .map((question) => {
      const criteria = question.criteria
        .map((c) => `${c.id} [${c.maxMarks} mark] ${c.text}`)
        .join("\n");

      // Verbatim. Rewording the guidance is the failure this section exists to
      // prevent, so it is inserted exactly as parsed from the marking scheme.
      const guidance =
        question.guidance.length === 0
          ? ""
          : [
              "",
              `AUTHORITATIVE MARKING INSTRUCTIONS FOR ${question.id}`,
              "The following is quoted verbatim from the marking scheme. It overrides",
              "your own judgement wherever the two differ.",
              "",
              ...question.guidance.map((line) => `  ${line}`),
            ].join("\n");

      return [`### ${question.id} — ${question.subject}`, "", criteria, guidance].join("\n");
    })
    .join("\n\n");
}

function referenceAnswers(rubric: Rubric): string {
  return rubric.modelAnswers
    .map((answer) => `### ${answer.questionId} — ${answer.subject}\n\n${answer.text}`)
    .join("\n\n");
}

function studentText(document: ExtractedDocument): string {
  return document.pages
    .map((page) => `--- PAGE ${page.page} ---\n${page.text.trim()}`)
    .join("\n\n");
}

function markingMaterialAndStudentWork(
  rubric: Rubric,
  student: ExtractedDocument,
  pageCount: number,
): string {
  const criterionCount = rubric.criteria.length;

  return `You are an experienced examiner marking a school examination script.

Mark the student's answer against the marking scheme below. There are ${criterionCount}
criteria. Return exactly one verdict for each of them, using the criterion IDs
exactly as written.

## HOW TO MARK

Judge each criterion separately, on its own merits, against its own wording and
nothing else. A criterion does not lose marks because a different criterion was
answered badly, and does not gain marks because the rest of the script is
strong. Mark each one as if it were the only thing you were looking at.

Each criterion is worth the number of marks shown in brackets, and resolves to a
whole number. Award the full mark when the criterion is met and 0 when it is
not. A criterion that is only half met scores 0 — there are no fractional marks.

Do not calculate, estimate or reason about a total or a percentage. You are not
given one and you must not return one. Totals are computed outside this task.

## WHAT COUNTS AS THE STUDENT'S ANSWER

The student's written text and their hand-drawn diagrams are both part of the
answer. You are given the extracted text of each page and an image of each page.

The text and the diagrams can disagree with each other. When they do, do not
silently pick one. Say in your feedback that the written statement and the
drawing do not agree, and then mark against whatever the criterion actually asks
about.

The extracted text may contain words the student crossed out. A strike-through
is a drawn line and does not survive text extraction, so a struck-out false
start can appear in the text running straight into the words that replaced it.
Check the page image, and disregard any span the student struck out when
deciding what their answer is.

Answers may be written out of order, and parts may be labelled out of sequence.
Locate content by what it says, not by where it sits on the page.

## SPELLING, GRAMMAR AND PRESENTATION

Report spelling and grammatical errors in your feedback — they are useful to the
student. They must not by themselves cost a criterion mark. Misspelling a
technical term is not the same as misunderstanding it: if the meaning is
identifiable, the point is made. Untidy layout and out-of-order parts likewise
cost nothing.

The only exception is a criterion whose own wording is about clarity of
communication, and even then judge the clarity of the reasoning, not the surface
errors.

## MARKING SCHEME

${markingScheme(rubric)}

## MODEL ANSWER — REFERENCE ONLY

What follows is one example of an answer that would earn full marks. It is
reference material to help you understand the subject matter. It is not a target
for the student to match, and it is not the standard against which you mark.

The student is not expected to reproduce its wording, its structure, or its
conclusion. Similarity to this text is not evidence that an answer is correct,
and difference from it is not evidence that an answer is wrong. A student who
argues the opposite position, or reaches the opposite conclusion, can earn full
marks if the criterion is met. Mark the quality of the reasoning against the
criterion wording. Never mark by resemblance to what follows.

${referenceAnswers(rubric)}

## STUDENT ANSWER — EXTRACTED TEXT

Quote your evidence from this text, character for character.

${studentText(student)}

## STUDENT ANSWER — PAGE IMAGES

The ${pageCount} page image${pageCount === 1 ? "" : "s"} below ${pageCount === 1 ? "is" : "are"} in page order. Use them to read the
hand-drawn diagrams, and to see anything the extracted text cannot show,
including struck-out spans.`;
}

function outputContract(criterionCount: number): string {
  return `## EVIDENCE

Every criterion result carries evidence, or is explicitly marked as missing.

For a point the student did make, quote the span of their text that carries your
finding. Copy it from the extracted text above character for character. Do not
correct spelling. Do not tidy punctuation or capitalisation. Do not join across a
line break any differently than the source does. The quote is matched against
the original document, and an edited quote cannot be found.

Quote the shortest span that carries the finding — about one sentence, and no
more than ${MAX_EVIDENCE_CHARS} characters. Long quotes locate less precisely and make worse
annotations.

For a point the student did not make at all, set "evidence" to null and
"findingType" to "missing". Do not quote a span that merely happens to be nearby
and do not invent one.

If your finding is about a diagram and there is no text that carries it, set
"evidence" to null, describe what the diagram shows in your feedback, and use
the findingType that fits the verdict.

## POSITIONS

Do not report coordinates, bounding boxes, pixel positions, or descriptions of
where something sits on the page such as "top of page 2" or "in the margin".
Describe what you found and quote it. Where it is on the page is worked out
separately from your quote.

The "page" field is the 1-based page number the quoted text appears on, and
nothing more. Use null when there is no quote.

## CONFIDENCE

Give each criterion a "confidence" between 0 and 1, and one line of "reasoning"
saying why you marked it as you did.

Low confidence on a genuinely arguable criterion is the correct answer, not a
failure. Some criteria are legitimately debatable, and some answers are half
right in a way that makes either verdict defensible. Say so with a low
confidence value. Honest uncertainty is more useful than false precision, and
low-confidence results are routed to a human for review.

## OUTPUT

Return one JSON object and nothing else. No prose before or after it, no
explanation, and no markdown code fences.

{
  "criteria": [
    {
      "criterionId": "string, exactly as written in the marking scheme",
      "awarded": "number, a whole number between 0 and the criterion's maximum",
      "maxMarks": "number, the criterion's maximum as given in the marking scheme",
      "findingType": ${JSON.stringify(FINDING_TYPES.join(" | "))},
      "evidence": "string quoted character for character, or null",
      "page": "number, the 1-based page of the quote, or null",
      "feedback": "string addressed to the student, explaining the verdict",
      "correction": "string stating what would have been correct, or null when the criterion is met",
      "confidence": "number between 0 and 1",
      "reasoning": "one line explaining the verdict"
    }
  ],
  "overallNotes": "optional string of general observations"
}

Return a verdict for all ${criterionCount} criteria, including the ones the student
answered well. Do not add a total field.`;
}

/**
 * The request as an ordered list of parts: marking material and the student's
 * text first so the criteria frame the reading, then one image per page, then
 * the output contract last so it is the most recent instruction.
 */
export function buildPromptParts(
  rubric: Rubric,
  student: ExtractedDocument,
  pageImages: Buffer[],
): PromptPart[] {
  return [
    { kind: "text", text: markingMaterialAndStudentWork(rubric, student, pageImages.length) },
    ...pageImages.map((png): PromptPart => ({ kind: "image", png })),
    { kind: "text", text: outputContract(rubric.criteria.length) },
  ];
}

/** Concatenates the text parts, for tests and for the prompt preview tool. */
export function promptText(parts: PromptPart[]): string {
  return parts
    .filter((part) => part.kind === "text")
    .map((part) => part.text)
    .join("\n\n");
}
