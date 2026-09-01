import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Annotation, PageGeometry, Rect } from "../lib/api";
import { AnnotationLayer } from "./AnnotationLayer";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type Props = {
  pdfHref: string;
  pages: PageGeometry[];
  annotations: Annotation[];
  selectedCriterionId: string | null;
  selectedAnnotationId: string | null;
  drawing: boolean;
  onSelectCriterion: (criterionId: string | null) => void;
  onSelectAnnotation: (annotationId: string | null) => void;
  onMoveOrResize: (annotationId: string, rect: Rect) => void;
  onDraw: (page: number, rect: Rect) => void;
};

export function PageViewer({
  pdfHref,
  pages,
  annotations,
  selectedCriterionId,
  selectedAnnotationId,
  drawing,
  onSelectCriterion,
  onSelectAnnotation,
  onMoveOrResize,
  onDraw,
}: Props) {
  const [document, setDocument] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const task = pdfjs.getDocument({ url: pdfHref });

    task.promise.then(
      (loaded) => {
        if (!cancelled) setDocument(loaded);
      },
      (cause: unknown) => {
        if (!cancelled) setError(String(cause));
      },
    );

    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [pdfHref]);

  if (error) return <p className="error">Could not open the PDF: {error}</p>;
  if (!document) return <p className="muted">Loading the page…</p>;

  return (
    <div className="pages">
      {pages.map((geometry) => (
        <Page
          key={geometry.page}
          document={document}
          geometry={geometry}
          annotations={annotations.filter((a) => a.page === geometry.page && a.rect !== null)}
          selectedCriterionId={selectedCriterionId}
          selectedAnnotationId={selectedAnnotationId}
          drawing={drawing}
          onSelectCriterion={onSelectCriterion}
          onSelectAnnotation={onSelectAnnotation}
          onMoveOrResize={onMoveOrResize}
          onDraw={(rect) => onDraw(geometry.page, rect)}
        />
      ))}
    </div>
  );
}

type PageProps = {
  document: pdfjs.PDFDocumentProxy;
  geometry: PageGeometry;
  annotations: Annotation[];
  selectedCriterionId: string | null;
  selectedAnnotationId: string | null;
  drawing: boolean;
  onSelectCriterion: (criterionId: string | null) => void;
  onSelectAnnotation: (annotationId: string | null) => void;
  onMoveOrResize: (annotationId: string, rect: Rect) => void;
  onDraw: (rect: Rect) => void;
};

function Page({
  document,
  geometry,
  annotations,
  selectedCriterionId,
  selectedAnnotationId,
  drawing,
  onSelectCriterion,
  onSelectAnnotation,
  onMoveOrResize,
  onDraw,
}: PageProps) {
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);

  // The overlay is positioned from this scale, so it has to be recomputed
  // whenever the container changes size. Without this the boxes drift away
  // from the text the moment the window is resized.
  useEffect(() => {
    const element = container.current;
    if (!element) return;

    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    setWidth(element.clientWidth);

    return () => observer.disconnect();
  }, []);

  const scale = width > 0 ? width / geometry.width : 0;

  useEffect(() => {
    if (scale === 0) return;
    let cancelled = false;

    void (async () => {
      const page = await document.getPage(geometry.page);
      if (cancelled) return;

      // Render above CSS resolution so the text stays sharp; the canvas is then
      // scaled back down by its style width.
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: scale * ratio });
      const target = canvas.current;
      const context = target?.getContext("2d");
      if (!target || !context) return;

      target.width = Math.floor(viewport.width);
      target.height = Math.floor(viewport.height);
      context.fillStyle = "white";
      context.fillRect(0, 0, target.width, target.height);

      await page.render({ canvas: target, canvasContext: context, viewport }).promise;
      page.cleanup();
    })();

    return () => {
      cancelled = true;
    };
  }, [document, geometry.page, scale]);

  return (
    <figure className="page" ref={container}>
      <div className="page-canvas" style={{ height: geometry.height * scale }}>
        <canvas ref={canvas} style={{ width: "100%", height: "100%" }} />
        <AnnotationLayer
          annotations={annotations}
          pageHeight={geometry.height}
          scale={scale}
          selectedCriterionId={selectedCriterionId}
          selectedAnnotationId={selectedAnnotationId}
          drawing={drawing}
          onSelectCriterion={onSelectCriterion}
          onSelectAnnotation={onSelectAnnotation}
          onMoveOrResize={onMoveOrResize}
          onDraw={onDraw}
        />
      </div>
      <figcaption className="muted">
        Page {geometry.page} — {Math.round(geometry.width)} × {Math.round(geometry.height)} pt
      </figcaption>
    </figure>
  );
}
