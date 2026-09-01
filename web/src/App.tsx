import { useCallback, useEffect, useState } from "react";
import { AnnotationEditor } from "./components/AnnotationEditor";
import { HistoryList } from "./components/HistoryList";
import { PageViewer } from "./components/PageViewer";
import { ResultPanel } from "./components/ResultPanel";
import { Uploader } from "./components/Uploader";
import {
  createAnnotation,
  deleteAnnotation,
  fetchHistory,
  fetchResult,
  patchAnnotation,
  pdfUrl,
  type Annotation,
  type AnnotationPatch,
  type HistoryEntry,
  type Rect,
  type StoredResult,
} from "./lib/api";

/**
 * What a drawn box will do when it is finished: start a new annotation, or give
 * a position to a finding we could not place.
 */
type DrawIntent = { kind: "new" } | { kind: "place"; annotation: Annotation };

export default function App() {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [current, setCurrent] = useState<StoredResult | null>(null);
  const [selectedCriterionId, setSelectedCriterionId] = useState<string | null>(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [drawIntent, setDrawIntent] = useState<DrawIntent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshHistory = useCallback(() => {
    fetchHistory().then(setHistory, (cause: unknown) => setError(String(cause)));
  }, []);

  useEffect(refreshHistory, [refreshHistory]);

  const open = useCallback((id: string) => {
    setSelectedCriterionId(null);
    setSelectedAnnotationId(null);
    setDrawIntent(null);
    fetchResult(id).then(setCurrent, (cause: unknown) => setError(String(cause)));
  }, []);

  /**
   * Annotation edits replace one annotation in local state from the server's
   * response. Nothing here reads or writes the grading result — the marks in
   * `current.result` are simply not part of any of these paths.
   */
  const replaceAnnotation = useCallback((updated: Annotation) => {
    setCurrent((previous) =>
      previous === null
        ? previous
        : {
            ...previous,
            annotations: previous.annotations.map((a) => (a.id === updated.id ? updated : a)),
          },
    );
  }, []);

  const runEdit = useCallback((work: Promise<void>) => {
    work.catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, []);

  const patch = useCallback(
    (annotationId: string, body: AnnotationPatch) => {
      if (!current) return;
      runEdit(patchAnnotation(current.id, annotationId, body).then(replaceAnnotation));
    },
    [current, replaceAnnotation, runEdit],
  );

  const remove = useCallback(
    (annotationId: string) => {
      if (!current) return;
      runEdit(
        deleteAnnotation(current.id, annotationId).then(() => {
          setSelectedAnnotationId(null);
          setCurrent((previous) =>
            previous === null
              ? previous
              : { ...previous, annotations: previous.annotations.filter((a) => a.id !== annotationId) },
          );
        }),
      );
    },
    [current, runEdit],
  );

  const draw = useCallback(
    (page: number, rect: Rect) => {
      if (!current || !drawIntent) return;

      if (drawIntent.kind === "place") {
        // Binding a position to a finding we could not place. Same PATCH route
        // as a drag; the criterion it belongs to is already on the annotation.
        patch(drawIntent.annotation.id, { page, rect });
        setSelectedAnnotationId(drawIntent.annotation.id);
      } else {
        runEdit(
          createAnnotation(current.id, { page, rect, comment: "", color: "red" }).then(
            (created) => {
              setCurrent((previous) =>
                previous === null
                  ? previous
                  : { ...previous, annotations: [...previous.annotations, created] },
              );
              setSelectedAnnotationId(created.id);
            },
          ),
        );
      }
      setDrawIntent(null);
    },
    [current, drawIntent, patch, runEdit],
  );

  const selectedAnnotation =
    current?.annotations.find((a) => a.id === selectedAnnotationId) ?? null;

  // Escape cancels drawing; Delete removes the selected box. Ignored while the
  // caret is in the comment field, where both keys mean what they normally do.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "TEXTAREA" || target?.tagName === "INPUT") return;

      if (event.key === "Escape") {
        setDrawIntent(null);
        setSelectedAnnotationId(null);
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selectedAnnotationId) {
        event.preventDefault();
        remove(selectedAnnotationId);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [remove, selectedAnnotationId]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>GradeSense</h1>
        <Uploader
          onGraded={(id) => {
            refreshHistory();
            open(id);
          }}
        />
        {current && (
          <button
            type="button"
            className={`draw-toggle ${drawIntent ? "is-on" : ""}`}
            onClick={() => setDrawIntent(drawIntent ? null : { kind: "new" })}
          >
            {drawIntent?.kind === "place"
              ? "Draw the box for this finding — Esc to cancel"
              : drawIntent
                ? "Drawing — drag on the page, or click to cancel"
                : "Add annotation"}
          </button>
        )}
      </header>

      {error && <p className="error">{error}</p>}

      <div className="app-body">
        <main className="viewer">
          {current ? (
            <PageViewer
              pdfHref={pdfUrl(current.id)}
              pages={current.document.pages}
              annotations={current.annotations}
              selectedCriterionId={selectedCriterionId}
              selectedAnnotationId={selectedAnnotationId}
              drawing={drawIntent !== null}
              onSelectCriterion={setSelectedCriterionId}
              onSelectAnnotation={setSelectedAnnotationId}
              onMoveOrResize={(annotationId, rect) => patch(annotationId, { rect })}
              onDraw={draw}
            />
          ) : (
            <p className="muted empty">
              Upload a student answer PDF, or open a past grading from the list.
            </p>
          )}
        </main>

        <aside className="sidebar">
          {selectedAnnotation && (
            <AnnotationEditor
              annotation={selectedAnnotation}
              onComment={(comment) => patch(selectedAnnotation.id, { comment })}
              onColour={(color) => patch(selectedAnnotation.id, { color })}
              onKind={(kind) => patch(selectedAnnotation.id, { kind })}
              onDelete={() => remove(selectedAnnotation.id)}
              onClose={() => setSelectedAnnotationId(null)}
            />
          )}

          {current ? (
            <ResultPanel
              stored={current}
              selectedCriterionId={selectedCriterionId}
              onSelectCriterion={setSelectedCriterionId}
              onPlace={(annotation) => {
                setDrawIntent({ kind: "place", annotation });
                setSelectedAnnotationId(annotation.id);
              }}
            />
          ) : null}

          <section className="panel">
            <h3 className="section-heading">History</h3>
            <HistoryList entries={history} currentId={current?.id ?? null} onOpen={open} />
          </section>
        </aside>
      </div>
    </div>
  );
}
