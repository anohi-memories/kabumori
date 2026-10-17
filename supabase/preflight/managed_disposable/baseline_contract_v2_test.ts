// Pure tests of the baseline contract v2 (F5 Phase 13): the three baseline objects the Phase 12 contract did not cover --
// public.ensure_my_profile() (shape), public.social_accounts.platform, auth.uid() -- are read out of the chain files' own
// preflights, are part of the requirement check and of the fingerprint, fail closed when absent / retyped / reshaped / moved,
// and never leak a value. The Phase 12 coverage is modelled by removing the three from the requirements; the real Phase 12
// code (the base commit) is run against a real local database by supabase/tests/common_account_phase13_contract_extension_run.sh.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRequirements, CHAIN_PREREQUISITE_FILES, CONTRACT_VERSION, EXPECTATIONS, extractChainPrerequisites, extractRequirements, isCurrentContract,
  PREFLIGHT_MIGRATION, type Requirements,
} from './baseline_requirements.ts';
import { auditChainPreflights, uncovered } from './chain_preflight_audit.ts';
import { projectRefsIn } from './guard.ts';
import { H, syntheticInventory } from './inventory_fixtures.ts';
import { baselineReadiness, canonicalize, chainMarkersPresent, checkRequirements, contractSubset, type Line, secretFindings, verifyInventory } from './inventory.ts';
import { sha256Hex } from './lock.ts';
import { CHAIN } from './plan.ts';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));
const requirements = buildRequirements(read);
const ENSURE = 'public.ensure_my_profile()';
const AUTH_UID = 'auth.uid()';
const PLATFORM_COLUMN = 'public.social_accounts.platform';
const P4_MARKER = 'private.account_lifecycle_service_state_refusal(uuid,text)';

/** The Phase 12 coverage, modelled: the same requirements without the three Phase 13 additions. */
const phase12Coverage: Requirements = {
  ...requirements,
  functions: requirements.functions.filter((signature) => signature !== ENSURE),
  columns: requirements.columns.filter((c) => `${c.relation}.${c.column}` !== PLATFORM_COLUMN),
  functionShapes: [],
  platformFunctions: [],
  prerequisites: [],
};

type Options = Parameters<typeof syntheticInventory>[1];
const synthetic = (options: Options = {}): Line[] => syntheticInventory(requirements, options);
const toText = (lines: Line[]) => lines.map((line) => JSON.stringify(line)).join('\n');
const digestOf = async (lines: Line[], over: Requirements = requirements) => (await canonicalize(contractSubset(lines, over))).digest;
const codes = (lines: Line[], over: Requirements = requirements) => checkRequirements(lines, over).map((f) => f.code).sort();
const find = (lines: Line[], kind: string, key: string) => lines.find((line) => line.k === kind && line.key === key);

// ---- 1. the requirements are READ out of the chain files -----------------------------------------------------------------------

test('contract v2: the Phase 1 lists are unchanged, plus exactly the three objects the later preflights name', () => {
  const phase1 = extractRequirements(read(PREFLIGHT_MIGRATION));
  assert.equal(requirements.contractVersion, CONTRACT_VERSION);
  assert.equal(requirements.relations.length, 17);
  assert.equal(requirements.columns.length, phase1.columns.length + 1);
  assert.deepEqual(requirements.columns.filter((c) => !phase1.columns.some((p) => p.relation === c.relation && p.column === c.column)), [{ relation: 'public.social_accounts', column: 'platform', type: 'text' }]);
  assert.deepEqual(requirements.functions, [ENSURE, ...phase1.functions]);
  assert.deepEqual(requirements.foreignKeys, phase1.foreignKeys);
  assert.deepEqual(requirements.functionShapes, [{ signature: ENSURE, returns: 'uuid', securityDefiner: false, replacedBy: { chainId: 'P4', marker: P4_MARKER } }]);
  assert.deepEqual(requirements.platformFunctions, [{ signature: AUTH_UID, returns: 'uuid' }]);
  assert.deepEqual(requirements.prerequisites.map((p) => `${p.kind} ${p.object}`), [`column ${PLATFORM_COLUMN}`, `function_shape ${ENSURE}`, `platform_function ${AUTH_UID}`]);
  assert.ok(isCurrentContract(requirements));
});

