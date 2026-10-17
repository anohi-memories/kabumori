// The pinned migration dependency DAG behind docs/common-account/phase13-postona-disposable-supabase-architecture.md
// (F5 Phase 13). SOURCE ONLY and OFFLINE: it reads files of this checkout, computes SHA-256 digests and scanner results,
// and writes (or checks) two derived artifacts: docs/common-account/phase13-migration-dag.json and the generated tables
// between the GENERATED markers of the architecture document. No database, no network, no managed project.
//
//   deno run --no-config --allow-read --allow-write supabase/preflight/managed_disposable/architecture_dag.ts --write
//   deno run --no-config --allow-read                  supabase/preflight/managed_disposable/architecture_dag.ts --check
//
// What is DERIVED here (lexically, from this checkout) and what is RECORDED (by hand, with its evidence file):
//   derived   chain order and digests, which chain file references an object another chain file defines, platform / baseline
//             objects a chain file touches, the scanner verdict of every repository migration, the exclusion buckets;
//   recorded  which chain files production has applied (P1, P2) -- with the repository file and the exact phrase that
//             records it, so a test can find that phrase again.
// A derived edge may over-approximate (a name that appears in a comment-free body but is only mentioned): that is the safe
// direction for an ordering constraint. Nothing here infers a missing DDL object: unknown objects stay listed as unknown.
import { CHAIN } from './plan.ts';
import { sha256Hex } from './lock.ts';
import { normalize, scanSql } from './sql_scan.ts';

export const DAG_PATH = 'docs/common-account/phase13-migration-dag.json';
export const ORACLE_PATH = 'docs/common-account/phase13-prerequisite-oracle.tsv';
export const DOC_PATH = 'docs/common-account/phase13-postona-disposable-supabase-architecture.md';
export const BEGIN_MARK = '<!-- GENERATED:DAG:BEGIN -->';
export const END_MARK = '<!-- GENERATED:DAG:END -->';

/** What production is recorded to have applied, and where the repository says so (a test searches the file for `phrase`). */
export const PRODUCTION_APPLIED: Readonly<Record<string, { file: string; phrase: string; summary: string }>> = {
  P1: {
    file: '.agent/CURRENT_STATE.md',
    phrase: '## Final K5 — Common-account Phase 1 foundation applied PASS — 2026-10-06',
    summary: 'applied exactly once by the G5 production window of 2026-10-06 (closed 14:58 JST); postflight exact',
  },
  P2: {
    file: '.agent/tasks/CLAUDE_TASK_5.md',
    phrase: '### Phase 2 production apply — 2026-10-07（APPLIED_PASS）',
    summary: 'applied exactly once by the G5 production window of 2026-10-07 (Stage A COMMIT 13:47:09 JST); read-backs ALL PASS',
  },
};

export type ChainNode = {
  id: string;
  order: number;
  file: string;
  sha256: string;
  bytes: number;
  marker: string;
  production: 'applied' | 'draft';
  appliedEvidence?: { file: string; phrase: string; summary: string };
  createsRelations: string[];
  definesFunctions: string[];
  requires: { chain: string[]; baseline: string[]; platform: string[] };
  scanner: { blocking: string[]; review: string[] };
};

export type ExcludedFile = { file: string; sha256: string; bucket: Bucket; blocking: string[]; review: string[]; requiredRelationEffects: string[] };
export const BUCKETS = ['cron_net_production_host', 'cron_indirect', 'vault_reference', 'url_literal_seed', 'other_blocking', 'review_only', 'clean'] as const;
export type Bucket = (typeof BUCKETS)[number];

/** One row of the prerequisite oracle (supabase/tests/common_account_phase13_prerequisite_oracle.sh), summarised. */
export type OracleFailure = { kind: string; object: string; chainId: string; refusal: string; sourceFile: string | null; coveredByContract: boolean };
export type Oracle = {
  file: string;
  sha256: string;
  control: string;
  candidates: Record<string, { tested: number; refused: number; notTested: number }>;
  failing: OracleFailure[];
  notTested: { kind: string; object: string }[];
};

