// Audits which stored bodies in a fixture file may stay in the repository under src/body_policy.ts, without changing the file.
//   deno run --no-config --allow-read [--allow-write=<out>] tools/provider-compare/scripts/fixture_rights_audit.ts [--out f.json]
// Reports, per case: host, whether the body is allowed, its length and SHA-256. The SHA-256 is what a later run uses to check
// a body re-read from production; a case whose body is not allowed can drop it and keep everything else.
import { bodyMayBeStored, hostOf } from "../src/body_policy.ts";
import { loadCases } from "../src/fixtures.ts";
import { sha256Hex } from "./eval_manifest.ts";

export type RightsRow = {
  caseId: string;
  sourceName: string;
  host: string | null;
  bodyChars: number;
  bodyStored: boolean;
  allowedByPolicy: boolean;
  sha256: string | null;
  action: "keep" | "replace_with_runtime_fetch";
};

export async function auditFixtures(cases: Awaited<ReturnType<typeof loadCases>>): Promise<RightsRow[]> {
  const rows: RightsRow[] = [];
  for (const item of cases) {
    const body = item.candidate.bodySummary;
    const allowed = bodyMayBeStored(item.candidate.sourceUrl);
    rows.push({
      caseId: item.caseId,
      sourceName: item.candidate.sourceName,
      host: hostOf(item.candidate.sourceUrl),
      bodyChars: (body ?? "").length,
      bodyStored: body !== null && body.length > 0,
      allowedByPolicy: allowed,
      sha256: body !== null && body.length > 0 ? await sha256Hex(body) : null,
      action: body !== null && body.length > 0 && !allowed ? "replace_with_runtime_fetch" : "keep",
    });
  }
  return rows;
}

export function summariseAudit(rows: readonly RightsRow[]) {
  const stored = rows.filter((r) => r.bodyStored);
  const bySource: Record<string, { stored: number; mustReplace: number; chars: number }> = {};
  for (const r of stored) {
    bySource[r.sourceName] ??= { stored: 0, mustReplace: 0, chars: 0 };
    bySource[r.sourceName].stored += 1;
    bySource[r.sourceName].chars += r.bodyChars;
    if (r.action === "replace_with_runtime_fetch") bySource[r.sourceName].mustReplace += 1;
  }
  return {
    cases: rows.length,
    bodiesStored: stored.length,
    allowedByPolicy: stored.filter((r) => r.allowedByPolicy).length,
    toReplaceWithRuntimeFetch: stored.filter((r) => r.action === "replace_with_runtime_fetch").length,
    charsToRemove: stored.filter((r) => r.action === "replace_with_runtime_fetch").reduce((s, r) => s + r.bodyChars, 0),
    bySource,
  };
}

if (import.meta.main) {
  const rows = await auditFixtures(await loadCases());
  const result = { summary: summariseAudit(rows), cases: rows };
  console.log(JSON.stringify(result.summary, null, 2));
  const i = Deno.args.indexOf("--out");
  if (i >= 0 && Deno.args[i + 1]) await Deno.writeTextFile(Deno.args[i + 1], JSON.stringify(result, null, 2) + "\n");
}
