import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Annotation } from "./annotate/annotations.js";
import { config } from "./config.js";
import type { EnforcedCriterion, EnforcedResult } from "./grade/enforce.js";
import type { GradeRun } from "./grade/pipeline.js";
import type { ExtractedDocument } from "./pdf/extract.js";

/**
 * Schema note: `annotations` references `results`, never `criterion_results`.
 * There is deliberately no path by which writing a grading result can rewrite
 * annotations - a teacher's edits are theirs, and re-grading produces a new
 * result rather than mutating an old one's boxes. `criterion_id` is plain text
 * with no foreign key for the same reason.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  id           TEXT PRIMARY KEY,       -- sha256 of the file bytes
  filename     TEXT NOT NULL,
  byte_size    INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  page_count   INTEGER NOT NULL,
  pages_json   TEXT NOT NULL,          -- per-page width/height/text/items/images
  text         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS results (
  id                 TEXT PRIMARY KEY,
  document_id        TEXT NOT NULL REFERENCES documents(id),
  question_paper_id  TEXT REFERENCES documents(id),
  model_answer_id    TEXT REFERENCES documents(id),
  provider           TEXT NOT NULL,
  provider_called    INTEGER NOT NULL,
  repaired           INTEGER NOT NULL,
  assessment_json    TEXT NOT NULL,
  total              INTEGER NOT NULL,
  max_total          INTEGER NOT NULL,
  confidence         REAL NOT NULL,
  needs_human_review INTEGER NOT NULL,
  review_reasons_json TEXT NOT NULL,
  adjustments_json   TEXT NOT NULL,
  overall_notes      TEXT,
  created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS criterion_results (
  id              TEXT PRIMARY KEY,
  result_id       TEXT NOT NULL REFERENCES results(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  criterion_id    TEXT NOT NULL,
  question_id     TEXT NOT NULL,
  criterion_text  TEXT NOT NULL,
  awarded         INTEGER NOT NULL,
  max_marks       INTEGER NOT NULL,
  finding_type    TEXT NOT NULL,
  evidence        TEXT,
  page            INTEGER,
  feedback        TEXT NOT NULL,
  correction      TEXT,
  confidence      REAL NOT NULL,
  reasoning       TEXT NOT NULL,
  adjusted        INTEGER NOT NULL,
  evidence_status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS annotations (
  id             TEXT PRIMARY KEY,
  result_id      TEXT NOT NULL REFERENCES results(id) ON DELETE CASCADE,
  criterion_id   TEXT,
  page           INTEGER NOT NULL,
  rect_json      TEXT,
  kind           TEXT NOT NULL,
  color          TEXT NOT NULL,
  comment        TEXT NOT NULL,
  anchor         TEXT NOT NULL,
  unplaced       INTEGER NOT NULL,
  needs_placement INTEGER NOT NULL,
  created_by     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_results_document ON results(document_id);
CREATE INDEX IF NOT EXISTS idx_criterion_results_result ON criterion_results(result_id);
CREATE INDEX IF NOT EXISTS idx_annotations_result ON annotations(result_id);
`;

export type StoredDocument = {
  id: string;
  filename: string;
  byteSize: number;
  storagePath: string;
  pageCount: number;
  /** Everything the frontend needs to re-render without re-extracting. */
  pages: ExtractedDocument["pages"];
  text: string;
  createdAt: string;
};

/** Just enough about a supporting document to say what a run was marked against. */
export type DocumentSummary = { id: string; filename: string; source: "uploaded" | "bundled" };

export type StoredResult = {
  id: string;
  document: StoredDocument;
  questionPaper: DocumentSummary | null;
  modelAnswer: DocumentSummary | null;
  provider: string;
  providerCalled: boolean;
  repaired: boolean;
  assessment: unknown;
  result: EnforcedResult;
  annotations: Annotation[];
  createdAt: string;
};

export type HistoryEntry = {
  id: string;
  filename: string;
  total: number;
  maxTotal: number;
  confidence: number;
  needsHumanReview: boolean;
  provider: string;
  annotationCount: number;
  createdAt: string;
};

let database: Database.Database | null = null;

