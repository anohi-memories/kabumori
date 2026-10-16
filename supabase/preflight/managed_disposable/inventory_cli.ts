// Operator tool for a schema inventory file (F5 Phase 12). SOURCE ONLY, offline: it reads files the operator names and
// prints COUNTS, finding CODES and digests -- never a line of the manifest and never a value.
//
//   deno run --no-config --allow-read inventory_cli.ts check <manifest.ndjson> [--approved <sha256>]
//   deno run --no-config --allow-read inventory_cli.ts diff  <approved.ndjson> <observed.ndjson>
//
// `check`: is this manifest a baseline the repository can reason about? exit 0 only for READY_FOR_OWNER_REVIEW (and, with
// --approved, only when the contract digest is the approved one). `diff`: object-level drift; exit 1 on any.
//
// Both commands read their inputs as UNTRUSTED: the raw text is scanned for secret-shaped material and checked against
// the closed shape contract BEFORE it is parsed, compared or printed. A contaminated input is a STOP whose output is
// finding CODES and COUNTS only -- never a value, an object name or a file path (paths can carry secrets too), and a
// failure to read a file reports no message (an error text would echo the path).
import type { Requirements } from './baseline_requirements.ts';
import {
  baselineReadiness, canonicalize, contractSubset, diffInventories, type Finding, hasDrift, InventoryError, type Line, parseInventory, secretFindings, validateShape,
} from './inventory.ts';

type ProvenanceFile = { requirements: Requirements; unknown: { relations: string[]; columns: string[]; foreignKeys: string[]; functions: string[] } };
export type CliResult = { code: number; output: string };

const USAGE = 'usage: inventory_cli.ts check <manifest> [--approved <sha256>] | diff <approved> <observed>';

/** `CODE=n CODE=n`: what was found, never where or what. */
const countCodes = (findings: readonly Finding[]) => {
  const counts = new Map<string, number>();
  for (const finding of findings) counts.set(finding.code, (counts.get(finding.code) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([code, n]) => `${code}=${n}`).join(' ');
};

/** Reads and vets one manifest: unreadable, secret-shaped, unparsable or outside the shape contract are each a STOP line. */
function vet(label: string, path: string, readText: (path: string) => string): { lines: Line[] } | { stop: string } {
  let text: string;
  try {
    text = readText(path);
  } catch {
    return { stop: `STOP the ${label} manifest could not be read` };
  }
  const secrets = secretFindings(text);
  if (secrets.length > 0) return { stop: `STOP secret-shaped text in the ${label} manifest (${countCodes(secrets)}): do not keep or share that file` };
  let lines: Line[];
  try {
    lines = parseInventory(text);
  } catch (error) {
    return { stop: `STOP the ${label} manifest is unreadable (${error instanceof InventoryError ? error.code : 'UNKNOWN'})` };
  }
  const shape = validateShape(lines);
  if (shape.length > 0) return { stop: `STOP the ${label} manifest violates the inventory contract (${countCodes(shape)})` };
  return { lines };
}

/** An object name from a VETTED manifest, still printed only when it looks like a plain object name. */
const printable = (name: string) => (/^[\x20-\x7e]{1,200}$/u.test(name) ? name : '<unprintable object name>');

export async function runInventoryCli(args: readonly string[], readText: (path: string) => string, provenance: ProvenanceFile): Promise<CliResult> {
  const [command, ...rest] = args;
  const out: string[] = [];
  if (command === 'check') {
    const path = rest[0];
    const approvedIndex = rest.indexOf('--approved');
    const approved = approvedIndex >= 0 ? rest[approvedIndex + 1] : undefined;
    if (!path || (approvedIndex >= 0 && !/^[0-9a-f]{64}$/u.test(approved ?? ''))) return { code: 2, output: USAGE };
    let text: string;
    try {
      text = readText(path);
    } catch {
      return { code: 1, output: 'STOP the manifest could not be read' };
    }
    const secrets = secretFindings(text);
    if (secrets.length > 0) {
      out.push(`STOP secret-shaped text present (${countCodes(secrets)}): do not keep or share this file`);
      return { code: 1, output: out.join('\n') };
    }
    let lines;
    try {
      lines = parseInventory(text);
    } catch (error) {
      out.push(`STOP unreadable: ${error instanceof InventoryError ? error.code : 'UNKNOWN'}`);
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
    // both inputs are vetted BEFORE anything is compared or formatted; an equal pair of contaminated files is a STOP, not "no drift"
    const approved = vet('approved', approvedPath, readText);
    const observed = vet('observed', observedPath, readText);
    const stops = [approved, observed].filter((side): side is { stop: string } => 'stop' in side).map((side) => side.stop);
    if (stops.length > 0 || !('lines' in approved) || !('lines' in observed)) return { code: 1, output: stops.join('\n') };
    const drift = diffInventories(approved.lines, observed.lines);
    out.push(`missing: ${drift.missing.length}`, `extra: ${drift.extra.length}`, `changed: ${drift.changed.length}`);
    for (const object of drift.missing.slice(0, 50)) out.push(`  - missing ${printable(object)}`);
    for (const object of drift.extra.slice(0, 50)) out.push(`  + extra ${printable(object)}`);
    for (const change of drift.changed.slice(0, 50)) out.push(`  ~ ${printable(change.object)}: ${change.fields.join(', ')}`);
    out.push(hasDrift(drift) ? 'DRIFT: STOP' : 'no drift');
    return { code: hasDrift(drift) ? 1 : 0, output: out.join('\n') };
  }
  return { code: 2, output: USAGE };
}

if (import.meta.main) {
  const provenance = JSON.parse(Deno.readTextFileSync(new URL('./baseline_provenance.json', import.meta.url))) as ProvenanceFile;
  let result: CliResult;
  try {
    result = await runInventoryCli(Deno.args, (path) => Deno.readTextFileSync(path), provenance);
  } catch {
    // an unexpected error is reported without its message (it could carry a path or a value)
    result = { code: 1, output: 'STOP the tool failed unexpectedly; no output was produced' };
  }
  console.log(result.output);
  Deno.exit(result.code);
}
