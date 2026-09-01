import type { Annotation } from "../lib/api";

type Props = {
  annotations: Annotation[];
  /** Page height in PDF points, needed to flip the origin. */
  pageHeight: number;
  scale: number;
  selectedCriterionId: string | null;
  onSelectCriterion: (criterionId: string | null) => void;
};

export function AnnotationLayer({
  annotations,
  pageHeight,
  scale,
  selectedCriterionId,
  onSelectCriterion,
}: Props) {
  // A quote spanning three lines is three annotations. Tagging every one of
  // them clutters the page, so only the first box for each criterion is named.
  const tagged = new Set<string>();

  return (
    <div className="annotation-layer">
      {annotations.map((annotation) => {
        const rect = annotation.rect;
        if (!rect) return null;

        const key = annotation.criterionId ?? annotation.id;
        const showTag = !tagged.has(key);
        tagged.add(key);

        // PDF user space has its origin at the bottom left; CSS at the top left.
        const style = {
          left: rect.x * scale,
          top: (pageHeight - rect.y - rect.h) * scale,
          width: rect.w * scale,
          height: rect.h * scale,
        };

        const selected = annotation.criterionId === selectedCriterionId;

        return (
          <button
            key={annotation.id}
            type="button"
            className={[
              "annotation",
              `annotation-${annotation.color}`,
              `annotation-${annotation.kind}`,
              selected ? "is-selected" : "",
              annotation.needsPlacement ? "needs-placement" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={style}
            title={`${annotation.criterionId ?? "note"}: ${annotation.comment}`}
            onClick={() => onSelectCriterion(selected ? null : annotation.criterionId)}
          >
            {/* Never colour alone: the criterion is named on the box itself. */}
            {showTag && <span className="annotation-tag">{annotation.criterionId ?? "note"}</span>}
          </button>
        );
      })}
    </div>
  );
}
