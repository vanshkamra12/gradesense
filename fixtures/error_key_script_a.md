# Script A - Error Key

**Script:** `student_answer_A.pdf`
**Type:** Partially correct answer (development fixture)
**Expected total:** 9 / 15

This file is the ground truth for Script A. Every mistake below was planted
deliberately. The grading system is expected to reproduce the per-criterion
marks in the table at the end.

Errors are split into two kinds:

- **Scoring errors** - substantive mistakes that should cost a rubric mark.
- **Control errors** - surface mistakes (spelling, grammar, layout) that should
  **not** cost a rubric mark. These exist to check that the grader does not
  over-penalise presentation.

---

## A-Q1-1 - Voltmeter connected in series

- **Type:** Scoring
- **Location:** Q1, paragraph 3, and in the hand-drawn circuit diagram
- **Student claim:** The voltmeter is connected in series in the main loop so
  that it can measure the voltage of the circuit.
- **Correct version:** The voltmeter must be connected in parallel across the
  bulb, because it measures the potential difference between the two ends of
  the bulb.
- **Rubric point:** Q1 Criterion 2 - correct placement of ammeter in series and
  voltmeter in parallel across the bulb
- **Expected mark:** 0 / 1
- **Note:** The marking scheme names this error explicitly as substantive. The
  ammeter placement is correct, but the criterion covers both instruments as a
  single mark, so the mark is not awarded.

## A-Q1-2 - Resistance and current relationship inverted

- **Type:** Scoring
- **Location:** Q1, final paragraph
- **Student claim:** Increasing the resistance makes more current flow, because
  the resistance pushes the current forward with more force; a higher
  resistance gives a brighter bulb.
- **Correct version:** With the battery voltage constant, increasing the
  resistance decreases the current (V = IR). The bulb would grow dimmer, not
  brighter.
- **Rubric point:** Q1 Criterion 4 - relationship between resistance and current
- **Expected mark:** 0 / 1

## A-Q1-3 - Spelling errors

- **Type:** Control
- **Location:** Q1, throughout
- **Student text:** "resistence", "amether", "voltmetre"
- **Correct version:** resistance, ammeter, voltmeter
- **Rubric point:** none
- **Expected effect on marks:** none. The physics being described is
  identifiable despite the spelling. Flagging these as feedback is correct;
  deducting a rubric mark for them is not.

---

## A-Q2-1 - Conclusion contradicts the argument

- **Type:** Scoring
- **Location:** Q2, final paragraph
- **Student claim:** After arguing throughout that technology makes students
  dependent on easy answers, the answer concludes that technology is making
  learning much better and every student should use it as much as possible.
- **Correct version:** The conclusion should follow from the body - for example,
  that technology harms learning when used as a substitute for thinking, and so
  its use needs to be deliberate rather than maximal.
- **Rubric point:** Q2 Criterion 5 - coherent conclusion that follows from the
  discussion
- **Expected mark:** 0 / 1

## A-Q2-2 - Position differs from the model answer

- **Type:** Control
- **Location:** Q2, throughout
- **Student claim:** Technology makes students dependent rather than better
  learners.
- **Correct version:** Not applicable. The model answer reaches a balanced
  conclusion, but the marking scheme states directly that a student arguing the
  opposing position can still receive full marks if the argument is developed.
- **Rubric point:** Q2 Criteria 1–4
- **Expected marks:** 1 / 1 on each. The position is clear, the argument is
  developed, the opposing viewpoint is addressed in paragraph 2, and a concrete
  example is given.
- **Note:** This is the single most important control in the set. A grader built
  on similarity to the model answer will wrongly penalise this and score Q2 low.

## A-Q2-3 - Grammar errors

- **Type:** Control
- **Location:** Q2, paragraph 2
- **Student text:** "technology also give many benefits"; "digital libraries has
  made information available"; "available in few seconds"
- **Correct version:** gives; have made; in a few seconds
- **Rubric point:** none
- **Expected effect on marks:** none. Worth surfacing as feedback only.

---

## A-Q3-1 - Equilibrium stated incorrectly

