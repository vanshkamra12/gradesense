# Architecture

Written up as it gets built. Stage 1 records only the shape of the repo and the
decisions already made; later stages fill in the pipeline sections.

## Workspaces

An npm workspace root with two packages, `server` and `web`. One `npm install`
at the root installs both. There is no shared package — the two sides exchange
JSON over HTTP and nothing else, so a third workspace for shared types would be
an abstraction with one consumer on each end.

## Server

TypeScript compiled by `tsc` with `module: NodeNext`, so the build output runs
under plain `node dist/index.js` with no loader or bundler. The cost is writing
`.js` on relative imports of `.ts` source files, which is the standard Node ESM
convention. `tsx` runs the same source directly in development with watch mode.

Environment variables are loaded by Node itself via `--env-file-if-exists`, so
there is no dotenv dependency and a missing `.env` is not an error — the
defaults in `config.ts` are enough to run against the mock provider.

`server/src/config.ts` is the only place that reads `process.env`. Everything
else takes its configuration from the exported `config` object, which keeps
tests from having to stub the environment in more than one place.

## Web

React + Vite. The dev server proxies `/api` to `localhost:3001`, so frontend
code calls relative URLs and there is no CORS handling or base-URL config in
the client. The server still enables `cors` for the case where the built bundle
is served from somewhere else.

## Runtime storage

Uploaded originals, rendered page images, exported PDFs and the SQLite file all
live under `server/storage/` and `server/data/`, both gitignored. The uploaded
PDF is stored under a content-addressed name and is never written to again;
export always produces a new file.

## Grading provider

A single `GradeProvider` interface with three implementations behind it — the
real Gemini client and the mock in its several modes. This is the one
abstraction in the codebase that has more than one implementation, which is why
it is the one interface worth having. `GRADE_PROVIDER` selects between them and
defaults to the mock, so the test suite runs with no API key and no network.

## PDF extraction

`server/src/pdf/extract.ts` is the only thing that touches pdf.js text content.
It uses the `legacy/build/pdf.mjs` entry point, which is the build that does not
assume browser globals.

For each page it produces the text items with their bounding boxes in PDF user
space (origin bottom-left), the page's viewport width and height, and the boxes
of any embedded images.

### The charStart contract

Each page carries a single concatenated `text` string, built by appending every
item's `str` in reading order and adding a newline after any item pdf.js marks
with `hasEOL`. Every item records the offset where its own text begins in that
string, as `charStart`.

That offset is the load-bearing part of this module. `locate.ts` matches an
evidence quote against the page text, gets back a character range, and has to
turn that range into rectangles — which it can only do by finding the items
whose `[charStart, charStart + text.length)` interval overlaps the range. A test
asserts the round trip for every item of every fixture page, because an
off-by-one here would put every annotation in the wrong place with nothing
obviously broken.

The concatenation also repairs pdf.js splitting ligatures into separate items:
"difference" arrives as "di", "ff", "erence", each with its own bounding box,
and only the joined page text spells the word the student wrote.

This is the reason `locate.ts` must match evidence quotes against the joined
page text and never against an item's own text. A quote containing any of the
words the rubric actually cares about — "difference", "flow", "benefits" — would
never match a single item, because no single item holds the whole word. Matching
runs on the page text; only afterwards does the matched character range get
mapped back to items through `charStart`, which is how a quote spanning a
ligature split still resolves to every box it covers.

### Image boxes

An image XObject always paints into the unit square, so where it lands is
entirely determined by the transform in effect when it is painted. The extractor
walks the page's operator list keeping a transform stack — `save`, `restore`,
`transform`, and the form XObject begin/end pair — and maps the unit square
through the current matrix at each paint operation. Boxes under 4pt on a side
are dropped as rule lines and other artefacts rather than figures.

Two things downstream need this. The blank-answer guard uses image presence to
tell an empty page from a handwritten one, and `locate.ts` anchors findings
about a drawing to the largest image on the page, which needs the area.

The largest-image rule is an assumption, not a guarantee. It holds for the
fixtures, where each page carries exactly one image and that image is the
hand-drawn diagram. On an answer sheet with a printed logo or a header rule,
largest-by-area would still pick the diagram, since a diagram is much bigger
than page furniture — but nothing enforces that, and a scanned page delivered as
one full-page image would defeat it entirely. The fallback is deliberately
conservative for this reason: a figure anchor is marked `needsPlacement`, so the
teacher confirms the position rather than trusting the guess.

