import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// src/ during dev, dist/ after a build - both are one level under server/.
export const serverRoot = path.resolve(here, "..");
export const repoRoot = path.resolve(serverRoot, "..");

export const config = {
  port: Number(process.env.PORT ?? 3001),
  // Where uploaded originals and generated files live. Never inside src/.
  storageDir: process.env.STORAGE_DIR ?? path.join(serverRoot, "storage"),
  dbPath: process.env.DB_PATH ?? path.join(serverRoot, "data", "gradesense.sqlite"),
  gradeProvider: process.env.GRADE_PROVIDER ?? "mock",
  mockMode: process.env.MOCK_MODE ?? "valid",
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-3.5-flash",
  // Overridable so the provider can be pointed at a local stub and verified
  // without network access. Empty means the real Gemini endpoint.
  geminiBaseUrl: process.env.GEMINI_BASE_URL ?? "",
  fixturesDir: path.join(repoRoot, "fixtures"),
};
