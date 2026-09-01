import { useRef, useState } from "react";
import type { Annotation, Rect } from "../lib/api";

/** Drag handles, as fractions of the box. */
const HANDLES = [
  { id: "nw", x: 0, y: 0 },
  { id: "ne", x: 1, y: 0 },
  { id: "sw", x: 0, y: 1 },
  { id: "se", x: 1, y: 1 },
] as const;

const MIN_SIZE_PT = 4;

type Props = {
  annotations: Annotation[];
  /** Page height in PDF points, needed to flip the origin. */
  pageHeight: number;
  scale: number;
  selectedCriterionId: string | null;
  selectedAnnotationId: string | null;
  drawing: boolean;
  onSelectCriterion: (criterionId: string | null) => void;
  onSelectAnnotation: (annotationId: string | null) => void;
  onMoveOrResize: (annotationId: string, rect: Rect) => void;
  onDraw: (rect: Rect) => void;
};

/** CSS box, in page-relative pixels, for a rect in PDF user space. */
function toCss(rect: Rect, pageHeight: number, scale: number) {
  return {
    left: rect.x * scale,
    top: (pageHeight - rect.y - rect.h) * scale,
    width: rect.w * scale,
    height: rect.h * scale,
  };
}

/** The inverse: a CSS box back into PDF user space. */
function toPdf(
  box: { left: number; top: number; width: number; height: number },
  pageHeight: number,
  scale: number,
): Rect {
  return {
    x: box.left / scale,
    y: pageHeight - (box.top + box.height) / scale,
    w: box.width / scale,
    h: box.height / scale,
  };
}

export function AnnotationLayer({
  annotations,
  pageHeight,
  scale,
  selectedCriterionId,
  selectedAnnotationId,
  drawing,
  onSelectCriterion,
  onSelectAnnotation,
  onMoveOrResize,
  onDraw,
}: Props) {
  const layer = useRef<HTMLDivElement>(null);

  /** The box being dragged, resized or drawn, in CSS pixels. */
  const [draft, setDraft] = useState<
    { id: string | null; left: number; top: number; width: number; height: number } | null
  >(null);

  const pointToLayer = (event: { clientX: number; clientY: number }) => {
    const bounds = layer.current!.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };

  /**
   * One pointer gesture: track it to the end, then commit once. Nothing is sent
   * to the server while the mouse is moving.
   */
  function gesture(
    event: React.PointerEvent,
    step: (from: { x: number; y: number }, to: { x: number; y: number }) => typeof draft,
    commit: (final: NonNullable<typeof draft>) => void,
  ) {
    event.preventDefault();
    event.stopPropagation();

    const from = pointToLayer(event);
    let latest = step(from, from);
    setDraft(latest);

    const move = (moveEvent: PointerEvent) => {
      latest = step(from, pointToLayer(moveEvent));
      setDraft(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDraft(null);
      if (latest) commit(latest);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function startDraw(event: React.PointerEvent) {
    if (!drawing) return;

    gesture(
      event,
      (from, to) => ({
        id: null,
        left: Math.min(from.x, to.x),
        top: Math.min(from.y, to.y),
        width: Math.abs(to.x - from.x),
        height: Math.abs(to.y - from.y),
      }),
      (final) => {
        const rect = toPdf(final, pageHeight, scale);
        if (rect.w < MIN_SIZE_PT || rect.h < MIN_SIZE_PT) return; // a stray click
        onDraw(rect);
      },
    );
  }

  function startMove(event: React.PointerEvent, annotation: Annotation) {
    const box = toCss(annotation.rect!, pageHeight, scale);
    onSelectAnnotation(annotation.id);

    gesture(
      event,
      (from, to) => ({
        id: annotation.id,
        left: box.left + (to.x - from.x),
        top: box.top + (to.y - from.y),
        width: box.width,
        height: box.height,
      }),
      (final) => onMoveOrResize(annotation.id, toPdf(final, pageHeight, scale)),
    );
  }

  function startResize(
    event: React.PointerEvent,
    annotation: Annotation,
    handle: (typeof HANDLES)[number],
  ) {
    const box = toCss(annotation.rect!, pageHeight, scale);
    onSelectAnnotation(annotation.id);

    gesture(
      event,
      (from, to) => {
        const dx = to.x - from.x;
        const dy = to.y - from.y;

        // The dragged corner moves; the opposite corner stays put.
        const left = handle.x === 0 ? box.left + dx : box.left;
        const top = handle.y === 0 ? box.top + dy : box.top;
        const right = handle.x === 1 ? box.left + box.width + dx : box.left + box.width;
        const bottom = handle.y === 1 ? box.top + box.height + dy : box.top + box.height;

        return {
          id: annotation.id,
          left: Math.min(left, right),
          top: Math.min(top, bottom),
          width: Math.abs(right - left),
          height: Math.abs(bottom - top),
        };
      },
      (final) => {
        const rect = toPdf(final, pageHeight, scale);
        if (rect.w < MIN_SIZE_PT || rect.h < MIN_SIZE_PT) return;
        onMoveOrResize(annotation.id, rect);
      },
    );
  }

  // A quote spanning three lines is three annotations. Tagging every one of
  // them clutters the page, so only the first box for each criterion is named.
  const tagged = new Set<string>();

  return (
    <div
      ref={layer}
      className={`annotation-layer ${drawing ? "is-drawing" : ""}`}
      onPointerDown={startDraw}
    >
      {annotations.map((annotation) => {
        if (!annotation.rect) return null;

        const key = annotation.criterionId ?? annotation.id;
        const showTag = !tagged.has(key);
        tagged.add(key);

        const dragging = draft?.id === annotation.id;
        const box = dragging
          ? { left: draft.left, top: draft.top, width: draft.width, height: draft.height }
          : toCss(annotation.rect, pageHeight, scale);

        const selected =
          annotation.id === selectedAnnotationId ||
          (annotation.criterionId !== null && annotation.criterionId === selectedCriterionId);

        return (
          <div
            key={annotation.id}
            className={[
              "annotation",
              `annotation-${annotation.color}`,
              `annotation-${annotation.kind}`,
              selected ? "is-selected" : "",
              annotation.needsPlacement ? "needs-placement" : "",
              annotation.createdBy === "user" ? "is-user" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={box}
            title={`${annotation.criterionId ?? "note"}: ${annotation.comment}`}
            onPointerDown={(event) => !drawing && startMove(event, annotation)}
            onClick={(event) => {
              event.stopPropagation();
              onSelectAnnotation(annotation.id);
              onSelectCriterion(annotation.criterionId);
            }}
          >
            {/* Never colour alone: the criterion is named on the box itself. */}
            {showTag && (
              <span className="annotation-tag">{annotation.criterionId ?? "note"}</span>
            )}

            {selected &&
              HANDLES.map((handle) => (
                <span
                  key={handle.id}
                  className={`handle handle-${handle.id}`}
                  onPointerDown={(event) => startResize(event, annotation, handle)}
                />
              ))}
          </div>
        );
      })}

      {draft?.id === null && (
        <div
          className="annotation annotation-draft"
          style={{
            left: draft.left,
            top: draft.top,
            width: draft.width,
            height: draft.height,
          }}
        />
      )}
    </div>
  );
}
