// Numbers-only report of how much of a retained text repeats a known third-party text verbatim.
//
// Redaction (src/eval_redaction.ts) removes the source's own headline and the post written from it. Other texts remain in
// the datasets: the production judgement reasons, the stored posts of the original 22 cases, and the labeller's notes. This
// module measures, for such a text, whether it contains a run of characters that also occurs in a reference text the
// operator holds (the private bodies, the pre-redaction headlines): the number of texts with a run of >= N characters, and
// the longest run. It prints and returns counts only; it never returns or logs any text.
//
// Limits: the references are only what the operator holds. A source whose text is not held (for example the body of an
// article that was never stored) cannot be compared, so "no overlap" means "no overlap with these references".

export type ReferenceText = { key: string; text: string };

export type OverlapSummary = {
  name: string;
  texts: number;
  /** windowChars -> number of texts that contain at least one run of that many characters from a reference */
  withRun: Record<number, number>;
  longestRun: number;
  /** longest runs, descending (at most 5), to see whether one text dominates */
  top: number[];
};

const squash = (s: string): string => s.replace(/\s+/g, "");

export function buildReferenceIndex(references: readonly ReferenceText[], windowChars: number): Map<string, string> {
  const index = new Map<string, string>();
  for (const ref of references) {
    const text = squash(ref.text);
    for (let i = 0; i + windowChars <= text.length; i += 1) {
      const gram = text.slice(i, i + windowChars);
      if (!index.has(gram)) index.set(gram, ref.key);
    }
  }
  return index;
}

/** Longest run (characters, whitespace ignored) that the text shares with one reference; 0 when no `minRun` window matches. */
export function longestSharedRun(text: string, references: readonly ReferenceText[], minRun: number): number {
  const t = squash(text);
  let best = 0;
  for (const ref of references) {
    const r = squash(ref.text);
    if (r.length < minRun) continue;
    // dynamic programming over the two strings (texts here are at most a few thousand characters)
    let previous = new Uint16Array(r.length + 1);
    for (let i = 1; i <= t.length; i += 1) {
      const current = new Uint16Array(r.length + 1);
      for (let j = 1; j <= r.length; j += 1) {
        if (t[i - 1] === r[j - 1]) {
          const run = previous[j - 1] + 1;
          current[j] = run;
          if (run > best) best = run;
        }
      }
      previous = current;
    }
  }
  return best >= minRun ? best : 0;
}

export function summariseOverlap(
  name: string,
  texts: readonly string[],
  references: readonly ReferenceText[],
  windows: readonly number[] = [20, 30, 40],
): OverlapSummary {
  const minRun = Math.min(...windows);
  const indexes = new Map(windows.map((w) => [w, buildReferenceIndex(references, w)]));
  const withRun: Record<number, number> = Object.fromEntries(windows.map((w) => [w, 0]));
  const runs: number[] = [];
  for (const text of texts) {
    const t = squash(text);
    let touched = false;
    for (const w of windows) {
      const index = indexes.get(w) as Map<string, string>;
      let hit = false;
      for (let i = 0; i + w <= t.length && !hit; i += 1) hit = index.has(t.slice(i, i + w));
      if (hit) {
        withRun[w] += 1;
        touched = true;
      }
    }
    if (touched) runs.push(longestSharedRun(text, references, minRun));
  }
  runs.sort((a, b) => b - a);
  return { name, texts: texts.length, withRun, longestRun: runs[0] ?? 0, top: runs.slice(0, 5) };
}
