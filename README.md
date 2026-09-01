# GradeSense

Reads a student answer paper, marks it against a model answer and marking
scheme, produces an explainable per-criterion score, and draws annotations at
the right place on the page.

The marking is editable afterwards. Moving, changing or deleting an annotation
never re-runs grading.

## What is in this submission

| the brief asks for | where it is |
|---|---|
| a realistic student answer with planted mistakes | `fixtures/student_answer_A.pdf` |
| a short error key for it | `fixtures/error_key_script_a.md` |
| further test scripts and their key | `fixtures/student_answer_{B,C,D,E,F}.pdf`, `fixtures/scripts_B_C_E.md` |
| one example of an annotated answer paper | `outputs/annotated_student_answer_A.pdf` |
| tests and their output | `npm test`, captured in `outputs/test-output.txt` |
| a short architecture explanation | `ARCHITECTURE.md` (first section; the rest is reference) |
| setup and run instructions | this file |

`outputs/` also holds the live grading runs used to check accuracy
(`gemini-runs-script-a.txt`, `gemini-runs-B-C-E.txt`) and a one-page account of
the build (`build-summary.md`).

## Requirements

Node 20.19+ or 22.12+ (developed on 22.21). No database server, no cloud
services, and no API key needed to run the whole system against the mock
provider.

## Five-minute start

```bash
git clone <this repo>
cd gradesense
npm install                          # installs both workspaces
cp server/.env.example server/.env   # optional; the defaults work as-is
```

Then two terminals:

```bash
npm run dev:server                   # http://localhost:3001
npm run dev:web                      # http://localhost:5173
```

Open http://localhost:5173, upload `fixtures/student_answer_A.pdf`, and you get
a marked page with a per-criterion breakdown beside it. That works offline
against the mock provider — no key required.

Try `fixtures/student_answer_D.pdf` (a blank sheet) and
`fixtures/student_answer_F.pdf` (a handwritten scan) to see the two guards.

## Using the real model

Put a key in `server/.env` and select the provider:

```bash
GRADE_PROVIDER=gemini
GEMINI_API_KEY=your-key-here
```

### Pointing it at a different model

```bash
GEMINI_MODEL=gemini-3.5-flash        # the default
```

Any vision-capable Gemini model works — the scripts contain hand-drawn diagrams
that have to be read. Availability varies a lot by project and billing tier, so
check what your key can actually reach rather than assuming a name works:

| response | meaning | retrying helps? |
|---|---|---|
| `404` | the model is retired for new API users | no |
| `403` | the model is not enabled for your project | no |
| `429` with `limit: 0` | your tier grants no quota for it; needs billing | no |
| `429` with a real quota | ordinary rate limiting | yes — the provider retries once |
| `503` | the model is overloaded | yes — the provider retries once |

The provider retries once on 408/429/500/502/503/504 and network faults, and
fails immediately on 400/401/403/404, since retrying a refusal only hides the
cause.

The free tier allows **20 requests per model per day**
(`GenerateRequestsPerDayPerProjectPerModel-FreeTier`), counted separately for
each model. Exhausting one model does not affect another, so switching
`GEMINI_MODEL` gives a fresh allowance. A 429 quoting that quota id is a daily
cap and waiting will not clear it; a 429 quoting a per-minute quota will clear
in about a minute.

### Grading a script and comparing it to the error key

```bash
GRADE_PROVIDER=gemini npm run compare --workspace server        # one run
GRADE_PROVIDER=gemini npm run compare --workspace server -- 3   # three runs
```

Prints every criterion's mark, finding type, confidence and evidence quote
beside `fixtures/error_key_script_a.md`, names the disagreements, and — with a
count above 1 — shows which criteria stayed stable between runs.

## Environment variables

All read in one place, `server/src/config.ts`. `.env` is gitignored;
`server/.env.example` documents each one.

| variable | default | what it does |
|---|---|---|
| `PORT` | `3001` | API port |
| `GRADE_PROVIDER` | `mock` | `mock` or `gemini` |
| `MOCK_MODE` | `valid` | `valid`, `malformed`, `overmax`, `throws`, `badEvidence` |
| `GEMINI_API_KEY` | — | required only when `GRADE_PROVIDER=gemini` |
| `GEMINI_MODEL` | `gemini-3.5-flash` | any vision-capable Gemini model |
| `GEMINI_BASE_URL` | — | points the provider at a stub endpoint, for tests |
| `DB_PATH` | `server/data/gradesense.sqlite` | SQLite file |
| `STORAGE_DIR` | `server/storage` | uploaded originals and generated files |

## Tests

```bash
npm test                                            # offline, mock, no key
GRADE_PROVIDER=gemini npm test --workspace server   # adds the live accuracy check
```

A bare `npm test` stays offline even when `server/.env` sets
`GRADE_PROVIDER=gemini`. Going live has to be asked for on the command line, so
local configuration cannot quietly turn the offline suite into one that spends
API quota.

The suite is in two parts, on purpose:

- **Offline tests** verify the *pipeline* — enforcement, clamping, evidence
  verification, locating, persistence, annotation editing, export, error
  handling. They cannot verify grading quality, because the answers come from a
  mock.
- **`tests/script-a-accuracy.test.ts`** is the only test that says anything
  about grading quality. It grades Script A with the real provider and checks it
  against the error key. Without a key it **skips** rather than falling back to
  the mock, so the suite never appears to prove more than it does.

## Other scripts

```bash
npm run build                                        # typecheck + compile + bundle
npm run typecheck                                    # types only
npm run print:extract --workspace server -- <pdf>    # text, boxes, page sizes
npm run print:rubric  --workspace server             # the parsed 15 criteria
npm run print:prompt  --workspace server -- <pdf>    # the assembled prompt
npm run print:locate  --workspace server             # where each quote landed
npm run render:pages  --workspace server -- <pdf>    # page PNGs
npm run export:sample --workspace server             # writes outputs/annotated_*.pdf
```

## Layout

```
server/    Express API, PDF handling, grading pipeline, SQLite
web/       React + Vite frontend
fixtures/  Question paper, model answer, sample scripts, Script A error key
outputs/   Submission artefacts: annotated PDF, test output, live grading runs
```

`ARCHITECTURE.md` explains how it fits together and why.

## Known limitations

Both are real, unfixed, and recorded in `outputs/test-output.txt` beside the run
that produced them.

**Confidence is not well calibrated.** Values cluster at 0.90–1.00 even on
criteria the marking scheme itself calls arguable. The prompt anchors confidence
to observable conditions rather than to a feeling, which spread the values out
from a flat 1.00, but did not push the genuinely uncertain criteria below 0.9.
The practical effect is that overall confidence sits near 0.95 and the
human-review flag does not fire on runs where the marking is in fact uncertain.
Enforcement cannot compensate: it only lowers confidence when it has had to
correct something, and on a clean run there is nothing to correct.

**Criterion bleed on Q2.C1, at an observed rate of about 1 run in 6.** The model
sometimes marks "presents a clear position" down because the *conclusion*
contradicts it — the Q2.C5 error charged twice. When it happens the total falls
to 7, one below the expected 8–10 band. The accuracy test asserts Q2.C1–C4 score
1, so it fails on such a run rather than hiding it. That assertion is kept
strict deliberately: a suite that fails one run in six and names the reason is
worth more than a green one that conceals the problem.

Grading quality depends on the model. The figures in `outputs/` were produced on
`gemini-3.6-flash` and `gemini-3.5-flash` — each file names the model it used.
The pro tiers returned `429` with `limit: 0` on the key available here.