### What extraction cannot see

Struck-out text is not distinguishable here. In Script A the false start in Q3
part (b) is drawn with a separate graphic line over ordinary text, so the
extracted page text reads "...where the demand From the table and from my
graph...", running the abandoned clause straight into the real answer. Only the
rasterised page image shows the strike, which is why the prompt has to tell the
model to ignore struck-out text rather than the extractor filtering it out.

## Page rasterisation

`server/src/pdf/render.ts` renders each page to a PNG at 2x. Two of the three
questions cannot be graded from text at all — Q1 needs the hand-drawn circuit
and Q3 needs the supply/demand graph — so these images are what let the model
see the parts of the answer that extraction cannot reach.

pdf.js 6 ships a `NodeCanvasFactory` built on `@napi-rs/canvas`, the same canvas
the spec already calls for, and picks it automatically outside a browser. So
rendering needs no factory of our own: create a canvas at the scaled viewport
size and hand it to `page.render`.

The canvas is filled white before rendering. A PDF page has no background of its
own, and without that fill the PNG is transparent, which composites to black
wherever it is later drawn — including in whatever the model sees.

At 2x a fixture page is 1192 x 1684 px and around 500 KB. That is enough to read
the pencil labels on both diagrams, and enough to see that the false start in Q3
part (b) is struck through — the strike is a drawn line, invisible to text
extraction, so the rendered page is the only place the model can observe it.

A test measures the share of non-white pixels rather than only checking the PNG
header, because a blank or fully transparent canvas still encodes to a
structurally valid PNG of exactly the right dimensions.

## Rubric parsing

`server/src/grade/rubric.ts` turns `fixtures/model_answer.pdf` into the typed
rubric. It is parsed deterministically, with no model call: the marking scheme
is fixed input, and a rubric that came out differently between runs would make
every downstream assertion flaky.

The document turned out to be cleanly structured, so the parser is line-based.
Each question is a section introduced by `Qn — Subject`, containing a
`Model Answer — 5 marks` heading, prose, a `Marking rubric` table between its
`Criterion / Marks` header and its `Total` row, and — under Q1 and Q2 only — an
`Important grading guidance` block that runs to the end of the section.

Two details are not obvious from reading the rendered page. Rubric rows wrap:
a long criterion runs onto a second line and only the final line carries the
mark, so rows are accumulated until a line ends in a digit. And the parser
cross-checks itself — the marks declared in the heading, the table's `Total`
row, and the sum of the individual criteria must all agree, or it throws rather
than returning a rubric with the wrong number of criteria.

### Guidance is first-class data

`guidance` holds the verbatim lines of the block, never a summary and never
appended onto criterion text. At the prompt-building stage it goes in as-is.

This matters more than the criterion wording does. The three sentences that
decide whether grading is correct all live in the guidance rather than in the
rubric table: that a voltmeter in series is a substantive error, that wording
need not match the model answer, and that a student may reach the opposite
conclusion and still score 5/5. The last of those is what stops the grader
penalising the Q2 position in Script A, which the error key calls the single
most important control in the set. A test asserts each sentence survives
parsing intact.

Because the lines are verbatim, they carry the PDF's hard wrapping — a sentence
may be split across two entries. They are joined with newlines for the prompt
rather than being unwrapped, since unwrapping is a normalisation and the whole
point of this field is that nothing rewords it.

### Model answer prose

The prose is captured separately, as `modelAnswers`, and never merged into the
rubric. The prompt needs it as reference material, but the rubric is what marks
are awarded against, and keeping them in separate fields is what makes it
possible to label them differently in the prompt. Grading by similarity to the
model answer is the failure this whole separation exists to prevent.

## Grading provider

`server/src/grade/provider.ts` holds the `GradeProvider` interface and the mock.
A provider takes a prompt and page images and returns the model's raw string.
It does no parsing, no validation and no enforcement — those belong to code that
must behave identically whichever provider produced the string.

`GRADE_PROVIDER` selects the implementation and defaults to `mock`, so the test
suite runs with no API key and no network.

### The mock

Five modes: `valid`, `malformed`, `overmax`, `throws`, `badEvidence`.

