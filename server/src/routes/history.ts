import { Router } from "express";
import { getResult, listHistory, readOriginal } from "../db.js";

export const historyRouter = Router();

historyRouter.get("/api/history", (_req, res) => {
  res.json(listHistory());
});

historyRouter.get("/api/results/:id", (req, res) => {
  const stored = getResult(req.params.id);
  if (!stored) {
    res.status(404).json({ error: "no such result" });
    return;
  }

  // The stored page dimensions and text are enough to re-render the overlay,
  // so reopening a grading never re-extracts or re-grades the PDF.
  res.json({
    id: stored.id,
    createdAt: stored.createdAt,
    provider: stored.provider,
    providerCalled: stored.providerCalled,
    repaired: stored.repaired,
    assessment: stored.assessment,
    result: stored.result,
    annotations: stored.annotations,
    document: {
      id: stored.document.id,
      filename: stored.document.filename,
      pageCount: stored.document.pageCount,
      pages: stored.document.pages.map((page) => ({
        page: page.page,
        width: page.width,
        height: page.height,
      })),
    },
  });
});

/** Serves the stored original so the browser can render its pages to canvas. */
historyRouter.get("/api/results/:id/pdf", (req, res) => {
  const stored = getResult(req.params.id);
  if (!stored) {
    res.status(404).json({ error: "no such result" });
    return;
  }

  res.type("application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${stored.document.filename}"`);
  res.send(readOriginal(stored.document.storagePath));
});
