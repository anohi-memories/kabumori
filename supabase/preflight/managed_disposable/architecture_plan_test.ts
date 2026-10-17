// Offline contract of the Phase 13 architecture plan (docs/common-account/phase13-postona-disposable-supabase-architecture.md).
// The document makes claims that must stay true of THIS checkout: the pinned migration DAG and its digests, the exclusion
// list, the production-applied prefix, the prerequisite-oracle numbers, the source lines it cites, the absence of secrets and
// production references, and the gates it promises. Pure file reads; no database, no network, no managed project.
//
//   deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/architecture_plan_test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BEGIN_MARK, buildDag, DAG_PATH, type Dag, DOC_PATH, END_MARK, EXTERNAL, ORACLE_PATH, PRODUCTION_APPLIED, type Reader, renderTables,
  serialize, withGenerated,
} from './architecture_dag.ts';
import { projectRefsIn, resolveTarget, scanSqlForForeignTargets } from './guard.ts';
import { secretFindings } from './inventory.ts';
import { sha256Hex } from './lock.ts';
import { CHAIN, STEPS } from './plan.ts';
import { run, type Lock } from './runner.ts';
import { scanSql } from './sql_scan.ts';

const root = new URL('../../../', import.meta.url);
const here = new URL('./', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));
const exists = (path: string) => { try { Deno.statSync(new URL(path, root)); return true; } catch { return false; } };
const reader: Reader = {
  list: (dir) => [...Deno.readDirSync(new URL(`${dir}/`, root))].filter((entry) => entry.isFile).map((entry) => entry.name),
  read,
};
const lock = JSON.parse(Deno.readTextFileSync(new URL('plan.lock.json', here))) as Lock & { networkFunctions?: string[]; dynamicFunctions?: string[] };
const provenance = JSON.parse(Deno.readTextFileSync(new URL('baseline_provenance.json', here)));
const doc = read(DOC_PATH);
const dag = JSON.parse(read(DAG_PATH)) as Dag;
const tsv = read(ORACLE_PATH);
const migrationNames = reader.list('supabase/migrations').filter((name) => name.endsWith('.sql')).sort();

// The eight repository migrations that schedule a cron job calling the production host, and the one that rewrites job commands.
const BG2_EIGHT = [
  '20260908110000_add_important_news_publish_ready_cron.sql', '20260910163500_add_send_push_notifications_dispatch_cron.sql',
  '20260916100000_mic_phase1b_automation_cron.sql', '20260919090000_mic_fx_phase1_automation_cron.sql',
  '20260921090000_mic_equity_index_phase1_automation_cron.sql', '20260923090000_mic_macro_indicators_phase1a_automation_cron.sql',
  '20260924093000_mic_estat_activation_and_gated_macro_cron.sql', '20260930090000_mic_scenario_automation_cron_phase3c.sql',
];
const BG2_INDIRECT = ['20260923110440_important_news_monitor_caller_auth.sql'];

// ---- 1. the pinned DAG is the checkout, and the document's generated block is the DAG -----------------------------------

test('the committed DAG json and the document\'s generated tables equal a fresh generation from this checkout', async () => {
  const fresh = await buildDag(reader, lock, provenance);
  assert.equal(read(DAG_PATH), serialize(fresh), 'run architecture_dag.ts --write and review the diff');
  assert.equal(doc, withGenerated(doc, renderTables(fresh)), 'the generated block of the document is stale');
  assert.ok(doc.indexOf(BEGIN_MARK) > 0 && doc.indexOf(END_MARK) > doc.indexOf(BEGIN_MARK));
});