`overmax` and `badEvidence` are separate modes on purpose. Clamping an
over-maximum award and detecting a hallucinated quote are different enforcement
paths, and folding them together would make a failure in either one look like a
failure in the other.

`overmax` exercises four paths at once: two marks on a one-mark criterion, a
`total` of 99 that matches nothing, `Q2.C3` omitted so it has to be filled in,
and an invented `Q4.C1` that has to be dropped.

`malformed` returns truncated JSON on the first call and a parseable payload of
the wrong shape on the second. That covers both failure kinds the spec names in
one mode, and it walks the real repair path: parse failure, retry, schema
failure, clean structured error. Determinism here means a given sequence of
calls always yields the same sequence of bytes.

Two properties keep the mock from drifting away from the rest of the system.
Criterion IDs come from `loadRubric()` rather than string literals, so a change
to rubric parsing moves the mock with it or fails loudly. And evidence quotes
are lifted from the real extracted text of `student_answer_A.pdf` at runtime,
by matching an anchor phrase whitespace-insensitively and expanding to the
surrounding sentence — never written out by hand. If an anchor stops matching,
the mock throws rather than emitting a quote that no longer exists. This is what
lets `locate.ts` be tested end to end against realistic input, misspellings and
mid-sentence line breaks included.

The marks in `valid` mode mirror `fixtures/error_key_script_a.md` and total
9/15, so pipeline tests run against a realistic spread rather than a uniform
result.

### What mock-backed tests prove, and what they do not

Tests that run against the mock verify the **pipeline**: enforcement, clamping,
evidence verification, locating, persistence and error handling. They cannot
verify **grading quality**. The mock's answers are fixed, so a test asserting
that Q1.C2 scores zero is only asserting that the mock returns what the mock was
told to return. That the mock's marks happen to match the error key is a
convenience for making the fixtures realistic, not evidence of anything.

Grading quality is a separate question with a separate answer: grade Script A
with the real provider and compare against `fixtures/error_key_script_a.md`.
That check belongs in an integration test that skips cleanly when
`GEMINI_API_KEY` is absent, kept apart from the unit suite, so that the suite
never appears to prove more than it does.

## Prompt, schema and pipeline

`prompt.ts` assembles the prompt, `schema.ts` validates what comes back, and
`pipeline.ts` runs the sequence. The provider sits between them and knows about
none of it.

### Section order

Task framing, then the marking scheme with its guidance, then the model answer
as reference, then the student's extracted text, then the page images, then the
output contract. The student's work comes after the marking material so that the
criteria frame the reading rather than being applied to an impression already
formed, and the output contract comes last so it is the most recent instruction.

The images have to sit between the student's text and the output contract, so
`buildPromptParts` returns an ordered `PromptPart[]` — a discriminated union of
`{ kind: "text" }` and `{ kind: "image" }` — rather than a string, and
`GradeProvider.grade` takes `{ parts }`. Gemini maps the array onto its own
parts; the mock ignores the content.

An earlier draft passed a single string containing a `<<<PAGE_IMAGES>>>` marker
for the provider to split on. That was a hidden contract: the type said "string"
while the real agreement was "string containing a magic token in the right
place", and nothing would have caught a provider that forgot to split. The array
makes the ordering the type's business, which is where it belongs.

### What the prompt does and does not say

The guidance blocks go in verbatim under a heading that names them as
authoritative and says they override the model's own judgement. The model answer
goes in under `MODEL ANSWER — REFERENCE ONLY` with an explicit statement that
similarity to it is not evidence of correctness, that difference from it is not
evidence of error, and that a student reaching the opposite conclusion can earn
full marks. That paragraph is the single most important instruction in the file.

The prompt never names the errors in any particular script. A test asserts that
the instruction sections contain no subject terms at all — no "voltmeter", no
"equilibrium", no criterion IDs. The marking scheme and the student's text
naturally contain such words, and must; our own prose must not, or a passing
grade run would prove only that the model can follow a hint.

The model is told not to reason about a total, not to return one, and not to
report positions of any kind. Coordinates are computed from the quote by
`locate.ts`; a model asked for a bounding box will invent one.

### Validation and repair

