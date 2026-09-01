import { getDocument, OPS, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFPageProxy } from "pdfjs-dist";

/** One text run as pdf.js reports it, in PDF user space (origin bottom-left). */
export type TextItem = {
  page: number;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  charStart: number;
};

export type ImageBox = {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type ExtractedPage = {
  page: number;
  width: number;
  height: number;
  /** Every item's text joined in reading order. Item.charStart indexes into this. */
  text: string;
  items: TextItem[];
  images: ImageBox[];
};

export type ExtractedDocument = {
  pages: ExtractedPage[];
  /** All pages' text joined with form feeds, for guards and prompt building. */
  text: string;
  items: TextItem[];
};

type Matrix = readonly [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/**
 * An image XObject always paints into the unit square, so the current
 * transform is the whole story about where it lands on the page.
 */
function unitSquareBounds(ctm: Matrix): { x: number; y: number; w: number; h: number } {
  const corners = [
    applyMatrix(ctm, 0, 0),
    applyMatrix(ctm, 1, 0),
    applyMatrix(ctm, 0, 1),
    applyMatrix(ctm, 1, 1),
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

const IMAGE_OPS = new Set<number>([
  OPS.paintImageXObject,
  OPS.paintImageXObjectRepeat,
  OPS.paintInlineImageXObject,
  OPS.paintImageMaskXObject,
  OPS.paintImageMaskXObjectRepeat,
]);

/**
 * Walks the page's operator list keeping a transform stack, and records where
 * each painted image lands. locate.ts uses these to anchor findings about a
 * drawing, and the blank-answer guard uses their presence to tell an empty
 * page from a handwritten one.
 */
async function extractImageBoxes(page: PDFPageProxy, pageNumber: number): Promise<ImageBox[]> {
  const opList = await page.getOperatorList();
  const boxes: ImageBox[] = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = IDENTITY;

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];

    if (fn === OPS.save) {
      stack.push(ctm);
    } else if (fn === OPS.restore) {
      ctm = stack.pop() ?? IDENTITY;
    } else if (fn === OPS.transform) {
      ctm = multiply(ctm, args as Matrix);
    } else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      ctm = multiply(ctm, (args as [Matrix])[0]);
    } else if (fn === OPS.paintFormXObjectEnd) {
      ctm = stack.pop() ?? IDENTITY;
    } else if (fn !== undefined && IMAGE_OPS.has(fn)) {
      const rect = unitSquareBounds(ctm);
      // Hairline artefacts are not figures; ignore anything smaller than a glyph.
      if (rect.w >= 4 && rect.h >= 4) boxes.push({ page: pageNumber, ...rect });
    }
  }

  return boxes;
}

export async function extractPdf(data: Uint8Array): Promise<ExtractedDocument> {
  // pdf.js takes ownership of the buffer it is given, and the caller may still
  // need theirs - the uploaded bytes get rasterised and exported later.
  // Font quirks in the fixtures raise warnings that say nothing actionable.
  const loadingTask = getDocument({
    data: new Uint8Array(data),
    verbosity: VerbosityLevel.ERRORS,
  });
  const doc = await loadingTask.promise;

  const pages: ExtractedPage[] = [];

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

    const items: TextItem[] = [];
    let text = "";

    for (const item of content.items) {
      if (!("str" in item)) continue; // marked-content markers, not text

      items.push({
        page: pageNumber,
        text: item.str,
        // transform is [a, b, c, d, e, f]; e/f are the text baseline origin.
        x: item.transform[4],
        y: item.transform[5],
        w: item.width,
        h: item.height,
        charStart: text.length,
      });

      text += item.str;
      if (item.hasEOL) text += "\n";
    }

    pages.push({
      page: pageNumber,
      width: viewport.width,
      height: viewport.height,
      text,
      items,
      images: await extractImageBoxes(page, pageNumber),
    });
  }

  await loadingTask.destroy();

  return {
    pages,
    text: pages.map((p) => p.text).join("\n\f\n"),
    items: pages.flatMap((p) => p.items),
  };
}