test('the check can fail: a changed chain byte, a smuggled cron call and a tampered table are each detected', async () => {
  const mutated = (path: string, change: (text: string) => string): Reader => ({ ...reader, read: (p) => (p === path ? change(read(p)) : read(p)) });
  const p6 = CHAIN.find((file) => file.id === 'P6')!.path;
  const changed = await buildDag(mutated(p6, (text) => `${text}\n-- x\n`), lock, provenance);
  assert.notEqual(serialize(changed), read(DAG_PATH), 'one added byte must change the pinned digest');
  const cron = await buildDag(mutated(p6, (text) => `${text}\nselect cron.schedule('j','* * * * *','select 1');\n`), lock, provenance);
  assert.ok(cron.chain.find((node) => node.id === 'P6')!.scanner.blocking.includes('CRON_REFERENCE'), 'a cron call in a chain file is a blocking finding');
  const dagNow = await buildDag(reader, lock, provenance);
  assert.notEqual(withGenerated(doc, renderTables(dagNow).replace('P10', 'P11')), doc);
});

test('chain = plan order = Phase 7 runner list = lock digests = bytes on disk; the production-applied prefix is P1, P2 with findable evidence', async () => {
  assert.deepEqual(dag.chain.map((node) => node.id), CHAIN.map((file) => file.id));
  assert.deepEqual(dag.chain.map((node) => node.file), CHAIN.map((file) => file.path));
  const runner = read('supabase/tests/common_account_release_preflight_run.sh');
  const listed = [...runner.slice(runner.indexOf('CHAIN_FILES=('), runner.indexOf('CHAIN_NAMES=')).matchAll(/^\s+(\d{14}_[a-z0-9_]+\.sql)$/gmu)].map((m) => `supabase/migrations/${m[1]}`);
  assert.deepEqual(dag.chain.map((node) => node.file), listed);
  for (const node of dag.chain) {
    assert.equal(node.sha256, lock.files[node.file], `${node.id}: the DAG digest equals plan.lock.json`);
    assert.equal(node.sha256, await sha256Hex(read(node.file)), `${node.id}: the DAG digest equals the bytes on disk`);
    assert.deepEqual(node.scanner.blocking, [], `${node.id}: a blocked migration is never a chain node`);
  }
  assert.deepEqual(dag.chain.filter((node) => node.production === 'applied').map((node) => node.id), ['P1', 'P2']);
  assert.deepEqual(dag.chain.slice(0, 2).map((node) => node.production), ['applied', 'applied'], 'the applied prefix comes first');
  assert.ok(dag.chain.slice(2).every((node) => node.production === 'draft'));
  for (const [id, evidence] of Object.entries(PRODUCTION_APPLIED)) {
    assert.ok(read(evidence.file).includes(evidence.phrase), `${id}: the repository phrase that records the production apply is still in ${evidence.file}`);
  }
});

test('dependencies point only backwards, and each node\'s marker is the one the harness checks', () => {
  const position = new Map(dag.chain.map((node, index) => [node.id, index]));
  for (const [index, node] of dag.chain.entries()) {
    for (const needed of node.requires.chain) assert.ok((position.get(needed) ?? Infinity) < index, `${node.id} needs ${needed}, which is not earlier`);
    assert.equal(node.marker, CHAIN[index].marker);
    assert.ok(node.sha256.length === 64 && /^[0-9a-f]{64}$/u.test(node.sha256));
  }
  assert.deepEqual(dag.chain.find((node) => node.id === 'P2')!.requires.chain, ['P1']);
  assert.ok(dag.chain.find((node) => node.id === 'P9')!.requires.chain.includes('P3b'), 'the session fence builds on the writer guard');
  assert.ok(dag.chain.find((node) => node.id === 'P9')!.requires.platform.includes('auth.sessions'));
});

test('the exclusion list partitions the corpus: 110 + 10 = 120, no chain file is excluded, no excluded file is pinned by the lock', () => {
  assert.equal(dag.corpus.migrations, migrationNames.length);
  assert.equal(dag.excluded.total + dag.chain.length, migrationNames.length);
  const chainNames = new Set(dag.chain.map((node) => node.file.split('/').pop()));
  const excludedNames = dag.excluded.files.map((file) => file.file.split('/').pop() as string);
  assert.equal(new Set(excludedNames).size, excludedNames.length);
  assert.ok(excludedNames.every((name) => !chainNames.has(name)));
  assert.deepEqual([...excludedNames, ...chainNames].sort(), migrationNames);
  const bucketed = Object.values(dag.excluded.buckets).flat();
  assert.deepEqual([...bucketed].sort(), [...excludedNames].sort());
  for (const file of dag.excluded.files) assert.ok(!(file.file in lock.files), `${file.file} must not be pinned for sending`);
});

