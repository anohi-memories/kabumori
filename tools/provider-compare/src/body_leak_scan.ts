// Detects verbatim text of known third-party bodies inside other files (fixtures, docs, tests).
//
// The repository must not carry TDnet / BBC / Al Jazeera / AP body text. The bodies themselves are not available to CI
// (that is the point), so the scan takes them as an argument: tests feed it synthetic bodies to prove the scanner works,
// and an owner who holds the private legacy file runs scripts/body_leak_scan.ts against the tree before publishing.
//
// A "hit" is a run of `windowChars` consecutive characters (whitespace ignored) that occurs in a known body. Output
// never contains the text itself: only the file, the JSON path, the case key and the covered character count.

export type LeakHit = {
  /** JSON path (".cases[].candidate.title") or "(text)" for non-JSON input. */
  path: string;
  caseKey: string;
  /** Characters of this string that fall inside at least one matching window. */
  covered: number;
  total: number;
};

const squash = (s: string): string => s.replace(/\s+/g, "");

export function buildIndex(bodies: ReadonlyMap<string, string>, windowChars: number): Map<string, string> {
  const index = new Map<string, string>();
  for (const [key, body] of bodies) {
    const text = squash(body);
    for (let i = 0; i + windowChars <= text.length; i += 1) {
      const gram = text.slice(i, i + windowChars);
      if (!index.has(gram)) index.set(gram, key);
    }
  }
  return index;
}

function scanString(value: string, index: ReadonlyMap<string, string>, windowChars: number): { key: string; covered: number; total: number } | null {
  const text = squash(value);
  if (text.length < windowChars) return null;
  const marks = new Uint8Array(text.length);
  let key: string | null = null;
  for (let i = 0; i + windowChars <= text.length; i += 1) {
    const hit = index.get(text.slice(i, i + windowChars));
    if (hit !== undefined) {
      key ??= hit;
      marks.fill(1, i, i + windowChars);
    }
  }
  if (key === null) return null;
  return { key, covered: marks.reduce((a, b) => a + b, 0), total: text.length };
}

/** Scans every string in a JSON value. `ignorePath` lets a caller skip a field whose overlap it has decided to accept. */
export function scanJson(
  value: unknown,
  index: ReadonlyMap<string, string>,
  windowChars: number,
  ignorePath?: (path: string) => boolean,
): LeakHit[] {
  const hits: LeakHit[] = [];
  const walk = (node: unknown, path: string) => {
    if (typeof node === "string") {
      if (ignorePath?.(path)) return;
      const found = scanString(node, index, windowChars);
      if (found) hits.push({ path: path || "(text)", caseKey: found.key, covered: found.covered, total: found.total });
    } else if (Array.isArray(node)) {
      for (const item of node) walk(item, `${path}[]`);
    } else if (node !== null && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
    }
  };
  walk(value, "");
  return hits;
}

export function scanText(text: string, index: ReadonlyMap<string, string>, windowChars: number): LeakHit[] {
  const found = scanString(text, index, windowChars);
  return found ? [{ path: "(text)", caseKey: found.key, covered: found.covered, total: found.total }] : [];
}