`parseModelOutput` strips markdown fences defensively — the prompt forbids them
and models emit them anyway — then parses and validates, reporting a JSON
failure distinctly from a schema failure. `pipeline.ts` retries exactly once,
appending one further text part that quotes the specific reason the last response
was unusable, and then fails with a structured error carrying every raw attempt.

A failed run returns `{ ok: false, error }` and never a partial result. There is
no path that returns some criteria and an error.

## Enforcement

`enforce.ts` runs after validation and holds the rules that must be true
regardless of what the model said. It takes the validated response, the rubric
and the student's extracted text, and returns the result the rest of the system
uses. Nothing downstream reads the raw model response.

It iterates the **rubric**, not the model's array. That single choice is what
makes the criterion set correct by construction: a criterion the model omitted
gets filled in because the loop reaches it anyway, a criterion the model invented
is never reached, and the output is always the 15 criteria in marking-scheme
order however the model ordered them.

Marks are rounded to a whole number, then clamped into `[0, maxMarks]`, with the
maximum taken from the marking scheme rather than from the model. The total is
recomputed as the sum of the clamped awards. The schema accepts an optional
`total` from the model, not because it is used, but so that enforcement can
report having ignored it instead of zod silently dropping the field.

Evidence is verified by normalising whitespace and case and checking the quote
occurs in the extracted text. Whitespace and case are the only differences a
faithful quote can legitimately have, because the extracted text carries the
PDF's hard wrapping. Anything else means the quote was not copied from the
answer, so it is removed, the criterion's confidence is capped at 0.2, and the
criterion is flagged. A `missing` finding with no quote is left alone, and so is
a finding about a diagram, which has no text to quote.

### The adjustments array

`adjustments` is the audit trail, and it is written for a teacher rather than
for a log. Every line names the criterion and says what changed:

    Q1.C1: awarded 2 of a maximum 1 — clamped to 1.
    Q2.C3: the model returned no result for this criterion — recorded as 0 of 1,
           missing, with no confidence.
    Q1.C2: the quoted evidence does not appear anywhere in the student's answer
           — the quote was removed as unverifiable and confidence lowered from
           0.95 to 0.2.
    Q4.C1: not a criterion in the marking scheme — the model's result for it was
           discarded.
    The model returned a total of 99. Totals are never taken from the model —
    recomputed from the criterion marks as 8 of 15.

Different failures read differently on purpose. A criterion the model never
answered and a criterion whose quote it invented are not the same event: the
first is silence, the second is a false statement, and a teacher deciding
whether to trust the mark needs to tell them apart at a glance. A test asserts
the two lines are not identical.

The lines are grouped so the trail reads in marking-scheme order first, then
what was discarded, then what applies to the response as a whole.

### Confidence and the review flag

Overall confidence is the mean of the per-criterion values, less 0.05 for each
criterion that had to be adjusted and 0.1 if the response needed repairing.
`needsHumanReview` is set when confidence falls below 0.7, when any criterion
was adjusted, or when the response was repaired — and `reviewReasons` says which
of those it was, in the same plain language as the adjustments.

A high-confidence result with one clamped criterion still goes to review. The
model being sure of itself says nothing about the thing that had to be
corrected.

Fractional marks are floored rather than rounded, for the same reason. The
prompt tells the model that a criterion only half met scores 0, so rounding 0.5
up in enforcement would mean the prompt and the enforcement stated two different
rules. A reviewer reading both should find one.

## Blank and unclear answers

`guard.ts` decides, before any model call, whether a sheet is worth grading.

### Discounting the pre-printed scaffolding

The answer sheet is printed from the question paper, so the question headings
are on the page before the student writes anything. A raw character count is
therefore not a measure of what the student wrote: the blank fixture carries 53
non-whitespace characters of headings alone, comfortably past the spec's ~40
threshold, and a guard built on that count would send an empty page to the
model.

So the guard measures the student's **contribution** — the page text with every
line that also appears in the question paper removed, matched on collapsed
whitespace and lowercased. On the blank fixture that leaves exactly zero
characters. The character threshold stays as a backstop for a sheet with a
stray word or two on it, rather than being the primary signal.

Matching whole lines against the question paper rather than a heading pattern
means the guard works on any answer sheet built from the provided paper, not
only on our fixture.

### The two cases