test('every prerequisite names the chain file and the refusal code that the file really contains; every expectation has its repository evidence', () => {
  for (const item of requirements.prerequisites) {
    assert.ok(item.neededBy.length >= 1 && item.refusals.length >= 1, item.object);
    for (const needed of item.neededBy) {
      const [id, file] = needed.split(' ') as [keyof typeof CHAIN_PREREQUISITE_FILES, string];
      assert.ok(CHAIN_PREREQUISITE_FILES[id].endsWith(file), needed);
      assert.ok(item.refusals.some((code) => read(CHAIN_PREREQUISITE_FILES[id]).includes(`'${code}'`)), `${needed} does not raise any of ${item.refusals.join(', ')}`);
    }
  }
  for (const [, table] of Object.entries(EXPECTATIONS)) {
    for (const [object, expectation] of Object.entries(table)) {
      assert.ok(read(expectation.evidence.file).includes(expectation.evidence.phrase), `${object}: the evidence phrase is no longer in ${expectation.evidence.file}`);
    }
  }
  assert.deepEqual(requirements.prerequisites.find((p) => p.object === AUTH_UID)?.neededBy.map((n) => n.split(' ')[0]), ['P3b', 'P4'], 'auth.uid() is needed by two files');
  assert.match(requirements.prerequisites.find((p) => p.object === ENSURE)?.expected ?? '', /^only until P4 has run/u, 'nothing is added to what P4 itself checks; the check only holds until P4 replaces the function');
  assert.match(requirements.prerequisites.find((p) => p.object === PLATFORM_COLUMN)?.expected ?? '', /^type text/u, 'the platform column type is a stated expectation, not a refusal');
});

test('the requirement FOLLOWS the preflight text, and a preflight that changed form is an error, never an empty list', () => {
  const phase1 = extractRequirements(read(PREFLIGHT_MIGRATION));
  const withChange = (id: keyof typeof CHAIN_PREREQUISITE_FILES, from: string, to: string) => {
    const text = read(CHAIN_PREREQUISITE_FILES[id]);
    assert.ok(text.includes(from), `the fixture text changed: ${from}`);
    return (path: string) => (path === CHAIN_PREREQUISITE_FILES[id] ? text.replace(from, to) : read(path));
  };
  const shapeOf = (reader: (path: string) => string) => extractChainPrerequisites(reader, phase1).functionShapes;
  const replacedBy = { chainId: 'P4', marker: P4_MARKER };
  assert.deepEqual(shapeOf(withChange('P4', "p.prorettype = 'uuid'::regtype", "p.prorettype = 'bigint'::regtype")), [{ signature: ENSURE, returns: 'bigint', securityDefiner: false, replacedBy }]);
  assert.deepEqual(shapeOf(withChange('P4', 'and not p.prosecdef)', 'and p.prosecdef)')), [{ signature: ENSURE, returns: 'uuid', securityDefiner: true, replacedBy }]);
  // the replacement is read from the text too: a P4 that no longer replaces the function leaves it a plain baseline requirement
  assert.deepEqual(shapeOf(withChange('P4', 'create or replace function public.ensure_my_profile()', 'create or replace function public.ensure_my_profile_x()')), [{ signature: ENSURE, returns: 'uuid', securityDefiner: false }]);
  assert.throws(() => shapeOf(withChange('P4', 'p.pronargs = 0', 'p.pronargs = 1')), /argument/u);
  assert.throws(() => shapeOf(withChange('P4', 'p.pronargs = 0', 'p.pronargs >= 0')), /function-shape check/u);
  assert.throws(() => extractChainPrerequisites(withChange('P3b', "to_regprocedure('auth.uid()') is null then", 'false then'), phase1), /auth function check/u);
  assert.throws(() => extractChainPrerequisites(withChange('P3b', "to_regprocedure('auth.uid()')", "to_regprocedure('auth.jwt()')"), phase1), /no recorded return type/u);
  assert.throws(() => extractChainPrerequisites(withChange('P6', "a.attname in ('platform')", "a.attname in ('platform', 'handle')"), phase1), /public\.social_accounts\.handle, which has no recorded type/u);
  assert.throws(() => extractChainPrerequisites(withChange('P6', "a.attrelid = 'public.social_accounts'::regclass", "a.attrelid = 'private.account_lifecycle_operations'::regclass"), phase1), /baseline column check/u);
  assert.throws(() => extractChainPrerequisites(() => 'select 1;', phase1), /function-shape check/u);
});

