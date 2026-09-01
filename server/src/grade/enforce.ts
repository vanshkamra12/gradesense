import { quoteMatchScore, FUZZY_THRESHOLD } from "../annotate/locate.js";
import type { Rubric } from "./rubric.js";
import type { CriterionResult, GradeResponse } from "./schema.js";

/** Below this, the whole result goes to a human. */
export const REVIEW_CONFIDENCE_THRESHOLD = 0.7;

/** What a hallucinated quote leaves a criterion's confidence at, at most. */
const UNVERIFIED_EVIDENCE_CONFIDENCE = 0.2;

const PENALTY_PER_ADJUSTED_CRITERION = 0.05;
const REPAIR_PENALTY = 0.1;

export type EnforcedCriterion = {
  criterionId: string;
  questionId: string;
  criterionText: string;
  awarded: number;
  maxMarks: number;
  findingType: CriterionResult["findingType"];
  evidence: string | null;
  page: number | null;
  feedback: string;
  correction: string | null;
  confidence: number;
  reasoning: string;
  /** True when enforcement changed this criterion in any way. */
  adjusted: boolean;
  /**
   * "verified"     - carries a quote that was found in the student's text.
   * "unverifiable" - the model quoted something absent, and it was removed.
   * "absent"       - no quote was offered: a missing point, or a finding about
   *                  a drawing that has no text to quote.
   *
   * The last two both leave `evidence` null, but they are not the same thing,
   * and locating treats them differently: an absent quote may be anchored to
   * the page's figure, while an unverifiable one is left unplaced. Guessing a
   * position for a quote the model invented would be inventing twice.
   */
  evidenceStatus: "verified" | "unverifiable" | "absent";
};

/**
 * A limit imposed by something enforcement cannot see in the response itself -
 * currently only that too little text was extracted to trust the marking.
 */
export type Caveat = {
  confidenceCeiling: number;
  reason: string;
};

export type EnforcedResult = {
  criteria: EnforcedCriterion[];
  total: number;
  maxTotal: number;
  confidence: number;
  needsHumanReview: boolean;
  reviewReasons: string[];
  /** The audit trail. One human-readable line per change made here. */
  adjustments: string[];
  overallNotes: string | null;
};

/**
 * Whitespace and case are the differences a faithful quote can still have from
 * the source, because the extracted text keeps the PDF's hard wrapping. Anything
 * beyond that means the quote was not copied from the student's answer.
 */