export function db(): Database.Database {
  if (database) return database;

  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  database = new Database(config.dbPath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA);

  // Columns added after the first schema shipped. A database created before
  // them is upgraded in place rather than discarded.
  const columns = (database.pragma("table_info(results)") as { name: string }[]).map((c) => c.name);
  for (const column of ["question_paper_id", "model_answer_id"]) {
    if (!columns.includes(column)) {
      database.exec(`ALTER TABLE results ADD COLUMN ${column} TEXT REFERENCES documents(id)`);
    }
  }

  return database;
}

/** Test helper: point the module at a different file, or close it. */
export function closeDatabase(): void {
  database?.close();
  database = null;
}

/**
 * Writes the upload under the hash of its own bytes and makes it read-only.
 * The same file uploaded twice lands on the same path and is not rewritten, so
 * an original can never be modified by a later run - export always produces a
 * new file elsewhere.
 */
export function storeOriginal(bytes: Uint8Array): { id: string; storagePath: string } {
  const id = createHash("sha256").update(bytes).digest("hex");
  const dir = path.join(config.storageDir, "originals");
  fs.mkdirSync(dir, { recursive: true });

  const storagePath = path.join(dir, `${id}.pdf`);
  if (!fs.existsSync(storagePath)) {
    fs.writeFileSync(storagePath, bytes, { mode: 0o444 });
  }
  return { id, storagePath };
}

/** Where a stored document's bytes live, by document id. */
export function documentLocation(id: string): { documentPath: string; filename: string } {
  const row = db().prepare(`SELECT storage_path, filename FROM documents WHERE id = ?`).get(id) as
    | { storage_path: string; filename: string }
    | undefined;
  if (!row) throw new Error(`no such document: ${id}`);
  return { documentPath: row.storage_path, filename: row.filename };
}

export function readOriginal(storagePath: string): Buffer {
  return fs.readFileSync(storagePath);
}

function rowToCriterion(row: Record<string, unknown>): EnforcedCriterion {
  return {
    criterionId: row.criterion_id as string,
    questionId: row.question_id as string,
    criterionText: row.criterion_text as string,
    awarded: row.awarded as number,
    maxMarks: row.max_marks as number,
    findingType: row.finding_type as EnforcedCriterion["findingType"],
    evidence: (row.evidence as string | null) ?? null,
    page: (row.page as number | null) ?? null,
    feedback: row.feedback as string,
    correction: (row.correction as string | null) ?? null,
    confidence: row.confidence as number,
    reasoning: row.reasoning as string,
    adjusted: Boolean(row.adjusted),
    evidenceStatus: row.evidence_status as EnforcedCriterion["evidenceStatus"],
  };
}

function rowToAnnotation(row: Record<string, unknown>): Annotation {
  return {
    id: row.id as string,
    resultId: row.result_id as string,
    criterionId: (row.criterion_id as string | null) ?? null,
    page: row.page as number,
    rect: row.rect_json ? JSON.parse(row.rect_json as string) : null,
    kind: row.kind as Annotation["kind"],
    color: row.color as Annotation["color"],
    comment: row.comment as string,
    anchor: row.anchor as Annotation["anchor"],
    unplaced: Boolean(row.unplaced),
    needsPlacement: Boolean(row.needs_placement),
    createdBy: row.created_by as Annotation["createdBy"],
    updatedAt: row.updated_at as string,
  };
}