// ---- 2. the check: absent / moved / retyped / reshaped is a finding with its own code -----------------------------------------

const fn = (key: string) => (line: Line) => line.k === 'function' && line.key === key;
const MISSING_ENSURE = fn(ENSURE);

test('the synthetic world provides the contract exactly, and the subset carries the three new items with the minimum attributes', () => {
  const lines = synthetic();
  assert.deepEqual(codes(lines), []);
  const subset = contractSubset(lines, requirements);
  assert.deepEqual(Object.keys(find(subset, 'function', ENSURE)?.a ?? {}).sort(), ['acl', 'config', 'kind', 'language', 'owner', 'returns', 'volatility'], 'a function the chain replaces keeps only what the chain leaves alone: no security mode, no body');
  assert.deepEqual(Object.keys(find(subset, 'function', AUTH_UID)?.a ?? {}).sort(), ['kind', 'returns'], 'a platform function is compared by kind and return type only');
  assert.deepEqual(Object.keys(find(subset, 'column', PLATFORM_COLUMN)?.a ?? {}).sort(), ['default_sha256', 'generated', 'identity', 'notnull', 'rel', 'type'], 'nullability and default are in the fingerprint');
  assert.equal(subset.length, contractSubset(synthetic(), phase12Coverage).length + 3);
});

test('each way the three objects can be missing, moved, retyped or reshaped is a typed finding (and a STOP before any chain file)', async () => {
  const approved = await digestOf(synthetic());
  const clone = (key: string) => JSON.parse(JSON.stringify(find(synthetic(), 'function', key))) as Line;
  const table: [string, Options, string[]][] = [
    ['ensure_my_profile() absent', { skip: MISSING_ENSURE }, ['FUNCTION_MISSING']],
    ['ensure_my_profile() returns bigint', { tweak: (l) => { if (MISSING_ENSURE(l)) l.a.returns = 'bigint'; } }, ['FUNCTION_SHAPE']],
    ['ensure_my_profile() is a security definer', { tweak: (l) => { if (MISSING_ENSURE(l)) l.a.security_definer = true; } }, ['FUNCTION_SHAPE']],
    ['ensure_my_profile() is a procedure', { tweak: (l) => { if (MISSING_ENSURE(l)) l.a.kind = 'p'; } }, ['FUNCTION_KIND']],
    ['ensure_my_profile() returns text and is a definer', { tweak: (l) => { if (MISSING_ENSURE(l)) { l.a.returns = 'text'; l.a.security_definer = true; } } }, ['FUNCTION_SHAPE', 'FUNCTION_SHAPE']],
    ['social_accounts.platform absent', { skip: (l) => l.k === 'column' && l.key === PLATFORM_COLUMN }, ['COLUMN_MISSING']],
    ['social_accounts.platform is varchar', { tweak: (l) => { if (l.k === 'column' && l.key === PLATFORM_COLUMN) l.a.type = 'character varying(10)'; } }, ['COLUMN_TYPE']],
    ['auth.uid() absent', { skip: fn(AUTH_UID) }, ['PLATFORM_FUNCTION_MISSING']],
    ['auth.uid() returns text', { tweak: (l) => { if (fn(AUTH_UID)(l)) l.a.returns = 'text'; } }, ['PLATFORM_FUNCTION_SHAPE']],
    ['auth.uid() is an aggregate', { tweak: (l) => { if (fn(AUTH_UID)(l)) l.a.kind = 'a'; } }, ['PLATFORM_FUNCTION_SHAPE']],
  ];
  for (const [name, options, expected] of table) {
    const lines = synthetic(options);
    assert.deepEqual(codes(lines), expected, name);
    const verdict = await verifyInventory(toText(lines), requirements, approved);
    assert.equal(verdict.status, 'STOP', name);
    assert.match(verdict.detail, new RegExp(`${expected[0]}`, 'u'), name);
  }
  // moved or overloaded: only the exact public.ensure_my_profile() with no argument counts
  const overload = [...synthetic({ skip: MISSING_ENSURE }), { ...clone(ENSURE), key: 'public.ensure_my_profile(uuid)' }];
  assert.deepEqual(codes(overload), ['FUNCTION_MISSING'], 'an overload with an argument is not the function P4 checks');
  const moved = [...synthetic({ skip: MISSING_ENSURE }), { ...clone(ENSURE), key: 'private.ensure_my_profile()' }];
  assert.deepEqual(codes(moved), ['FUNCTION_MISSING'], 'a copy in another schema is not the function P4 checks');
  const renamedAuth = [...synthetic({ skip: fn(AUTH_UID) }), { ...clone(AUTH_UID), key: 'public.uid()' }];
  assert.deepEqual(codes(renamedAuth), ['PLATFORM_FUNCTION_MISSING']);
});

