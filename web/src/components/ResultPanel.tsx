import { useEffect, useRef } from "react";
import type { Annotation, Criterion, StoredResult } from "../lib/api";

type Props = {
  stored: StoredResult;
  selectedCriterionId: string | null;
  onSelectCriterion: (criterionId: string | null) => void;
};

const FINDING_COLOUR: Record<Criterion["findingType"], string> = {
  correct: "green",
  incorrect: "red",
  partial: "amber",
  missing: "amber",
};

export function ResultPanel({ stored, selectedCriterionId, onSelectCriterion }: Props) {
  const { result, annotations } = stored;

  const unplaced = annotations.filter((a) => a.unplaced || a.rect === null);
  const needsPlacement = annotations.filter((a) => a.needsPlacement && a.rect !== null);

  return (
    <section className="panel">
      <Score result={result} />

      {result.overallNotes && <p className="notes">{result.overallNotes}</p>}

      {result.adjustments.length > 0 && <Adjustments lines={result.adjustments} />}

      {(unplaced.length > 0 || needsPlacement.length > 0) && (
        <Placement
          unplaced={unplaced}
          needsPlacement={needsPlacement}
          onSelectCriterion={onSelectCriterion}
        />
      )}

      <h3 className="section-heading">Criteria</h3>
      <ol className="criteria">
        {result.criteria.map((criterion) => (
          <CriterionCard
            key={criterion.criterionId}
            criterion={criterion}
            selected={criterion.criterionId === selectedCriterionId}
            onSelect={onSelectCriterion}
          />
        ))}
      </ol>
    </section>
  );
}

function Score({ result }: { result: StoredResult["result"] }) {
  return (
    <div className="score">
      <div className="score-total">
        <strong>{result.total}</strong>
        <span> / {result.maxTotal}</span>
      </div>
      <dl className="score-meta">
        <div>
          <dt>Confidence</dt>
          <dd>{result.confidence.toFixed(2)}</dd>
        </div>
        <div>
          <dt>Review</dt>
          <dd className={result.needsHumanReview ? "flag-on" : "flag-off"}>
            {result.needsHumanReview ? "Needs a human" : "Not required"}
          </dd>
        </div>
      </dl>
      {result.reviewReasons.length > 0 && (
        <ul className="review-reasons">
          {result.reviewReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The audit trail, not an error list. These are corrections the system made to
 * its own output, and a teacher should be able to read them as such.
 */
function Adjustments({ lines }: { lines: string[] }) {
  return (
    <details className="adjustments" open>
      <summary>
        What the system corrected about itself <span className="count">{lines.length}</span>
      </summary>
      <ul>
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </details>
  );
}

function Placement({
  unplaced,
  needsPlacement,
  onSelectCriterion,
}: {
  unplaced: Annotation[];
  needsPlacement: Annotation[];
  onSelectCriterion: (id: string | null) => void;
}) {
  return (
    <section className="placement">
      {unplaced.length > 0 && (
        <>
          <h3 className="section-heading">Findings we could not place ({unplaced.length})</h3>
          <p className="muted">
            These findings are real, but no position on the page could be verified for them. Nothing
            is drawn rather than drawn in the wrong place.
          </p>
          <ul className="placement-list">
            {unplaced.map((annotation) => (
              <li key={annotation.id}>
                <button type="button" onClick={() => onSelectCriterion(annotation.criterionId)}>
                  {annotation.criterionId ?? "note"}
                </button>
                <span>{annotation.comment}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {needsPlacement.length > 0 && (
        <>
          <h3 className="section-heading">Placed on a drawing ({needsPlacement.length})</h3>
          <p className="muted">
            Anchored to the largest figure on the page as a best guess. Confirm or move each one.
          </p>
          <ul className="placement-list">
            {needsPlacement.map((annotation) => (
              <li key={annotation.id}>
                <button type="button" onClick={() => onSelectCriterion(annotation.criterionId)}>
                  {annotation.criterionId ?? "note"}
                </button>
                <span>{annotation.comment}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function CriterionCard({
  criterion,
  selected,
  onSelect,
}: {
  criterion: Criterion;
  selected: boolean;
  onSelect: (id: string | null) => void;
}) {
  const card = useRef<HTMLLIElement>(null);

  // Clicking a box on the page selects its criterion, and the card has to come
  // into view. scrollIntoView is wrong here: it scrolls every scrollable
  // ancestor, which drags the page viewer around as a side effect. Scroll the
  // sidebar itself and leave the page where the teacher left it.
  useEffect(() => {
    if (!selected) return;

    const element = card.current;
    const panel = element?.closest<HTMLElement>(".sidebar");
    if (!element || !panel) return;

    // Assigned directly rather than scrolled smoothly. A smooth scroll here is
    // animated over several frames, and the canvas repainting beside it
    // cancels the animation partway — measured landing 22px down a 1299px
    // scroll. An instant jump always arrives.
    const offset = element.getBoundingClientRect().top - panel.getBoundingClientRect().top;
    panel.scrollTop = panel.scrollTop + offset - 12;
  }, [selected]);

  const colour = FINDING_COLOUR[criterion.findingType];

  return (
    <li
      ref={card}
      id={`criterion-${criterion.criterionId}`}
      className={`criterion criterion-${colour} ${selected ? "is-selected" : ""}`}
    >
      <button
        type="button"
        className="criterion-head"
        onClick={() => onSelect(selected ? null : criterion.criterionId)}
      >
        <span className="criterion-id">{criterion.criterionId}</span>
        <span className={`badge badge-${colour}`}>{criterion.findingType}</span>
        <span className="criterion-mark">
          {criterion.awarded} / {criterion.maxMarks}
        </span>
      </button>

      <p className="criterion-text">{criterion.criterionText}</p>

      {criterion.evidence ? (
        <blockquote className="evidence">{criterion.evidence}</blockquote>
      ) : (
        <p className="evidence evidence-none">
          {criterion.evidenceStatus === "unverifiable"
            ? "The quote given did not appear in the answer and was removed."
            : "No quote — nothing was written for this point, or the finding is about a drawing."}
        </p>
      )}

      <p className="feedback">{criterion.feedback}</p>
      {criterion.correction && <p className="correction">{criterion.correction}</p>}

      <p className="criterion-foot muted">
        confidence {criterion.confidence.toFixed(2)}
        {criterion.adjusted && <span className="adjusted-flag">adjusted</span>}
      </p>
    </li>
  );
}
