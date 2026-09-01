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
"difference" arrives as "di", "ff", "erence", and only the joined page text
spells the word the student wrote.

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

### What extraction cannot see

Struck-out text is not distinguishable here. In Script A the false start in Q3
part (b) is drawn with a separate graphic line over ordinary text, so the
extracted page text reads "...where the demand From the table and from my
graph...", running the abandoned clause straight into the real answer. Only the
rasterised page image shows the strike, which is why the prompt has to tell the
model to ignore struck-out text rather than the extractor filtering it out.