test('the eight production-calling cron migrations and the one indirect rewriter are exactly the BG2 list, and the guard also refuses the eight', () => {
  assert.deepEqual(dag.excluded.buckets.cron_net_production_host, BG2_EIGHT);
  assert.deepEqual(dag.excluded.buckets.cron_indirect, BG2_INDIRECT);
  for (const name of BG2_EIGHT) {
    const file = dag.excluded.files.find((entry) => entry.file.endsWith(name))!;
    for (const code of ['CRON_REFERENCE', 'NET_REFERENCE', 'FOREIGN_PROJECT_HOST']) assert.ok(file.blocking.includes(code), `${name} ${code}`);
    assert.ok(scanSqlForForeignTargets(read(`supabase/migrations/${name}`), 'a'.repeat(20)).length > 0, `${name}: the guard refuses it`);
  }
  assert.deepEqual(lock.networkFunctions ?? [], [], 'no SQL helper reaches the network in the chain closure');
  assert.equal(dag.corpus.dynamicFunctions, (lock.dynamicFunctions ?? []).length);
  for (const node of dag.chain) assert.deepEqual(scanSqlForForeignTargets(read(node.file), 'a'.repeat(20)), [], `${node.id} is clean to send`);
});

test('the baseline facts of the document are the provenance record: 17 relations, 3 unknown, 6 columns, 4 foreign keys', () => {
  const requirements = provenance.requirements;
  assert.deepEqual([requirements.relations.length, requirements.columns.length, requirements.foreignKeys.length, requirements.functions.length], [17, 26, 14, 2]);
  assert.deepEqual([...provenance.unknown.relations].sort(), ['public.brands', 'public.social_account_oauth_states', 'public.social_accounts']);
  assert.equal(provenance.unknown.columns.length, 6);
  assert.equal(provenance.unknown.foreignKeys.length, 4);
  assert.deepEqual(provenance.createdButNotReplayable, ['public.brand_memberships', 'public.social_mobile_account_deletions']);
  const classes = Object.values(dag.baseline.knownCreators).map((entry) => entry.class);
  const count = (name: string) => classes.filter((c) => c === name).length;
  assert.deepEqual([count('platform_managed'), count('repository_created'), count('repository_altered_only'), count('absent_from_repository')], [4, 10, 2, 1]);
  assert.deepEqual(dag.baseline.knownCreators['public.brands'].createdBy, [], 'no migration creates public.brands');
  assert.ok(exists('supabase/migrations') && !exists('supabase/config.toml'), 'F-5: the repository has no supabase/config.toml');
});

// ---- 2. the prerequisite oracle and the contract gap -----------------------------------------------------------------------