test('FAIL-before / PASS-after (logic level): the same drop-one inventories pass the Phase 12 coverage and stop under contract v2', async () => {
  const cases: [string, Options][] = [
    ['ensure_my_profile() absent', { skip: MISSING_ENSURE }],
    ['ensure_my_profile() returns bigint', { tweak: (l) => { if (MISSING_ENSURE(l)) l.a.returns = 'bigint'; } }],
    ['ensure_my_profile() is a security definer', { tweak: (l) => { if (MISSING_ENSURE(l)) l.a.security_definer = true; } }],
    ['social_accounts.platform absent', { skip: (l) => l.k === 'column' && l.key === PLATFORM_COLUMN }],
    ['auth.uid() absent', { skip: fn(AUTH_UID) }],
  ];
  const approved12 = await digestOf(synthetic(), phase12Coverage);
  const approved13 = await digestOf(synthetic());
  assert.notEqual(approved12, approved13, 'a digest approved under the Phase 12 coverage can never pass contract v2');
  for (const [name, options] of cases) {
    const lines = synthetic(options);
    const before = await verifyInventory(toText(lines), phase12Coverage, approved12);
    assert.equal(before.status, 'PASS', `${name}: the Phase 12 coverage does not see it (the gap)`);
    const after = await verifyInventory(toText(lines), requirements, approved13);
    assert.equal(after.status, 'STOP', `${name}: contract v2 stops before any chain file`);
  }
  assert.equal((await verifyInventory(toText(synthetic()), requirements, approved12)).status, 'STOP', 'a digest from the Phase 12 contract is refused as drift');
});

test('a requirements object of another contract version is refused everywhere (a lock built before Phase 13 is never read as v2)', async () => {
  const stale = { ...phase12Coverage, contractVersion: undefined, functionShapes: undefined, platformFunctions: undefined, prerequisites: undefined } as unknown as Requirements;
  assert.equal(isCurrentContract(stale), false);
  assert.deepEqual(codes(synthetic(), stale), ['CONTRACT_VERSION']);
  const verdict = await verifyInventory(toText(synthetic()), stale, await digestOf(synthetic(), phase12Coverage));
  assert.equal(verdict.status, 'STOP');
  assert.match(verdict.detail, /CONTRACT_VERSION/u);
  assert.equal((await baselineReadiness({ relations: [], columns: [], foreignKeys: [], functions: [] }, stale, toText(synthetic()))).state, 'NOT_READY');
  const future = { ...requirements, contractVersion: 3 } as unknown as Requirements;
  assert.deepEqual(codes(synthetic(), future), ['CONTRACT_VERSION']);
});

