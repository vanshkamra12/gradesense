# GradeSense — build spec

Build a grading and annotation tool. It reads a student answer paper, compares it
against a model answer and marking rubric, produces an explainable per-criterion
score, and draws annotations at the right place on the page.

Read this whole file before writing code.

---

## Non-negotiable rules

These are correctness requirements, not preferences. Enforce them in code, not
in the prompt.

1. A criterion's awarded marks can never exceed its maximum.
2. The total must equal the sum of the per-criterion marks. Recompute it
   server-side; never use a total returned by the model.
3. Every piece of feedback must carry evidence quoted from the student answer,
   or be explicitly marked as a missing-content finding.
4. The uploaded answer PDF is never modified. Export writes a new file.
5. When the system is uncertain it says so — a confidence value plus a
   human-review flag.

---

## Stack

- Backend: Node 18+, TypeScript, Express
- Frontend: React + TypeScript, Vite
- PDF text + coordinates: `pdfjs-dist`
- PDF page rasterisation: `pdfjs-dist` + `@napi-rs/canvas`
- PDF export: `pdf-lib`
- Validation: `zod`
- Persistence: `better-sqlite3`
- Tests: `vitest`
- LLM: Google Gemini (`@google/generative-ai`), vision-capable model

No auth, no design system, no cloud infra. Keep it small.

---

## Repo layout

```
gradesense/
  server/
    src/
      index.ts
      db.ts
      routes/
        upload.ts
        grade.ts
        annotations.ts
        export.ts
        history.ts
      pdf/
        extract.ts        text + per-item bounding boxes
        render.ts         page -> PNG buffer
      grade/
        provider.ts       LLM interface + Gemini + mock
        prompt.ts         builds the grading prompt
        schema.ts         zod schema for model output
        enforce.ts        clamping, totals, confidence, review flag
        pipeline.ts       orchestrates the whole grade run
      annotate/
        locate.ts         evidence quote -> bounding box
        export.ts         annotated PDF copy
    tests/
    .env.example
  web/
    src/
      App.tsx
      components/
        Uploader.tsx
        PageViewer.tsx        renders PDF page + annotation overlay
        AnnotationLayer.tsx   drag / resize / edit / delete
        ResultPanel.tsx       per-criterion breakdown
        HistoryList.tsx
      lib/api.ts
  fixtures/
    question_paper.pdf
    model_answer.pdf
    student_answer_A.pdf
    student_answer_D.pdf
    error_key_script_a.md
  README.md
  ARCHITECTURE.md
```

---

## The rubric

The marking scheme has exactly 15 criteria: 3 questions x 5 criteria, each worth
exactly 1 mark. Parse them out of the model answer PDF once and store as a
typed structure. Do not re-derive them per request.

```ts
type Criterion = {
  id: string;          // "Q1.C2"
  questionId: string;  // "Q1"
  text: string;        // the criterion wording from the marking scheme
  maxMarks: number;    // always 1 here, but keep it general
};
```

The marking scheme also contains "Important grading guidance" blocks under Q1
and Q2. These must be extracted and passed into the prompt. They are the most
important part of the rubric and are easy to miss:

- Q1: a voltmeter placed in series is a substantive error.
- Q1: wording need not match the model answer; equivalent reasoning earns credit.
- Q2: a student may reach the opposite conclusion and still score full marks.
  Grade the quality of reasoning, never similarity to the model answer.

---

## Pipeline

```
upload PDFs
  -> extract text with per-item coordinates (student answer)
  -> render each page to PNG
  -> guard: blank / too little text?
  -> build prompt (rubric + guidance + student text + page images)
  -> call provider
  -> validate with zod
  -> enforce (clamp, recompute total, confidence, review flag)
  -> locate evidence quotes -> bounding boxes
  -> persist result + annotations
  -> return to client
```

### Extraction

`pdfjs-dist` `page.getTextContent()` returns items with a `transform` matrix,
`width`, and `height`. Build a flat array:

```ts
type TextItem = {
  page: number;
  text: string;
  x: number; y: number; w: number; h: number;   // PDF user space, origin bottom-left
  charStart: number;                             // offset into the page's full text
};
```

Also produce, per page, the concatenated plain text with an index mapping back
to the items. `locate.ts` depends on this mapping.

Record each page's `width`/`height` from the viewport — the frontend needs them
to scale the overlay.

