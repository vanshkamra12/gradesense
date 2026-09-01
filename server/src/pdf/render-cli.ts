/**
 * Development tool: writes each page of a PDF to a PNG so the rasterisation the
 * model will see can be opened and eyeballed.
 *
 *   npm run render:pages --workspace server -- ../fixtures/student_answer_A.pdf
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { renderPdfPages, DEFAULT_RENDER_SCALE } from "./render.js";

const arg = process.argv[2] ?? path.join(config.fixturesDir, "student_answer_A.pdf");
const file = path.resolve(process.cwd(), arg);
const scale = Number(process.argv[3] ?? DEFAULT_RENDER_SCALE);

if (!fs.existsSync(file)) {
  console.error(`No such file: ${file}`);
  process.exit(1);
}

const outDir = path.join(config.storageDir, "preview");
fs.mkdirSync(outDir, { recursive: true });

const stem = path.basename(file, path.extname(file));
const pages = await renderPdfPages(new Uint8Array(fs.readFileSync(file)), scale);

console.log(`${file}\nscale: ${scale}x -> ${outDir}\n`);
for (const page of pages) {
  const out = path.join(outDir, `${stem}-p${page.page}.png`);
  fs.writeFileSync(out, page.png);
  console.log(
    `page ${page.page}: ${page.width}x${page.height}px  ` +
      `${(page.png.length / 1024).toFixed(0)} KB  ${out}`,
  );
}
