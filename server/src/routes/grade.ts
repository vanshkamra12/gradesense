import { randomUUID } from "node:crypto";
import { Router } from "express";
import { buildAnnotations } from "../annotate/annotations.js";
import { saveGradeRun } from "../db.js";
import { gradeDocument } from "../grade/pipeline.js";
import { createProvider } from "../grade/provider.js";

export const gradeRouter = Router();

/**
 * Raw PDF bytes in the body rather than multipart, which keeps the upload path
 * to one dependency-free route. The browser posts the File object directly.
 */
gradeRouter.post("/api/grade", async (req, res) => {
  const bytes = req.body as Buffer;

  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) {
    res.status(400).json({ error: "send the PDF as the request body with Content-Type: application/pdf" });
    return;
  }
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
    res.status(400).json({ error: "that file is not a PDF" });
    return;
  }

  const filename = typeof req.query.filename === "string" ? req.query.filename : "upload.pdf";

  const outcome = await gradeDocument(new Uint8Array(bytes), createProvider());
  if (!outcome.ok) {
    // A failed grade persists nothing. There is no half-saved run.
    res.status(502).json({ error: outcome.error.message, code: outcome.error.code });
    return;
  }

  const resultId = randomUUID();
  const annotations = buildAnnotations(resultId, outcome.run.result, outcome.run.student);
  saveGradeRun({ resultId, run: outcome.run, annotations, filename, bytes: new Uint8Array(bytes) });

  res.status(201).json({ id: resultId });
});