// ---- 3. the fingerprint: what is inside the contract is drift, what is the platform's own business is not ---------------------

test('the fingerprint covers the new objects: a changed owner, ACL, language, volatility, settings, column nullability or default is drift; what the chain overwrites or the platform owns is not', async () => {
  const approved = await digestOf(synthetic());
  const e = MISSING_ENSURE;
  const inside: [string, (l: Line) => void][] = [
    ['owner of ensure_my_profile()', (l) => { if (e(l)) l.a.owner = 'someone_else'; }],
    ['unexpected grant on ensure_my_profile() (anon)', (l) => { if (e(l)) l.a.acl = ['anon:EXECUTE', 'service_role:EXECUTE']; }],
    ['grant to PUBLIC on ensure_my_profile()', (l) => { if (e(l)) l.a.acl = ['PUBLIC:EXECUTE']; }],
    ['volatility of ensure_my_profile()', (l) => { if (e(l)) l.a.volatility = 's'; }],
    ['language of ensure_my_profile()', (l) => { if (e(l)) l.a.language = 'sql'; }],
    ['search_path of ensure_my_profile()', (l) => { if (e(l)) l.a.config = { search_path: 'public' }; }],
    ['platform becomes NOT NULL', (l) => { if (l.k === 'column' && l.key === PLATFORM_COLUMN) l.a.notnull = true; }],
    ['platform default changes', (l) => { if (l.k === 'column' && l.key === PLATFORM_COLUMN) l.a.default_sha256 = H(202); }],
    ['platform becomes generated', (l) => { if (l.k === 'column' && l.key === PLATFORM_COLUMN) l.a.generated = 's'; }],
    ['unexpected grant on the table that holds platform (anon)', (l) => { if (l.k === 'relation' && l.key === 'public.social_accounts') l.a.acl = ['anon:SELECT', 'service_role:SELECT']; }],
    ['RLS of the table that holds platform', (l) => { if (l.k === 'relation' && l.key === 'public.social_accounts') l.a.rls = false; }],
  ];
  for (const [name, tweak] of inside) {
    const verdict = await verifyInventory(toText(synthetic({ tweak })), requirements, approved);
    assert.equal(verdict.status, 'STOP', name);
    assert.match(verdict.detail, /differs from the approved one/u, name);
  }
  const outside: [string, (l: Line) => void][] = [
    ['body of ensure_my_profile() (P4 replaces it: not baseline drift that matters)', (l) => { if (e(l)) l.a.body_sha256 = H(201); }],
    ['owner of auth.uid() (platform version)', (l) => { if (fn(AUTH_UID)(l)) l.a.owner = 'supabase_auth_admin_v2'; }],
    ['body of auth.uid() (platform version)', (l) => { if (fn(AUTH_UID)(l)) l.a.body_sha256 = H(203); }],
    ['ACL of auth.uid()', (l) => { if (fn(AUTH_UID)(l)) l.a.acl = ['authenticated:EXECUTE']; }],
    ['volatility of auth.uid()', (l) => { if (fn(AUTH_UID)(l)) l.a.volatility = 'v'; }],
    ['an unrelated function', (l) => { if (l.k === 'function' && l.key === 'public.noise()') l.a.body_sha256 = H(204); }],
  ];
  for (const [name, tweak] of outside) assert.equal((await verifyInventory(toText(synthetic({ tweak })), requirements, approved)).status, 'PASS', name);
});

// ---- 3b. the chain replaces ensure_my_profile(): the baseline read-back must stay re-runnable before every chain file ----------

