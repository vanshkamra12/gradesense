import { useEffect, useState } from "react";
import type { Annotation } from "../lib/api";

type Props = {
  annotation: Annotation;
  onComment: (comment: string) => void;
  onColour: (color: Annotation["color"]) => void;
  onKind: (kind: Annotation["kind"]) => void;
  onDelete: () => void;
  onClose: () => void;
};

const COLOURS: Annotation["color"][] = ["red", "amber", "green"];

export function AnnotationEditor({
  annotation,
  onComment,
  onColour,
  onKind,
  onDelete,
  onClose,
}: Props) {
  const [comment, setComment] = useState(annotation.comment);

  // Switching selection to a different box replaces what is being edited.
  useEffect(() => setComment(annotation.comment), [annotation.id, annotation.comment]);

  const dirty = comment !== annotation.comment;

  return (
    <section className="panel editor">
      <header className="editor-head">
        <strong>{annotation.criterionId ?? "Note"}</strong>
        <span className="muted">
          {annotation.createdBy === "user" ? "added by you" : "from the marking"} · {annotation.anchor}
        </span>
        <button type="button" className="link" onClick={onClose}>
          close
        </button>
      </header>

      <textarea
        className="editor-comment"
        rows={4}
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setComment(annotation.comment);
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) onComment(comment);
        }}
      />

      <div className="editor-row">
        <button type="button" disabled={!dirty} onClick={() => onComment(comment)}>
          Save comment
        </button>
        <button type="button" disabled={!dirty} onClick={() => setComment(annotation.comment)}>
          Revert
        </button>
      </div>

      <div className="editor-row">
        {COLOURS.map((colour) => (
          <button
            key={colour}
            type="button"
            className={`swatch swatch-${colour} ${annotation.color === colour ? "is-on" : ""}`}
            title={colour}
            onClick={() => onColour(colour)}
          >
            {colour}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onKind(annotation.kind === "box" ? "underline" : "box")}
        >
          {annotation.kind === "box" ? "make underline" : "make box"}
        </button>
      </div>

      <div className="editor-row">
        <button type="button" className="danger" onClick={onDelete}>
          Delete annotation
        </button>
        <span className="muted">Marks are never affected.</span>
      </div>
    </section>
  );
}