A sheet with almost no contributed text and **no images** is blank. It returns a
zero result immediately, with confidence 1 — an empty page is not an ambiguous
one, and saying "we are unsure" about it would be false — and no review flag.
The provider is never called, which a test enforces with a provider that throws
if it is reached.

A sheet with almost no contributed text but **images present** is unclear, not
blank: the answer is probably handwritten. `fixtures/student_answer_F.pdf` is
exactly this — a real handwritten page on ruled notebook paper, scanned as one
full-page image with zero extractable text. It is the fixture that proves the
system declines to fake confidence about handwriting rather than pretending to
have read the page: it is graded, but the result says plainly that almost no
machine-readable text was found and that a human has to confirm it.

It is also the case that defeats the largest-image heuristic noted above, since
the whole page is one image — which is why a figure anchor is only ever a
suggestion a teacher confirms. It is graded normally, but overall
confidence is capped at 0.5 and the result is flagged for review with a reason
naming the actual cause — how many characters were found, how many page images
there are, and that the marking may rest on the images alone. That reason is
listed before the generic threshold message, because it says why rather than
what.

### The blank result is not a special shape

The zero result is built as a `GradeResponse` in exactly the shape a model would
have returned, and then run through `enforce()` like any other response. It gets
the same 15 criteria in the same order, the same recomputed total, and the same
invariants.

This costs a few lines and buys the guarantee that there is only one result
shape in the system. A blank answer that took a shortcut around enforcement
would eventually reach persistence, or the annotation layer, or the exporter,
carrying a subtly different object — and it would fail there rather than here.
A test asserts the blank and marked results have identical key sets, at the
result level and per criterion.

## Locating evidence

`annotate/locate.ts` turns an evidence quote into rectangles. No model is
involved: the model supplies a quote, and this file decides where that quote is.

### Matching against joined page text

Matching runs against each page's concatenated text, never against an
individual text item. pdf.js splits ligatures into separate items — "difference"
arrives as "di", "ff", "erence", each with its own bounding box — so no single
item holds a whole word, and a quote containing any such word could never match
item text. The matched character range is mapped back to items afterwards,
through `charStart`. A comment says so at the matching site, because it is the
one thing a future reader would otherwise simplify away.

Both sides are normalised the same way: whitespace collapsed, lowercased,
punctuation dropped, keeping an offset back into the original for every
surviving character. Collapsing whitespace is what lets a quote the model joined
with a space match a source that wrapped the same sentence across a newline —
which is the common case, since the extracted text carries the PDF's hard
wrapping.

### Exact, then fuzzy

Exact matching collects every occurrence on every page. Only if there are none
does the fuzzy pass run.

The fuzzy pass uses Sellers' algorithm rather than a sliding window: the first
row of the edit-distance table is left at zero, so a match may begin anywhere at
no cost, and the smallest value in the final row is the distance from the whole
quote to the best-matching substring of the page. The start offset is carried
alongside the distance. This finds the true best window in one pass over the
page, where a stepped sliding window costs one distance computation per offset
and can still miss the optimum between steps.

### The threshold, and how it was chosen

0.85, measured against the 15 real quotes in the mock's valid output rather than
picked:

| input | score |
|---|---|
| genuine quote, unchanged | 1.000 |
| genuine quote with the student's spelling "corrected" by the model | 0.980 (worst of 7) |
| genuine quote with 3 characters corrupted | 0.940 (worst of 15) |
| the same quote against a page it is not on | 0.480 (best of 15) |

The band between the worst genuine repair and the best false positive runs from
0.94 down to 0.48, so 0.85 sits in open space rather than against either edge.
Nothing plausible needed a threshold below 0.9, let alone 0.8. Raising it to
0.95 would begin rejecting genuine respelled quotes; lowering it to 0.5 would
begin accepting text from the wrong page.

### Ambiguity and failure

A quote matching in more than one place is not resolved silently. Candidates on
the page the model reported are preferred; if a choice still has to be made, the
best-scoring one wins and `ambiguous` is set either way, so the UI can say that
a choice was made.

A quote matching nothing returns no rectangle and `unplaced: true`. There is no
fallback to the reported page and no approximate position. A box in the wrong
place is worse than no box, because it looks equally authoritative.

### One rect per line

A quote spanning three lines produces three rectangles, not one tall rectangle
covering the gap between them. Items are grouped by baseline, and an item only
partly covered by the quote is narrowed proportionally, so a quote starting
mid-sentence does not get a box running back to the left margin.

