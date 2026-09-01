import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { locateFigure, locateQuote, FUZZY_THRESHOLD } from "../src/annotate/locate.js";
import { mockProvider } from "../src/grade/provider.js";
import { extractPdf, type ExtractedDocument } from "../src/pdf/extract.js";

describe("locateQuote against student_answer_A", () => {
  let doc: ExtractedDocument;

  beforeAll(async () => {
    doc = await extractPdf(
      new Uint8Array(fs.readFileSync(path.join(config.fixturesDir, "student_answer_A.pdf"))),
    );
  }, 30_000);

  const within = (rect: { x: number; y: number; w: number; h: number }, page: number) => {
    const source = doc.pages.find((p) => p.page === page)!;
    return (
      rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= source.width && rect.y + rect.h <= source.height
    );
  };

  describe("exact matching", () => {
    it("locates a quote that sits on a single line", () => {
      const found = locateQuote(doc, "It is true that technology also give many benefits.");

      expect(found.unplaced).toBe(false);
      expect(found.method).toBe("exact");
      expect(found.score).toBe(1);
      expect(found.page).toBe(2);
      expect(found.rects).toHaveLength(1);
      expect(within(found.rects[0]!, 2)).toBe(true);
    });

    it("narrows the box to the quote rather than the whole line", () => {
      // This sentence starts partway along its line.
      const found = locateQuote(doc, "The voltmetre is also connected in series");
      expect(found.rects[0]!.x).toBeGreaterThan(100);
    });
  });

  // The three inputs that actually occur in the real mock output.
  describe("the awkward real quotes", () => {
    it("matches a quote the model joined with a space where the source wraps with a newline", () => {
      const asExtracted =
        "In my diagram the battery, switch, resistor, bulb and the amether are all joined one after another in\nseries.";
      const asTheModelMightSendIt = asExtracted.replace(/\n/g, " ");

      expect(doc.pages[0]!.text).toContain(asExtracted);
      expect(doc.pages[0]!.text).not.toContain(asTheModelMightSendIt);

      const found = locateQuote(doc, asTheModelMightSendIt);
      expect(found.unplaced).toBe(false);
      expect(found.method).toBe("exact"); // exact after normalisation
      expect(found.page).toBe(1);
      expect(found.rects).toHaveLength(2);
    });

    it("matches a quote containing the struck-out false start in Q3(b)", () => {
      // Extraction cannot see the strike, so the abandoned clause runs straight
      // into the words that replaced it. The quote must still locate.
      const quote =
        "(b) The equilibrum point is the place where the demand From the table and from my graph the\nequilibrum of the market comes at the price of ₹40 and the quantity of 40 units, because this is the\npoint where the two curves are meeting each other.";

      const found = locateQuote(doc, quote);

      expect(found.unplaced).toBe(false);
      expect(found.page).toBe(2);
      expect(found.rects).toHaveLength(3);
      for (const rect of found.rects) expect(within(rect, 2)).toBe(true);
    });

    it("matches a quote containing a ligature-split word", () => {
      // "difference" is three separate text items: "di", "ff", "erence". Only
      // the joined page text spells the word, which is why matching runs there.
      const items = doc.pages[0]!.items.map((item) => item.text);
      expect(items).not.toContain("difference");
      expect(items).toContain("ff");

      const found = locateQuote(
        doc,
        "The battery is the source of energy and it provides the potential difference which pushes the current in the circuit.",
      );

      expect(found.unplaced).toBe(false);
      expect(found.page).toBe(1);
      expect(found.rects.length).toBeGreaterThan(0);
    });
  });

  describe("fuzzy matching", () => {
    it("still finds a quote whose spelling the model corrected", () => {
      // The student wrote "voltmetre"; a model that tidied it would send this.
      const found = locateQuote(
        doc,
        "The voltmeter is also connected in series in the same loop so that it can measure the voltage of the circuit.",
      );

      expect(found.unplaced).toBe(false);
      expect(found.method).toBe("fuzzy");
      expect(found.score).toBeGreaterThanOrEqual(FUZZY_THRESHOLD);
      expect(found.score).toBeLessThan(1);
      expect(found.page).toBe(1);
    });

    it("survives several misspellings at once", () => {
      const found = locateQuote(
        doc,
        "If we increase the resistance in the circuit then more current will flow through the bulb, because the resistance pushes the current forward with more force.",
      );

      expect(found.unplaced).toBe(false);
      expect(found.method).toBe("fuzzy");
      expect(found.score).toBeGreaterThan(0.95);
    });
  });

  describe("when nothing matches", () => {
    it("returns no box and marks the quote unplaced", () => {
      const found = locateQuote(
        doc,
        "The voltmeter is connected in parallel across the bulb as the marking scheme requires.",
      );

      expect(found.unplaced).toBe(true);
      expect(found.rects).toEqual([]);
      expect(found.page).toBeNull();
      expect(found.method).toBe("none");
    });

    // Never guess. A box in the wrong place is worse than no box.
    it("does not fall back to the page the model reported", () => {
      const found = locateQuote(doc, "Nothing in this sentence appears in the script at all.", 2);

      expect(found.unplaced).toBe(true);
      expect(found.page).toBeNull();
      expect(found.rects).toEqual([]);
    });

    it("returns unplaced for an empty quote", () => {
      expect(locateQuote(doc, "   ").unplaced).toBe(true);
    });
  });

  describe("multi-line quotes", () => {
    it("produces one rect per line rather than one tall rect", () => {
      const found = locateQuote(
        doc,
        "For example, in my own class many students directly search the solution of maths\nsums online and copy the steps without understanding why those steps are used.",
      );

      expect(found.rects).toHaveLength(2);

      // A single rect spanning both lines would be about twice as tall as the
      // text and would swallow the gap between them.
      const [first, second] = found.rects as [typeof found.rects[0], typeof found.rects[0]];
      expect(first.h).toBeLessThan(14);
      expect(second.h).toBeLessThan(14);
      expect(first.y).toBeGreaterThan(second.y); // ordered down the page
      expect(first.y - second.y).toBeGreaterThan(first.h); // a real gap between them
    });

    it("orders rects from the top of the page downwards", () => {
      const found = locateQuote(
        doc,
        "(c) When the market price is below the equilibrum price, the quantity supplied becomes more than the\nquantity demanded and this creates a surplus in the market.",
      );

      const ys = found.rects.map((r) => r.y);
      expect(ys).toEqual([...ys].sort((a, b) => b - a));
    });
  });

  describe("ambiguity", () => {
    const twice: ExtractedDocument = (() => {
      const line = "the equilibrum price";
      const text = `${line} appears here\nand ${line} appears here too`;
      const items = [
        { page: 1, text: `${line} appears here`, x: 72, y: 700, w: 200, h: 11, charStart: 0 },
        { page: 1, text: `and ${line} appears here too`, x: 72, y: 685, w: 220, h: 11, charStart: text.indexOf("and ") },
      ];
      return {
        pages: [{ page: 1, width: 596, height: 842, text, items, images: [] }],
        text,
        items,
      };
    })();

    it("reports that a quote matching twice was ambiguous, and still places it", () => {
      const found = locateQuote(twice, "the equilibrum price");

      expect(found.unplaced).toBe(false);
      expect(found.ambiguous).toBe(true);
      expect(found.rects.length).toBeGreaterThan(0);
    });

    it("is not ambiguous when the quote occurs once", () => {
      expect(locateQuote(twice, "appears here too").ambiguous).toBe(false);
    });

    it("prefers a match on the page the model reported", () => {
      const shared = "the same sentence on both pages";
      const pages = [1, 2].map((page) => ({
        page,
        width: 596,
        height: 842,
        text: shared,
        items: [{ page, text: shared, x: 72, y: 700, w: 200, h: 11, charStart: 0 }],
        images: [],
      }));
      const twoPages: ExtractedDocument = {
        pages,
        text: shared,
        items: pages.flatMap((p) => p.items),
      };

      expect(locateQuote(twoPages, shared, 2).page).toBe(2);
      expect(locateQuote(twoPages, shared, 1).page).toBe(1);
      expect(locateQuote(twoPages, shared, 2).ambiguous).toBe(true);
    });
  });

  describe("figure fallback", () => {
    it("anchors to the largest image and asks a human to confirm the position", () => {
      const found = locateFigure(doc);

      expect(found.anchor).toBe("figure");
      expect(found.needsPlacement).toBe(true);
      expect(found.unplaced).toBe(false);
      expect(found.rects).toHaveLength(1);

      // The supply/demand graph on page 2 is the larger of the two drawings.
      expect(found.page).toBe(2);
      expect(within(found.rects[0]!, 2)).toBe(true);
    });

    it("is unplaced when the document has no images at all", async () => {
      const blank = await extractPdf(
        new Uint8Array(fs.readFileSync(path.join(config.fixturesDir, "student_answer_D.pdf"))),
      );
      expect(locateFigure(blank).unplaced).toBe(true);
    });
  });

  describe("every quote the mock actually produces", () => {
    it("locates all 15 on the page the model reported", async () => {
      const response = JSON.parse(await mockProvider("valid").grade({ parts: [] }));

      for (const criterion of response.criteria) {
        const found = locateQuote(doc, criterion.evidence, criterion.page);

        expect(found.unplaced, `${criterion.criterionId} did not locate`).toBe(false);
        expect(found.page, `${criterion.criterionId} landed on the wrong page`).toBe(criterion.page);
        expect(found.rects.length).toBeGreaterThan(0);
        for (const rect of found.rects) {
          expect(within(rect, found.page!), `${criterion.criterionId} rect off-page`).toBe(true);
          expect(rect.w).toBeGreaterThan(0);
          expect(rect.h).toBeGreaterThan(0);
        }
      }
    }, 30_000);
  });
});
