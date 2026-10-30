// Non-retention of source-derived text in the evaluation datasets.
//
// eval_expansion.json and eval_nopost_sample.json carry, per candidate, the headline of the source article and (for some)
// the post the product generated from it. Whether the headline of a TDnet / BBC / Al Jazeera / AP article, or a post
// written from such an article, may be kept in this repository has not been confirmed (src/body_policy.ts), and "it was
// published" is not a licence. This module replaces them by a placeholder plus length and SHA-256:
//
//   * a headline whose source is not on the open-terms host list (bodyMayBeStored) is withheld;
//   * a stored generated post is withheld, whatever its source;
//   * labels, expected values, judgement metadata and the labeller's own notes are untouched.
//
// The fingerprints keep the dataset comparable: duplicates are still detectable (titleKeySha256 is the hash of the
// normalised headline), counts and lengths are unchanged, and a LOCAL export can be checked against them without anything
// being written back. Nothing here reads the network or a file; callers pass the parsed JSON.
import { bodyMayBeStored } from "./body_policy.ts";
import { isWithheldTitle, sha256Hex, TITLE_WITHHELD } from "./fixture_access.ts";

export const POST_WITHHELD = "（投稿文非保持）";

export function isWithheldPost(text: string): boolean {
  return text.startsWith(POST_WITHHELD);
}

