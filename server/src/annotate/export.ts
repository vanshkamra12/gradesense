import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import type { Annotation } from "./annotations.js";
import type { StoredResult } from "../db.js";
import type { EnforcedCriterion } from "../grade/enforce.js";

const COLOURS: Record<Annotation["color"], RGB> = {
  red: rgb(0.702, 0.149, 0.118),
  amber: rgb(0.659, 0.392, 0),
  green: rgb(0.11, 0.42, 0.235),
};

const INK = rgb(0.1, 0.1, 0.1);
const MUTED = rgb(0.42, 0.42, 0.42);
const RULE = rgb(0.84, 0.83, 0.81);

const MARGIN = 48;
const NOTE_SIZE = 6.5;
const MARGIN_NOTE_SIZE = 5.2;
const MARGIN_NOTE_WIDTH = 62;
const MARGIN_NOTE_LINES = 9;
const BODY_SIZE = 9.5;

/**
 * pdf-lib draws with the standard 14 fonts in WinAnsi, which cannot encode
 * every character the fixtures contain - the rupee sign and subscript digits
 * in Q3 both fall outside it, and passing them through throws at draw time.
 * They are transliterated rather than dropped, so a marked-up quote still reads
 * as what the student wrote.
 */
function winAnsi(text: string): string {
  return (
    text
      .replace(/₹/g, "Rs.")
      .replace(/[₀₁₂₃₄₅₆₇₈₉]/g, (digit) => String("₀₁₂₃₄₅₆₇₈₉".indexOf(digit)))
      .replace(/\s+/g, " ")
      // Latin-1, plus the punctuation WinAnsi keeps in 0x80-0x9F: dashes,
      // curly quotes, the ellipsis and the bullet. Em dashes are encodable and
      // are not worth turning into two hyphens.
      .replace(/[^\x20-\x7E\xA0-\xFF\u2013\u2014\u2018\u2019\u201A\u201C\u201D\u201E\u2020\u2021\u2022\u2026\u2030\u2039\u203A\u20AC\u2122]/g, "")
  );
}

/** Greedy wrap to a pixel width, returning the lines. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = "";

  for (const word of winAnsi(text).split(" ").filter(Boolean)) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (font.widthOfTextAtSize(candidate, size) <= width) {
      line = candidate;
    } else {
      if (line !== "") lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

type Fonts = { body: PDFFont; bold: PDFFont; italic: PDFFont };

/**
 * Draws one annotation onto the page it belongs to.
 *
 * pdf-lib's origin is the bottom-left of the page, the same as pdf.js user
 * space, so a rect measured during extraction carries over with no conversion.
 * The only adjustment is the MediaBox offset, which is zero for these fixtures
 * but need not be in general.
 */
function drawAnnotation(page: PDFPage, annotation: Annotation, fonts: Fonts): void {
  if (!annotation.rect) return;

  const box = page.getMediaBox();
  const colour = COLOURS[annotation.color];
  const x = box.x + annotation.rect.x;
  const y = box.y + annotation.rect.y;
  const { w, h } = annotation.rect;

  if (annotation.kind === "underline") {
    page.drawLine({
      start: { x, y: y - 1 },
      end: { x: x + w, y: y - 1 },
      thickness: 1.2,
      color: colour,
    });
  } else {
    page.drawRectangle({
      x,
      y,
      width: w,
      height: h,
      borderColor: colour,
      borderWidth: 1,
      color: colour,
      opacity: 0.06,
      borderOpacity: 1,
    });
  }

}

/**
 * The criterion id, as on screen, so colour is never the only signal - printed
 * in the left margin rather than over the box. The fixture's text block starts
 * an inch in, and a tag drawn on the box itself covers the first word of the
 * line above it.
 */
function drawTag(page: PDFPage, annotation: Annotation, fonts: Fonts): void {
  if (!annotation.rect || !annotation.criterionId) return;

  const box = page.getMediaBox();
  const label = winAnsi(annotation.criterionId);
  const y = box.y + annotation.rect.y;

  page.drawText(label, {
    x: box.x + 8,
    y: y + 1,
    size: NOTE_SIZE,
    font: fonts.bold,
    color: COLOURS[annotation.color],
  });
}

