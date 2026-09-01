import { createCanvas, loadImage } from "@napi-rs/canvas";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { renderPdfPages, type RenderedPage } from "../src/pdf/render.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** Share of pixels that are not the white background we paint first. */
async function inkCoverage(png: Buffer): Promise<number> {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, image.width, image.height);

  let inked = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i]! < 240 || data[i + 1]! < 240 || data[i + 2]! < 240) inked++;
  }
  return inked / (image.width * image.height);
}

describe("renderPdfPages", () => {
  let pages: RenderedPage[];
  beforeAll(async () => {
    const file = path.join(config.fixturesDir, "student_answer_A.pdf");
    pages = await renderPdfPages(new Uint8Array(fs.readFileSync(file)));
  }, 30_000);

  it("renders every page as a PNG at 2x the page size", () => {
    expect(pages).toHaveLength(2);
    for (const page of pages) {
      expect(page.png.subarray(0, 4)).toEqual(PNG_MAGIC);
      expect(page.scale).toBe(2);
      // The fixture pages are 596 x 842 pt.
      expect(page.width).toBe(1192);
      expect(page.height).toBe(1684);
    }
  });

  // A transparent or blank canvas would still encode to a valid PNG of the
  // right size, so check that something was actually drawn.
  it("draws content on an opaque white background", async () => {
    for (const page of pages) {
      const coverage = await inkCoverage(page.png);
      expect(coverage).toBeGreaterThan(0.01);
      expect(coverage).toBeLessThan(0.9);
    }
  });

  it("renders larger images at a higher scale", async () => {
    const file = path.join(config.fixturesDir, "student_answer_D.pdf");
    const at1x = await renderPdfPages(new Uint8Array(fs.readFileSync(file)), 1);
    expect(at1x).toHaveLength(1);
    expect(at1x[0]!.width).toBe(596);
    expect(at1x[0]!.height).toBe(842);
  }, 30_000);
});
