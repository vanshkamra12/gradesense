import { randomUUID } from "node:crypto";
import type { EnforcedCriterion, EnforcedResult } from "../grade/enforce.js";
import type { ExtractedDocument } from "../pdf/extract.js";
import { locateFigure, locateQuote, type Located, type Rect } from "./locate.js";

export type Annotation = {
  id: string;
  resultId: string;
  criterionId: string | null;
  page: number;
  rect: Rect | null;
  kind: "box" | "underline";
  color: "red" | "amber" | "green";
  comment: string;
  anchor: "text" | "figure" | "manual";
  unplaced: boolean;
  needsPlacement: boolean;
  createdBy: "system" | "user";
  updatedAt: string;
};

function colourFor(criterion: EnforcedCriterion): Annotation["color"] {
  if (criterion.awarded >= criterion.maxMarks) return "green";
  return criterion.findingType === "missing" ? "amber" : "red";
}

/**
 * Where a criterion's finding sits on the page, if anywhere.
 *
 * The three evidence states are not interchangeable here:
 *
 * - "verified"     the quote is matched against the page and boxed.
 * - "absent"       no quote was offered, because the finding is about a drawing
 *                  or the point is simply missing. Anchor it to the page's
 *                  figure and let a human confirm the position.
 * - "unverifiable" the model quoted something that is not in the answer, and
 *                  enforcement removed it. This gets no figure anchor and no
 *                  box. Placing it on the drawing would be inventing a position
 *                  for a quote that was already invented once — a second
 *                  fabrication dressed up as a location, and on screen it would
 *                  look exactly as authoritative as a real one.
 */
function place(criterion: EnforcedCriterion, student: ExtractedDocument): Located | null {
  if (criterion.evidence !== null) {
    return locateQuote(student, criterion.evidence, criterion.page);
  }
  if (criterion.evidenceStatus === "unverifiable") return null;
  if (criterion.findingType === "missing" && criterion.awarded === 0) {
    // Nothing was written, so there is nothing on the page to point at.
    return null;
  }
  return locateFigure(student);
}

export function buildAnnotations(
  resultId: string,
  result: EnforcedResult,
  student: ExtractedDocument,
  now: string = new Date().toISOString(),
): Annotation[] {
  const annotations: Annotation[] = [];

  for (const criterion of result.criteria) {
    const located = place(criterion, student);
    if (located === null) continue;

    const comment = criterion.correction
      ? `${criterion.feedback}\n\n${criterion.correction}`
      : criterion.feedback;

    annotations.push({
      id: randomUUID(),
      resultId,
      criterionId: criterion.criterionId,
      page: located.page ?? criterion.page ?? 1,
      rect: located.rects[0] ?? null,
      kind: criterion.awarded >= criterion.maxMarks ? "underline" : "box",
      color: colourFor(criterion),
      comment,
      anchor: located.anchor,
      unplaced: located.unplaced,
      needsPlacement: located.needsPlacement,
      createdBy: "system",
      updatedAt: now,
    });

    // A quote spanning several lines gets one annotation per line, so no box
    // swallows the gap between two lines of text.
    for (const rect of located.rects.slice(1)) {
      annotations.push({
        ...annotations[annotations.length - 1]!,
        id: randomUUID(),
        rect,
      });
    }
  }

  return annotations;
}
