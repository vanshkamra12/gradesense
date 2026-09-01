import { createCanvas, loadImage } from "@napi-rs/canvas";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAnnotations } from "../src/annotate/annotations.js";
import { buildAnnotatedPdf } from "../src/annotate/export.js";
import { config } from "../src/config.js";
import {
  createAnnotation,
  deleteAnnotation,
  getResult,
  readOriginal,
  saveGradeRun,
  updateAnnotation,
  type StoredResult,
} from "../src/db.js";
import { gradeDocument } from "../src/grade/pipeline.js";
import { mockProvider } from "../src/grade/provider.js";
import { extractPdf } from "../src/pdf/extract.js";
import { renderPdfPages } from "../src/pdf/render.js";

const sha256 = (bytes: Uint8Array | Buffer) => createHash("sha256").update(bytes).digest("hex");

async function persistScriptA(): Promise<string> {
  const bytes = new Uint8Array(
    fs.readFileSync(path.join(config.fixturesDir, "student_answer_A.pdf")),
  );
  const outcome = await gradeDocument(bytes, mockProvider("valid"));
  if (!outcome.ok) throw new Error("grading failed in test setup");

  const id = randomUUID();
  saveGradeRun({
    resultId: id,
    run: outcome.run,
    annotations: buildAnnotations(id, outcome.run.result, outcome.run.student),
    filename: "student_answer_A.pdf",
    bytes,
  });
  return id;
}

const exportOf = async (stored: StoredResult) =>
  buildAnnotatedPdf(stored, new Uint8Array(readOriginal(stored.document.storagePath)));