### Which findings get a figure anchor

`enforce` distinguishes three states in `evidenceStatus`, and locating treats
them differently. A `verified` quote is located. An `absent` one — a missing
point, or a finding about a drawing that had no text to quote — falls back to
the largest image in the document, marked `anchor: "figure"` and
`needsPlacement: true` for a human to confirm.

An `unverifiable` one — where the model quoted something that is not in the
answer and enforcement removed it — is left unplaced. Anchoring it to the figure
would be inventing a position for a quote that was already invented once.

## Persistence

`db.ts` is the whole data layer: `better-sqlite3`, four tables, synchronous
calls, no ORM.

### The original upload is read-only

An upload is written to `storage/originals/<sha256 of its bytes>.pdf` with mode
`0444`, and is not rewritten if that path already exists. The same file uploaded
twice is one stored copy and one `documents` row, with a new `results` row each
time. Nothing in the system opens an original for writing; export produces a new
file elsewhere. A test asserts the stored file has no write bit and that a
second store leaves the first file's mtime untouched.

### Reopening does not re-extract

`documents` carries the page geometry and the extracted text and items, not just
the file path. A reopened grading can therefore scale and draw its annotation
overlay straight from the stored rows — no pdf.js, no re-extraction, and no
possibility of the overlay being computed against different coordinates from the
ones the annotations were placed in.

### Annotations are deliberately not connected to the marks

`annotations` has a foreign key to `results` and nothing else. `criterion_id` is
plain text with no foreign key at all, and there is no reference from an
annotation to a row in `criterion_results`.

That is the point of the split. The requirement is that moving, editing or
deleting an annotation never re-runs grading, and the way to guarantee it is to
leave no path along which a write to one could reach the other. `saveGradeRun`
is the only function that writes both, and it only ever inserts, once, when a
run is first persisted. The CRUD functions below it touch the `annotations`
table alone. Re-grading a document produces a new result with its own
annotations rather than mutating an existing one's.

A test reads `PRAGMA foreign_key_list(annotations)` and asserts the only table
referenced is `results` — so the guarantee is checked against the schema itself
rather than against our intentions about it. Another persists a run, reopens it,
moves an annotation, reopens again, and asserts the move survived while every
criterion, the total, the confidence and the adjustments are byte-identical.

### Routes

| route | does |
|---|---|
| `POST /api/grade` | raw PDF bytes in the body, grades, persists, returns the id |
| `GET /api/history` | recent runs with score, confidence, review flag, annotation count |
| `GET /api/results/:id` | a full result with its annotations and page geometry |
| `GET/POST/PATCH/DELETE /api/results/:id/annotations` | annotation CRUD |

The upload takes raw bytes with `Content-Type: application/pdf` rather than
multipart, which avoids a file-upload dependency for a route that accepts
exactly one file. A failed grade returns a structured error and persists
nothing — there is no half-saved run to clean up.

Patching an annotation's rect sets its anchor to `manual` and clears
`needsPlacement`: once a teacher has moved a box, its position is theirs and the
system should stop asking them to confirm it. Clearing the rect marks the
annotation unplaced rather than deleting it, so a finding never silently
disappears from the sidebar.

## The frontend

React and Vite, plain CSS, no component library. The page is the primary object
and takes the whole left column; the result panel is a fixed 420px beside it.

### Rendering and the overlay

The browser renders each page to a canvas with pdf.js, using the original bytes
served from `GET /api/results/:id/pdf`. The annotation layer is an absolutely
positioned div over that canvas.

The scale is rendered width over PDF page width, and it is recomputed by a
`ResizeObserver` on the page container rather than being measured once. Every
rectangle is positioned from that scale, so an overlay that did not react to a
resize would drift away from the words it marks the moment the window changed
size — the most visible possible bug in this system. Measured across a
1000px → 520px change, an annotation's position drifts by 0.0005 of the page
width, which is a quarter of a pixel of rounding.

The canvas is rendered at up to 2x the CSS size and scaled down by its style
width, so text stays sharp. PDF user space has its origin at the bottom left and
CSS at the top left, so the layer flips the y axis: `top = pageHeight - y - h`.

### The two-way link

