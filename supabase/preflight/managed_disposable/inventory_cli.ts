// Operator tool for a schema inventory file (F5 Phase 12). SOURCE ONLY, offline: it reads files the operator names and
// prints COUNTS, finding CODES and digests -- never a line of the manifest and never a value.
//
//   deno run --no-config --allow-read inventory_cli.ts check <manifest.ndjson> [--approved <sha256>]
//   deno run --no-config --allow-read inventory_cli.ts diff  <approved.ndjson> <observed.ndjson>
//
// `check`: is this manifest a baseline the repository can reason about? exit 0 only for READY_FOR_OWNER_REVIEW (and, with
// --approved, only when the contract digest is the approved one). `diff`: object-level drift; exit 1 on any.
import type { Requirements } from './baseline_requirements.ts';
import {
  baselineReadiness, canonicalize, contractSubset, diffInventories, hasDrift, InventoryError, parseInventory, secretFindings, validateShape,
} from './inventory.ts';

type ProvenanceFile = { requirements: Requirements; unknown: { relations: string[]; columns: string[]; foreignKeys: string[]; functions: string[] } };
export type CliResult = { code: number; output: string };

const USAGE = 'usage: inventory_cli.ts check <manifest> [--approved <sha256>] | diff <approved> <observed>';

export async function runInventoryCli(args: readonly string[], readText: (path: string) => string, provenance: ProvenanceFile): Promise<CliResult> {
  const [command, ...rest] = args;
  const out: string[] = [];
  if (command === 'check') {
    const path = rest[0];
    const approvedIndex = rest.indexOf('--approved');
    const approved = approvedIndex >= 0 ? rest[approvedIndex + 1] : undefined;
    if (!path || (approvedIndex >= 0 && !/^[0-9a-f]{64}$/u.test(approved ?? ''))) return { code: 2, output: USAGE };
    const text = readText(path);
    const secrets = secretFindings(text);
    out.push(`manifest: ${path}`);
    if (secrets.length > 0) {
      out.push(`STOP secret-shaped text present (${secrets.map((f) => f.code).join(', ')}): do not keep or share this file`);
      return { code: 1, output: out.join('\n') };
    }
    let lines;
    try {
      lines = parseInventory(text);
    } catch (error) {
      out.push(`STOP unreadable: ${error instanceof InventoryError ? `${error.code} ${error.message}` : 'unknown error'}`);
      return { code: 1, output: out.join('\n') };
    }
    const full = await canonicalize(lines);
    out.push(`lines: ${lines.length}`);
    out.push(`kinds: ${Object.entries(full.kinds).map(([kind, v]) => `${kind}=${v.count}`).join(' ')}`);
    out.push(`full digest: ${full.digest}`);
    const shape = validateShape(lines);
    out.push(`contract violations: ${shape.length}${shape.length > 0 ? ` (${[...new Set(shape.map((f) => f.code))].join(', ')})` : ''}`);
    const unclassified = lines.filter((line) => line.k === 'schema' && line.a.scope === 'unclassified').map((line) => line.key);
    if (unclassified.length > 0) out.push(`REVIEW schemas that are neither application nor known platform: ${unclassified.join(', ')}`);
    const readiness = await baselineReadiness(provenance.unknown, provenance.requirements, text);
    const subset = contractSubset(lines, provenance.requirements);
    out.push(`contract items: ${subset.length}`);
    out.push(`contract digest: ${readiness.contractDigest ?? '(none)'}`);
    out.push(`readiness: ${readiness.state}`);
    for (const reason of readiness.reasons) out.push(`  - ${reason}`);
    if (approved !== undefined) {
      const same = readiness.contractDigest === approved;
      out.push(`approved digest: ${same ? 'EQUAL' : 'DIFFERENT'}`);
      return { code: readiness.state === 'READY_FOR_OWNER_REVIEW' && same ? 0 : 1, output: out.join('\n') };
    }
    return { code: readiness.state === 'READY_FOR_OWNER_REVIEW' ? 0 : 1, output: out.join('\n') };
  }
  if (command === 'diff') {
    const [approvedPath, observedPath] = rest;
    if (!approvedPath || !observedPath) return { code: 2, output: USAGE };
    try {
      const drift = diffInventories(parseInventory(readText(approvedPath)), parseInventory(readText(observedPath)));
      out.push(`missing: ${drift.missing.length}`, `extra: ${drift.extra.length}`, `changed: ${drift.changed.length}`);
      for (const object of drift.missing.slice(0, 50)) out.push(`  - missing ${object}`);
      for (const object of drift.extra.slice(0, 50)) out.push(`  + extra ${object}`);
      for (const change of drift.changed.slice(0, 50)) out.push(`  ~ ${change.object}: ${change.fields.join(', ')}`);
      out.push(hasDrift(drift) ? 'DRIFT: STOP' : 'no drift');
      return { code: hasDrift(drift) ? 1 : 0, output: out.join('\n') };
    } catch (error) {
      return { code: 1, output: `STOP unreadable: ${error instanceof InventoryError ? error.code : 'unknown error'}` };
    }
  }
  return { code: 2, output: USAGE };
}

if (import.meta.main) {
  const provenance = JSON.parse(Deno.readTextFileSync(new URL('./baseline_provenance.json', import.meta.url))) as ProvenanceFile;
  const result = await runInventoryCli(Deno.args, (path) => Deno.readTextFileSync(path), provenance);
  console.log(result.output);
  Deno.exit(result.code);
}
