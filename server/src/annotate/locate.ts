import type { ExtractedDocument, ExtractedPage, TextItem } from "../pdf/extract.js";

export type Rect = { x: number; y: number; w: number; h: number };

export type LocateMethod = "exact" | "fuzzy" | "figure" | "none";

export type Located = {
  page: number | null;
  /** One rect per line the quote spans. Empty when unplaced. */
  rects: Rect[];
  method: LocateMethod;
  /** 1 for an exact match, the similarity ratio for a fuzzy one, 0 otherwise. */
  score: number;
  unplaced: boolean;
  /** The quote matched in more than one place and one had to be chosen. */
  ambiguous: boolean;
  anchor: "text" | "figure";
  /** The position is a guess a human should confirm. */
  needsPlacement: boolean;
};

/**
 * Minimum similarity for a fuzzy match to be believed.
 *
 * Measured against the 15 real quotes in the mock's valid output, which are
 * lifted verbatim from the extracted script:
 *
 *   genuine quote, unchanged                     1.000
 *   genuine quote with the student's spelling
 *     "corrected" by the model                   0.980  (worst of 7 such)
 *   genuine quote with 3 characters corrupted    0.940  (worst of 15)
 *   same quote against a page it is not on       0.480  (best of 15)
 *
 * The gap between a real quote that needs repairing and the best false positive
 * runs from 0.94 down to 0.48, so 0.85 sits in open space rather than being
 * fitted to either edge. Nothing plausible needed a threshold below 0.9, let
 * alone 0.8. Raising it to 0.95 would start rejecting genuine respelled quotes;
 * lowering it to 0.5 would start accepting text from the wrong page.
 */
export const FUZZY_THRESHOLD = 0.85;

/** Baseline difference, in points, within which items count as one line. */
const LINE_TOLERANCE = 1.5;

export const UNPLACED_RESULT: Located = {
  page: null,
  rects: [],
  method: "none",
  score: 0,
  unplaced: true,
  ambiguous: false,
  anchor: "text",
  needsPlacement: false,
};

type Normalised = {
  text: string;
  /** For each character of `text`, its offset in the original string. */
  offsets: number[];
};

/**
 * Collapses whitespace, lowercases, and drops punctuation, keeping an offset
 * back to the original string for every surviving character.
 *
 * Both sides of every comparison go through this. It is what lets a quote the
 * model joined with a space match a source that wrapped the same sentence
 * across a newline.
 */
function normalise(value: string): Normalised {
  const chars: string[] = [];
  const offsets: number[] = [];

  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;

    if (/\s/.test(char)) {
      // One space between words, and never a leading one.
      if (chars.length > 0 && chars[chars.length - 1] !== " ") {
        chars.push(" ");
        offsets.push(i);
      }
      continue;
    }
    if (/[^\p{L}\p{N}]/u.test(char)) continue; // punctuation and symbols

    chars.push(char.toLowerCase());
    offsets.push(i);
  }

  while (chars[chars.length - 1] === " ") {
    chars.pop();
    offsets.pop();
  }

  return { text: chars.join(""), offsets };
}

type Match = { page: number; start: number; end: number; score: number };

function exactMatches(page: ExtractedPage, haystack: Normalised, needle: string): Match[] {
  const found: Match[] = [];
  for (let at = haystack.text.indexOf(needle); at !== -1; at = haystack.text.indexOf(needle, at + 1)) {
    found.push({ page: page.page, start: at, end: at + needle.length, score: 1 });
  }
  return found;
}

/**
 * Sellers' algorithm: the edit distance from the whole needle to the best
 * matching substring of the haystack, in one pass. Row 0 is all zeros, so a
 * match may begin anywhere at no cost; the answer is the smallest value in the
 * final row, and the start offset is carried along beside the distance.
 *
 * This finds the true best window, unlike a stepped sliding window, and costs
 * one distance computation over the page rather than one per candidate offset.
 */
function sellers(haystack: string, needle: string): { start: number; end: number; score: number } | null {
  const n = haystack.length;
  const m = needle.length;
  if (m === 0 || n === 0) return null;

  let previousDistance = new Int32Array(n + 1);
  let previousStart = new Int32Array(n + 1);
  let distance = new Int32Array(n + 1);
  let start = new Int32Array(n + 1);

  for (let j = 0; j <= n; j++) previousStart[j] = j;

  for (let i = 1; i <= m; i++) {
    distance[0] = i;
    start[0] = 0;

    for (let j = 1; j <= n; j++) {
      const substitution = previousDistance[j - 1]! + (needle[i - 1] === haystack[j - 1] ? 0 : 1);
      const deletion = previousDistance[j]! + 1;
      const insertion = distance[j - 1]! + 1;

      if (substitution <= deletion && substitution <= insertion) {
        distance[j] = substitution;
        start[j] = previousStart[j - 1]!;
      } else if (deletion <= insertion) {
        distance[j] = deletion;
        start[j] = previousStart[j]!;
      } else {
        distance[j] = insertion;
        start[j] = start[j - 1]!;
      }
    }

    [previousDistance, distance] = [distance, previousDistance];
    [previousStart, start] = [start, previousStart];
  }

  let bestEnd = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let j = 0; j <= n; j++) {
    if (previousDistance[j]! < bestDistance) {
      bestDistance = previousDistance[j]!;
      bestEnd = j;
    }
  }

  const score = 1 - bestDistance / m;
  if (score <= 0) return null;

  return { start: previousStart[bestEnd]!, end: bestEnd, score };
}