test('the oracle evidence: control OK, 96 candidates, four refusals of which exactly two are outside the Phase 12 contract', async () => {
  const lines = tsv.split('\n').filter((row) => row !== '');
  assert.equal(lines.length, 97);
  assert.equal(dag.oracle.sha256, await sha256Hex(tsv));
  assert.equal(dag.oracle.control, 'OK');
  const candidates = Object.values(dag.oracle.candidates);
  assert.equal(candidates.reduce((sum, row) => sum + row.tested + row.notTested, 0), 96);
  assert.deepEqual(dag.oracle.failing.map((row) => `${row.chainId} ${row.object.replace(/\(.*$/u, '')}`).sort(), [
    'P1 public.social_mobile_account_deletion_subject', 'P1 public.social_mobile_account_deletion_workspace', 'P4 public.ensure_my_profile', 'P6 public.social_accounts.platform',
  ]);
  assert.deepEqual(dag.oracle.failing.filter((row) => !row.coveredByContract).map((row) => row.object.replace(/\(.*$/u, '')).sort(), ['public.ensure_my_profile', 'public.social_accounts.platform']);
  // the document quotes these numbers
  const none = (kind: string) => dag.oracle.candidates[kind].tested - dag.oracle.candidates[kind].refused;
  assert.match(doc, new RegExp(`${none('function')} functions,\\s+${none('table')} tables, ${none('trigger')} triggers and ${none('column')} columns could be removed`, 'u'));
  assert.deepEqual([none('function'), none('table'), none('trigger'), none('column')], [23, 10, 11, 44]);
});

test('GAP PIN: the Phase 12 contract does not yet cover ensure_my_profile() or social_accounts.platform (D-1); fix both before any production read, then update this pin', () => {
  const requirements = lock.requirements as { functions: string[]; columns: { relation: string; column: string }[] };
  assert.ok(!requirements.functions.some((signature) => signature.includes('ensure_my_profile')));
  assert.ok(!requirements.columns.some((column) => column.relation === 'public.social_accounts' && column.column === 'platform'));
  assert.match(doc, /\*\*D-1\*\*/u);
  assert.ok(read('supabase/migrations/20261012130000_common_account_core_service_fence.sql').includes('COMMON_ACCOUNT_CORE_FENCE_PREFLIGHT_ENSURE_MY_PROFILE_SHAPE'));
  assert.ok(read('supabase/migrations/20261013120000_common_account_service_deletion_ownership.sql').includes('COMMON_ACCOUNT_SERVICE_OWNERSHIP_PREFLIGHT_SHAPE'));
});

// ---- 3. no secret, no production reference, no placeholder ---------------------------------------------------------------------

const ARTIFACTS: Record<string, string> = {
  [DOC_PATH]: doc,
  [DAG_PATH]: read(DAG_PATH),
  [ORACLE_PATH]: tsv,
  'supabase/tests/common_account_phase13_prerequisite_oracle.sh': read('supabase/tests/common_account_phase13_prerequisite_oracle.sh'),
  'supabase/preflight/managed_disposable/architecture_dag.ts': Deno.readTextFileSync(new URL('architecture_dag.ts', here)),
};

test('no artifact of this phase holds secret-shaped text, a production project ref or any project host', () => {
  const production = new Set(migrationNames.flatMap((name) => projectRefsIn(read(`supabase/migrations/${name}`))));
  assert.ok(production.size >= 1, 'the repository itself names production (the guard derives its deny list from it)');
  for (const [path, text] of Object.entries(ARTIFACTS)) {
    // the one URL form the document may hold is the placeholder `https://<ref>.supabase.co/...` (the provider-callback shape)
    assert.deepEqual(secretFindings(text.replace(/https:\/\/<ref>\.supabase\.co\/[A-Za-z0-9/_-]*/gu, '')), [], `${path}: secret-shaped text or a URL`);
    assert.deepEqual(projectRefsIn(text), [], `${path}: a project host`);
    for (const ref of production) assert.ok(!text.includes(ref), `${path}: names a production ref`);
    assert.ok(!/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/u.test(text), `${path}: a JWT`);
    assert.ok(!/postgres(?:ql)?:\/\/[^\s<>`]*:[^\s<>`@]+@/u.test(text), `${path}: a database URL with a password`);
    assert.ok(!/sb_(?:secret|publishable)_[A-Za-z0-9]/u.test(text), `${path}: a Supabase key`);
  }
  assert.ok(!doc.includes('RESULTS_PLACEHOLDER') && !/\bTODO\b|\bFIXME\b|\bTBD\b/u.test(doc), 'no unfinished marker');
});

// ---- 4. every file the document links exists; every cited line says what the document says it says ------------------------------

const LINE_FACTS: readonly [file: string, from: number, to: number, pattern: RegExp][] = [
  ['supabase/functions/social-mobile-account-delete/delete_logic.ts', 21, 21, /RECENT_AUTH_SECONDS = 600/u],
  ['supabase/functions/social-mobile-account-delete/delete_logic.ts', 74, 81, /lastAuthenticatedAt[\s\S]*amr[\s\S]*timestamp[\s\S]*Math\.max/u],
  ['supabase/functions/social-mobile-account-delete/delete_logic.ts', 156, 156, /SCOPE_CHANGED/u],
  ['supabase/functions/account-delete/lifecycle_logic.ts', 207, 210, /RECENT_AUTH_SECONDS/u],
  ['supabase/functions/account-delete/lifecycle_logic.ts', 267, 270, /managedDeleteReleased[\s\S]*release_gate/u],
  ['supabase/functions/account-delete/lifecycle_logic.ts', 685, 685, /recentlyAuthenticated/u],
  ['supabase/functions/account-delete/lifecycle_logic.ts', 721, 721, /recentlyAuthenticated/u],
  ['supabase/functions/account-delete/lifecycle_logic.ts', 748, 748, /X_CLEANUP_UNSUPPORTED/u],
  ['supabase/functions/account-delete/lifecycle_logic.ts', 826, 834, /recentlyAuthenticated[\s\S]*managedDeleteReleased[\s\S]*COMMON_ACCOUNT_DELETION_UNAVAILABLE/u],
  ['supabase/functions/account-delete/lifecycle_logic_test.ts', 82, 82, /600-second boundary is exact/u],
  ['supabase/functions/account-delete/http.ts', 2, 2, /Keep platform JWT verification ON/u],
  ['supabase/functions/account-delete/http.ts', 9, 10, /legacy call with no body[\s\S]*ACTION_REQUIRED/u],
  ['supabase/functions/account-delete/http.ts', 15, 15, /appleConfigFrom/u],
  ['supabase/functions/account-delete/http.ts', 127, 128, /action !== 'preview'[\s\S]*ACTION_REQUIRED/u],
  ['supabase/functions/account-delete/http.ts', 137, 137, /appleConfigFrom/u],
  ['supabase/functions/account-delete/http.ts', 186, 186, /revokeApple: apple \?[\s\S]*: null/u],
  ['supabase/functions/account-delete/http.ts', 189, 192, /x: \{[\s\S]*preview[\s\S]*callX/u],
  ['supabase/functions/account-delete/http.ts', 220, 226, /handlePreview[\s\S]*handleDeleteCommonAccount/u],
  ['supabase/migrations/20261010051938_common_account_service_write_guard.sql', 55, 64, /auth\.sessions[\s\S]*has_table_privilege/u],
  ['supabase/migrations/20261010051938_common_account_service_write_guard.sql', 97, 97, /request\.jwt\.claim\.session_id/u],
  ['supabase/migrations/20261010051938_common_account_service_write_guard.sql', 107, 107, /session_id/u],
  ['supabase/migrations/20261010051938_common_account_service_write_guard.sql', 154, 156, /auth\.sessions[\s\S]*not_after/u],
  ['supabase/migrations/20261015090000_common_account_enrollment_session_fence.sql', 80, 84, /auth\.sessions[\s\S]*has_table_privilege/u],
  ['supabase/migrations/20261015090000_common_account_enrollment_session_fence.sql', 108, 108, /request\.jwt\.claim\.session_id/u],
  ['supabase/migrations/20261015090000_common_account_enrollment_session_fence.sql', 117, 117, /session_id/u],
  ['supabase/migrations/20261015090000_common_account_enrollment_session_fence.sql', 138, 140, /auth\.sessions[\s\S]*not_after/u],
  ['apps/social-mobile/src/domain/service-enrollment.ts', 114, 114, /export function loginSessionIdOf/u],
  ['apps/social-mobile/src/providers/auth-provider.tsx', 212, 238, /reauthenticate[\s\S]*sessionIdOf[\s\S]*context: \{ userId, sessionId \}/u],
  ['apps/social-mobile/src/domain/auth-flows.ts', 15, 15, /AUTH_CALLBACK_URL = 'kabumori-social:\/\/auth-callback'/u],
  ['apps/social-mobile/src/domain/auth-flows.ts', 17, 17, /POSTING_CALLBACK_URL = 'kabumori-social:\/\/oauth-callback'/u],
  ['apps/social-mobile/src/lib/supabase.ts', 52, 52, /appendPkceFlowIdToRedirects: true/u],
  ['apps/social-mobile/src/lib/auth-client-flows.ts', 61, 61, /redirectTo: AUTH_CALLBACK_URL/u],
  ['apps/social-mobile/src/lib/auth-client-flows.ts', 91, 91, /redirectTo: AUTH_CALLBACK_URL/u],
  ['apps/social-mobile/docs/account-deletion-rollout-runbook.md', 168, 168, /verify_jwt=true/u],
  ['docs/common-account/phase10-x-ack-snapshot.md', 179, 179, /R2'/u],
  ['docs/postona/multi-social-phase1.md', 42, 42, /brands/u],
  ['docs/postona/multi-social-phase1.md', 43, 43, /social_accounts/u],
];

test('every pinned line fact holds (the lines the document cites say what it says they say)', () => {
  for (const [file, from, to, pattern] of LINE_FACTS) {
    const lines = read(file).split('\n');
    assert.ok(lines.length >= to, `${file} has fewer than ${to} lines`);
    assert.match(lines.slice(from - 1, to).join('\n'), pattern, `${file}:${from}-${to}`);
  }
});

const backticked = [...doc.matchAll(/`([^`\n]+)`/gu)].map((match) => match[1]);
const ROOTS = /^(?:supabase|apps|docs|\.agent)\//u;
const CITE = /^(.+?):(\d+(?:[–-]\d+)?(?:,\d+(?:[–-]\d+)?)*)$/u;
const external = new Set(EXTERNAL.map((entry) => entry.path));
const ABSENT_BY_DESIGN = new Set(['supabase/config.toml']);

test('every repository path the document names exists (or is a pinned external file, or is documented as absent)', () => {
  let checked = 0;
  for (const token of backticked) {
    const cite = CITE.exec(token);
    const path = cite ? cite[1] : token;
    if (!ROOTS.test(path) || /[*<>\s]/u.test(path)) continue;
    checked += 1;
    if (ABSENT_BY_DESIGN.has(path)) { assert.ok(!exists(path), `${path} is documented as absent`); continue; }
    assert.ok(exists(path) || external.has(path), `the document names ${path}, which is neither in the tree nor a pinned external file`);
  }
  assert.ok(checked >= 40, `only ${checked} paths were checked`);
  for (const link of doc.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/gu)) {
    if (/^[a-z]+:/u.test(link[1])) continue;
    assert.ok(exists(`docs/common-account/${link[1]}`), `broken link ${link[1]}`);
  }
});

test('every cited line range in the document is covered by a pinned line fact', () => {
  let cites = 0;
  for (const token of backticked) {
    const cite = CITE.exec(token);
    if (!cite || !ROOTS.test(cite[1]) || external.has(cite[1])) continue;
    cites += 1;
    for (const part of cite[2].split(',')) {
      const [from, to = from] = part.split(/[–-]/u).map(Number);
      assert.ok(
        LINE_FACTS.some(([file, a, b]) => file === cite[1] && a <= from && to <= b),
        `${token}: no pinned line fact covers ${part}; add one to LINE_FACTS (it is checked against the source)`,
      );
    }
  }
  assert.ok(cites >= 15, `only ${cites} citations were checked`);
});

test('external files are pinned by PR, commit and git blob id, and the exact heads in the evidence table are the pinned commits', () => {
  for (const entry of EXTERNAL) {
    assert.match(entry.commit, /^[0-9a-f]{40}$/u);
    assert.match(entry.blob, /^[0-9a-f]{40}$/u);
    assert.ok(doc.includes(entry.commit), `${entry.path}: the evidence table names commit ${entry.commit}`);
    assert.ok(doc.includes(`#${entry.pr}`), `PR #${entry.pr} is named`);
  }
  for (const head of ['28695586f63a30c739a44b829e79a7950932b5e7', '3d87a8457ddade3209583cbb820d5e5feec23f00', '499a9e1fac595064fbc3928725be8907db1b692b', '45b08a879749b853d3dc77465d9e65e8fd684305']) {
    assert.ok(doc.includes(head));
  }
});