- **Type:** Scoring
- **Location:** Q3 part (b), and the label written on the hand-drawn graph
- **Student claim:** Equilibrium is at ₹40 and 40 units.
- **Correct version:** Equilibrium is at ₹30 and 60 units, where quantity
  demanded equals quantity supplied.
- **Rubric point:** Q3 Criterion 2 - correctly identifies the equilibrium and
  explains why it is equilibrium
- **Expected mark:** 0 / 1
- **Note:** The curves are drawn by hand and cross near ₹30 / 60 units - close
  to the correct equilibrium, but not pixel-exact. The written claim of ₹40 /
  40 units does not match the drawing. Only the student's stated interpretation
  is wrong. A grader that reads the written figure without reconciling it
  against the plotted curves reaches the right mark for the wrong reason; a
  grader that reads only the graph may wrongly award the mark. The hand-drawn
  imprecision is deliberate and should not by itself cost a mark under
  Criterion 1.

## A-Q3-2 - Shortage and surplus reversed

- **Type:** Scoring
- **Location:** Q3 part (c)
- **Student claim:** Below equilibrium there is a surplus; above equilibrium
  there is a shortage.
- **Correct version:** Below the equilibrium price, quantity demanded exceeds
  quantity supplied, creating a shortage. Above it, quantity supplied exceeds
  quantity demanded, creating a surplus.
- **Rubric point:** Q3 Criterion 3 - shortage below equilibrium, surplus above
- **Expected mark:** 0 / 1

## A-Q3-3 - New equilibrium after a supply shift stated incorrectly

- **Type:** Scoring
- **Location:** Q3, final line
- **Student claim:** After the supply curve shifts left, the new equilibrium is
  at a lower price and a lower quantity.
- **Correct version:** A leftward shift in supply, with demand unchanged, gives
  a higher equilibrium price and a lower equilibrium quantity.
- **Rubric point:** Q3 Criterion 5 - resulting tendency toward higher price and
  lower quantity
- **Expected mark:** 0 / 1
- **Note:** The quantity half of the claim is right and the price half is wrong.
  Useful for checking that partial correctness inside a single criterion does
  not produce a fractional mark - each criterion is worth exactly 1 and must
  resolve to 0 or 1.

## A-Q3-4 - Sub-parts written out of order

- **Type:** Control
- **Location:** Q3, structure of the whole answer
- **Detail:** The student writes part (c) before part (b), with a struck-out
  false start at the beginning of (b) and a margin note reading "written below
  by mistake".
- **Correct version:** Parts answered in order (a), (b), (c), (d).
- **Rubric point:** none
- **Expected effect on marks:** none. All four parts are present and each is
  identifiable. This checks that the grader locates content by what it says
  rather than by where it sits on the page, and that struck-out text is not
  read as the student's answer.

## A-Q3-5 - Spelling error

- **Type:** Control
- **Location:** Q3, parts (b), (c) and (d)
- **Student text:** "equilibrum"
- **Correct version:** equilibrium
- **Rubric point:** none
- **Expected effect on marks:** none.

---

## Expected marks

| Question | C1 | C2 | C3 | C4 | C5 | Total |
|----------|----|----|----|----|----|-------|
| Q1 — Science | 1 | 0 | 1 | 0 | 1 | 3 / 5 |
| Q2 — English | 1 | 1 | 1 | 1 | 0 | 4 / 5 |
| Q3 — Economics | 1 | 0 | 0 | 1 | 0 | 2 / 5 |
| **Overall** | | | | | | **9 / 15** |

### Criteria expected to be uncertain

Two items are genuinely arguable and are reasonable candidates for a low
confidence score and a human-review flag:

- **Q1 Criterion 5** - the diagram is labelled and shows current direction, but
  it also contains the miswired voltmeter, so "clear and logically structured"
  is defensible either way.
- **Q3 Criterion 5** - half the claim is correct (lower quantity) and half is
  wrong (lower price).

A grader that flags these two while remaining confident about the clear-cut
items is behaving correctly.

### Notes on assertions

Per-criterion marks for A-Q1-1, A-Q1-2, A-Q3-1, A-Q3-2 and A-Q2-1 are
unambiguous and should be asserted exactly in tests. The overall total should be
asserted as a range (8–10) rather than an exact value, since model output varies
between runs on the two uncertain criteria above.