function bestFuzzyMatch(page: ExtractedPage, haystack: string, needle: string): Match | null {
  const found = sellers(haystack, needle);
  return found === null ? null : { page: page.page, ...found };
}

/**
 * How well a quote matches some text: 1 for an exact match after normalisation,
 * the similarity ratio for the best approximate one, 0 for nothing.
 *
 * `enforce` uses this to decide whether a quote is real, and it has to be the
 * same matcher used to place the quote on the page. Verifying with exact
 * matching while locating with fuzzy matching would strip every quote whose
 * spelling the model tidied — which is precisely the case fuzzy matching exists
 * for, so it would never run.
 */
export function quoteMatchScore(text: string, quote: string): number {
  const haystack = normalise(text).text;
  const needle = normalise(quote).text;
  if (haystack === "" || needle === "") return 0;
  if (haystack.includes(needle)) return 1;

  return sellers(haystack, needle)?.score ?? 0;
}

/**
 * The items covered by a character range, grouped into one rect per line.
 *
 * An item only partly covered by the quote is narrowed proportionally, so a
 * quote starting mid-sentence does not get a box running back to the margin.
 */
function rectsForRange(page: ExtractedPage, start: number, end: number): Rect[] {
  const lines = new Map<number, Rect>();

  for (const item of page.items) {
    const itemEnd = item.charStart + item.text.length;
    if (itemEnd <= start || item.charStart >= end) continue;
    if (item.text.length === 0 || item.w === 0) continue;

    const from = Math.max(start, item.charStart) - item.charStart;
    const to = Math.min(end, itemEnd) - item.charStart;
    const rect = narrowToRange(item, from, to);

    const key = Math.round(item.y / LINE_TOLERANCE);
    const existing = lines.get(key);
    lines.set(key, existing ? merge(existing, rect) : rect);
  }

  return [...lines.values()].sort((a, b) => b.y - a.y); // top of page first
}

function narrowToRange(item: TextItem, from: number, to: number): Rect {
  const fraction = (at: number) => at / item.text.length;
  return {
    x: item.x + item.w * fraction(from),
    y: item.y,
    w: item.w * (fraction(to) - fraction(from)),
    h: item.h,
  };
}

function merge(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

export function locateQuote(
  student: ExtractedDocument,
  quote: string,
  reportedPage: number | null = null,
): Located {
  const needle = normalise(quote).text;
  if (needle === "") return UNPLACED_RESULT;

  // Matching runs against each page's joined text, never against an item's own
  // text. pdf.js splits ligatures into separate items — "difference" arrives as
  // "di", "ff", "erence", each with its own box — so no single item holds a
  // whole word. Only the joined text spells what the student wrote. The matched
  // range is mapped back to items afterwards, through charStart.
  const normalisedPages = student.pages.map((page) => ({ page, haystack: normalise(page.text) }));

  let candidates: Match[] = normalisedPages.flatMap(({ page, haystack }) =>
    exactMatches(page, haystack, needle),
  );
  let method: LocateMethod = "exact";

  if (candidates.length === 0) {
    method = "fuzzy";
    candidates = normalisedPages
      .map(({ page, haystack }) => bestFuzzyMatch(page, haystack.text, needle))
      .filter((match): match is Match => match !== null && match.score >= FUZZY_THRESHOLD);
  }

  if (candidates.length === 0) return UNPLACED_RESULT;

  // More than one plausible position. Prefer the page the model reported, then
  // the best score — but say that a choice had to be made either way.
  const ambiguous = candidates.length > 1;
  const onReportedPage = candidates.filter((match) => match.page === reportedPage);
  const shortlist = onReportedPage.length > 0 ? onReportedPage : candidates;

  const best = shortlist.reduce((a, b) =>
    b.score > a.score || (b.score === a.score && b.start < a.start) ? b : a,
  );

  const entry = normalisedPages.find(({ page }) => page.page === best.page)!;
  const { offsets } = entry.haystack;
  const rects = rectsForRange(
    entry.page,
    offsets[best.start]!,
    (offsets[best.end - 1] ?? offsets[offsets.length - 1]!) + 1,
  );

  if (rects.length === 0) return UNPLACED_RESULT;

  return {
    page: best.page,
    rects,
    method,
    score: Math.round(best.score * 1000) / 1000,
    unplaced: false,
    ambiguous,
    anchor: "text",
    needsPlacement: false,
  };
}

/**
 * For a finding about a drawing there is no text to quote, so fall back to the
 * largest image in the document. This is a guess, not a location, which is why
 * it is returned with needsPlacement set for a human to confirm.
 */
export function locateFigure(student: ExtractedDocument): Located {
  const images = student.pages.flatMap((page) => page.images);
  if (images.length === 0) return UNPLACED_RESULT;

  const largest = images.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));

  return {
    page: largest.page,
    rects: [{ x: largest.x, y: largest.y, w: largest.w, h: largest.h }],
    method: "figure",
    score: 0,
    unplaced: false,
    ambiguous: false,
    anchor: "figure",
    needsPlacement: true,
  };
}
