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

export type StoredResult = {
  id: string;
  createdAt: string;
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

export async function gradeUpload(file: File): Promise<{ id: string }> {
  return json(
    await fetch(`/api/grade?filename=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: file,
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