test('chain progress: once P4\'s marker exists the function is chain-owned (security mode and body not asserted, fingerprint unmoved); before that the baseline shape is strict', async () => {
  const approved = await digestOf(synthetic());
  const marker = (): Line => ({ ...JSON.parse(JSON.stringify(find(synthetic(), 'function', 'public.noise()'))), key: P4_MARKER }) as Line;
  const replaced = (extra: (l: Line) => void = () => {}): Line[] => [...synthetic({ tweak: (l) => { if (MISSING_ENSURE(l)) { l.a.security_definer = true; l.a.body_sha256 = H(300); extra(l); } } }), marker()];
  // after P4 (and again after P9): definer, another body, marker present -> nothing to say, and the digest is the one approved before the chain
  const after = replaced();
  assert.deepEqual(codes(after), []);
  assert.deepEqual([...chainMarkersPresent(after, requirements)], [ENSURE]);
  const verdict = await verifyInventory(toText(after), requirements, approved);
  assert.equal(verdict.status, 'PASS');
  assert.equal(verdict.digest, approved, 'the fingerprint does not move when the chain replaces the function');
  // the same function without the marker is the strict baseline: a definer is what P4 refuses
  const before = synthetic({ tweak: (l) => { if (MISSING_ENSURE(l)) { l.a.security_definer = true; l.a.body_sha256 = H(300); } } });
  assert.deepEqual(codes(before), ['FUNCTION_SHAPE']);
  assert.equal((await verifyInventory(toText(before), requirements, approved)).status, 'STOP');
  // chain-owned does not mean unchecked: kind, return type and a reaching-out body still stop
  assert.deepEqual(codes(replaced((l) => { l.a.returns = 'bigint'; })), ['FUNCTION_SHAPE']);
  assert.deepEqual(codes(replaced((l) => { l.a.kind = 'p'; })), ['FUNCTION_KIND']);
  assert.deepEqual(codes(replaced((l) => { l.a.mentions = { cron: false, net: true, vault: false, url: false, supabase_host: false }; })), ['FUNCTION_MENTIONS']);
  assert.equal((await verifyInventory(toText(replaced((l) => { l.a.owner = 'someone_else'; })), requirements, approved)).status, 'STOP', 'the attributes the chain leaves alone are still fingerprinted');
  // the marker is the one P4 really creates, and P4 and P9 both replace the function
  assert.equal(CHAIN.find((file) => file.id === 'P4')?.marker, P4_MARKER);
  for (const id of ['P4', 'P9'] as const) assert.match(read(CHAIN.find((file) => file.id === id)!.path), /create or replace function public\.ensure_my_profile\(\)/u, id);
});

// ---- 4. malicious or misleading content, and non-leakage -----------------------------------------------------------------------