/**
 * The correction, in the right margin beside its box.
 *
 * It goes in the margin rather than under the box on purpose. Drawn below a
 * box, wrapped text lands on the next line of the student's answer and hides
 * it; the margin is narrow, so the note is set small and wraps over several
 * short lines instead. It never covers the answer, which is the point.
 */
function drawMarginNote(
  page: PDFPage,
  annotation: Annotation,
  correction: string,
  fonts: Fonts,
): void {
  if (!annotation.rect) return;

  const box = page.getMediaBox();
  const width = MARGIN_NOTE_WIDTH;
  const left = box.x + box.width - width - 6;

  const wrapped = wrap(correction, fonts.italic, MARGIN_NOTE_SIZE, width);
  const lines = wrapped.slice(0, MARGIN_NOTE_LINES);
  // The full correction is always on the summary page, so a long one is cut
  // here rather than run down the whole margin.
  if (wrapped.length > lines.length) lines[lines.length - 1] += "...";

  const top = box.y + annotation.rect.y + annotation.rect.h - MARGIN_NOTE_SIZE;

  lines.forEach((line, index) => {
    const y = top - index * (MARGIN_NOTE_SIZE + 0.8);
    if (y < box.y + 8) return; // off the bottom of the page
    page.drawText(line, {
      x: left,
      y,
      size: MARGIN_NOTE_SIZE,
      font: fonts.italic,
      color: COLOURS[annotation.color],
    });
  });
}

/** A cursor that flows text down pages, adding one when it runs out of room. */
class Report {
  private page: PDFPage;
  private y: number;

  constructor(
    private readonly pdf: PDFDocument,
    private readonly fonts: Fonts,
    private readonly width = 595.28,
    private readonly height = 841.89,
  ) {
    this.page = pdf.addPage([width, height]);
    this.y = height - MARGIN;
  }

  private room(needed: number): void {
    if (this.y - needed >= MARGIN) return;
    this.page = this.pdf.addPage([this.width, this.height]);
    this.y = this.height - MARGIN;
  }

  gap(amount = 8): void {
    this.y -= amount;
  }

  rule(): void {
    this.room(10);
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: this.width - MARGIN, y: this.y },
      thickness: 0.75,
      color: RULE,
    });
    this.y -= 10;
  }

  text(
    value: string,
    options: { size?: number; font?: PDFFont; color?: RGB; indent?: number } = {},
  ): void {
    const size = options.size ?? BODY_SIZE;
    const font = options.font ?? this.fonts.body;
    const indent = options.indent ?? 0;
    const width = this.width - MARGIN * 2 - indent;

    for (const line of wrap(value, font, size, width)) {
      this.room(size + 3);
      this.page.drawText(line, {
        x: MARGIN + indent,
        y: this.y,
        size,
        font,
        color: options.color ?? INK,
      });
      this.y -= size + 3;
    }
  }

  heading(value: string): void {
    this.room(28);
    this.gap(6);
    this.text(value, { size: 11, font: this.fonts.bold });
    this.gap(2);
  }
}

function criterionBlock(report: Report, criterion: EnforcedCriterion, fonts: Fonts): void {
  const colour = COLOURS[
    criterion.awarded >= criterion.maxMarks
      ? "green"
      : criterion.findingType === "missing" || criterion.findingType === "partial"
        ? "amber"
        : "red"
  ];

  report.gap(6);
  report.text(
    `${criterion.criterionId}   ${criterion.awarded} / ${criterion.maxMarks}   ${criterion.findingType.toUpperCase()}   confidence ${criterion.confidence.toFixed(2)}${criterion.adjusted ? "   ADJUSTED" : ""}`,
    { font: fonts.bold, size: 9.5, color: colour },
  );
  report.text(criterion.criterionText, { size: 8.5, color: MUTED, indent: 10 });

  if (criterion.evidence) {
    report.text(`"${criterion.evidence}"`, { size: 8.5, font: fonts.italic, indent: 10 });
  } else {
    report.text(
      criterion.evidenceStatus === "unverifiable"
        ? "No quote: the model quoted text that is not in the answer, and it was removed."
        : "No quote: nothing was written for this point, or the finding is about a drawing.",
      { size: 8.5, font: fonts.italic, color: MUTED, indent: 10 },
    );
  }

  report.text(criterion.feedback, { size: 9, indent: 10 });
  if (criterion.correction) {
    report.text(`Correction: ${criterion.correction}`, { size: 9, color: colour, indent: 10 });
  }
}

