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
