import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { Annotation } from "../annotate/annotations.js";
import {
  createAnnotation,
  deleteAnnotation,
  getAnnotation,
  getResult,
  listAnnotations,
  updateAnnotation,
} from "../db.js";

export const annotationsRouter = Router();

const Rect = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

const NewAnnotation = z.object({
  criterionId: z.string().nullable().default(null),
  page: z.number().int().positive(),
  rect: Rect.nullable().default(null),
  kind: z.enum(["box", "underline"]).default("box"),
  color: z.enum(["red", "amber", "green"]).default("red"),
  comment: z.string().default(""),
});

const AnnotationPatch = z.object({
  page: z.number().int().positive().optional(),
  rect: Rect.nullable().optional(),
  kind: z.enum(["box", "underline"]).optional(),
  color: z.enum(["red", "amber", "green"]).optional(),
  comment: z.string().optional(),
});

annotationsRouter.get("/api/results/:id/annotations", (req, res) => {
  if (!getResult(req.params.id)) {
    res.status(404).json({ error: "no such result" });
    return;
  }
  res.json(listAnnotations(req.params.id));
});

annotationsRouter.post("/api/results/:id/annotations", (req, res) => {
  if (!getResult(req.params.id)) {
    res.status(404).json({ error: "no such result" });
    return;
  }

  const parsed = NewAnnotation.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: z.prettifyError(parsed.error) });
    return;
  }

  const annotation: Annotation = {
    ...parsed.data,
    id: randomUUID(),
    resultId: req.params.id,
    anchor: "manual",
    unplaced: parsed.data.rect === null,
    needsPlacement: false,
    createdBy: "user",
    updatedAt: new Date().toISOString(),
  };

  res.status(201).json(createAnnotation(annotation));
});

annotationsRouter.patch("/api/results/:id/annotations/:annotationId", (req, res) => {
  const existing = getAnnotation(req.params.annotationId);
  if (!existing || existing.resultId !== req.params.id) {
    res.status(404).json({ error: "no such annotation" });
    return;
  }

  const parsed = AnnotationPatch.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: z.prettifyError(parsed.error) });
    return;
  }

  res.json(updateAnnotation(req.params.annotationId, parsed.data));
});

annotationsRouter.delete("/api/results/:id/annotations/:annotationId", (req, res) => {
  const existing = getAnnotation(req.params.annotationId);
  if (!existing || existing.resultId !== req.params.id) {
    res.status(404).json({ error: "no such annotation" });
    return;
  }

  deleteAnnotation(req.params.annotationId);
  res.status(204).end();
});
