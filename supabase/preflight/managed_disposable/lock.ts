// The plan lock: SHA-256 of every file the harness may send, pinned at review time, plus what the review accepted in
// each file statement by statement (dynamic statements, write targets, top-level selects) and the corpus's network
// helpers. A file whose bytes differ is never sent (runner.ts); a file that gained a dynamic statement, a write target
// or any blocking finding is refused. Regenerate deliberately with `cli.ts --write-lock` and review the diff: a
// changed digest means a changed migration, a changed `reviewed` list means a changed effect.
import { extractRequirements, PREFLIGHT_MIGRATION } from './baseline_requirements.ts';
import type { Lock, Reviewed } from './runner.ts';
import { networkFunctionNames, scanSql } from './sql_scan.ts';

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Builds the lock. `corpus` is every repository migration (name -> text): the network helpers are taken from it. `pinnedOnly` are probe files (digest only). */
export async function buildLock(
  paths: readonly string[], read: (path: string) => string, corpus: Record<string, string> = {}, pinnedOnly: readonly string[] = [],
): Promise<Lock> {
  const files: Record<string, string> = {};
  const reviewed: Record<string, Reviewed> = {};
  // files that are only ever READ by a probe channel (the inventory query): pinned by digest, never scanned as a migration
  for (const path of pinnedOnly) files[path] = await sha256Hex(read(path));
  for (const path of [...paths].sort()) {
    const text = read(path);
    files[path] = await sha256Hex(text);
    const scan = scanSql(text);
    const blocking = scan.findings.filter((finding) => finding.severity === 'block');
    if (blocking.length > 0) throw new Error(`${path} has blocking findings and cannot be locked: ${[...new Set(blocking.map((f) => f.code))].join(',')}`);
    reviewed[path] = {
      dynamic: (await Promise.all(scan.dynamic.map((statement) => sha256Hex(statement.text)))).sort(),
      writes: scan.writes,
      selects: (await Promise.all(scan.topLevelSelects.map((statement) => sha256Hex(statement.text)))).sort(),
    };
  }
  const scans = Object.values(corpus).map((text) => scanSql(text));
  const networkFunctions = [...networkFunctionNames(scans)].sort();
  // what the chain requires of the baseline: read out of the Phase 1 preflight itself, so a changed preflight is a changed lock.
  // (An unreadable preflight leaves it out; the baseline read-back step then STOPs on "no requirements" rather than passing.)
  let requirements: Lock['requirements'];
  try {
    requirements = extractRequirements(read(PREFLIGHT_MIGRATION));
  } catch {
    requirements = undefined;
  }
  return { files, reviewed, networkFunctions, ...(requirements ? { requirements } : {}) };
}
