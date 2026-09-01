export type Rect = { x: number; y: number; w: number; h: number };

export type Annotation = {
  id: string;
  resultId: string;
  criterionId: string | null;
  page: number;
  rect: Rect | null;
  kind: "box" | "underline";
  color: "red" | "amber" | "green";
  comment: string;
  anchor: "text" | "figure" | "manual";
  unplaced: boolean;
  needsPlacement: boolean;
  createdBy: "system" | "user";
  updatedAt: string;
};

export type Criterion = {
  criterionId: string;
  questionId: string;
  criterionText: string;
  awarded: number;
  maxMarks: number;
  findingType: "correct" | "incorrect" | "missing" | "partial";
  evidence: string | null;
  page: number | null;
  feedback: string;
  correction: string | null;
  confidence: number;
  reasoning: string;
  adjusted: boolean;
  evidenceStatus: "verified" | "unverifiable" | "absent";
};

export type GradeResult = {
  criteria: Criterion[];
  total: number;
  maxTotal: number;
  confidence: number;
  needsHumanReview: boolean;
  reviewReasons: string[];
  adjustments: string[];
  overallNotes: string | null;
};

export type PageGeometry = { page: number; width: number; height: number };

export type DocumentSummary = { id: string; filename: string; source: "uploaded" | "bundled" };

export type StoredResult = {
  id: string;
  createdAt: string;
  questionPaper: DocumentSummary | null;
  modelAnswer: DocumentSummary | null;
  provider: string;
  providerCalled: boolean;
  repaired: boolean;
  assessment: { kind: "blank" | "unclear" | "gradeable"; contributedChars: number; imageCount: number };
  result: GradeResult;
  annotations: Annotation[];
  document: { id: string; filename: string; pageCount: number; pages: PageGeometry[] };
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

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

/** Uploads a question paper or marking scheme and returns its document id. */
export async function uploadDocument(file: File): Promise<{ id: string; filename: string }> {
  return json(
    await fetch(`/api/documents?filename=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: file,
    }),
  );
}

export async function gradeUpload(
  student: File,
  supporting: { questionPaper?: File; modelAnswer?: File } = {},
): Promise<{ id: string }> {
  // The supporting documents go up first, so grading is a single call that
  // names them by id. Whichever is omitted falls back to the bundled fixture.
  const params = new URLSearchParams({ filename: student.name });

  if (supporting.questionPaper) {
    params.set("questionPaper", (await uploadDocument(supporting.questionPaper)).id);
  }
  if (supporting.modelAnswer) {
    params.set("modelAnswer", (await uploadDocument(supporting.modelAnswer)).id);
  }

  return json(
    await fetch(`/api/grade?${params}`, {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: student,
    }),
  );
}

export async function fetchHistory(): Promise<HistoryEntry[]> {
  return json(await fetch("/api/history"));
}

export async function fetchResult(id: string): Promise<StoredResult> {
  return json(await fetch(`/api/results/${id}`));
}

export const pdfUrl = (id: string) => `/api/results/${id}/pdf`;

// --- annotation mutations ---------------------------------------------------
// These are the only writes the editor makes. They address the annotations
// routes and nothing else; no client path reaches the grading endpoint.

export type NewAnnotation = {
  criterionId?: string | null;
  page: number;
  rect: Rect | null;
  kind?: Annotation["kind"];
  color?: Annotation["color"];
  comment?: string;
};

export type AnnotationPatch = Partial<
  Pick<Annotation, "page" | "rect" | "kind" | "color" | "comment">
>;

export async function createAnnotation(
  resultId: string,
  annotation: NewAnnotation,
): Promise<Annotation> {
  return json(
    await fetch(`/api/results/${resultId}/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(annotation),
    }),
  );
}

export async function patchAnnotation(
  resultId: string,
  annotationId: string,
  patch: AnnotationPatch,
): Promise<Annotation> {
  return json(
    await fetch(`/api/results/${resultId}/annotations/${annotationId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  );
}

export async function deleteAnnotation(resultId: string, annotationId: string): Promise<void> {
  const response = await fetch(`/api/results/${resultId}/annotations/${annotationId}`, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
}

/**
 * Asks the server for an annotated copy and hands it to the browser to save.
 * The export always reflects the annotations as they are now.
 */
export async function exportAnnotatedPdf(resultId: string, filename: string): Promise<void> {
  const response = await fetch(`/api/results/${resultId}/export`, { method: "POST" });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
  }

  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.replace(/\.pdf$/i, "") + "-marked.pdf";
  link.click();
  URL.revokeObjectURL(url);
}
