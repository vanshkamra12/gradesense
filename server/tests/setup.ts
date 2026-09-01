import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gradesense-test-"));

process.env.DB_PATH = path.join(root, "data", "test.sqlite");
process.env.STORAGE_DIR = path.join(root, "storage");

/**
 * vitest does not read server/.env the way the CLI scripts do, so without this
 * the live accuracy test could never see GEMINI_API_KEY and would silently skip
 * — reporting a pass while proving nothing, which is the failure mode the
 * separation of these tests exists to avoid.
 *
 * Anything already set on the command line wins, so `GRADE_PROVIDER=mock` still
 * forces the offline path.
 */
const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env");

// Whether the live provider was asked for on the command line, before .env is
// read. A developer who has GRADE_PROVIDER=gemini in .env for day-to-day use
// must still get an offline run from a bare `npm test`; going live has to be a
// deliberate act, not a side effect of local configuration.
const askedForLiveProvider = process.env.GRADE_PROVIDER !== undefined;

if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key!] !== undefined) continue;
    process.env[key!] = rawValue!.replace(/^["']|["']$/g, "");
  }
}

if (!askedForLiveProvider) {
  process.env.GRADE_PROVIDER = "mock";
}
