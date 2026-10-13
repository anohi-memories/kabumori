// Withholds retained texts that repeat a known third-party text.
//
// src/eval_redaction.ts withholds what is certainly source-derived (the headline of an unconfirmed source, the post written
// from it). Other texts stay in the datasets: judgement reasons, the stored posts of the original 22 cases and the
// labeller's notes. They are the product's or the labeller's own words, but a run of characters copied from a source would
// still be third-party text. This module finds such runs against reference texts the operator holds locally (the private
// bodies, the pre-redaction headlines) and withholds ONLY the strings that contain a run of at least `minRun` characters.
//
// What is recorded about a withheld string is its JSON pointer, length, SHA-256 and longest shared run: no text. A masked
// content digest (the file with those pointers blanked) lets a reviewer check that nothing else changed.
import { isWithheldTitle, sha256Hex } from "./fixture_access.ts";
import { isWithheldPost } from "./eval_redaction.ts";
import { buildReferenceIndex, longestSharedRun, type ReferenceText } from "./residual_text_report.ts";

export const RESIDUAL_WITHHELD = "（記述非保持: 出典との重複）";

export const isResidualWithheld = (text: string): boolean => text.startsWith(RESIDUAL_WITHHELD);

export type WithheldEntry = { pointer: string; chars: number; sha256: string; longestRun: number };

const squash = (s: string): string => s.replace(/\s+/g, "");
const escapeKey = (key: string): string => key.replace(/~/g, "~0").replace(/\//g, "~1");
const unescapeKey = (key: string): string => key.replace(/~1/g, "/").replace(/~0/g, "~");

/**
 * Subtrees that hold identifiers, source metadata and stored text that is retained on purpose: the candidate record, the
 * headline (src/eval_redaction.ts handles headlines of unconfirmed sources) and a body kept because its host's terms allow it.
 */
const SKIPPED_KEYS = new Set([
  "candidate", "candidateId", "caseId", "codeVersions", "population", "sampling",
  "title", "bodySummary", "sourceUrl", "companyName",
]);

function alreadyWithheld(text: string): boolean {
  return isWithheldTitle(text) || isWithheldPost(text) || isResidualWithheld(text);
}

/** Finds, without changing anything, the strings that contain a run of at least `minRun` characters from a reference. */
export async function findOverlapping(root: unknown, references: readonly ReferenceText[], minRun: number): Promise<WithheldEntry[]> {
  const index = buildReferenceIndex(references, minRun);
  const found: WithheldEntry[] = [];
  const visit = async (node: unknown, pointer: string): Promise<void> => {
    if (typeof node === "string") {
      if (node.length < minRun || alreadyWithheld(node)) return;
      const t = squash(node);
      let hit = false;
      for (let i = 0; i + minRun <= t.length && !hit; i += 1) hit = index.has(t.slice(i, i + minRun));
      if (hit) {
        found.push({
          pointer,
          chars: node.length,
          sha256: await sha256Hex(node),
          longestRun: longestSharedRun(node, references, minRun),
        });
      }
    } else if (Array.isArray(node)) {
      for (const [i, item] of node.entries()) await visit(item, `${pointer}/${i}`);
    } else if (node !== null && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (!SKIPPED_KEYS.has(key)) await visit(value, `${pointer}/${escapeKey(key)}`);
      }
    }
  };
  await visit(root, "");
  return found;
}

function parentOf(root: unknown, pointer: string): { parent: Record<string, unknown> | unknown[]; key: string } {
  const parts = pointer.split("/").slice(1).map(unescapeKey);
  let current = root as Record<string, unknown> | unknown[];
  for (const part of parts.slice(0, -1)) current = (current as Record<string, unknown>)[part] as Record<string, unknown> | unknown[];
  return { parent: current, key: parts[parts.length - 1] };
}

export function resolvePointer(root: unknown, pointer: string): unknown {
  const { parent, key } = parentOf(root, pointer);
  return (parent as Record<string, unknown>)[key];
}

/** Replaces each found string by a placeholder (with the first 8 hex digits of its hash, so placeholders differ). */
export function applyWithheld(root: unknown, entries: readonly WithheldEntry[]): void {
  for (const entry of entries) {
    const { parent, key } = parentOf(root, entry.pointer);
    (parent as Record<string, unknown>)[key] = `${RESIDUAL_WITHHELD}#${entry.sha256.slice(0, 8)}`;
  }
}

/** SHA-256 of the file with the given pointers blanked: unchanged by withholding exactly those strings. */
export async function maskedDigest(root: unknown, pointers: readonly string[]): Promise<string> {
  const copy = JSON.parse(JSON.stringify(root));
  for (const pointer of pointers) {
    const { parent, key } = parentOf(copy, pointer);
    (parent as Record<string, unknown>)[key] = "";
  }
  return await sha256Hex(JSON.stringify(copy));
}

/** Checks that each recorded pointer holds a placeholder whose hash tail matches the record. */
export function checkRecordedPlaceholders(root: unknown, entries: readonly WithheldEntry[]): string[] {
  const problems: string[] = [];
  for (const entry of entries) {
    const value = resolvePointer(root, entry.pointer);
    if (typeof value !== "string" || !isResidualWithheld(value)) problems.push(`${entry.pointer}: not withheld`);
    else if (!value.endsWith(`#${entry.sha256.slice(0, 8)}`)) problems.push(`${entry.pointer}: placeholder does not match the record`);
  }
  return problems;
}

/** Strings that still contain a run of `minRun` characters from a reference (should be empty after applying). */
export async function stillOverlapping(root: unknown, references: readonly ReferenceText[], minRun: number): Promise<string[]> {
  return (await findOverlapping(root, references, minRun)).map((e) => e.pointer);
}
