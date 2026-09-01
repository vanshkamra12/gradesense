import { Router } from "express";
import { buildAnnotatedPdf } from "../annotate/export.js";
import { getResult, readOriginal } from "../db.js";

export const exportRouter = Router();

/**
 * Returns a new annotated PDF built from the stored original and whatever the
 * annotations currently say. Nothing is written to disk here: the original is
 * read-only and the export is streamed to the caller.
 */
exportRouter.post("/api/results/:id/export", async (req, res) => {
  const stored = getResult(req.params.id);
  if (!stored) {
    res.status(404).json({ error: "no such result" });
    return;
  }

  const original = readOriginal(stored.document.storagePath);
  const annotated = await buildAnnotatedPdf(stored, new Uint8Array(original));

  const name = stored.document.filename.replace(/\.pdf$/i, "");
  res.type("application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${name}-marked.pdf"`);
  res.send(Buffer.from(annotated));
});