function normaliseForMatch(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function enforce(input: {
  response: GradeResponse;
  rubric: Rubric;
  studentText: string;
  repaired: boolean;
  caveat?: Caveat;
}): EnforcedResult {
  const { response, rubric, studentText, repaired, caveat } = input;

  // Kept in three groups so the audit trail reads in marking-scheme order,
  // then what was thrown away, then what applies to the response as a whole.
  const criterionAdjustments: string[] = [];
  const discardAdjustments: string[] = [];
  const responseAdjustments: string[] = [];
  const reviewReasons: string[] = [];
  // Index the model's results, keeping the first of any duplicates.
  const returned = new Map<string, CriterionResult>();
  for (const result of response.criteria) {
    if (returned.has(result.criterionId)) {
      discardAdjustments.push(
        `${result.criterionId}: the model returned more than one result for this criterion - the first was kept and the rest discarded.`,
      );
      continue;
    }
    returned.set(result.criterionId, result);
  }

  const rubricIds = new Set(rubric.criteria.map((c) => c.id));
  for (const id of returned.keys()) {
    if (!rubricIds.has(id)) {
      discardAdjustments.push(
        `${id}: not a criterion in the marking scheme - the model's result for it was discarded.`,
      );
    }
  }

  // Always iterate the rubric, so the output is the 15 criteria in scheme order
  // whatever the model returned or omitted.
  const criteria: EnforcedCriterion[] = rubric.criteria.map((criterion) => {
    const result = returned.get(criterion.id);

    if (!result) {
      criterionAdjustments.push(
        `${criterion.id}: the model returned no result for this criterion - recorded as 0 of ${criterion.maxMarks}, missing, with no confidence.`,
      );
      return {
        criterionId: criterion.id,
        questionId: criterion.questionId,
        criterionText: criterion.text,
        awarded: 0,
        maxMarks: criterion.maxMarks,
        findingType: "missing",
        evidence: null,
        page: null,
        feedback: "This criterion was not marked. It needs a human decision.",
        correction: null,
        confidence: 0,
        reasoning: "No result was returned for this criterion.",
        adjusted: true,
        evidenceStatus: "absent",
      };
    }

    let adjusted = false;
    let awarded = result.awarded;
    let evidence = result.evidence;
    let confidence = result.confidence;
    let evidenceStatus: EnforcedCriterion["evidenceStatus"] = "absent";

    if (result.maxMarks !== criterion.maxMarks) {
      criterionAdjustments.push(
        `${criterion.id}: the model reported a maximum of ${result.maxMarks} marks; the marking scheme says ${criterion.maxMarks}. The marking scheme was used.`,
      );
      adjusted = true;
    }

    // Floored, not rounded. The prompt tells the model a criterion that is only
    // half met scores 0, so rounding 0.5 up here would contradict the rule the
    // model was marking under.
    if (!Number.isInteger(awarded)) {
      const floored = Math.floor(awarded);
      criterionAdjustments.push(
        `${criterion.id}: awarded ${awarded}, which is not a whole mark - floored to ${floored}, since a criterion that is only partly met earns nothing.`,
      );
      awarded = floored;
      adjusted = true;
    }

    if (awarded > criterion.maxMarks) {
      criterionAdjustments.push(
        `${criterion.id}: awarded ${awarded} of a maximum ${criterion.maxMarks} - clamped to ${criterion.maxMarks}.`,
      );
      awarded = criterion.maxMarks;
      adjusted = true;
    } else if (awarded < 0) {
      criterionAdjustments.push(`${criterion.id}: awarded ${awarded}, below zero - clamped to 0.`);
      awarded = 0;
      adjusted = true;
    }

    // A quote with no counterpart in the answer cannot be shown to the student
    // as evidence, and cannot be located on the page. A finding with no quote at
    // all is allowed - a missing point, or something only the diagram shows.
    if (evidence !== null) {
      // The same matcher that places the quote on the page decides whether it
      // is real. A quote the locator could find is not a hallucination.
      if (quoteMatchScore(studentText, evidence) >= FUZZY_THRESHOLD) {
        evidenceStatus = "verified";
      } else {
        const lowered = Math.min(confidence, UNVERIFIED_EVIDENCE_CONFIDENCE);
        criterionAdjustments.push(
          `${criterion.id}: the quoted evidence does not appear anywhere in the student's answer - the quote was removed as unverifiable and confidence lowered from ${round(confidence)} to ${round(lowered)}.`,
        );
        evidence = null;
        confidence = lowered;
        evidenceStatus = "unverifiable";
        adjusted = true;
      }
    }

    return {
      criterionId: criterion.id,
      questionId: criterion.questionId,
      criterionText: criterion.text,
      awarded,
      maxMarks: criterion.maxMarks,
      findingType: result.findingType,
      evidence,
      page: evidence === null ? null : result.page,
      feedback: result.feedback,
      correction: result.correction,
      confidence,
      reasoning: result.reasoning,
      adjusted,
      evidenceStatus,
    };
  });

  const total = criteria.reduce((sum, c) => sum + c.awarded, 0);
  const maxTotal = criteria.reduce((sum, c) => sum + c.maxMarks, 0);

  if (response.total !== undefined && response.total !== total) {
    responseAdjustments.push(
      `The model returned a total of ${response.total}. Totals are never taken from the model - recomputed from the criterion marks as ${total} of ${maxTotal}.`,
    );
  }

  if (repaired) {
    responseAdjustments.push(
      "The model's first response could not be used. This result came from a second, corrected attempt.",
    );
  }

  const adjustedCriteria = criteria.filter((c) => c.adjusted);
  const meanConfidence =
    criteria.length === 0 ? 0 : criteria.reduce((sum, c) => sum + c.confidence, 0) / criteria.length;

  const confidence = round(
    Math.min(
      caveat?.confidenceCeiling ?? 1,
      Math.max(
        0,
        meanConfidence -
          PENALTY_PER_ADJUSTED_CRITERION * adjustedCriteria.length -
          (repaired ? REPAIR_PENALTY : 0),
      ),
    ),
  );

  // First, because it names the actual cause rather than the symptom.
  if (caveat) {
    reviewReasons.push(caveat.reason);
  }
  if (adjustedCriteria.length > 0) {
    reviewReasons.push(
      `${adjustedCriteria.length} of ${criteria.length} criteria had to be corrected after marking: ${adjustedCriteria
        .map((c) => c.criterionId)
        .join(", ")}.`,
    );
  }
  if (repaired) {
    reviewReasons.push("The model's first response was unusable and had to be repaired.");
  }
  if (confidence < REVIEW_CONFIDENCE_THRESHOLD) {
    reviewReasons.push(
      `Overall confidence is ${confidence}, below the ${REVIEW_CONFIDENCE_THRESHOLD} threshold for automatic acceptance.`,
    );
  }

  return {
    criteria,
    total,
    maxTotal,
    confidence,
    needsHumanReview: reviewReasons.length > 0,
    reviewReasons,
    adjustments: [...criterionAdjustments, ...discardAdjustments, ...responseAdjustments],
    overallNotes: response.overallNotes ?? null,
  };
}
