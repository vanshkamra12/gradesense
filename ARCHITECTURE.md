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

The images have to sit between the student's text and the output contract, but
the provider interface takes a single prompt string. So the prompt contains a
`<<<PAGE_IMAGES>>>` marker line at that position; the Gemini provider splits on
it and interleaves the image parts, and the mock ignores it. That keeps the
ordering real rather than nominal without widening the interface.

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
appending a correction section that quotes the specific reason the last response
was unusable, and then fails with a structured error carrying every raw attempt.

A failed run returns `{ ok: false, error }` and never a partial result. There is
no path that returns some criteria and an error.