Clicking a criterion highlights its boxes; clicking a box selects and scrolls to
its criterion. Both directions run off one piece of state, the selected
criterion id, held in `App`.

The scroll is a direct `scrollTop` assignment rather than `scrollIntoView` or a
smooth scroll, for two measured reasons. `scrollIntoView` scrolls every
scrollable ancestor, which dragged the page viewer around as a side effect of
selecting a criterion. And a smooth scroll is animated over several frames,
which the canvas repainting beside it cancels partway — a 1299px scroll was
measured landing 22px down. An instant jump always arrives.

### Colour is never the only signal

Red for incorrect, amber for partial and missing, green for correct — and the
criterion id is printed on the box itself, so the annotation is identifiable
without seeing colour at all. Correct criteria are drawn as underlines with no
fill, since a tint behind the words reads as a strikethrough. A quote spanning
three lines produces three boxes but only one tag, on the first.

### Nothing is hidden

**A finding that exists but could not be positioned must never be dropped.**
Silently discarding it would be the worst failure in this system: worse than a
wrong mark, because a wrong mark is visible and arguable, while a finding that
never appears cannot be questioned at all. The teacher would be looking at a
clean page and a shorter list with no way to know that either was incomplete,
and the system would look most confident exactly where it had failed.

So findings that could not be placed are listed in the panel under a heading
that says so, with a count. That includes the case where the model quoted
something that is not in the answer: enforcement strips the quote, and the
annotation is kept with no rectangle so the finding still appears in the list
and can be placed by hand. An early version returned nothing at all for those,
and on the handwritten fixture — where every quote is unverifiable — it produced
a blank page beside an empty sidebar that looked like a clean pass.

Figure-anchored annotations get their own list, labelled as a best guess to
confirm.

## Annotation editing

A teacher can move, resize, recolour, re-comment, delete and draw annotations,
and none of it can re-grade the paper. That is arranged structurally rather than
by care.

### Why it cannot re-grade

`routes/annotations.ts` reaches exactly three modules at runtime:

    routes/annotations.ts
      db.ts
        config.ts

The grading pipeline is not in that graph, so there is no call path to audit —
there is nothing to call. For comparison, the grade route reaches fourteen
modules including `grade/pipeline.ts`, `grade/provider.ts` and `pdf/render.ts`.

`tests/isolation.test.ts` walks that graph from the source, skipping type-only
imports because the compiler erases them, and asserts no grading module is
reachable from the annotation routes or from `db.ts`. It also asserts the whole
pipeline *is* reachable from the grade route, so a walker that silently found
nothing would fail rather than pass everything.

Beneath that, `db.ts` exposes annotation CRUD functions that touch only the
`annotations` table, which has no foreign key to `criterion_results`. So the
guarantee holds at three levels: the schema has no link, the data layer has no
function that writes both, and the route has no import that reaches grading.

A second test performs every mutation the UI can perform — create, move, resize,
recolour, change kind, edit comment, clear a rect, place an unplaced finding,
delete — against a run that has adjustments and a review flag, then asserts
`JSON.stringify(result)` is identical before and after. Serialising the whole
result means a field added later is covered automatically, and the test also
asserts the annotations *did* change, so it cannot pass by doing nothing.

### Placing what could not be placed

The unplaced list has a **place** button per finding. Pressing it arms the draw
tool bound to that annotation, and the box the teacher draws becomes its
position through the same PATCH a drag uses. This is what makes the unplaced
list actionable rather than merely honest: the system says what it could not
position, and the teacher positions it.

Any box a teacher moves or draws becomes `anchor: "manual"`, and a box they draw
from scratch is `createdBy: "user"`, so the record distinguishes what the system
proposed from what a person decided.

### Interaction

Pointer gestures are tracked on `window` rather than the element, so a fast drag
that leaves the box still finishes correctly. Nothing is sent while the pointer
moves — a local draft rect is drawn, and one request is sent on release. Escape
cancels drawing and clears the selection; Delete removes the selected
annotation, except while the caret is in the comment field, where both keys mean
what they normally mean.

## Annotated PDF export

`annotate/export.ts` loads the stored original into a new pdf-lib document in
memory, draws onto that copy, appends a summary, and returns fresh bytes. The
file on disk is never opened for writing — it is mode `0444`, and its filename
is the sha256 of its own contents, so a test can assert it is unchanged simply
by re-hashing it and comparing to its name.

