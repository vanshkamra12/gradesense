import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAnnotations, type Annotation } from "../src/annotate/annotations.js";
import { config } from "../src/config.js";
import {
  createAnnotation,
  db,
  deleteAnnotation,
  getResult,
  listAnnotations,
  listHistory,
  readOriginal,
  saveGradeRun,
  storeOriginal,
  updateAnnotation,
} from "../src/db.js";
import { gradeDocument, type GradeRun } from "../src/grade/pipeline.js";
import { mockProvider } from "../src/grade/provider.js";

const fixture = (name: string) =>
  new Uint8Array(fs.readFileSync(path.join(config.fixturesDir, name)));

/** Grades Script A with the mock and persists it. Returns the new result id. */
async function persistRun(mode: "valid" | "overmax" = "valid"): Promise<{ id: string; run: GradeRun }> {
  const bytes = fixture("student_answer_A.pdf");
  const outcome = await gradeDocument(bytes, mockProvider(mode));
  if (!outcome.ok) throw new Error("grading failed in test setup");

  const id = randomUUID();
  const annotations = buildAnnotations(id, outcome.run.result, outcome.run.student);
  saveGradeRun({ resultId: id, run: outcome.run, annotations, filename: "student_answer_A.pdf", bytes });
  return { id, run: outcome.run };
}

describe("storeOriginal", () => {
  it("writes the upload under the hash of its bytes and leaves it read-only", () => {
    const bytes = fixture("student_answer_D.pdf");
    const stored = storeOriginal(bytes);

    expect(stored.id).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(stored.storagePath)).toBe(true);

    // Read-only on disk: the uploaded PDF is never modified, and export writes
    // a new file elsewhere.
    const mode = fs.statSync(stored.storagePath).mode & 0o777;
    expect(mode & 0o222).toBe(0);
    expect(Buffer.from(readOriginal(stored.storagePath))).toEqual(Buffer.from(bytes));
  });

  it("is content-addressed, so the same file twice is one stored copy", () => {
    const bytes = fixture("student_answer_D.pdf");
    const first = storeOriginal(bytes);
    const mtime = fs.statSync(first.storagePath).mtimeMs;

    const second = storeOriginal(bytes);

    expect(second.id).toBe(first.id);
    expect(second.storagePath).toBe(first.storagePath);
    expect(fs.statSync(second.storagePath).mtimeMs).toBe(mtime);
  });
});

describe("saveGradeRun and getResult", () => {
  let id: string;
  let run: GradeRun;

  beforeAll(async () => {
    ({ id, run } = await persistRun());
  }, 30_000);

  it("round-trips the marks unchanged", () => {
    const stored = getResult(id)!;

    expect(stored.result.total).toBe(run.result.total);
    expect(stored.result.maxTotal).toBe(15);
    expect(stored.result.confidence).toBe(run.result.confidence);
    expect(stored.result.needsHumanReview).toBe(run.result.needsHumanReview);
    expect(stored.result.criteria).toEqual(run.result.criteria);
  });

  it("keeps the adjustments and review reasons", async () => {
    const { id: flagged } = await persistRun("overmax");
    const stored = getResult(flagged)!;

    expect(stored.result.adjustments.length).toBeGreaterThan(0);
    expect(stored.result.reviewReasons.length).toBeGreaterThan(0);
    expect(stored.result.adjustments.some((a) => a.includes("clamped to 1"))).toBe(true);
  }, 30_000);

  // A reopened grading has to be able to draw its overlay without the PDF being
  // parsed again, so the page geometry travels with the result.
  it("stores the page dimensions and extracted text alongside the result", () => {
    const stored = getResult(id)!;

    expect(stored.document.pageCount).toBe(2);
    expect(stored.document.pages).toHaveLength(2);
    for (const page of stored.document.pages) {
      expect(page.width).toBeCloseTo(596, 0);
      expect(page.height).toBeCloseTo(842, 0);
      expect(page.items.length).toBeGreaterThan(0);
    }
    expect(stored.document.text).toContain("voltmetre");
  });

  it("returns null for an unknown id", () => {
    expect(getResult(randomUUID())).toBeNull();
  });
});