test('hostile or misleading inventory content is refused without echoing a value', async () => {
  const approved = await digestOf(synthetic());
  const planted = ['s_sb_secret_', 'P13PlantedSentinel0123456789'].join('');
  const verdictOf = (lines: Line[] | string) => verifyInventory(typeof lines === 'string' ? lines : toText(lines), requirements, approved);
  const noEcho = (text: string) => assert.ok(!text.includes(planted) && !text.includes('P13PlantedSentinel'), 'the planted value reached a message');

  // a key-shaped name on a function line
  const named = [...synthetic(), { ...JSON.parse(JSON.stringify(find(synthetic(), 'function', 'public.noise()'))), key: `public.${planted}()` } as Line];
  const secret = await verdictOf(named);
  assert.equal(secret.status, 'STOP');
  assert.match(secret.detail, /secret-shaped/u);
  noEcho(JSON.stringify(secret));

  // an attribute that could carry a value
  const smuggled = await verdictOf(synthetic({ tweak: (l) => { if (MISSING_ENSURE(l)) l.a.note = planted; } }));
  assert.equal(smuggled.status, 'STOP');
  noEcho(JSON.stringify(smuggled));

  // a literal in the default of the new column (the query masks literals; a line that does not is refused)
  const literal = await verdictOf(synthetic({ tweak: (l) => { if (l.k === 'column' && l.key === PLATFORM_COLUMN) { l.a.default_shape = `'${planted}'::text`; l.a.default_sha256 = H(205); } } }));
  assert.equal(literal.status, 'STOP');
  noEcho(JSON.stringify(literal));

  // a hash that is not a hash (a body smuggled in the hash field)
  const notHash = await verdictOf(synthetic({ tweak: (l) => { if (MISSING_ENSURE(l)) l.a.body_sha256 = `select '${planted}'`; } }));
  assert.equal(notHash.status, 'STOP');
  noEcho(JSON.stringify(notHash));

  // a duplicate line that tries to override the real one is a parse error, not a last-wins
  const duplicate = `${toText(synthetic())}\n${JSON.stringify(find(synthetic(), 'function', ENSURE))}`;
  const dup = await verdictOf(duplicate);
  assert.equal(dup.status, 'STOP');
  assert.match(dup.detail, /INVENTORY_DUPLICATE/u);

  // the body of ensure_my_profile() is not fingerprinted (P4 overwrites it), so a body that reaches out is refused on its own flags;
  // a plain body change is not an event
  const network = await verdictOf(synthetic({ tweak: (l) => { if (MISSING_ENSURE(l)) { l.a.body_sha256 = H(206); l.a.mentions = { cron: false, net: true, vault: false, url: true, supabase_host: false }; } } }));
  assert.equal(network.status, 'STOP');
  assert.match(network.detail, /FUNCTION_MENTIONS/u);
  assert.equal((await verdictOf(synthetic({ tweak: (l) => { if (MISSING_ENSURE(l)) l.a.body_sha256 = H(207); } }))).status, 'PASS');

  // the finding lists of every failing case name objects and codes only
  for (const lines of [synthetic({ skip: MISSING_ENSURE }), synthetic({ tweak: (l) => { if (l.k === 'column' && l.key === PLATFORM_COLUMN) l.a.type = planted; } })]) {
    noEcho(JSON.stringify(checkRequirements(lines, requirements)));
  }
  assert.deepEqual(secretFindings(JSON.stringify(requirements)), [], 'the contract itself holds no secret-shaped text');
});

// ---- 5. the static audit: every baseline object a chain preflight names is covered ---------------------------------------------

const chainFiles = () => Object.fromEntries(CHAIN.map((file) => [file.path, read(file.path)]));

test('audit: under contract v2 no baseline object named by a chain preflight is uncovered; under the Phase 12 coverage the audit finds the same gaps the oracle found', () => {
  const references = auditChainPreflights(chainFiles(), requirements);
  assert.ok(references.length >= 100 && references.filter((r) => !r.internal).length >= 20, 'the audit actually sees the preflights');
  assert.deepEqual(uncovered(references), []);
  const gaps = uncovered(auditChainPreflights(chainFiles(), phase12Coverage)).map((r) => `${r.kind} ${r.object}`);
  assert.deepEqual([...new Set(gaps)].sort(), [`column ${PLATFORM_COLUMN}`, `function ${AUTH_UID}`, `function ${ENSURE}`]);
});

test('audit: a NEW baseline object named by a future chain preflight is reported until the contract learns it', () => {
  const files = chainFiles();
  const p6 = CHAIN.find((file) => file.id === 'P6')!.path;
  const withNew = { ...files, [p6]: files[p6].replace("to_regclass('public.social_accounts') is null then", "to_regclass('public.social_accounts') is null or to_regclass('public.new_baseline_table') is null then") };
  assert.notEqual(withNew[p6], files[p6]);
  assert.deepEqual(uncovered(auditChainPreflights(withNew, requirements)).map((r) => `${r.kind} ${r.object}`), ['relation public.new_baseline_table']);
  const p4 = CHAIN.find((file) => file.id === 'P4')!.path;
  const newColumn = { ...files, [p4]: files[p4].replace("a.attname = 'id' and a.atttypid", "a.attname = 'handle' and a.atttypid") };
  assert.deepEqual(uncovered(auditChainPreflights(newColumn, requirements)).map((r) => `${r.kind} ${r.object}`), ['column public.profiles.handle']);
});