// ---- 5. the promises of the document ------------------------------------------------------------------------------------------------

test('the document has every required section, gate and decision, and states the safety boundary', () => {
  for (let n = 1; n <= 14; n += 1) assert.match(doc, new RegExp(`^## ${n}\\. `, 'mu'), `section ${n}`);
  for (const id of ['PG0', 'PG1', 'PG2a', 'PG2b', 'PG3', 'PG4', 'PG5', 'PG6', 'PG7', 'PG8', 'PG9']) assert.ok(doc.includes(`**${id}**`), `gate ${id}`);
  for (const label of ['**A1**', '**A2**', '**AS-A**', '**D-1**', '**D-2**', '**D-3**', '**D-4**', '**D-5**', 'Q-1', 'Q-8', 'CA-1', 'CA-6', 'M14', 'M15', 'X-1', 'X-7', 'F-1', 'F-6']) {
    assert.ok(doc.includes(label), label);
  }
  for (const phrase of ['REFUSED (10 failing)', 'managed_auth_delete', 'IDP_PREPAUSE_BLOCKED', 'NO_GO', 'supabase db push', '**NO_GO**', 'Nothing in this document was run against any managed or production system']) {
    assert.ok(doc.includes(phrase), phrase);
  }
  // the thirteen F4 #243 checks are all mapped
  for (const check of ['DATA_SOURCE_SUPABASE', 'ENV_FILES_CONSISTENT', 'ENV_FILES_NO_MOCK', 'KEY_IS_PUBLISHABLE', 'URL_NOT_PRODUCTION', 'URL_IS_DECLARED_SANDBOX', 'SANDBOX_DECLARED', 'SANDBOX_NOT_PRODUCTION', 'REDIRECTS_DECLARED', 'END_FLAG_LOCAL_ONLY', 'OTHER_GATES_OFF', 'OWNER_SIGNOFF', 'SIDE_EFFECTS_ATTESTED']) {
    assert.ok(doc.includes(check), `#243 check ${check}`);
  }
  // every gate row says it is a separate approval; no row grants the next
  assert.match(doc, /Every row is a \*\*separate, explicit owner approval\*\*/u);
  assert.match(doc, /All rows are NO_GO today/u);
});

test('the harness plan the document builds on still has the steps it names, G3b before any mutation, and the dry run touches nothing', async () => {
  const ids = STEPS.map((step) => step.id);
  for (const id of ['G1', 'G2', 'G3a', 'G3b', 'G3c', 'G4', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'M11', 'M12', 'T1']) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes('M14') && !ids.includes('M15'), 'M14 / M15 are proposals of this plan, not yet in plan.ts');
  assert.ok(ids.indexOf('G3b') < ids.indexOf('G3-P1'));
  // no transport is passed: a dry run that tried to call anything would throw
  const report = await run(STEPS, { mode: 'dry-run', decision: resolveTarget({}), lock, reader: { read } });
  assert.ok(report.results.length > 20 && report.results.every((result) => result.status === 'NOT_RUN'));
  assert.equal(report.complete, false);
});

test('scanning the chain with the real scanner yields no blocking finding and no network function (the claim of section 7)', () => {
  for (const file of CHAIN) {
    const findings = scanSql(read(file.path)).findings.filter((finding) => finding.severity === 'block');
    assert.deepEqual(findings.map((finding) => finding.code), [], file.path);
  }
});
