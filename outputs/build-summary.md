# GradeSense - what was built, and what was learned building it

A one-page account of the decisions that mattered, the bugs that were real, and
what the system does when it is not sure.

---

## The idea the whole thing turns on

A language model will confidently produce a mark it cannot justify, a quote that
does not exist, and a coordinate it invented. So the model is asked only for the
judgement it can actually make - did the student make this point, and in which of
their own words - and **everything checkable is checked in code**.

It is never asked for a total. Never asked for a coordinate. Totals are
arithmetic; positions are string matching. Both happen where they can be
verified.

---

## Six decisions that shaped the result

**1. The marking scheme is parsed, not prompted.** The 15 criteria come out of
the model answer PDF deterministically, and the parser cross-checks the heading
marks, the table total, and the sum of criteria against each other before
returning anything. A silent mis-parse cannot produce a plausible-looking
rubric.

**2. The guidance blocks are first-class data, held verbatim.** Most of the
signal in the marking scheme is not in the criterion wording - it is in the
prose underneath: that a voltmeter in series is a substantive error, and that a
student may reach the opposite conclusion and still score 5/5. Those sentences go
into the prompt untouched, under a heading naming them authoritative. A test
asserts each survives parsing.

**3. `enforce.ts` iterates the rubric, not the model's answer.** That one choice
makes the criterion set correct by construction: an omitted criterion is filled
because the loop reaches it anyway, an invented one is never reached, and the
output is always the 15 in scheme order. Nothing is checked afterwards because
nothing can be wrong.

**4. Annotations live in their own table with no link to the marks.**
`routes/annotations.ts` reaches exactly three modules at runtime - itself,
`db.ts`, `config.ts`. The grading pipeline is not in that graph, so "editing
never re-grades" is not a discipline, it is an absence of any path. A test walks
the import graph and asserts it.

**5. The prompt is an ordered array, not a string.** An early version passed one
string with a `<<<PAGE_IMAGES>>>` marker for the provider to split on. The type
said "string" while the real contract was "string containing a magic token in
the right position". Replacing it with `PromptPart[]` made ordering the type's
business - and made the Gemini provider a one-line mapping instead of a parser.

**6. The prompt never names the errors in any particular script.** A test
asserts the instruction sections contain no subject terms at all - no
"voltmeter", no "equilibrium", no criterion IDs. The marking scheme and the
student's text naturally contain such words and must; our own prose must not, or
a passing grade proves only that the model can follow a hint.

---

## Bugs that were real

**The blank sheet was not blank.** `student_answer_D.pdf` carries 53
non-whitespace characters - the pre-printed question headings - comfortably past
the spec's ~40 threshold. The guard would have sent an empty page to the model.
Fixed by measuring what the *student* contributed: page text minus every line
that also appears in the question paper. That leaves exactly zero.

**Findings that could not be placed were silently dropped.** On the handwritten
script every quote is unverifiable, so the annotation builder returned nothing -
producing a blank page beside an empty sidebar that looked like a clean pass.
This was the worst bug in the build: a wrong mark is visible and arguable, but a
finding that never appears cannot be questioned at all, and the system looked
most confident exactly where it had failed. Unplaced findings are now listed
under a heading that says so, with a **place** button that lets the teacher
position what we could not.

**Fuzzy matching could never run.** `enforce` verified a quote by exact
containment while `locate` matched fuzzily - so a quote whose spelling the model
had tidied was stripped as a hallucination *before* the fuzzy matcher saw it.
The matcher existed precisely for that case and was unreachable. Both now use
one matcher: a quote is real if the locator could find it. Found by writing the
OCR test case.

**The live accuracy test was silently skipping.** It reported "1 passed" in
427ms. vitest does not load `server/.env`, so the API key was invisible and the
only test that proves anything about grading quality never ran - reporting a
pass while proving nothing, which is the exact failure the two-part suite exists
to prevent.

**Two UI bugs the tests could not see, found by driving a browser.**
`scrollIntoView` scrolls every scrollable ancestor, so selecting a criterion
dragged the paper around underneath. And a smooth scroll landed at 22px of a
1299px target, because the canvas repainting beside it cancels the animation -
that one would have failed live on camera.

---

## What it does when it is not sure

This is the part worth showing.

**It says which quotes it could not find.** Evidence is verified against the
extracted text. A quote that is not there is removed, its confidence capped at
0.2, and the finding listed as unplaced - never anchored to a guess. Placing an
invented quote on the diagram would be inventing a position for it, and on
screen it would look exactly as authoritative as a real one.

**It writes down every correction it made to itself.** The `adjustments` array
is an audit trail in plain language, and a filled-in criterion and a hallucinated
quote deliberately read differently - one is silence, the other a false
statement:

```
Q1.C1: awarded 2 of a maximum 1 - clamped to 1.
Q2.C3: the model returned no result for this criterion - recorded as 0 of 1,
       missing, with no confidence.
Q1.C2: the quoted evidence does not appear anywhere in the student's answer -
       the quote was removed as unverifiable and confidence lowered from 0.95
       to 0.2.
The model returned a total of 99. Totals are never taken from the model -
recomputed from the criterion marks as 8 of 15.
```

**It refuses to guess a position.** A quote that matches nothing gets no
rectangle. There is no fallback to "somewhere on the reported page". A box in
the wrong place is worse than no box, because it looks equally authoritative.

**It distinguishes blank from unreadable.** A blank sheet returns zero at
confidence 1 with no review flag and **no model call at all** - an empty page is
not an ambiguous one. A handwritten scan with no extractable text is graded, but
capped at 0.5 confidence and flagged with the actual cause: how many characters
were found, and that the marking may rest on the images alone.

**Any correction forces review.** A high-confidence result with one clamped
criterion still goes to a human. The model being sure of itself says nothing
about the thing that had to be corrected.

---

## How well it actually marks

Six live runs of Script A against `gemini-3.6-flash`, compared to the error key's
expected 9/15:

- **Totals: 8, 8, 9, 7, 8, 8.** Five of six inside the 8–10 band.
- **All six criteria the key calls unambiguous scored 0 in every run.**
- **The most important control held.** The student argues the *opposite* of the
  model answer in Q2. Q2.C1–C4 were credited in full in every run - the grader
  is marking reasoning, not resemblance.
- **45 of 45 evidence quotes located**, none stripped, including quotes
  containing `₹40` and the struck-out false start in Q3(b).
- The only unstable criterion is **Q1.C5** - which the error key itself names as
  genuinely arguable.

## What is still wrong

**Confidence is not calibrated.** Values cluster at 0.90–1.00 even on criteria
the marking scheme calls arguable. One attempt was made - anchoring confidence to
observable conditions rather than a feeling - which spread the values out from a
flat 1.00 but did not push the uncertain ones below 0.9. So the review flag does
not fire on runs where the marking genuinely is uncertain. Enforcement cannot
compensate: it only lowers confidence when it has had to correct something.

**Criterion bleed on Q2.C1, about 1 run in 6.** The model sometimes marks
"presents a clear position" down because the *conclusion* contradicts it - the
Q2.C5 error charged twice, which the prompt's independence rule forbids. The
total falls to 7. The accuracy test asserts Q2.C1–C4 score 1, so it **fails** on
such a run rather than hiding it. That was a deliberate choice: a suite that
fails one run in six and names the reason is worth more than a green one that
conceals criterion bleed.

---

## By the numbers

165 tests, 15 files. The eight required cases run offline against a mock and
verify the pipeline; one separate test grades Script A with the real provider and
is the only thing in the suite that says anything about grading quality. Without
a key it skips rather than falling back to the mock, so the suite never appears
to prove more than it does.