// ---- 6. the document ----------------------------------------------------------------------------------------------------------

const DOC_PATH = 'docs/common-account/phase13-baseline-contract-v2.md';
const doc = read(DOC_PATH);

test('the contract v2 document names every prerequisite with its chain file and refusal, and quotes digests that are the real ones', async () => {
  for (const item of requirements.prerequisites) {
    assert.ok(doc.includes(`\`${item.object}\``) || doc.includes(item.object), item.object);
    for (const refusal of item.refusals) assert.ok(doc.includes(refusal), `${item.object}: ${refusal}`);
    for (const needed of item.neededBy) assert.ok(doc.includes(needed.split(' ')[1].replace(/\.sql$/u, '')), needed);
  }
  const provenance = JSON.parse(read('supabase/preflight/managed_disposable/baseline_provenance.json')) as { inventory: { querySha256: string; worlds: Record<string, { contractDigest: string; contractItems: number }> } };
  assert.equal(provenance.inventory.querySha256, await sha256Hex(read('supabase/preflight/managed_disposable/inventory/schema_inventory.sql')));
  assert.ok(doc.includes(provenance.inventory.querySha256), 'the (unchanged) inventory query digest');
  assert.ok(doc.includes(provenance.inventory.worlds.fixture.contractDigest) && doc.includes(provenance.inventory.worlds.replay.contractDigest), 'the model digests');
  assert.equal(provenance.inventory.worlds.fixture.contractItems, 90);
  assert.equal(provenance.inventory.worlds.replay.contractItems, 60);
  for (let n = 0; n <= 15; n += 1) assert.ok(doc.includes(`| C${String(n).padStart(2, '0')} |`), `case C${n}`);
  for (const head of ['2a626cd49f55611258c7695f0b84cb2a917d4595', '499a9e1fac595064fbc3928725be8907db1b692b']) assert.ok(doc.includes(head), head);
});

test('the contract v2 document cites only files that exist, holds no secret / project host / placeholder, and states the safety boundary', () => {
  const ROOTS = /^(?:supabase|docs|apps|\.agent)\//u;
  let checked = 0;
  for (const match of doc.matchAll(/`([^`\n]+)`/gu)) {
    const cite = /^(.+?):(\d+)$/u.exec(match[1]);
    const path = cite ? cite[1] : match[1];
    if (!ROOTS.test(path) || /[*<>\s]/u.test(path)) continue;
    checked += 1;
    try {
      Deno.statSync(new URL(path, root));
    } catch {
      assert.fail(`the document names ${path}, which does not exist`);
    }
    if (cite) assert.ok(read(path).split('\n').length >= Number(cite[2]), `${path} has fewer than ${cite[2]} lines`);
  }
  assert.ok(checked >= 8, `only ${checked} paths were checked`);
  assert.match(read('docs/postona/multi-social-phase1.md').split('\n')[42], /social_accounts/u, 'the cited line 43 is the social_accounts row');
  assert.deepEqual(secretFindings(doc), []);
  assert.deepEqual(projectRefsIn(doc), []);
  assert.ok(!doc.includes('RESULTS_PLACEHOLDER') && !/\bTODO\b|\bFIXME\b|\bTBD\b/u.test(doc), 'no unfinished marker');
  for (const phrase of ['source-only', 'NO_GO', 'managed_auth_delete', 'IDP_PREPAUSE_BLOCKED', 'never inferred', 'F3-owned', 'not an automatic review', 'a Phase 12 digest can never be approved or passed by mistake']) {
    assert.ok(doc.includes(phrase) || doc.includes(phrase.replace('not an automatic review', 'future gate, not an automatic review')), phrase);
  }
});
