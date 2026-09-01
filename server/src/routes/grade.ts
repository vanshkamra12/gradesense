import { randomUUID } from "node:crypto";
import { Router } from "express";
import { buildAnnotations } from "../annotate/annotations.js";
import { documentLocation, readOriginal, saveGradeRun, saveSupportingDocument } from "../db.js";
import { gradeDocument } from "../grade/pipeline.js";
import { createProvider } from "../grade/provider.js";

export const gradeRouter = Router();

function pdfFromBody(body: unknown): Buffer | null {
  if (!Buffer.isBuffer(body) || body.byteLength === 0) return null;
  return body.subarray(0, 5).toString("latin1") === "%PDF-" ? body : null;
}

/**
 * Uploads one supporting document — a question paper or a marking scheme — and
 * returns its id. Kept separate from grading so the three files can be sent
 * independently without a multipart parser.
 */
gradeRouter.post("/api/documents", async (req, res) => {
  const bytes = pdfFromBody(req.body);
  if (!bytes) {
    res.status(400).json({ error: "send a PDF as the request body with Content-Type: application/pdf" });
    return;
  }

  const filename = typeof req.query.filename === "string" ? req.query.filename : "upload.pdf";
  const id = await saveSupportingDocument(new Uint8Array(bytes), filename);
  res.status(201).json({ id, filename });
});

/**
 * Grades a student answer. The body is the student's PDF; the optional
 * questionPaper and modelAnswer query parameters are ids returned by
 * /api/documents. When either is absent the bundled fixture is used.
 */
gradeRouter.post("/api/grade", async (req, res) => {
  const bytes = pdfFromBody(req.body);
  if (!bytes) {
    res.status(400).json({ error: "send the student answer as the request body with Content-Type: application/pdf" });
    return;
  }

  const filename = typeof req.query.filename === "string" ? req.query.filename : "upload.pdf";
  const questionPaperId = typeof req.query.questionPaper === "string" ? req.query.questionPaper : null;
  const modelAnswerId = typeof req.query.modelAnswer === "string" ? req.query.modelAnswer : null;

  const supporting = (id: string | null, label: string) => {
    if (!id) return { bytes: undefined as Uint8Array | undefined, error: null as string | null };
    try {
      const { documentPath } = documentLocation(id);
      return { bytes: new Uint8Array(readOriginal(documentPath)), error: null };
    } catch {
      return { bytes: undefined, error: `the uploaded ${label} could not be found (id ${id})` };
    }
  };

  const paper = supporting(questionPaperId, "question paper");
  const scheme = supporting(modelAnswerId, "marking scheme");
  if (paper.error || scheme.error) {
    res.status(400).json({ error: paper.error ?? scheme.error });
    return;
  }

  const outcome = await gradeDocument(
    { student: new Uint8Array(bytes), questionPaper: paper.bytes, modelAnswer: scheme.bytes },
    createProvider(),
  );

  if (!outcome.ok) {
    // A failed grade persists nothing. There is no half-saved run.
    res.status(outcome.error.code === "provider_failed" ? 502 : 400).json({
      error: outcome.error.message,
      code: outcome.error.code,
    });
    return;
  }

  const resultId = randomUUID();
  const annotations = buildAnnotations(resultId, outcome.run.result, outcome.run.student);
  saveGradeRun({
    resultId,
    run: outcome.run,
    annotations,
    filename,
    bytes: new Uint8Array(bytes),
    questionPaperId,
    modelAnswerId,
  });

  res.status(201).json({ id: resultId });
});