export async function buildAnnotatedPdf(stored: StoredResult, original: Uint8Array): Promise<Uint8Array> {
  // Loaded into a new document in memory. The file on disk is never opened for
  // writing; this returns fresh bytes for the caller to save elsewhere.
  const pdf = await PDFDocument.load(original);

  const fonts: Fonts = {
    body: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
  };

  const pages = pdf.getPages();
  const correctionFor = new Map(
    stored.result.criteria.filter((c) => c.correction).map((c) => [c.criterionId, c.correction!]),
  );
  const noted = new Set<string>();

  for (const annotation of stored.annotations) {
    const page = pages[annotation.page - 1];
    if (!page || !annotation.rect) continue;

    drawAnnotation(page, annotation, fonts);

    // One tag and one margin note per criterion, on its first box, so a quote
    // spanning three lines is not labelled three times.
    const key = annotation.criterionId ?? annotation.id;
    if (!noted.has(key)) {
      noted.add(key);
      drawTag(page, annotation, fonts);

      const correction = annotation.criterionId
        ? correctionFor.get(annotation.criterionId)
        : undefined;
      if (correction) drawMarginNote(page, annotation, correction, fonts);
    }
  }

  writeSummary(pdf, stored, fonts);
  return pdf.save();
}

function writeSummary(pdf: PDFDocument, stored: StoredResult, fonts: Fonts): void {
  const { result } = stored;
  const report = new Report(pdf, fonts);

  report.text("GradeSense - marked answer", { size: 15, font: fonts.bold });
  report.text(
    `${stored.document.filename}   ·   graded ${new Date(stored.createdAt).toISOString().slice(0, 16).replace("T", " ")}   ·   provider ${stored.provider}`,
    { size: 8.5, color: MUTED },
  );
  report.rule();

  report.text(`${result.total} / ${result.maxTotal}`, { size: 26, font: fonts.bold });
  report.text(
    `Confidence ${result.confidence.toFixed(2)}   ·   ${result.needsHumanReview ? "NEEDS HUMAN REVIEW" : "No review required"}`,
    { size: 10, font: fonts.bold, color: result.needsHumanReview ? COLOURS.amber : COLOURS.green },
  );

  for (const reason of result.reviewReasons) {
    report.text(`· ${reason}`, { size: 8.5, color: MUTED, indent: 8 });
  }

  if (result.overallNotes) {
    report.gap(4);
    report.text(result.overallNotes, { size: 9 });
  }

  if (result.adjustments.length > 0) {
    report.heading(`What the system corrected about itself (${result.adjustments.length})`);
    for (const line of result.adjustments) {
      report.text(`· ${line}`, { size: 8.5, indent: 8 });
    }
  }

  // Findings with no box. Leaving these out of the export would hide exactly
  // what the teacher most needs to know: that a finding exists which we could
  // not put anywhere on the page.
  const unplaced = stored.annotations.filter((a) => a.rect === null);
  if (unplaced.length > 0) {
    report.heading(`Findings that could not be placed on the page (${unplaced.length})`);
    report.text(
      "These findings are real. No position for them could be verified, so nothing was drawn rather than something drawn in the wrong place.",
      { size: 8.5, color: MUTED, indent: 8 },
    );
    report.gap(4);
    for (const annotation of unplaced) {
      report.text(`· ${annotation.criterionId ?? "note"}: ${annotation.comment}`, {
        size: 8.5,
        indent: 8,
      });
    }
  }

  report.heading("Criteria");
  for (const criterion of result.criteria) {
    criterionBlock(report, criterion, fonts);
  }
}
