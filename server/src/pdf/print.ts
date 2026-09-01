/**
 * Development tool: dumps what extract.ts sees for a PDF, so extraction can be
 * eyeballed against the real page before anything downstream depends on it.
 *
 *   npm run print:extract --workspace server -- fixtures/student_answer_A.pdf
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { extractPdf } from "./extract.js";

const arg = process.argv[2] ?? path.join(config.fixturesDir, "student_answer_A.pdf");
const file = path.resolve(process.cwd(), arg);

if (!fs.existsSync(file)) {
  console.error(`No such file: ${file}`);
  process.exit(1);
}

const round = (n: number) => Math.round(n * 10) / 10;

const doc = await extractPdf(new Uint8Array(fs.readFileSync(file)));

console.log(`file: ${file}`);
console.log(`pages: ${doc.pages.length}`);

for (const page of doc.pages) {
  const nonWhitespace = page.text.replace(/\s/g, "").length;

  console.log(`\n${"=".repeat(78)}`);
  console.log(
    `PAGE ${page.page}  ${round(page.width)} x ${round(page.height)} pt  ` +
      `| text items: ${page.items.length}  | chars: ${page.text.length} ` +
      `(${nonWhitespace} non-whitespace)  | images: ${page.images.length}`,
  );
  console.log("=".repeat(78));

  if (page.images.length > 0) {
    console.log("\nEmbedded images (PDF user space, origin bottom-left):");
    for (const [i, img] of page.images.entries()) {
      console.log(
        `  [${i}] x=${round(img.x)} y=${round(img.y)} ` +
          `w=${round(img.w)} h=${round(img.h)}  area=${round(img.w * img.h)}`,
      );
    }
  }

  console.log("\nText items:");
  console.log("  idx  charStart  x       y       w       h      text");
  for (const [i, item] of page.items.entries()) {
    const pos = [
      String(i).padStart(5),
      String(item.charStart).padStart(10),
      round(item.x).toString().padStart(8),
      round(item.y).toString().padStart(8),
      round(item.w).toString().padStart(8),
      round(item.h).toString().padStart(7),
    ].join("");
    console.log(`${pos}  ${JSON.stringify(item.text)}`);
  }

  console.log("\nConcatenated page text:");
  console.log("-".repeat(78));
  console.log(page.text);
  console.log("-".repeat(78));
}
