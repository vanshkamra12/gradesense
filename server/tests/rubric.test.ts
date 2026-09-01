import { beforeAll, describe, expect, it } from "vitest";
import { loadRubric, parseRubric, type Rubric } from "../src/grade/rubric.js";

describe("rubric parsed from model_answer.pdf", () => {
  let rubric: Rubric;
  beforeAll(async () => {
    rubric = await loadRubric();
  }, 30_000);

  // This is the assertion that protects everything downstream. enforce.ts fills
  // in omitted criteria and drops invented ones against exactly this list.
  it("has exactly 15 criteria worth 1 mark each", () => {
    expect(rubric.criteria).toHaveLength(15);
    expect(rubric.totalMarks).toBe(15);
    for (const criterion of rubric.criteria) {
      expect(criterion.maxMarks).toBe(1);
    }
  });

  it("has three questions of five criteria each", () => {
    expect(rubric.questions.map((q) => q.id)).toEqual(["Q1", "Q2", "Q3"]);
    expect(rubric.questions.map((q) => q.subject)).toEqual(["Science", "English", "Economics"]);
    for (const question of rubric.questions) {
      expect(question.criteria).toHaveLength(5);
      expect(question.maxMarks).toBe(5);
    }
  });

  it("numbers criteria as Qn.Cm and keeps them attached to their question", () => {
    expect(rubric.criteria.map((c) => c.id)).toEqual([
      "Q1.C1", "Q1.C2", "Q1.C3", "Q1.C4", "Q1.C5",
      "Q2.C1", "Q2.C2", "Q2.C3", "Q2.C4", "Q2.C5",
      "Q3.C1", "Q3.C2", "Q3.C3", "Q3.C4", "Q3.C5",
    ]);
    for (const criterion of rubric.criteria) {
      expect(criterion.id.startsWith(criterion.questionId)).toBe(true);
    }
  });

  it("reassembles criteria whose text wraps onto a second line", () => {
    const byId = (id: string) => rubric.criteria.find((c) => c.id === id)!.text;
    expect(byId("Q1.C4")).toBe(
      "Correctly explains the relationship between resistance and current, " +
        "including the relevant principle/Ohm's law",
    );
    expect(byId("Q3.C5")).toBe(
      "Correctly explains the resulting tendency toward a higher equilibrium price " +
        "and lower equilibrium quantity, with the change represented appropriately on the graph",
    );
  });

  it("carries a non-empty guidance block for Q1 and Q2", () => {
    const guidance = (id: string) => rubric.questions.find((q) => q.id === id)!.guidance;
    expect(guidance("Q1").length).toBeGreaterThan(0);
    expect(guidance("Q2").length).toBeGreaterThan(0);
    // The marking scheme has no guidance block under Q3.
    expect(guidance("Q3")).toEqual([]);
  });

  // The guidance is most of the signal in the marking scheme. If any of these
  // three sentences is lost or reworded, the grader stops behaving correctly on
  // exactly the cases the error key calls controls.
  it("preserves the three load-bearing guidance sentences verbatim", () => {
    const q1 = rubric.questions[0]!.guidance.join(" ");
    const q2 = rubric.questions[1]!.guidance.join(" ");

    expect(q1).toContain(
      "if the student places the voltmeter in series with the bulb, that is a " +
        "substantive error and should affect the relevant rubric mark.",
    );
    expect(q1).toContain("The student does not need to reproduce the model answer word-for-word.");
    expect(q2).toContain(
      "A student does not have to reach the same conclusion as the model answer.",
    );
    expect(q2).toContain("That can still receive 5/5 if the student develops the argument properly");
    expect(q2).toContain(
      "evaluates quality of reasoning rather than similarity to the model answer.",
    );
  });

  it("keeps the model answer prose separate from the rubric", () => {
    expect(rubric.modelAnswers.map((m) => m.questionId)).toEqual(["Q1", "Q2", "Q3"]);
    for (const answer of rubric.modelAnswers) {
      expect(answer.text.split(/\s+/).length).toBeGreaterThan(100);
    }

    // Reference material, not criterion text — the two must not bleed together.
    const q3 = rubric.modelAnswers[2]!.text;
    expect(q3).toContain("intersect at a price of ₹30 and a quantity of 60 units");
    for (const criterion of rubric.criteria) {
      expect(criterion.text).not.toContain("Model Answer");
      expect(criterion.text.length).toBeLessThan(200);
    }
  });
});

describe("parseRubric error handling", () => {
  const section = [
    "Q1 — Science",
    "Model Answer — 5 marks",
    "Some model answer prose.",
    "Marking rubric",
    "Criterion Marks",
    "First criterion 1",
    "Second criterion 1",
    "Third criterion 1",
    "Fourth criterion 1",
    "Fifth criterion 1",
    "Total 5",
  ];

  it("parses a well-formed section", () => {
    const rubric = parseRubric(section.join("\n"));
    expect(rubric.criteria).toHaveLength(5);
    expect(rubric.totalMarks).toBe(5);
  });

  it("refuses a table whose criteria do not sum to its total", () => {
    const short = section.filter((l) => l !== "Fifth criterion 1");
    expect(() => parseRubric(short.join("\n"))).toThrow(/sum to 4 .* totals 5/);
  });

  it("refuses a heading whose marks disagree with the table total", () => {
    const mismatched = section.map((l) => (l === "Model Answer — 5 marks" ? "Model Answer — 4 marks" : l));
    expect(() => parseRubric(mismatched.join("\n"))).toThrow(/says 4 marks .* totals 5/);
  });

  it("refuses a rubric row with no mark", () => {
    const dangling = [...section];
    dangling.splice(dangling.indexOf("Total 5"), 0, "A row that never got a mark");
    expect(() => parseRubric(dangling.join("\n"))).toThrow(/row with no mark/);
  });
});

describe("determinism", () => {
  it("produces an identical rubric on a second parse", async () => {
    const first = await loadRubric();
    const second = parseRubric(
      // Re-parse from the same source rather than reusing the memoised promise.
      first.questions
        .map((q) => {
          const answer = first.modelAnswers.find((m) => m.questionId === q.id)!;
          return [
            `${q.id} — ${q.subject}`,
            `Model Answer — ${q.maxMarks} marks`,
            answer.text,
            "Marking rubric",
            "Criterion Marks",
            ...q.criteria.map((c) => `${c.text} ${c.maxMarks}`),
            `Total ${q.maxMarks}`,
            ...(q.guidance.length > 0 ? ["Important grading guidance", ...q.guidance] : []),
          ].join("\n");
        })
        .join("\n"),
    );
    expect(second.criteria).toEqual(first.criteria);
    expect(second.questions.map((q) => q.guidance)).toEqual(
      first.questions.map((q) => q.guidance),
    );
  }, 30_000);
});