/** Stores a supporting document (question paper or marking scheme) and returns its id. */
async function storeSupporting(
  bytes: Uint8Array,
  filename: string,
  now: string,
): Promise<string> {
  const { extractPdf } = await import("./pdf/extract.js");
  const { id, storagePath } = storeOriginal(bytes);
  const extracted = await extractPdf(bytes);

  db()
    .prepare(
      `INSERT OR IGNORE INTO documents
         (id, filename, byte_size, storage_path, page_count, pages_json, text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, filename, bytes.byteLength, storagePath, extracted.pages.length,
      JSON.stringify(extracted.pages), extracted.text, now);

  return id;
}

export async function saveSupportingDocument(
  bytes: Uint8Array,
  filename: string,
): Promise<string> {
  return storeSupporting(bytes, filename, new Date().toISOString());
}

export function saveGradeRun(input: {
  resultId: string;
  run: GradeRun;
  annotations: Annotation[];
  filename: string;
  bytes: Uint8Array;
  /** Ids of the question paper and marking scheme this run was marked against. */
  questionPaperId?: string | null;
  modelAnswerId?: string | null;
}): string {
  const { resultId, run, annotations, filename, bytes } = input;
  const { id: documentId, storagePath } = storeOriginal(bytes);
  const now = new Date().toISOString();
  const handle = db();

  const write = handle.transaction(() => {
    handle
      .prepare(
        `INSERT OR IGNORE INTO documents
           (id, filename, byte_size, storage_path, page_count, pages_json, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        documentId,
        filename,
        bytes.byteLength,
        storagePath,
        run.student.pages.length,
        JSON.stringify(run.student.pages),
        run.student.text,
        now,
      );

    handle
      .prepare(
        `INSERT INTO results
           (id, document_id, question_paper_id, model_answer_id, provider, provider_called,
            repaired, assessment_json, total, max_total, confidence, needs_human_review,
            review_reasons_json, adjustments_json, overall_notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        resultId,
        documentId,
        input.questionPaperId ?? null,
        input.modelAnswerId ?? null,
        run.provider,
        run.providerCalled ? 1 : 0,
        run.repaired ? 1 : 0,
        JSON.stringify(run.assessment),
        run.result.total,
        run.result.maxTotal,
        run.result.confidence,
        run.result.needsHumanReview ? 1 : 0,
        JSON.stringify(run.result.reviewReasons),
        JSON.stringify(run.result.adjustments),
        run.result.overallNotes,
        now,
      );

    const criterion = handle.prepare(
      `INSERT INTO criterion_results
         (id, result_id, position, criterion_id, question_id, criterion_text, awarded, max_marks,
          finding_type, evidence, page, feedback, correction, confidence, reasoning, adjusted,
          evidence_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    run.result.criteria.forEach((c, position) => {
      criterion.run(
        `${resultId}:${c.criterionId}`,
        resultId,
        position,
        c.criterionId,
        c.questionId,
        c.criterionText,
        c.awarded,
        c.maxMarks,
        c.findingType,
        c.evidence,
        c.page,
        c.feedback,
        c.correction,
        c.confidence,
        c.reasoning,
        c.adjusted ? 1 : 0,
        c.evidenceStatus,
      );
    });

    for (const annotation of annotations) insertAnnotationRow(annotation);
  });

  write();
  return resultId;
}

function insertAnnotationRow(annotation: Annotation): void {
  db()
    .prepare(
      `INSERT INTO annotations
         (id, result_id, criterion_id, page, rect_json, kind, color, comment, anchor, unplaced,
          needs_placement, created_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      annotation.id,
      annotation.resultId,
      annotation.criterionId,
      annotation.page,
      annotation.rect ? JSON.stringify(annotation.rect) : null,
      annotation.kind,
      annotation.color,
      annotation.comment,
      annotation.anchor,
      annotation.unplaced ? 1 : 0,
      annotation.needsPlacement ? 1 : 0,
      annotation.createdBy,
      annotation.updatedAt,
    );
}

export function getResult(resultId: string): StoredResult | null {
  const handle = db();

  const result = handle
    .prepare(`SELECT * FROM results WHERE id = ?`)
    .get(resultId) as Record<string, unknown> | undefined;
  if (!result) return null;

  const document = handle
    .prepare(`SELECT * FROM documents WHERE id = ?`)
    .get(result.document_id) as Record<string, unknown>;

  const criteria = handle
    .prepare(`SELECT * FROM criterion_results WHERE result_id = ? ORDER BY position`)
    .all(resultId) as Record<string, unknown>[];

  const summary = (id: unknown, source: "uploaded" | "bundled"): DocumentSummary | null => {
    if (typeof id !== "string") return null;
    const row = handle.prepare(`SELECT id, filename FROM documents WHERE id = ?`).get(id) as
      | { id: string; filename: string }
      | undefined;
    return row ? { id: row.id, filename: row.filename, source } : null;
  };

  const assessment = JSON.parse(result.assessment_json as string);

  return {
    id: resultId,
    createdAt: result.created_at as string,
    questionPaper: summary(result.question_paper_id, "uploaded"),
    modelAnswer: summary(result.model_answer_id, "uploaded"),
    provider: result.provider as string,
    providerCalled: Boolean(result.provider_called),
    repaired: Boolean(result.repaired),
    assessment: JSON.parse(result.assessment_json as string),
    document: {
      id: document.id as string,
      filename: document.filename as string,
      byteSize: document.byte_size as number,
      storagePath: document.storage_path as string,
      pageCount: document.page_count as number,
      pages: JSON.parse(document.pages_json as string),
      text: document.text as string,
      createdAt: document.created_at as string,
    },
    result: {
      criteria: criteria.map(rowToCriterion),
      total: result.total as number,
      maxTotal: result.max_total as number,
      confidence: result.confidence as number,
      needsHumanReview: Boolean(result.needs_human_review),
      reviewReasons: JSON.parse(result.review_reasons_json as string),
      adjustments: JSON.parse(result.adjustments_json as string),
      overallNotes: (result.overall_notes as string | null) ?? null,
    },
    annotations: listAnnotations(resultId),
  };
}

export function listHistory(limit = 50): HistoryEntry[] {
  return (
    db()
      .prepare(
        `SELECT r.id, r.total, r.max_total, r.confidence, r.needs_human_review, r.provider,
                r.created_at, d.filename,
                (SELECT COUNT(*) FROM annotations a WHERE a.result_id = r.id) AS annotation_count
           FROM results r
           JOIN documents d ON d.id = r.document_id
          ORDER BY r.created_at DESC, r.rowid DESC
          LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[]
  ).map((row) => ({
    id: row.id as string,
    filename: row.filename as string,
    total: row.total as number,
    maxTotal: row.max_total as number,
    confidence: row.confidence as number,
    needsHumanReview: Boolean(row.needs_human_review),
    provider: row.provider as string,
    annotationCount: row.annotation_count as number,
    createdAt: row.created_at as string,
  }));
}

// --- Annotation CRUD -------------------------------------------------------
// These are the only functions that write the annotations table after a run is
// saved. None of them touch results or criterion_results, so editing a box can
// never change a mark.

export function listAnnotations(resultId: string): Annotation[] {
  return (
    db()
      .prepare(`SELECT * FROM annotations WHERE result_id = ? ORDER BY page, rowid`)
      .all(resultId) as Record<string, unknown>[]
  ).map(rowToAnnotation);
}

export function getAnnotation(id: string): Annotation | null {
  const row = db().prepare(`SELECT * FROM annotations WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToAnnotation(row) : null;
}

export function createAnnotation(annotation: Annotation): Annotation {
  insertAnnotationRow(annotation);
  return annotation;
}

export type AnnotationPatch = Partial<
  Pick<Annotation, "page" | "rect" | "kind" | "color" | "comment" | "anchor" | "unplaced" | "needsPlacement">
>;

export function updateAnnotation(id: string, patch: AnnotationPatch): Annotation | null {
  const existing = getAnnotation(id);
  if (!existing) return null;

  const next: Annotation = {
    ...existing,
    ...patch,
    // Moving or resizing a system-placed box makes its position the teacher's.
    anchor: patch.rect !== undefined && patch.anchor === undefined ? "manual" : (patch.anchor ?? existing.anchor),
    unplaced: patch.rect === undefined ? (patch.unplaced ?? existing.unplaced) : patch.rect === null,
    needsPlacement: patch.rect !== undefined ? false : (patch.needsPlacement ?? existing.needsPlacement),
    updatedAt: new Date().toISOString(),
  };

  db()
    .prepare(
      `UPDATE annotations
          SET page = ?, rect_json = ?, kind = ?, color = ?, comment = ?, anchor = ?,
              unplaced = ?, needs_placement = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(
      next.page,
      next.rect ? JSON.stringify(next.rect) : null,
      next.kind,
      next.color,
      next.comment,
      next.anchor,
      next.unplaced ? 1 : 0,
      next.needsPlacement ? 1 : 0,
      next.updatedAt,
      id,
    );

  return next;
}

export function deleteAnnotation(id: string): boolean {
  return db().prepare(`DELETE FROM annotations WHERE id = ?`).run(id).changes > 0;
}