### Coordinates carry over

pdf-lib and pdf.js both place the origin at the bottom left of the page, so a
rect measured during extraction is drawn with no conversion at all; the only
adjustment is the MediaBox offset, which is zero for these fixtures but need not
be in general.

That is asserted rather than assumed. A test exports a single annotation with
its criterion id stripped, so nothing but the rectangle is drawn, rasterises the
page at 1x, finds the bounding box of the coloured pixels, and checks all four
edges against the rect flipped into image space. Every edge lands within 3px. A
second test extracts the text of the exported page, takes the items falling
inside the drawn rectangle, and asserts they are the words the criterion quoted
— so the box is proved to be over the right text, not merely at plausible
coordinates.

### Marking without covering the answer

The criterion id goes in the **left** margin and the correction in the **right**
margin, neither over the text. Both were originally drawn against the box: the
id above it, which covered the first word of the line above, and the correction
below it, which landed on the next line of the student's answer. A marked script
that hides the thing being marked is worse than an unmarked one.

The right margin is narrow, so corrections are set at 5.2pt, wrapped to it, and
cut after nine lines — the full text is always on the summary page. Only the
first box of a criterion is tagged and annotated, so a quote spanning three
lines is not labelled three times.

The standard 14 fonts encode WinAnsi, which covers Latin-1 plus the dashes,
curly quotes and ellipsis in 0x80–0x9F. The rupee sign and subscript digits in
Q3 fall outside it and throw at draw time, so those two are transliterated —
"Rs." and plain digits — and nothing else is touched. An earlier version also
rewrote em dashes as `--`, which was unnecessary and looked wrong in the title.

### The summary

A flowing report that adds pages as it fills: total, confidence, review flag and
its reasons, the adjustments under "what the system corrected about itself",
findings that could not be placed, then every criterion with its wording, mark,
finding type, confidence, evidence, feedback and correction.

Unplaced findings appear here under their own heading. Leaving them out of the
export would reintroduce, through the back door, the failure the unplaced list
exists to prevent — the export is the artefact that leaves the system, and a
finding that vanishes from it is a finding nobody will ever see.

The summary is written to stand on its own away from the app, because it is what
gets submitted as an example of a marked paper.

### The deliverable

`npm run export:sample --workspace server` grades a fixture and writes
`outputs/annotated_student_answer_A.pdf`. It is a script rather than a one-off
so the committed file can be regenerated instead of being an artefact nobody can
rebuild.

## The Gemini provider

`grade/gemini.ts` implements the same `GradeProvider` interface as the mock, and
nothing else in the system knows which one it has. `createProvider()` picks by
`GRADE_PROVIDER`; there is no special-casing anywhere downstream.

Because the prompt is already an ordered `PromptPart[]`, mapping it to Gemini is
a one-line transformation — text stays text, a PNG becomes `inlineData` base64,
and the order is preserved. This is the payoff for changing the interface at
stage 6: had the prompt still been a string with a marker in it, this file would
have had to parse it back apart.

The request asks for `responseMimeType: "application/json"` on top of the
prompt's own instruction, and `temperature: 0`, since marking should not wander
between runs any more than it has to.

### Retrying, and what does not get retried

One retry, and only for a failure worth retrying: 408, 429, 500, 502, 503, 504,
or a network fault. A 400, 401, 403 or 404 fails immediately — retrying a
refusal only wastes time and hides the cause. A malformed *answer* is not
retried here at all; that is the pipeline's repair attempt, which is a different
thing and belongs at a different level. An empty response is treated as a
failure rather than as an answer, carrying the finish reason so a truncated
generation is distinguishable from a refusal.

### Verified without the network

`geminiProvider()` accepts an optional base URL, so the provider can be pointed
at a local HTTP stub. `tests/gemini.test.ts` runs the real SDK against that stub
and asserts the request it actually produces: four parts in the order the prompt
builder set them, images as `inlineData` PNG base64, `responseMimeType` and
`temperature` as configured. It then drives the retry — a 503 followed by a 200
succeeds on the second attempt, a 403 is not retried at all, and two 429s fail
with a clean error.

That covers everything about this integration except the model's own answers.
Grading quality is a different question, and only the real API can answer it.