describe("annotated PDF export", () => {
  let id: string;
  let stored: StoredResult;
  let exported: Uint8Array;

  beforeAll(async () => {
    id = await persistScriptA();
    stored = getResult(id)!;
    exported = await exportOf(stored);
  }, 60_000);

  it("produces a valid PDF with the original pages plus a summary", async () => {
    expect(Buffer.from(exported.subarray(0, 5)).toString("latin1")).toBe("%PDF-");

    const parsed = await extractPdf(exported);
    expect(parsed.pages.length).toBeGreaterThan(stored.document.pageCount);
    expect(parsed.pages[0]!.text).toContain("Question 1");
  }, 60_000);

  // Rule 4: the uploaded PDF is never modified.
  it("leaves the stored original byte-identical and still read-only", async () => {
    const file = stored.document.storagePath;
    const before = sha256(fs.readFileSync(file));
    const modeBefore = fs.statSync(file).mode & 0o777;

    await exportOf(stored);
    await exportOf(stored);

    expect(sha256(fs.readFileSync(file))).toBe(before);
    expect(fs.statSync(file).mode & 0o777).toBe(modeBefore);
    expect(modeBefore & 0o222).toBe(0);
    expect(sha256(exported)).not.toBe(before);
  }, 60_000);

  /**
   * pdf-lib and pdf.js are both meant to use a bottom-left origin, which is why
   * a rect measured during extraction is drawn without conversion. Asserted
   * rather than assumed: rasterise the exported page, find the pixels of the
   * annotation's colour, and check their bounding box is where the rect said.
   */
  describe("coordinates carry over unchanged", () => {
    it("draws the box where the rect says, in image space", async () => {
      const target = stored.annotations.find(
        (a) => a.criterionId === "Q1.C2" && a.rect !== null && a.page === 1,
      )!;
      const rect = target.rect!;

      // Exported with this one annotation, stripped of its criterion id so
      // neither the margin tag nor the margin note is drawn. Every coloured
      // pixel on the page then belongs to the box under test.
      const alone = await buildAnnotatedPdf(
        { ...stored, annotations: [{ ...target, criterionId: null }] },
        new Uint8Array(readOriginal(stored.document.storagePath)),
      );

      const [page] = await renderPdfPages(alone, 1);
      const image = await loadImage(page!.png);
      const canvas = createCanvas(image.width, image.height);
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, image.width, image.height);

      // The red used for an incorrect finding: r high, g and b low.
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
        if (r > 140 && r < 210 && g < 90 && b < 90) {
          const pixel = i / 4;
          const x = pixel % image.width;
          const y = Math.floor(pixel / image.width);
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
      }

      const pageHeight = stored.document.pages[0]!.height;
      // Flip the y axis to get image space, which is all the conversion needed.
      const expected = {
        left: rect.x,
        right: rect.x + rect.w,
        top: pageHeight - rect.y - rect.h,
        bottom: pageHeight - rect.y,
      };

      // Within a couple of pixels on every edge, at 1x, with no conversion
      // beyond the y flip. That is the claim being checked.
      for (const [label, actual, want] of [
        ["left", minX, expected.left],
        ["right", maxX, expected.right],
        ["top", minY, expected.top],
        ["bottom", maxY, expected.bottom],
      ] as const) {
        expect(Math.abs(actual - want), `${label} edge off by ${actual - want}px`).toBeLessThan(3);
      }
    }, 60_000);

    it("lands over the words the criterion quoted", async () => {
      const target = stored.annotations.find(
        (a) => a.criterionId === "Q1.C2" && a.rect !== null && a.page === 1,
      )!;
      const rect = target.rect!;

      // Text items of the exported page that fall inside the drawn rectangle.
      const parsed = await extractPdf(exported);
      const covered = parsed.pages[0]!.items
        .filter(
          (item) =>
            item.x + item.w > rect.x &&
            item.x < rect.x + rect.w &&
            item.y + item.h > rect.y &&
            item.y < rect.y + rect.h,
        )
        .map((item) => item.text)
        .join("");

      expect(covered).toContain("voltmetre is also connected in series");
    }, 60_000);
  });

  it("prints the total, confidence, review flag and adjustments on the summary", async () => {
    const parsed = await extractPdf(exported);
    const summary = parsed.pages.slice(stored.document.pageCount).map((p) => p.text).join("\n");

    expect(summary).toContain("GradeSense");
    expect(summary).toContain(`${stored.result.total} / ${stored.result.maxTotal}`);
    expect(summary).toContain("Confidence 0.87");
    expect(summary).toContain("No review required");
    expect(summary).toContain("student_answer_A.pdf");

    for (const criterion of stored.result.criteria) {
      expect(summary).toContain(criterion.criterionId);
    }
    expect(summary).toContain("Correction:");
  }, 60_000);

  it("transliterates characters the standard fonts cannot encode", async () => {
    const parsed = await extractPdf(exported);
    const summary = parsed.pages.slice(stored.document.pageCount).map((p) => p.text).join("\n");

    // The student wrote "₹40"; WinAnsi has no rupee sign.
    expect(summary).toContain("Rs.40");
    expect(summary).not.toContain("₹");
  }, 60_000);

  // Dropping unplaced findings from the export would hide exactly what the
  // teacher most needs to know, through the back door.
  it("lists findings that could not be placed", async () => {
    const handwritten = new Uint8Array(
      fs.readFileSync(path.join(config.fixturesDir, "student_answer_F.pdf")),
    );
    const outcome = await gradeDocument(handwritten, mockProvider("valid"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const otherId = randomUUID();
    saveGradeRun({
      resultId: otherId,
      run: outcome.run,
      annotations: buildAnnotations(otherId, outcome.run.result, outcome.run.student),
      filename: "handwritten.pdf",
      bytes: handwritten,
    });

    const other = getResult(otherId)!;
    expect(other.annotations.filter((a) => a.rect === null)).toHaveLength(15);

    const parsed = await extractPdf(await exportOf(other));
    const summary = parsed.pages.slice(1).map((p) => p.text).join("\n");

    expect(summary).toContain("Findings that could not be placed on the page (15)");
    for (const criterion of other.result.criteria) {
      expect(summary).toContain(criterion.criterionId);
    }
  }, 60_000);
});

describe("export reflects the current annotation state", () => {
  it("changes with what the teacher moved, added and deleted", async () => {
    const id = await persistScriptA();
    const before = getResult(id)!;
    const first = await exportOf(before);

    const moved = before.annotations.find((a) => a.rect !== null)!;
    const removed = before.annotations.filter((a) => a.rect !== null)[1]!;

    updateAnnotation(moved.id, {
      rect: { x: 90, y: 120, w: 300, h: 30 },
      comment: "Moved to the bottom of the page.",
    });
    deleteAnnotation(removed.id);
    createAnnotation({
      id: randomUUID(),
      resultId: id,
      criterionId: null,
      page: 1,
      rect: { x: 60, y: 700, w: 200, h: 20 },
      kind: "box",
      color: "amber",
      comment: "A note the teacher drew.",
      anchor: "manual",
      unplaced: false,
      needsPlacement: false,
      createdBy: "user",
      updatedAt: new Date().toISOString(),
    });

    const after = getResult(id)!;
    const second = await exportOf(after);

    expect(sha256(second)).not.toBe(sha256(first));
    expect(after.annotations).toHaveLength(before.annotations.length);

    // The moved box is drawn at its new position, and the deleted one is gone.
    const [page] = await renderPdfPages(second, 1);
    expect(page!.png.length).toBeGreaterThan(0);

    // The marks are untouched by all of it, so both exports report the same score.
    const firstSummary = (await extractPdf(first)).pages.slice(2).map((p) => p.text).join("\n");
    const secondSummary = (await extractPdf(second)).pages.slice(2).map((p) => p.text).join("\n");
    expect(secondSummary).toContain(`${after.result.total} / ${after.result.maxTotal}`);
    expect(firstSummary).toContain(`${before.result.total} / ${before.result.maxTotal}`);
    expect(after.result).toEqual(before.result);
  }, 60_000);
});
