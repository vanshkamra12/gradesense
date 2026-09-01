import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { extractPdf, type ExtractedDocument } from "../src/pdf/extract.js";

const read = (name: string) =>
  extractPdf(new Uint8Array(fs.readFileSync(path.join(config.fixturesDir, name))));

describe("extractPdf on student_answer_A", () => {
  let doc: ExtractedDocument;
  beforeAll(async () => {
    doc = await read("student_answer_A.pdf");
  });

  it("reads both pages with their dimensions", () => {
    expect(doc.pages).toHaveLength(2);
    for (const page of doc.pages) {
      expect(page.width).toBeCloseTo(596, 0);
      expect(page.height).toBeCloseTo(842, 0);
    }
  });

  it("finds the hand-drawn figure on each page", () => {
    // The circuit diagram and the supply/demand graph.
    expect(doc.pages.map((p) => p.images.length)).toEqual([1, 1]);
    for (const page of doc.pages) {
      for (const img of page.images) {
        expect(img.w).toBeGreaterThan(100);
        expect(img.h).toBeGreaterThan(100);
        expect(img.x).toBeGreaterThanOrEqual(0);
        expect(img.y).toBeGreaterThanOrEqual(0);
        expect(img.x + img.w).toBeLessThanOrEqual(page.width);
        expect(img.y + img.h).toBeLessThanOrEqual(page.height);
      }
    }
  });

  // locate.ts maps a matched character range back to items through charStart,
  // so this offset has to be exact or every bounding box lands in the wrong place.
  it("gives every item a charStart that indexes its own text in the page text", () => {
    for (const page of doc.pages) {
      for (const item of page.items) {
        expect(page.text.slice(item.charStart, item.charStart + item.text.length)).toBe(item.text);
      }
    }
  });

  it("rejoins ligatures split across items", () => {
    const text = doc.pages[0]!.text;
    expect(text).toContain("potential difference");
    expect(text).toContain("current can flow");
  });

  it("preserves the planted misspellings rather than correcting them", () => {
    const text = doc.text;
    expect(text).toContain("resistence");
    expect(text).toContain("amether");
    expect(text).toContain("voltmetre");
    expect(text).toContain("equilibrum");
  });
});

describe("extractPdf on student_answer_D", () => {
  it("reports one page with no images and nothing but question headings", async () => {
    const doc = await read("student_answer_D.pdf");

    expect(doc.pages).toHaveLength(1);
    expect(doc.pages[0]!.images).toHaveLength(0);

    // The sheet is blank in the sense that matters — the student wrote nothing —
    // but it is pre-printed with the three question headings, which is 53
    // non-whitespace characters. A raw character count would sail past the
    // spec's ~40 threshold and send a blank page to the model. The stage 8
    // guard has to discount the pre-printed scaffolding before counting.
    const lines = doc.text.split("\n").filter((l) => l.trim() !== "");
    expect(lines).toEqual([
      "Question 1 — Science",
      "Question 2 — English",
      "Question 3 — Economics",
    ]);

    const studentText = lines.filter((l) => !/^Question \d+ —/.test(l)).join("");
    expect(studentText.replace(/\s/g, "")).toHaveLength(0);
  });
});
