import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

/**
 * Relative imports of a module, excluding type-only ones.
 *
 * `import type { X } from "..."` and `import { type X }` are erased by the
 * compiler and cannot cause code to run, so they are not part of the runtime
 * graph. Everything else is.
 */
function runtimeImports(file: string): string[] {
  const source = fs.readFileSync(file, "utf8");
  const imports: string[] = [];

  // Every specifier is matched, bare ones included, and non-relative ones are
  // discarded afterwards. Matching only relative specifiers lets the lazy
  // clause run past a bare import like "node:crypto" and swallow the three
  // statements after it, which reports the wrong module as a runtime import.
  const pattern = /import\s+(type\s+)?([\s\S]*?)\s*from\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    const [, typeKeyword, clause, specifier] = match;
    if (!specifier!.startsWith(".")) continue; // a package, not our code
    if (typeKeyword) continue; // import type { ... } from "..."

    // A clause whose every named binding is `type X` is also fully erased.
    const named = clause?.match(/\{([\s\S]*)\}/)?.[1];
    if (named !== undefined && clause?.trim().startsWith("{")) {
      const bindings = named.split(",").map((b) => b.trim()).filter(Boolean);
      if (bindings.length > 0 && bindings.every((b) => b.startsWith("type "))) continue;
    }

    imports.push(path.resolve(path.dirname(file), specifier!.replace(/\.js$/, ".ts")));
  }

  return imports;
}

/** Every module reachable at runtime from an entry point. */
function reachableFrom(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    queue.push(...runtimeImports(file));
  }

  return [...seen].map((file) => path.relative(srcRoot, file)).sort();
}

/**
 * The requirement is that editing an annotation cannot re-grade the paper, and
 * this checks it structurally rather than by inspection: the grading pipeline is
 * not reachable from the annotation routes at all, so there is no call path to
 * find. It fails the moment someone adds an import that would create one.
 */
describe("annotation editing is structurally isolated from grading", () => {
  const GRADING_MODULES = [
    "grade/pipeline.ts",
    "grade/provider.ts",
    "grade/prompt.ts",
    "grade/enforce.ts",
    "grade/guard.ts",
    "grade/rubric.ts",
    "grade/schema.ts",
    "pdf/render.ts",
    "pdf/extract.ts",
    "annotate/locate.ts",
    "annotate/annotations.ts",
  ];

  it("cannot reach any grading module from the annotation routes", () => {
    const reachable = reachableFrom(path.join(srcRoot, "routes/annotations.ts"));

    expect(reachable).toContain("routes/annotations.ts");
    expect(reachable).toContain("db.ts");

    for (const module of GRADING_MODULES) {
      expect(reachable, `${module} is reachable from the annotation routes`).not.toContain(module);
    }
  });

  it("reaches the whole pipeline from the grade route, proving the graph is real", () => {
    // If this fails, the walker is not finding imports and the test above
    // would pass for the wrong reason.
    const reachable = reachableFrom(path.join(srcRoot, "routes/grade.ts"));

    expect(reachable).toContain("grade/pipeline.ts");
    expect(reachable).toContain("grade/provider.ts");
    expect(reachable).toContain("annotate/annotations.ts");
    expect(reachable).toContain("pdf/render.ts");
  });

  it("keeps db.ts free of the grading pipeline", () => {
    const reachable = reachableFrom(path.join(srcRoot, "db.ts"));

    for (const module of GRADING_MODULES) {
      expect(reachable, `db.ts reaches ${module}`).not.toContain(module);
    }
  });

  it("has no mention of grading in the annotation route source", () => {
    const source = fs.readFileSync(path.join(srcRoot, "routes/annotations.ts"), "utf8");

    expect(source).not.toMatch(/gradeDocument|createProvider|enforce|buildAnnotations|locateQuote/);
    expect(source).not.toMatch(/criterion_results/);
  });
});