describe("listHistory", () => {
  it("lists persisted runs with their scores and annotation counts", async () => {
    const { id } = await persistRun();
    const entry = listHistory().find((row) => row.id === id)!;

    expect(entry).toBeDefined();
    expect(entry.filename).toBe("student_answer_A.pdf");
    expect(entry.maxTotal).toBe(15);
    expect(entry.provider).toBe("mock:valid");
    expect(entry.annotationCount).toBeGreaterThan(0);
  }, 30_000);
});

describe("annotations are independent of the grading result", () => {
  it("has no foreign key from annotations to criterion_results", () => {
    const keys = db().pragma("foreign_key_list(annotations)") as { table: string }[];
    expect(keys.map((k) => k.table)).toEqual(["results"]);
    expect(keys.map((k) => k.table)).not.toContain("criterion_results");
  });

  it("stores every located criterion as an annotation", async () => {
    const { id } = await persistRun();
    const annotations = listAnnotations(id);

    expect(annotations.length).toBeGreaterThanOrEqual(15);
    for (const annotation of annotations) {
      expect(annotation.resultId).toBe(id);
      expect(annotation.createdBy).toBe("system");
      expect([1, 2]).toContain(annotation.page);
    }
  }, 30_000);
});

// The requirement this whole table split exists for.
describe("a reopened result stays fully editable, and editing never re-grades", () => {
  it("survives move, reopen, and reopen again with the marks untouched", async () => {
    const { id } = await persistRun();

    const before = getResult(id)!;
    const target = before.annotations.find((a) => a.rect !== null)!;
    const originalRect = { ...target.rect! };
    const marksBefore = before.result.criteria.map((c) => c.awarded);

    // Reopen, then move the annotation.
    const reopened = getResult(id)!;
    const toMove = reopened.annotations.find((a) => a.id === target.id)!;
    const moved = updateAnnotation(toMove.id, {
      rect: { x: 100, y: 200, w: 300, h: 20 },
      comment: "Moved by the teacher.",
    })!;

    expect(moved.rect).toEqual({ x: 100, y: 200, w: 300, h: 20 });
    expect(moved.anchor).toBe("manual");
    expect(moved.updatedAt >= toMove.updatedAt).toBe(true);

    // Reopen again: the move survived and nothing about the marking moved with it.
    const after = getResult(id)!;
    const persisted = after.annotations.find((a) => a.id === target.id)!;

    expect(persisted.rect).toEqual({ x: 100, y: 200, w: 300, h: 20 });
    expect(persisted.rect).not.toEqual(originalRect);
    expect(persisted.comment).toBe("Moved by the teacher.");

    expect(after.result.criteria.map((c) => c.awarded)).toEqual(marksBefore);
    expect(after.result.total).toBe(before.result.total);
    expect(after.result.confidence).toBe(before.result.confidence);
    expect(after.result.adjustments).toEqual(before.result.adjustments);
    expect(after.result.criteria).toEqual(before.result.criteria);
  }, 30_000);

  it("adds and deletes annotations without touching the marks", async () => {
    const { id } = await persistRun();
    const before = getResult(id)!;

    const added = createAnnotation({
      id: randomUUID(),
      resultId: id,
      criterionId: null,
      page: 1,
      rect: { x: 10, y: 20, w: 30, h: 40 },
      kind: "box",
      color: "amber",
      comment: "A note the teacher added.",
      anchor: "manual",
      unplaced: false,
      needsPlacement: false,
      createdBy: "user",
      updatedAt: new Date().toISOString(),
    } satisfies Annotation);

    expect(listAnnotations(id)).toHaveLength(before.annotations.length + 1);

    expect(deleteAnnotation(added.id)).toBe(true);
    expect(deleteAnnotation(added.id)).toBe(false);

    const after = getResult(id)!;
    expect(after.annotations).toHaveLength(before.annotations.length);
    expect(after.result.criteria).toEqual(before.result.criteria);
    expect(after.result.total).toBe(before.result.total);
  }, 30_000);

  it("clearing a rect marks the annotation unplaced rather than deleting it", async () => {
    const { id } = await persistRun();
    const target = getResult(id)!.annotations.find((a) => a.rect !== null)!;

    const cleared = updateAnnotation(target.id, { rect: null })!;

    expect(cleared.rect).toBeNull();
    expect(cleared.unplaced).toBe(true);
    expect(listAnnotations(id).some((a) => a.id === target.id)).toBe(true);
  }, 30_000);

  it("returns null when patching an annotation that does not exist", () => {
    expect(updateAnnotation(randomUUID(), { comment: "nope" })).toBeNull();
  });
});