### Rasterisation

Render each page at ~2x scale to PNG. These images go to the model so it can
grade the hand-drawn circuit diagram and the supply/demand graph. Text alone is
not enough — two of the three questions require reading a drawing.

---

## Provider

```ts
export type GradeProvider = {
  name: string;
  grade(input: { prompt: string; images: Buffer[] }): Promise<string>;
};
```

Two implementations:

- `geminiProvider` — real API. Key from `process.env.GEMINI_API_KEY`. Never
  hardcode. Add `.env` to `.gitignore`.
- `mockProvider(mode)` — returns fixed output. Modes:
  - `"valid"` — a well-formed result
  - `"malformed"` — truncated JSON / wrong shape
  - `"overmax"` — awards 2 marks on a 1-mark criterion, and a total that does
    not match the sum
  - `"throws"` — rejects, simulating an API failure

Select via `GRADE_PROVIDER` env var, defaulting to mock. Tests must run with no
API key and no network.

Retry the real provider once on transient failure, then fail cleanly. A failed
grade returns a structured error to the client — never a partial or invented
result.

---

## Prompt design

This is the part that decides whether the tool is any good. Requirements:

- Grade strictly against the criterion wording, one criterion at a time.
- Never reward or penalise similarity to the model answer's wording or its
  conclusion. Include the grading-guidance blocks verbatim.
- Every criterion result must include a verbatim quote from the student answer
  as evidence, or `evidence: null` with `findingType: "missing"` when the point
  is absent.
- Evidence quotes must be copied exactly from the student text so they can be
  located. Instruct the model explicitly: copy the span character for character,
  do not paraphrase, do not fix spelling.
- The model returns no coordinates. Ever. Coordinates are computed by our code.
  A model asked for a bounding box will invent one.
- Surface spelling and grammar as feedback, but they must not by themselves
  cost a criterion mark unless the criterion is about communication.
- Text that appears struck out in the source should not be treated as the
  student's answer.
- Ask for a per-criterion `confidence` between 0 and 1 and a one-line
  `reasoning`.

Output must be a single JSON object, no prose, no markdown fences.

### Output schema (zod)

```ts
const CriterionResult = z.object({
  criterionId: z.string(),
  awarded: z.number(),
  maxMarks: z.number(),
  findingType: z.enum(["correct", "incorrect", "missing", "partial"]),
  evidence: z.string().nullable(),
  page: z.number().nullable(),
  feedback: z.string(),
  correction: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

const GradeResponse = z.object({
  criteria: z.array(CriterionResult),
  overallNotes: z.string().optional(),
});
```

Strip markdown fences before parsing. If `JSON.parse` or zod validation fails,
retry once with a repair instruction, then fail cleanly with a structured error.

---

## Enforcement

`enforce.ts` runs after validation and is where the hard rules live. It must:

- Clamp `awarded` into `[0, maxMarks]`, rounding to the nearest whole mark since
  every criterion here is worth 1.
- Fill in any criterion the model omitted, as `awarded: 0`,
  `findingType: "missing"`, `confidence: 0`, flagged for review.
- Drop any criterion the model invented that is not in the rubric.
- Recompute `total` as the sum of clamped awards, and `maxTotal` as the sum of
  `maxMarks`. Never trust a model-supplied total.
- Verify every non-missing result's `evidence` actually occurs in the extracted
  student text. If it does not, the model hallucinated the quote: set
  `evidence: null`, drop confidence, and flag for review. Do not silently keep
  it.
- Compute an overall confidence — the mean of per-criterion confidence, reduced
  when any criterion was clamped, repaired, filled in, or had unlocatable
  evidence.
- Set `needsHumanReview` when overall confidence is below a threshold, or any
  individual criterion was clamped / repaired / had bad evidence.

Every adjustment made here gets appended to an `adjustments: string[]` on the
result. This is what makes the system auditable, and it is worth showing in the
UI.

---

## Blank and unclear answers

Before calling the model:

- If extracted text across all pages is under ~40 non-whitespace characters and
  the pages contain no images, return a zero result immediately: every criterion
  `awarded: 0`, `findingType: "missing"`, `confidence: 1` (we are certain it is
  blank), `needsHumanReview: false`, with a clear message. Do not call the API.
- If there is little text but the pages do contain images, the answer may be
  handwritten. Grade it, but cap confidence and set `needsHumanReview: true`
  with a reason stating that little machine-readable text was found.

