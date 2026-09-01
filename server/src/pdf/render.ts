import { createCanvas } from "@napi-rs/canvas";
import { getDocument, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";

/** The model has to read two hand-drawn diagrams, so render well above 1x. */
export const DEFAULT_RENDER_SCALE = 2;

export type RenderedPage = {
  page: number;
  /** Pixel dimensions of the PNG. */
  width: number;
  height: number;
  scale: number;
  png: Buffer;
};

export async function renderPdfPages(
  data: Uint8Array,
  scale: number = DEFAULT_RENDER_SCALE,
): Promise<RenderedPage[]> {
  const loadingTask = getDocument({
    data: new Uint8Array(data),
    verbosity: VerbosityLevel.ERRORS,
  });
  const doc = await loadingTask.promise;
  const rendered: RenderedPage[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale });

      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext("2d");

      // A PDF page has no background of its own. Without this the PNG is
      // transparent, which reads as black wherever it is composited.
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvas, viewport }).promise;
      page.cleanup();

      rendered.push({
        page: pageNumber,
        width: canvas.width,
        height: canvas.height,
        scale,
        png: canvas.encodeSync("png"),
      });
    }
  } finally {
    await loadingTask.destroy();
  }

  return rendered;
}