/** The normalisation the headline de-duplication has always used (case, width, punctuation and spacing ignored). */
export function normaliseTitle(title: string): string {
  return title.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

export type TitleFingerprint = { titleChars: number; titleSha256: string; titleKeySha256: string };

export async function titleFingerprint(title: string): Promise<TitleFingerprint> {
  return {
    titleChars: title.length,
    titleSha256: await sha256Hex(title),
    titleKeySha256: await sha256Hex(normaliseTitle(title)),
  };
}

/** A key that identifies a headline for duplicate detection, whether or not the text itself was withheld. */
export function titleKeyOf(record: { title: string; titleKeySha256?: string }): string {
  return record.titleKeySha256 ?? normaliseTitle(record.title);
}

/** Keys that carry source-derived text or its fingerprint; everything else is "content" that must not change. */
const REDACTABLE_KEYS = new Set(["title", "titleChars", "titleSha256", "titleKeySha256", "text", "textChars", "textSha256", "derived"]);

/**
 * SHA-256 of the file with the redactable keys removed. Redaction must leave this unchanged: case ids and order, labels,
 * expected values, recorded judgements, models, counts and all other fields. (Only `title` of a candidate / case and
 * `generation.text` carry source text, so dropping these keys everywhere is exact for these datasets.)
 */
export async function contentDigest(file: unknown): Promise<string> {
  return await sha256Hex(JSON.stringify(file, (key, value) => (REDACTABLE_KEYS.has(key) ? undefined : value)));
}

export type HostClass = "tdnet" | "bbc" | "al_jazeera" | "ap" | "open_terms" | "other";

export function hostClassOf(sourceUrl: string): HostClass {
  if (bodyMayBeStored(sourceUrl)) return "open_terms";
  let host = "";
  try {
    host = new URL(sourceUrl).hostname.toLowerCase();
  } catch { /* keep "" */ }
  if (host.includes("tdnet")) return "tdnet";
  if (host.includes("bbc.")) return "bbc";
  if (host.includes("aljazeera")) return "al_jazeera";
  if (host.includes("apnews")) return "ap";
  return "other";
}

export type RedactionStats = {
  cases: number;
  titlesWithheld: number;
  titlesKept: number;
  postsWithheld: number;
  alreadyRedacted: number;
};

/** The 8-character id prefix: from the candidate id when there is one, else the suffix of the case id. */
const id8Of = (candidateId: string | null, caseId = "") => (candidateId ?? caseId.slice(-8)).slice(0, 8);

type ExpansionCase = {
  caseId: string;
  candidateId: string | null;
  candidate: { title: string; sourceUrl: string } & Partial<TitleFingerprint>;
  recorded: { generation: ({ text: string | null } & { textChars?: number; textSha256?: string }) | null };
};

type NopostCase = { caseId: string; candidateId: string | null; title: string; sourceUrl: string } & Partial<TitleFingerprint>;

async function redactTitleIn(
  holder: { title: string } & Partial<TitleFingerprint>,
  id: string,
  sourceUrl: string,
  stats: RedactionStats,
): Promise<void> {
  if (isWithheldTitle(holder.title)) {
    stats.alreadyRedacted += 1;
    return;
  }
  if (bodyMayBeStored(sourceUrl)) {
    stats.titlesKept += 1;
    return;
  }
  Object.assign(holder, await titleFingerprint(holder.title));
  holder.title = `${TITLE_WITHHELD}#${id}`;
  stats.titlesWithheld += 1;
}

/**
 * Features computed from the source text BEFORE it is withheld (for example which hazard types a post exercises), so that
 * a dataset stays analysable without the text. Stored under `derived`; contains tags and numbers only, never text.
 */
export type DeriveFeatures = (item: ExpansionCase) => Record<string, unknown>;

/** Redacts an evaluation-expansion file in place and says what it did. Idempotent. */
export async function redactEvalExpansion(file: { cases: ExpansionCase[] }, derive?: DeriveFeatures): Promise<RedactionStats> {
  const stats: RedactionStats = { cases: file.cases.length, titlesWithheld: 0, titlesKept: 0, postsWithheld: 0, alreadyRedacted: 0 };
  for (const item of file.cases) {
    const holder = item as ExpansionCase & { derived?: Record<string, unknown> };
    const withholdsSomething = !isWithheldTitle(item.candidate.title) && !bodyMayBeStored(item.candidate.sourceUrl) ||
      (typeof item.recorded.generation?.text === "string" && item.recorded.generation.text.length > 0 && !isWithheldPost(item.recorded.generation.text));
    if (derive && withholdsSomething && holder.derived === undefined) holder.derived = derive(item);
    await redactTitleIn(item.candidate, id8Of(item.candidateId, item.caseId), item.candidate.sourceUrl, stats);
    const generation = item.recorded.generation;
    if (generation && typeof generation.text === "string" && generation.text.length > 0 && !isWithheldPost(generation.text)) {
      generation.textChars = generation.text.length;
      generation.textSha256 = await sha256Hex(generation.text);
      generation.text = `${POST_WITHHELD}#${id8Of(item.candidateId, item.caseId)}`;
      stats.postsWithheld += 1;
    }
  }
  return stats;
}

/** Redacts the flat no_post sample (headlines only; it holds no generated posts). Idempotent. */
export async function redactNopostSample(file: { cases: NopostCase[] }): Promise<RedactionStats> {
  const stats: RedactionStats = { cases: file.cases.length, titlesWithheld: 0, titlesKept: 0, postsWithheld: 0, alreadyRedacted: 0 };
  for (const item of file.cases) await redactTitleIn(item, id8Of(item.candidateId, item.caseId), item.sourceUrl, stats);
  return stats;
}

export type VerifyResult = {
  titles: { checked: number; matched: number; mismatched: string[]; missing: string[] };
  posts: { checked: number; matched: number; mismatched: string[]; missing: string[] };
};

type VerifiableCase = {
  caseId: string;
  candidateId: string | null;
  title?: string;
  titleSha256?: string;
  candidate?: { title: string; titleSha256?: string };
  recorded?: { generation?: { text: string | null; textSha256?: string } | null };
};

/**
 * Checks withheld headlines and posts against a LOCAL export: rows carry `id`, `title` and optionally `generated_text`.
 * Reads nothing from disk and writes nothing; the verdict is per candidate id8. A candidate that is not in the export is
 * `missing`, one whose text hashes differently is `mismatched`; neither attaches anything.
 */
export async function verifyAgainstRows(
  file: { cases: VerifiableCase[] },
  rows: ReadonlyArray<Record<string, unknown>>,
): Promise<VerifyResult> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of rows) if (typeof row.id === "string") byId.set(row.id.slice(0, 8), row);
  const out: VerifyResult = {
    titles: { checked: 0, matched: 0, mismatched: [], missing: [] },
    posts: { checked: 0, matched: 0, mismatched: [], missing: [] },
  };
  const check = async (bucket: VerifyResult["titles"], id: string, expected: string, actual: unknown) => {
    bucket.checked += 1;
    if (typeof actual !== "string") bucket.missing.push(id);
    else if ((await sha256Hex(actual)) === expected) bucket.matched += 1;
    else bucket.mismatched.push(id);
  };
  for (const item of file.cases) {
    const id = id8Of(item.candidateId, item.caseId);
    const row = byId.get(id);
    const titleSha = item.candidate?.titleSha256 ?? item.titleSha256;
    if (titleSha !== undefined) await check(out.titles, id, titleSha, row?.title);
    const textSha = item.recorded?.generation?.textSha256;
    if (textSha !== undefined) await check(out.posts, id, textSha, row?.generated_text);
  }
  return out;
}
