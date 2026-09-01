import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gradesense-test-"));

process.env.DB_PATH = path.join(root, "data", "test.sqlite");
process.env.STORAGE_DIR = path.join(root, "storage");