/** Files that exist in OTHER pull requests' branches (not in this checkout): path, PR, exact commit, git blob id. */
export const EXTERNAL: readonly { path: string; pr: number; commit: string; blob: string; role: string }[] = [
  { path: 'apps/social-mobile/docs/postona-sandbox-preflight.md', pr: 243, commit: '60e4a4c059a9d7304e5a48a7b3219ab801e822ae', blob: '3009556572d9746c4a7bee852be7c1a98afad5f7', role: 'F4 non-production isolation preflight: documentation' },
  { path: 'apps/social-mobile/scripts/postona-sandbox-preflight.mjs', pr: 243, commit: '60e4a4c059a9d7304e5a48a7b3219ab801e822ae', blob: 'b2ec507904e38e97cafb7928fafd075d71dfdb82', role: 'F4 non-production isolation preflight: the check script' },
  { path: 'apps/social-mobile/tests/postona-sandbox-preflight.test.mjs', pr: 243, commit: '60e4a4c059a9d7304e5a48a7b3219ab801e822ae', blob: 'dafe903e5ed72a39f151d10a9a76811600a4b786', role: 'F4 preflight: its 15 offline tests' },
  { path: 'apps/social-mobile/src/features/service-enrollment/service-enrollment-gate.tsx', pr: 240, commit: '5e462ba73be691c80f75198d57782626f1d241cc', blob: '951119be47269d7473399ebe0ac1adc8b2c0b0c3', role: 'POSTONA enrollment gate after the J2 V2 fix (G1/G2)' },
  { path: 'apps/social-mobile/src/features/service-lifecycle/service-lifecycle.tsx', pr: 236, commit: '605d8776c6be2e33ec247af7c82a99270cf32b82', blob: '3066ebc2768d991461c3c180ed33066eebb7313b', role: 'F4 lifecycle provider (per-person epoch, open/close surface)' },
  { path: 'apps/social-mobile/src/features/service-lifecycle/service-lifecycle-surface.tsx', pr: 236, commit: '605d8776c6be2e33ec247af7c82a99270cf32b82', blob: 'b62dde7eb9d450f645120002d66032c763ca3eca', role: 'F4 service-end surface outside the gate' },
  { path: 'apps/social-mobile/docs/j5-postona-deletion-boundary.md', pr: 197, commit: '2171ee4c02ea2eec46562d81595f5460e5507d9d', blob: '51128c2123ab88b3782c3970424710e85436c17c', role: 'POSTONA client deletion boundary and its staging checklist' },
];

export type Dag = {
  version: 1;
  kind: 'postona-disposable-supabase-migration-dag';
  rules: string[];
  chain: ChainNode[];
  baseline: {
    requiredRelations: string[];
    unknownRelations: string[];
    unknownColumns: string[];
    unknownForeignKeys: string[];
    createdButNotReplayable: string[];
    knownCreators: Record<string, { class: string; createdBy: string[]; alteredBy: string[] }>;
  };
  excluded: { total: number; buckets: Record<Bucket, string[]>; files: ExcludedFile[] };
  oracle: Oracle;
  external: typeof EXTERNAL;
  corpus: { migrations: number; networkFunctions: string[]; dynamicFunctions: number };
};

export type Reader = { list(dir: string): string[]; read(path: string): string };

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const bare = (name: string) => name.slice(name.lastIndexOf('.') + 1);
const unique = (items: Iterable<string>) => [...new Set(items)].sort();

/** Relations a file creates (`create table [if not exists] name`), lower case, as written (schema kept). */
export function createdRelations(sql: string): string[] {
  const text = normalize(sql).text.toLowerCase();
  return unique([...text.matchAll(/\bcreate\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)/gu)].map((match) => match[1]));
}