---

## Locating evidence

`locate.ts` turns an evidence quote into one or more bounding boxes. No model
involvement.

1. Normalise both the quote and the page text: collapse whitespace, lowercase,
   strip punctuation. Keep an index map back to original offsets.
2. Try exact match on the normalised page text.
3. If that fails, sliding-window fuzzy match (Levenshtein ratio, accept above
   ~0.85). This is what makes OCR-style misspellings still locatable.
4. Map the matched character range back to `TextItem`s via `charStart`.
5. Merge items on the same line into one rect; produce one rect per line the
   quote spans.
6. If nothing matches, return no box and mark the annotation
   `unplaced: true` — the UI shows it in a sidebar so the teacher can place it
   manually. Never guess a position.

For findings about a diagram there is no text to quote. Fall back to the
bounding box of the page's largest embedded image, mark the annotation
`anchor: "figure"` and `needsPlacement: true`. The teacher drags it into place.
Do not ask the model where the drawing is.

---

## Annotations

```ts
type Annotation = {
  id: string;
  resultId: string;
  criterionId: string | null;
  page: number;
  rect: { x: number; y: number; w: number; h: number } | null;
  kind: "box" | "underline";
  color: "red" | "amber" | "green";
  comment: string;
  anchor: "text" | "figure" | "manual";
  unplaced: boolean;
  createdBy: "system" | "user";
  updatedAt: string;
};
```

Annotations are stored in their own table, separate from the grading result.
This is what makes the editable requirement work: moving, editing or deleting an
annotation is a plain CRUD write and must never re-run grading. There must be no
code path from an annotation mutation back into the pipeline.

Routes: `GET/POST/PATCH/DELETE /api/results/:id/annotations`.

Frontend: render the PDF page to canvas, overlay an absolutely-positioned
annotation layer. Scale factor = rendered width / PDF page width. Drag to move,
handles to resize, click to edit the comment, key to delete, button to add a new
one. Every change is a PATCH. Nothing re-grades.

---

## Export

`POST /api/results/:id/export` returns an annotated PDF.

Load the original file's bytes with `pdf-lib`, draw rectangles or underlines and
the correction text, and save to a new file. Never write back over the upload.
Store the original under a content-addressed name and keep it read-only.

Remember pdf-lib's origin is bottom-left, same as pdfjs user space, so the
coordinates carry over directly. Draw comment text beside the box, wrapping if
it would run off the page edge, and add a summary page or footer showing the
total.

---

## History

SQLite tables: `documents`, `results`, `criterion_results`, `annotations`.

Persist every run. `GET /api/history` lists them, `GET /api/results/:id`
rehydrates a full result with its annotations so a past grading can be reopened
and its annotations edited.

---

## Tests

`vitest`, all runnable offline with the mock provider. Cover at least:

1. Fully correct answer — full marks, no criterion below its max.
2. Partially correct answer — Script A. Assert the specific criteria in the
   error key: Q1.C2, Q1.C4, Q2.C5, Q3.C2, Q3.C3, Q3.C5 all score 0. Assert the
   total is in the 8–10 range rather than exactly 9, since model output varies.
3. Incorrect answer — near zero, evidence still present for what was found.
4. Blank answer — zero, no API call made, high confidence, no review flag.
5. OCR-like spelling errors — content graded on merit, evidence still located
   via fuzzy matching, spelling not costing marks.
6. Malformed model output — repaired or failed cleanly; never throws an
   unhandled error, never returns a partial result.
7. Model/API failure — surfaces a structured error; nothing persisted as if it
   succeeded.
8. Score exceeding maximum — mock returns 2 on a 1-mark criterion and a bogus
   total; assert it is clamped to 1, the total is recomputed, an adjustment is
   recorded, and the result is flagged for review.

Plus unit tests for `locate.ts`: exact match, fuzzy match with a misspelling,
and a quote that does not exist returning `unplaced`.

Save the run output to a file for submission.

---

## Do not

- Do not ask the model for coordinates.
- Do not trust a model-supplied total.
- Do not grade by similarity to the model answer.
- Do not re-grade when an annotation changes.
- Do not modify the uploaded PDF.
- Do not commit `.env`.
- Do not build login, theming, or a component library.
- Do not add abstractions with a single implementation, except the provider
  interface, which has three.