const PLATFORM_TOKENS: readonly [string, RegExp][] = [
  ['auth.users', /\bauth\.users\b/u], ['auth.identities', /\bauth\.identities\b/u], ['auth.sessions', /\bauth\.sessions\b/u],
  ['auth.uid()', /\bauth\.uid\s*\(/u], ['auth.jwt()', /\bauth\.jwt\s*\(/u], ['storage.*', /\bstorage\.[a-z_]+/u],
  ['vault.*', /\bvault\.[a-z_]+/u], ['cron.*', /\bcron\.[a-z_]+/u], ['net.*', /\bnet\.[a-z_]+/u],
];

function bucketOf(blocking: Set<string>, review: Set<string>): Bucket {
  const has = (code: string) => blocking.has(code);
  if (has('CRON_REFERENCE') && has('NET_REFERENCE') && has('FOREIGN_PROJECT_HOST')) return 'cron_net_production_host';
  if (has('CRON_REFERENCE') || has('NET_REFERENCE') || has('INDIRECT_NETWORK_CALL')) return 'cron_indirect';
  if ([...blocking].every((code) => code === 'VAULT_REFERENCE') && blocking.size > 0) return 'vault_reference';
  if ([...blocking].every((code) => code === 'URL_LITERAL' || code === 'URL_FRAGMENT') && blocking.size > 0) return 'url_literal_seed';
  if (blocking.size > 0) return 'other_blocking';
  return review.size > 0 ? 'review_only' : 'clean';
}

type Provenance = {
  requirements: { relations: string[] };
  relations: { name: string; class: string; createdBy: string[]; alteredBy: string[] }[];
  unknown: { relations: string[]; columns: string[]; foreignKeys: string[] };
  createdButNotReplayable: string[];
};
type Lock = { files: Record<string, string>; networkFunctions?: string[]; dynamicFunctions?: string[]; requirements?: { functions: string[]; columns: { relation: string; column: string }[]; foreignKeys: { relation: string; columns: string[]; references: string; referencedColumns: string[] }[]; relations: string[] } };

/** Reads the oracle TSV (one line per candidate) and says which refusals the Phase 12 contract does not cover. */
export async function summariseOracle(tsv: string, lock: Lock, chainTexts: Record<string, string>): Promise<Oracle> {
  const requirements = lock.requirements;
  const contractFunctions = new Set((requirements?.functions ?? []).map((signature) => signature.replace(/\s+/gu, '')));
  const contractColumns = new Set([
    ...(requirements?.columns ?? []).map((column) => `${column.relation}.${column.column}`),
    ...(requirements?.foreignKeys ?? []).flatMap((key) => [...key.columns.map((c) => `${key.relation}.${c}`), ...key.referencedColumns.map((c) => `${key.references}.${c}`)]),
  ]);
  const covered = (kind: string, object: string) => {
    if (kind === 'function') {
      const name = object.slice(0, object.indexOf('('));
      const types = object.slice(object.indexOf('(') + 1, -1).split(',').map((part) => part.trim().split(/\s+/u).slice(1).join(' ') || part.trim()).join(',');
      return contractFunctions.has(`${name}(${types})`);
    }
    if (kind === 'column') return contractColumns.has(object);
    if (kind === 'table') return (requirements?.relations ?? []).includes(object);
    return false;
  };
  const candidates: Oracle['candidates'] = {};
  const failing: OracleFailure[] = [];
  const notTested: Oracle['notTested'] = [];
  let control = '';
  for (const line of tsv.split('\n').filter((row) => row !== '')) {
    const [kind, object, dropped, result] = line.split('\t');
    if (kind === 'control') { control = result; continue; }
    const row = (candidates[kind] ??= { tested: 0, refused: 0, notTested: 0 });
    if (result === '(not tested)') { row.notTested += 1; notTested.push({ kind, object }); continue; }
    row.tested += 1;
    if (result.startsWith('FAIL')) {
      row.refused += 1;
      const [, chainId, ...rest] = result.split(' ');
      const refusal = rest.join(' ');
      const code = refusal.split(':')[0];
      const source = Object.entries(chainTexts).find(([, text]) => text.includes(code))?.[0] ?? null;
      failing.push({ kind, object, chainId, refusal, sourceFile: source, coveredByContract: covered(kind, object) });
    } else if (dropped !== 'dropped') throw new Error(`oracle row ${kind} ${object} was neither dropped nor blocked`);
  }
  return { file: ORACLE_PATH, sha256: await sha256Hex(tsv), control, candidates, failing, notTested };
}

export async function buildDag(reader: Reader, lock: Lock, provenance: Provenance): Promise<Dag> {
  const migrationsDir = 'supabase/migrations';
  const migrationFiles = reader.list(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
  const pathOf = (name: string) => `${migrationsDir}/${name}`;
  const chainPaths = new Set(CHAIN.map((file) => file.path));
  const required = provenance.requirements.relations;

  // ---- the chain: digests, what each file creates, and what it needs from earlier files, the baseline and the platform
  const texts = CHAIN.map((file) => reader.read(file.path));
  const scans = texts.map((text) => scanSql(text));
  const created = texts.map(createdRelations);
  const defined = scans.map((scan) => unique(scan.definedFunctions.map((fn) => fn.name)));
  const nodes: ChainNode[] = [];
  for (const [index, file] of CHAIN.entries()) {
    const text = normalize(texts[index]).text.toLowerCase();
    const own = new Set([...created[index], ...defined[index]]);
    const requiresChain: string[] = [];
    for (let earlier = 0; earlier < index; earlier += 1) {
      const names = [...created[earlier], ...defined[earlier]].filter((name) => !own.has(name));
      const referenced = names.some((name) => {
        const pattern = name.includes('.') && !defined[earlier].includes(name)
          ? new RegExp(`\\b${escapeRegex(name)}\\b`, 'u')
          : new RegExp(`\\b${escapeRegex(bare(name))}\\b${defined[earlier].includes(name) ? '\\s*\\(' : ''}`, 'u');
        return pattern.test(text);
      });
      if (referenced) requiresChain.push(CHAIN[earlier].id);
    }
    const blocking = scans[index].findings.filter((finding) => finding.severity === 'block').map((finding) => finding.code);
    const review = scans[index].findings.filter((finding) => finding.severity === 'review').map((finding) => finding.code);
    const applied = PRODUCTION_APPLIED[file.id];
    nodes.push({
      id: file.id,
      order: index + 1,
      file: file.path,
      sha256: await sha256Hex(texts[index]),
      bytes: new TextEncoder().encode(texts[index]).length,
      marker: file.marker,
      production: applied ? 'applied' : 'draft',
      ...(applied ? { appliedEvidence: applied } : {}),
      createsRelations: created[index],
      definesFunctions: defined[index],
      requires: {
        chain: requiresChain,
        baseline: required.filter((name) => new RegExp(`\\b${escapeRegex(name)}\\b`, 'u').test(text)),
        platform: PLATFORM_TOKENS.filter(([, pattern]) => pattern.test(text)).map(([label]) => label),
      },
      scanner: { blocking: unique(blocking), review: unique(review) },
    });
  }

  // ---- everything else: never sent; the baseline export carries what it created
  const knownCreators: Dag['baseline']['knownCreators'] = {};
  for (const relation of provenance.relations) knownCreators[relation.name] = { class: relation.class, createdBy: relation.createdBy, alteredBy: relation.alteredBy };
  const effects = new Map<string, string[]>();
  for (const relation of provenance.relations) {
    for (const stamp of [...relation.createdBy, ...relation.alteredBy]) {
      effects.set(stamp, unique([...(effects.get(stamp) ?? []), relation.name]));
    }
  }
  const excludedFiles: ExcludedFile[] = [];
  const buckets = Object.fromEntries(BUCKETS.map((bucket) => [bucket, [] as string[]])) as Record<Bucket, string[]>;
  const corpusScans = [];
  for (const name of migrationFiles) {
    const text = reader.read(pathOf(name));
    const scan = scanSql(text);
    corpusScans.push(scan);
    if (chainPaths.has(pathOf(name))) continue;
    const blocking = new Set(scan.findings.filter((finding) => finding.severity === 'block').map((finding) => finding.code));
    const review = new Set(scan.findings.filter((finding) => finding.severity === 'review').map((finding) => finding.code));
    const bucket = bucketOf(blocking, review);
    buckets[bucket].push(name);
    excludedFiles.push({
      file: pathOf(name), sha256: await sha256Hex(text), bucket, blocking: unique(blocking), review: unique(review),
      requiredRelationEffects: effects.get(name.slice(0, name.indexOf('_'))) ?? [],
    });
  }

  const chainTexts = Object.fromEntries(CHAIN.map((file, index) => [file.path, texts[index]]));
  const oracle = await summariseOracle(reader.read(ORACLE_PATH), lock, chainTexts);

  return {
    version: 1,
    kind: 'postona-disposable-supabase-migration-dag',
    rules: [
      'A migration file is applied to a disposable project only if it is a chain node below, byte-identical to its sha256, with no blocking scanner finding.',
      'No other repository migration is ever applied: what they created is carried by the digest-pinned schema-only baseline export, and 8 of them name the production host with cron.schedule + net.http_post.',
      'P1 and P2 are recorded as applied to production; P3a..P10 are unmerged Draft source. Nothing here is a production approval.',
      'Missing DDL (public.brands, public.social_accounts, public.social_account_oauth_states) is never inferred: it is listed as unknown until a separately approved schema-only inventory supplies it.',
      '`supabase db push`, `supabase link` and "apply every migration" are never used.',
    ],
    chain: nodes,
    baseline: {
      requiredRelations: required,
      unknownRelations: provenance.unknown.relations,
      unknownColumns: provenance.unknown.columns,
      unknownForeignKeys: provenance.unknown.foreignKeys,
      createdButNotReplayable: provenance.createdButNotReplayable,
      knownCreators,
    },
    excluded: { total: excludedFiles.length, buckets, files: excludedFiles },
    oracle,
    external: EXTERNAL,
    corpus: { migrations: migrationFiles.length, networkFunctions: lock.networkFunctions ?? [], dynamicFunctions: (lock.dynamicFunctions ?? []).length },
  };
}

/** The generated tables of the document (everything between the GENERATED markers). Deterministic. */
export function renderTables(dag: Dag): string {
  const short = (digest: string) => `\`${digest.slice(0, 16)}…\``;
  const rows = dag.chain.map((node) => {
    const requires = [...node.requires.chain, ...node.requires.baseline.map((name) => name.replace(/^public\./u, '')), ...node.requires.platform].join(', ') || '—';
    return `| ${node.order} | ${node.id} | \`${node.file.split('/').pop()}\` | ${short(node.sha256)} | ${node.production === 'applied' ? '**applied**' : 'Draft'} | ${requires} | \`${node.marker}\` |`;
  });
  const bucketRows = BUCKETS.map((bucket) => `| \`${bucket}\` | ${dag.excluded.buckets[bucket].length} |`);
  const eight = dag.excluded.buckets.cron_net_production_host.map((name) => `- \`${name}\``);
  const nine = dag.excluded.buckets.cron_indirect.map((name) => `- \`${name}\``);
  return [
    '### Chain (the only files that may be applied), in release order',
    '',
    '| # | id | file | sha256 | production | requires (earlier chain files, baseline relations, platform objects) | marker |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    `Full digests: [\`phase13-migration-dag.json\`](phase13-migration-dag.json) (\`chain[].sha256\`); they equal \`plan.lock.json\`.`,
    '',
    `### Exclusion list: ${dag.excluded.total} of ${dag.corpus.migrations} repository migrations are never applied`,
    '',
    '| bucket | files |',
    '| --- | --- |',
    ...bucketRows,
    '',
    `The ${dag.excluded.buckets.cron_net_production_host.length} that name the production host with \`cron.schedule\` + \`net.http_post\`:`,
    '',
    ...eight,
    '',
    `Indirect cron (rewrites existing job commands from Vault; no host in its text):`,
    '',
    ...nine,
    '',
    '### Prerequisites the chain has at apply time (prerequisite oracle, local model baseline)',
    '',
    `Control (unmodified model baseline, whole chain): **${dag.oracle.control}**. Candidates removed one at a time: ${Object.entries(dag.oracle.candidates).map(([kind, row]) => `${kind} ${row.tested + row.notTested}`).join(', ')}.`,
    '',
    '| removed object | kind | first refusal | file that refuses | in the Phase 12 contract |',
    '| --- | --- | --- | --- | --- |',
    ...dag.oracle.failing.map((row) => `| \`${row.object.replace(/\(.*$/u, row.kind === 'function' ? '()' : '')}\` | ${row.kind} | ${row.chainId}: \`${row.refusal.split(':')[0]}\` | \`${(row.sourceFile ?? '?').split('/').pop()}\` | ${row.coveredByContract ? 'yes' : '**NO — gap**'} |`),
    '',
    `Not testable alone (they have dependents): ${dag.oracle.notTested.map((row) => `\`${row.object.replace(/\(.*$/u, '')}\``).join(', ')}.`,
    '',
  ].join('\n');
}

export function withGenerated(doc: string, tables: string): string {
  const begin = doc.indexOf(BEGIN_MARK);
  const end = doc.indexOf(END_MARK);
  if (begin < 0 || end < begin) throw new Error('the document has no GENERATED:DAG markers');
  return `${doc.slice(0, begin + BEGIN_MARK.length)}\n\n${tables}\n${doc.slice(end)}`;
}

export const serialize = (dag: Dag) => `${JSON.stringify(dag, null, 2)}\n`;

// ---- command line ------------------------------------------------------------------------------------------------------

if (import.meta.main) {
  const root = new URL('../../../', import.meta.url);
  const reader: Reader = {
    list: (dir) => [...Deno.readDirSync(new URL(`${dir}/`, root))].filter((entry) => entry.isFile).map((entry) => entry.name),
    read: (path) => Deno.readTextFileSync(new URL(path, root)),
  };
  const lock = JSON.parse(reader.read('supabase/preflight/managed_disposable/plan.lock.json')) as Lock;
  const provenance = JSON.parse(reader.read('supabase/preflight/managed_disposable/baseline_provenance.json')) as Provenance;
  const dag = await buildDag(reader, lock, provenance);
  const json = serialize(dag);
  const doc = withGenerated(reader.read(DOC_PATH), renderTables(dag));
  if (Deno.args.includes('--write')) {
    Deno.writeTextFileSync(new URL(DAG_PATH, root), json);
    Deno.writeTextFileSync(new URL(DOC_PATH, root), doc);
    console.log(`wrote ${DAG_PATH} (${dag.chain.length} chain nodes, ${dag.excluded.total} excluded) and the generated tables of ${DOC_PATH}`);
  } else {
    const current = reader.read(DAG_PATH);
    const currentDoc = reader.read(DOC_PATH);
    if (current !== json || currentDoc !== doc) {
      console.error('the DAG json or the generated tables of the document differ from a fresh generation (run with --write and review the diff)');
      Deno.exit(1);
    }
    console.log('the DAG json and the generated tables are current');
  }
}
