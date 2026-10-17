// Offline contract of the Phase 13 D-3 package (docs/common-account/phase13-d3-hosted-sandbox-preflight.md and its two data files).
// The package is execution-READY and non-executing; these tests keep every claim of it true of THIS checkout: the gates and their
// consent phrases, the harness steps they name, the cost figures and their sources, the allow / deny coverage, the guard's refusals,
// the settings read-back rule, and the absence of secrets and project hosts. Pure file reads; no database, no network, no project.
//
//   deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/d3_package_test.ts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  APP_SCHEME, checkReadbackSheet, DEFAULT_PLATFORM_SECRET_NAMES, READBACK_CODES, type ReadbackOptions, SIDE_EFFECTS_ATTESTATION,
} from './d3_readback.ts';
import { ENV, projectRefsIn, resolveTarget } from './guard.ts';
import { secretFindings } from './inventory.ts';
import { CHAIN, STEPS } from './plan.ts';
import { run, type Lock, unsafeSelection } from './runner.ts';

const root = new URL('../../../', import.meta.url);
const here = new URL('./', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));
const DOC_PATH = 'docs/common-account/phase13-d3-hosted-sandbox-preflight.md';
const doc = read(DOC_PATH);
const gates = JSON.parse(read('docs/common-account/phase13-d3-gates.json')) as Gates;
const cost = JSON.parse(read('docs/common-account/phase13-d3-cost-sources.json')) as Cost;
const lock = JSON.parse(Deno.readTextFileSync(new URL('plan.lock.json', here))) as Lock;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

type Consent = { id: string; en: string; ja: string };
type Gate = { id: string; title: string; access: string; prerequisites: string[]; consents: Consent[]; authorizes: string[]; doesNotAuthorize: string[]; evidence: string[]; stop: string[]; existsToday: string[]; missingToday: string[] };
type Gates = {
  rules: string[]; closing: { en: string; ja: string }; gates: Gate[]; notGatesHere: { id: string; reason: string }[];
  decisions: { id: string; question: string; options: string[]; recommended: string; why: string }[];
  f4Conditions: { code: string; gate: string; howEstablished: string }[];
};
type CostEntry = { id: string; claim: string; figure: number | null; unit: string; status: 'observed' | 'not_stated'; url: string };
type Cost = {
  retrievedOn: string; entries: CostEntry[];
  derived: { id: string; inputs: string[]; multiplier: number; value: number }[];
  envelopes: { id: string; ceilingUsd: number; basis: string[]; condition: string }[];
};

// ---- the gates ------------------------------------------------------------------------------------------------------------------

test('the gates are the eight of the TASK, in one line, each prerequisite earlier, none open', () => {
  assert.deepEqual(gates.gates.map((gate) => gate.id), ['PG1', 'PG2a', 'PG2b', 'PG3', 'PG4', 'PG5', 'PG6', 'PG7']);
  gates.gates.forEach((gate, index) => {
    const earlier = gates.gates.slice(0, index).map((other) => other.id);
    // each gate depends on the gate before it and on nothing later (PG3 needs both PG2a and PG2b)
    assert.deepEqual(gate.prerequisites.filter((id) => !earlier.includes(id)), [], `${gate.id} depends only on earlier gates`);
    if (index > 0) assert.ok(gate.prerequisites.includes(earlier[earlier.length - 1]), `${gate.id} depends on the gate before it`);
    if (gate.id === 'PG3') assert.deepEqual(gate.prerequisites, ['PG2a', 'PG2b']);
    for (const key of ['authorizes', 'doesNotAuthorize', 'evidence', 'stop', 'existsToday', 'missingToday'] as const) {
      assert.ok(Array.isArray(gate[key]) && gate[key].length > 0, `${gate.id}.${key}`);
    }
    assert.ok(gate.consents.length >= 1, `${gate.id} has a consent phrase`);
  });
  assert.deepEqual(gates.notGatesHere.map((gate) => gate.id), ['PG8', 'PG9']);
  assert.ok(gates.rules.some((rule) => /No gate is open today/u.test(rule)));
  assert.ok(gates.rules.some((rule) => /never receives, types or stores/u.test(rule)));
});

test('every consent phrase is unique, authorizes one scope, ends with the closing sentence in both languages, and names no project', () => {
  const phrases = gates.gates.flatMap((gate) => gate.consents);
  const ids = phrases.map((phrase) => phrase.id);
  assert.equal(new Set(ids).size, ids.length, 'consent ids are unique');
  assert.equal(new Set(phrases.map((phrase) => phrase.en)).size, phrases.length, 'no two English phrases are equal');
  assert.equal(new Set(phrases.map((phrase) => phrase.ja)).size, phrases.length, 'no two Japanese phrases are equal');
  const placeholders = (text: string) => [...text.matchAll(/<([a-z0-9-]+)>/gu)].map((match) => match[1]).sort();
  for (const phrase of phrases) {
    assert.ok(phrase.en.endsWith(gates.closing.en), `${phrase.id}: English closing sentence`);
    assert.ok(phrase.ja.endsWith(gates.closing.ja), `${phrase.id}: Japanese closing sentence`);
    assert.deepEqual(placeholders(phrase.en), placeholders(phrase.ja), `${phrase.id}: the same placeholders in both languages`);
    assert.ok(!/supabase\.co/iu.test(phrase.en + phrase.ja), `${phrase.id}: names no host`);
    assert.deepEqual(projectRefsIn(phrase.en + phrase.ja), []);
    assert.deepEqual(secretFindings(phrase.en + phrase.ja), [], `${phrase.id}: nothing secret-shaped`);
    assert.ok(!/\bUSD\s*\d/u.test(phrase.en) && !/<[a-z0-9-]+>/u.test(phrase.ja.replace(/<[a-z0-9-]+>/gu, '')), `${phrase.id}: amounts and values are placeholders, not decided here`);
  }
  // a phrase for one gate must not be able to pass for another: the scope words differ
  const scope = (id: string) => phrases.find((phrase) => phrase.id === id)?.en ?? '';
  assert.match(scope('PG2A-RUN'), /read-only run of .*schema_inventory\.sql/u);
  assert.match(scope('PG2A-LOGIN'), /production write/u);
  assert.match(scope('PG2B-RUN'), /schema-only export/u);
  assert.match(scope('PG3-APPROVE'), /approves no environment and no execution/u);
  assert.match(scope('PG4-CREATE'), /creating ONE new empty Supabase project/u);
  assert.match(scope('PG5-DB'), /cli\.ts --execute --only=/u);
  assert.match(scope('PG5-EDGE'), /deploying exactly the Edge function account-delete/u);
  assert.match(scope('PG6-SMOKE'), /acceptance steps/u);
  assert.match(scope('PG7-DEVICE'), /ONE sandbox build/u);
  // PG8 and PG9 have no phrase here, by design
  assert.ok(!phrases.some((phrase) => /^PG[89]/u.test(phrase.id)));
});

test('the steps the consent phrases name exist in plan.ts, are safe to select, and PG6 leaves out M3 and M12', () => {
  const stepIds = STEPS.map((step) => step.id);
  const dbPhrase = gates.gates.find((gate) => gate.id === 'PG5')!.consents.find((phrase) => phrase.id === 'PG5-DB')!.en;
  const selected = /--only=([A-Za-z0-9,-]+)/u.exec(dbPhrase)![1].split(',');
  for (const id of selected) assert.ok(stepIds.includes(id), `${id} is a step of plan.ts`);
  assert.deepEqual(unsafeSelection(STEPS, selected), [], 'the PG5 selection is accepted by the harness');
  assert.ok(selected.includes('G3b'), 'G3b is selected: it is non-skippable');
  for (const file of CHAIN) assert.ok(selected.includes(`G3-${file.id}`), `the chain file ${file.id} is selected`);
  assert.ok(!selected.some((id) => /^M\d|^T1$/u.test(id)), 'PG5 selects no acceptance step');

  const smokePhrase = gates.gates.find((gate) => gate.id === 'PG6')!.consents[0].en;
  const named = [...smokePhrase.split('. ')[0].matchAll(/\b(M\d+|T1)\b/gu)].map((match) => match[1]);
  assert.match(smokePhrase, /M12 is excluded unless it is separately approved/u);
  for (const id of named) assert.ok(stepIds.includes(id), `${id} is a step of plan.ts`);
  assert.ok(!named.includes('M3') && !named.includes('M12'), 'M3 (manual) and M12 (no reachable saga) are not in the PG6 phrase');
  assert.ok(named.includes('T1'), 'the teardown is part of PG6');
  assert.equal(STEPS.find((step) => step.id === 'M3')?.mode, 'manual');
  assert.ok(!stepIds.some((id) => /^M1[3-9]$/u.test(id)), 'M13 - M15 are proposals, not steps of plan.ts yet');
  assert.ok(!stepIds.some((id) => /^X-\d/u.test(id)), 'X-1 ... X-7 are proposals, not steps of plan.ts yet');
});

test('the 13 conditions of F4\'s preflight are all assigned to a gate, and the document lists each', () => {
  const codes = gates.f4Conditions.map((condition) => condition.code);
  assert.equal(codes.length, 13);
  assert.equal(new Set(codes).size, 13);
  const gateIds = new Set(gates.gates.map((gate) => gate.id));
  for (const condition of gates.f4Conditions) {
    assert.ok(gateIds.has(condition.gate), `${condition.code} -> ${condition.gate}`);
    assert.ok(doc.includes(`\`${condition.code}\``), `the document lists ${condition.code}`);
  }
});

test('the decisions A to G are in the document with their recommendation, and the document carries every consent phrase verbatim', () => {
  assert.deepEqual(gates.decisions.map((decision) => decision.id), ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
  for (const decision of gates.decisions) {
    assert.ok(decision.options.length >= 2 && decision.recommended !== '' && decision.why !== '', decision.id);
    assert.match(doc, new RegExp(`\\| \\*\\*${decision.id}\\*\\* \\|`, 'u'), `decision ${decision.id} is a row of the document`);
  }
  for (const gate of gates.gates) {
    assert.match(doc, new RegExp(`\\*\\*${gate.id}\\*\\*`, 'u'), `${gate.id} is in the document`);
    for (const consent of gate.consents) {
      assert.ok(doc.includes(consent.en), `${consent.id}: the English phrase is in the document verbatim`);
      assert.ok(doc.includes(consent.ja), `${consent.id}: the Japanese phrase is in the document verbatim`);
    }
  }
  assert.match(doc, /No gate is open today/u);
  assert.match(doc, /no implied permission/iu);
});

// ---- cost and sources -----------------------------------------------------------------------------------------------------------

test('every cost figure is traceable: public provider pages only, dated, and the derived numbers recompute', () => {
  assert.match(cost.retrievedOn, /^\d{4}-\d{2}-\d{2}$/u);
  const byId = new Map(cost.entries.map((entry) => [entry.id, entry]));
  assert.equal(byId.size, cost.entries.length, 'ids are unique');
  for (const entry of cost.entries) {
    const url = new URL(entry.url);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, 'supabase.com', `${entry.id}: only the provider's public site`);
    assert.ok(url.pathname === '/pricing' || url.pathname.startsWith('/docs/'), `${entry.id}: a public pricing or documentation page`);
    assert.ok(url.search === '' && url.hash === '' && url.username === '', `${entry.id}: no query, no fragment, no credential`);
    if (entry.status === 'observed') assert.ok(entry.figure !== null && typeof entry.figure === 'number', `${entry.id}: an observed entry has a figure`);
    else assert.ok(entry.status === 'not_stated' && entry.figure === null, `${entry.id}: a not-stated entry has no figure`);
  }
  for (const item of cost.derived) {
    const base = byId.get(item.inputs[0])!;
    assert.ok(Math.abs(base.figure! * item.multiplier - item.value) < 1e-9, `${item.id} recomputes`);
  }
  const micro = byId.get('micro-hourly')!.figure!;
  const credit = byId.get('pro-compute-credit')!.figure!;
  assert.ok(24 * micro < credit && 744 * micro < credit, 'a day, and even a 31-day month, of one Micro instance stays inside the monthly credit');
  const envelope = (id: string) => cost.envelopes.find((item) => item.id === id)!;
  assert.equal(envelope('E0-free').ceilingUsd, byId.get('free-compute')!.figure);
  const overCredit = Math.max(0, 24 * micro - credit);
  assert.equal(envelope('E1-pro-fallback').ceilingUsd, byId.get('pro-price')!.figure! + overCredit, 'the Pro envelope is the base price (compute stays inside the credit)');
  for (const item of cost.envelopes) for (const basis of item.basis) assert.ok(byId.has(basis) || cost.derived.some((derived) => derived.id === basis), `${item.id} basis ${basis}`);
});

test('the document\'s cost table quotes only figures of the sources, and every not-stated item is called an assumption or NOT_VERIFIED', () => {
  const byId = new Map(cost.entries.map((entry) => [entry.id, entry]));
  const quoted = doc.split('\n').filter((line) => /`cost:[a-z0-9-]+`/u.test(line));
  assert.ok(quoted.length >= 15, `only ${quoted.length} cost rows`);
  const seen = new Set<string>();
  for (const line of quoted) {
    for (const match of line.matchAll(/`cost:([a-z0-9-]+)`/gu)) {
      const entry = byId.get(match[1]);
      assert.ok(entry, `${match[1]} is an entry of the sources`);
      seen.add(match[1]);
      if (entry.status === 'observed') {
        const figure = entry.figure!;
        const forms = [String(figure), figure.toLocaleString('en-US')];
        assert.ok(forms.some((form) => line.includes(form)), `the row of ${entry.id} quotes the figure ${figure}`);
      } else {
        assert.match(line, /NOT_VERIFIED|assumption/iu, `${entry.id}: a not-stated item is labelled`);
      }
    }
  }
  for (const entry of cost.entries.filter((item) => item.status === 'not_stated')) assert.ok(seen.has(entry.id), `${entry.id} is in the document`);
  for (const envelope of cost.envelopes) assert.ok(doc.includes(envelope.id) && doc.includes(`USD ${envelope.ceilingUsd}`), `${envelope.id} and its ceiling are in the document`);
  assert.ok(doc.includes(cost.retrievedOn), 'the retrieval date is in the document');
});

// ---- leakage --------------------------------------------------------------------------------------------------------------------

const ALLOWED_URL = /^https:\/\/(supabase\.com\/(docs\/[A-Za-z0-9/_.-]*|pricing)|github\.com\/anohi-memories\/kabumori\/pull\/\d+)$/u;

test('the package holds no secret-shaped text, no project host, and only public provider and repository URLs', () => {
  const texts: [string, string][] = [
    [DOC_PATH, doc], ['gates', read('docs/common-account/phase13-d3-gates.json')], ['cost', read('docs/common-account/phase13-d3-cost-sources.json')],
  ];
  for (const [name, text] of texts) {
    const urls = [...text.matchAll(/https?:\/\/[^\s"'`)<>]+/gu)].map((match) => match[0].replace(/[.,;]+$/u, ''));
    for (const url of urls) assert.match(url, ALLOWED_URL, `${name}: ${url}`);
    const stripped = urls.reduce((acc, url) => acc.split(url).join(''), text);
    assert.deepEqual(secretFindings(stripped), [], `${name}: nothing secret-shaped`);
    assert.deepEqual(projectRefsIn(text), [], `${name}: no project host`);
    assert.ok(!/postgres(ql)?:\/\//iu.test(text), `${name}: no connection string`);
    assert.ok(!/\bTODO\b|\bFIXME\b|\bTBD\b|RESULTS_PENDING/u.test(text), `${name}: nothing unfinished`);
  }
  // the production project's ref appears nowhere in the package (the ref is read from the repository's own migrations, never printed)
  for (const ref of repositoryRefs()) for (const [name, text] of texts) assert.ok(!text.includes(ref), `${name} names the production ref`);
});

function repositoryRefs(): string[] {
  const found = new Set<string>();
  for (const entry of Deno.readDirSync(new URL('supabase/migrations/', root))) {
    if (entry.isFile && entry.name.endsWith('.sql')) for (const ref of projectRefsIn(read(`supabase/migrations/${entry.name}`))) found.add(ref);
  }
  return [...found].sort();
}

function* walk(dir: URL): Generator<URL> {
  for (const entry of Deno.readDirSync(dir)) {
    if (['node_modules', '.git', '.expo', 'dist', 'build', '.next', '.turbo'].includes(entry.name)) continue;
    const child = new URL(`${entry.name}${entry.isDirectory ? '/' : ''}`, dir);
    if (entry.isDirectory) yield* walk(child);
    else if (entry.isFile) yield child;
  }
}

test('the deny list covers the repository: every project host in a non-test tracked-type file is a host the harness already denies', () => {
  const denied = new Set(repositoryRefs());
  assert.ok(denied.size >= 1, 'the repository names the production project in its migrations');
  const outside: string[] = [];
  for (const dir of ['supabase/', 'apps/', 'tests/', 'scripts/', 'docs/', '.agent_v2/']) {
    let base: URL;
    try {
      base = new URL(dir, root);
      Deno.statSync(base);
    } catch {
      continue;
    }
    for (const file of walk(base)) {
      const path = file.pathname.slice(root.pathname.length);
      if (!/\.(ts|tsx|js|mjs|sql|md|json|sh|py|toml|yml|yaml)$/u.test(path) || /_test\.(ts|tsx)$|\.test\.(ts|tsx|mjs)$|\/tests?\//u.test(path)) continue;
      let text = '';
      try {
        text = Deno.readTextFileSync(file);
      } catch {
        continue;
      }
      for (const ref of projectRefsIn(text)) if (!denied.has(ref)) outside.push(path);
    }
  }
  assert.deepEqual(outside, [], 'a project host outside the migrations would not be on the harness deny list');
});

// ---- the guard ------------------------------------------------------------------------------------------------------------------

const REF_A = 'a'.repeat(20);
const REF_B = 'b'.repeat(20);
const KEY_PUBLISHABLE = 'sb_publishable_synthetic_key_value_1';
const KEY_SERVICE = 'sb_secret_synthetic_key_value_2';

function env(extra: Record<string, string | undefined> = {}, prod = REF_B): Record<string, string | undefined> {
  return {
    [ENV.projectRef]: REF_A, [ENV.allowlist]: REF_A, [ENV.denylist]: prod, [ENV.apiUrl]: `https://${REF_A}.supabase.co`, [ENV.confirm]: REF_A,
    [ENV.publishableKey]: KEY_PUBLISHABLE, [ENV.serviceKey]: KEY_SERVICE, [ENV.dbUrl]: `postgresql://postgres:pw@db.${REF_A}.supabase.co:5432/postgres`,
    [ENV.baselineSha256]: sha('baseline'), [ENV.baselinePath]: 'baseline/disposable_baseline.sql', [ENV.inventorySha256]: sha('contract'), [ENV.emailDomain]: 'disposable.test',
    ...extra,
  };
}
const codes = (decision: ReturnType<typeof resolveTarget>) => (decision.ok ? [] : decision.failures.map((failure) => failure.code));

test('the guard accepts a complete synthetic environment and refuses each way of pointing it at production or at the wrong kind of key', () => {
  const production = repositoryRefs()[0];
  const options = { execute: true, repositoryRefs: repositoryRefs() };
  assert.equal(resolveTarget(env(), options).ok, true, 'the control passes');
  assert.deepEqual(codes(resolveTarget(env({ [ENV.projectRef]: production, [ENV.confirm]: production, [ENV.apiUrl]: `https://${production}.supabase.co`, [ENV.dbUrl]: `postgresql://postgres:pw@db.${production}.supabase.co:5432/postgres` }), options)).includes('TARGET_IS_PRODUCTION'), true, 'the production ref is refused');
  assert.ok(codes(resolveTarget(env({ [ENV.allowlist]: `${REF_A},${production}` }), options)).includes('ALLOWLIST_CONTAINS_PRODUCTION'), 'a polluted allow list refuses everything');
  assert.ok(codes(resolveTarget(env({ [ENV.denylist]: undefined }), options)).includes('DENYLIST_MISSING'));
  assert.ok(codes(resolveTarget(env({ [ENV.allowlist]: REF_B }), options)).includes('TARGET_NOT_ALLOWLISTED'));
  assert.ok(codes(resolveTarget(env({ [ENV.apiUrl]: `https://${REF_B}.supabase.co` }), options)).includes('API_URL_REF_MISMATCH'));
  assert.ok(codes(resolveTarget(env({ [ENV.apiUrl]: `http://${REF_A}.supabase.co` }), options)).includes('API_URL_INVALID'));
  assert.ok(codes(resolveTarget(env({ [ENV.apiUrl]: `https://${REF_A}.supabase.co/rest/v1` }), options)).includes('API_URL_INVALID'));
  assert.ok(codes(resolveTarget(env({ [ENV.confirm]: REF_B }), options)).includes('CONFIRM_MISMATCH'));
  assert.ok(codes(resolveTarget(env({ [ENV.publishableKey]: KEY_SERVICE }), options)).includes('PUBLISHABLE_KEY_WRONG_KIND'));
  assert.ok(codes(resolveTarget(env({ [ENV.serviceKey]: KEY_PUBLISHABLE }), options)).includes('SERVICE_KEY_NOT_A_SERVICE_KEY'));
  assert.ok(codes(resolveTarget(env({ [ENV.dbUrl]: `postgresql://postgres:pw@db.${REF_B}.supabase.co:5432/postgres` }), options)).includes('DB_URL_REF_MISMATCH'));
  assert.ok(codes(resolveTarget(env({ [ENV.dbUrl]: `postgresql://postgres.${REF_B}:pw@aws-0-eu.pooler.supabase.com:5432/postgres` }), options)).includes('DB_URL_REF_MISMATCH'));
  assert.equal(resolveTarget(env({ [ENV.dbUrl]: `postgresql://postgres.${REF_A}:pw@aws-0-eu.pooler.supabase.com:5432/postgres` }), options).ok, true, 'the pooler form of the same project is accepted');
  assert.ok(codes(resolveTarget(env({ [ENV.emailDomain]: 'gmail.com' }), options)).includes('EMAIL_DOMAIN_NOT_CONTROLLED'));
  assert.ok(codes(resolveTarget(env({ [ENV.inventorySha256]: undefined }), options)).includes('INVENTORY_DIGEST_MISSING'));
  assert.ok(codes(resolveTarget(env({ [ENV.baselineSha256]: undefined }), options)).includes('BASELINE_DIGEST_MISSING'));
  // execution without any secret is refused, with a complete list rather than the first failure
  const bare = resolveTarget({ [ENV.projectRef]: REF_A, [ENV.allowlist]: REF_A, [ENV.denylist]: REF_B, [ENV.apiUrl]: `https://${REF_A}.supabase.co` }, options);
  assert.equal(bare.ok, false);
  assert.ok(codes(bare).length >= 6);
});

test('the environment variables the document lists are exactly the guard\'s; the dry run touches nothing', async () => {
  for (const name of Object.values(ENV)) assert.ok(doc.includes(`\`${name}\``), `${name} is in the document`);
  const named = new Set([...doc.matchAll(/`(KABUMORI_[A-Z_]+)`/gu)].map((match) => match[1]));
  for (const name of named) assert.ok((Object.values(ENV) as string[]).includes(name), `${name} is not a variable of the guard`);
  const report = await run(STEPS, { mode: 'dry-run', decision: resolveTarget({}), lock, reader: { read } });
  assert.ok(report.results.length > 20 && report.results.every((result) => result.status === 'NOT_RUN'));
  assert.equal(report.complete, false);
});

// ---- the read-back sheet --------------------------------------------------------------------------------------------------------

const DIGEST = sha('account-delete pinned bytes');
const OPTIONS: ReadbackOptions = {
  stage: 'deployed', productionRefSha256: [sha(repositoryRefs()[0])], redirectPolicy: 'both-exact', expectedFunctions: { 'account-delete': DIGEST },
};
// deno-lint-ignore no-explicit-any
const good = (): Record<string, any> => ({
  schema: 1,
  identity: { refSha256: sha(REF_A), regionLabel: 'owner-chosen', plan: 'free', organizationHoldsProduction: false, createdAs: 'new_project' },
  auth: {
    providersEnabled: ['email'], anonymousSignIns: false, signUpsOpen: true, emailAutoconfirm: true, jwtExpirySeconds: 3600,
    redirectUrls: [`${APP_SCHEME}://auth-callback`, `${APP_SCHEME}://oauth-callback`],
  },
  api: { exposedSchemas: ['public', 'graphql_public'] },
  edge: { functions: [{ name: 'account-delete', verifyJwt: true, sha256: DIGEST }] },
  secrets: { names: [...DEFAULT_PLATFORM_SECRET_NAMES] },
  database: {
    extensions: ['pgcrypto', 'uuid-ossp', 'supabase_vault', 'pg_stat_statements'], markerRefSha256: sha(REF_A),
    counts: { cronJobs: 0, networkTriggers: 0, storageObjects: 0, vaultSecrets: 0, pushTokens: 0, socialAccounts: 0, scheduledPosts: 0 },
  },
  attestation: SIDE_EFFECTS_ATTESTATION,
});
const stopCodes = (sheet: unknown, options: ReadbackOptions = OPTIONS) => checkReadbackSheet(sheet, options).findings.filter((finding) => finding.severity === 'stop').map((finding) => finding.code);

test('the read-back sheet: a correct sheet passes at both stages, and its codes are the documented ones', () => {
  assert.deepEqual(checkReadbackSheet(good(), OPTIONS), { ok: true, findings: [] });
  const created = good();
  created.edge.functions = [];
  delete created.database.counts;
  delete created.database.markerRefSha256;
  assert.deepEqual(checkReadbackSheet(created, { ...OPTIONS, stage: 'created' }), { ok: true, findings: [] });
  for (const code of READBACK_CODES) assert.ok(doc.includes(`\`${code}\``), `${code} is explained in the document`);
});

test('the read-back sheet refuses, one by one, each unsafe or unknown setting (fail closed)', () => {
  // deno-lint-ignore no-explicit-any
  const cases: [string, (sheet: Record<string, any>) => void, string][] = [
    ['not an object', () => undefined, 'SHEET_SHAPE'],
    ['a production ref', (s) => { s.identity.refSha256 = sha(repositoryRefs()[0]); }, 'IDENTITY_PRODUCTION'],
    ['an organization that holds production', (s) => { s.identity.organizationHoldsProduction = true; }, 'IDENTITY_PRODUCTION'],
    ['the organization question unanswered', (s) => { delete s.identity.organizationHoldsProduction; }, 'IDENTITY_PRODUCTION'],
    ['a branch of another project', (s) => { s.identity.createdAs = 'branch'; }, 'IDENTITY_NOT_NEW'],
    ['a restored project', (s) => { s.identity.createdAs = 'restore'; }, 'IDENTITY_NOT_NEW'],
    ['a marker that names another project', (s) => { s.database.markerRefSha256 = sha(REF_B); }, 'IDENTITY_MARKER_MISMATCH'],
    ['Google enabled', (s) => { s.auth.providersEnabled = ['email', 'google']; }, 'PROVIDER_NOT_ALLOWED'],
    ['Apple enabled', (s) => { s.auth.providersEnabled = ['email', 'apple']; }, 'PROVIDER_NOT_ALLOWED'],
    ['e-mail off', (s) => { s.auth.providersEnabled = []; }, 'PROVIDER_EMAIL_OFF'],
    ['anonymous sign-ins on', (s) => { s.auth.anonymousSignIns = true; }, 'ANONYMOUS_ON'],
    ['anonymous sign-ins not stated', (s) => { delete s.auth.anonymousSignIns; }, 'ANONYMOUS_ON'],
    ['a wildcard redirect', (s) => { s.auth.redirectUrls.push(`${APP_SCHEME}://*`); }, 'REDIRECT_WILDCARD'],
    ['a foreign redirect', (s) => { s.auth.redirectUrls.push('someone-else://callback'); }, 'REDIRECT_UNEXPECTED'],
    ['oauth-callback missing under both-exact', (s) => { s.auth.redirectUrls = [`${APP_SCHEME}://auth-callback`]; }, 'REDIRECT_MISSING'],
    ['a zero JWT expiry', (s) => { s.auth.jwtExpirySeconds = 0; }, 'JWT_EXPIRY_INVALID'],
    ['a fractional JWT expiry', (s) => { s.auth.jwtExpirySeconds = 60.5; }, 'JWT_EXPIRY_INVALID'],
    ['the private schema exposed', (s) => { s.api.exposedSchemas.push('private'); }, 'SCHEMA_EXPOSED_NOT_ALLOWED'],
    ['public not exposed', (s) => { s.api.exposedSchemas = ['graphql_public']; }, 'SCHEMA_PUBLIC_NOT_EXPOSED'],
    ['the legacy function deployed', (s) => { s.edge.functions.push({ name: 'social-mobile-account-delete', verifyJwt: true, sha256: DIGEST }); }, 'EDGE_FUNCTION_NOT_ALLOWED'],
    ['the X OAuth function deployed', (s) => { s.edge.functions.push({ name: 'x-oauth-connect-user', verifyJwt: true, sha256: DIGEST }); }, 'EDGE_FUNCTION_NOT_ALLOWED'],
    ['account-delete without JWT verification', (s) => { s.edge.functions[0].verifyJwt = false; }, 'EDGE_VERIFY_JWT_OFF'],
    ['account-delete of another digest', (s) => { s.edge.functions[0].sha256 = sha('other bytes'); }, 'EDGE_DIGEST_MISMATCH'],
    ['account-delete not deployed', (s) => { s.edge.functions = []; }, 'EDGE_FUNCTION_MISSING'],
    ['an X secret', (s) => { s.secrets.names.push('X_CLIENT_SECRET'); }, 'SECRET_NAME_FORBIDDEN'],
    ['a Threads secret', (s) => { s.secrets.names.push('THREADS_APP_SECRET'); }, 'SECRET_NAME_FORBIDDEN'],
    ['an AI key', (s) => { s.secrets.names.push('OPENAI_API_KEY'); }, 'SECRET_NAME_FORBIDDEN'],
    ['an unknown secret name', (s) => { s.secrets.names.push('SOMETHING_ELSE'); }, 'SECRET_NAME_UNKNOWN'],
    ['pg_cron enabled', (s) => { s.database.extensions.push('pg_cron'); }, 'EXTENSION_FORBIDDEN'],
    ['pg_net enabled', (s) => { s.database.extensions.push('pg_net'); }, 'EXTENSION_FORBIDDEN'],
    ['a cron job exists', (s) => { s.database.counts.cronJobs = 1; }, 'COUNT_NOT_ZERO'],
    ['a vault secret exists', (s) => { s.database.counts.vaultSecrets = 1; }, 'COUNT_NOT_ZERO'],
    ['a push token exists', (s) => { s.database.counts.pushTokens = 2; }, 'COUNT_NOT_ZERO'],
    ['a social account exists', (s) => { s.database.counts.socialAccounts = 1; }, 'COUNT_NOT_ZERO'],
    ['a count missing', (s) => { delete s.database.counts.scheduledPosts; }, 'COUNTS_MISSING'],
    ['the attestation missing', (s) => { delete s.attestation; }, 'ATTESTATION_MISSING'],
    ['the attestation reworded', (s) => { s.attestation = 'no x'; }, 'ATTESTATION_MISSING'],
    ['a key-shaped value anywhere', (s) => { s.identity.regionLabel = 'sb_secret_synthetic_key_value_3'; }, 'SECRET_SHAPED'],
    ['a URL anywhere', (s) => { s.identity.regionLabel = 'https://example.invalid/x'; }, 'SECRET_SHAPED'],
    ['a section missing', (s) => { delete s.secrets; }, 'SHEET_SHAPE'],
    ['the wrong schema number', (s) => { s.schema = 2; }, 'SHEET_SHAPE'],
  ];
  for (const [label, change, expected] of cases) {
    const sheet = good();
    change(sheet);
    const got = label === 'not an object' ? stopCodes('nope') : stopCodes(sheet);
    assert.ok(got.includes(expected as never), `${label}: expected ${expected}, got ${got.join(',') || 'nothing'}`);
    assert.equal(checkReadbackSheet(label === 'not an object' ? 'nope' : sheet, OPTIONS).ok, false, `${label}: a STOP finding refuses the sheet`);
  }
  // a function on a project that must still be empty
  const created = good();
  delete created.database.counts;
  assert.ok(stopCodes(created, { ...OPTIONS, stage: 'created' }).includes('EDGE_NOT_EMPTY'));
  // the auth-only policy accepts a list without oauth-callback, and refuses the other one
  const authOnly = good();
  authOnly.auth.redirectUrls = [`${APP_SCHEME}://auth-callback`];
  assert.deepEqual(stopCodes(authOnly, { ...OPTIONS, redirectPolicy: 'auth-only' }), []);
  assert.ok(stopCodes(good(), { ...OPTIONS, redirectPolicy: 'auth-only' }).includes('REDIRECT_UNEXPECTED'));
  // warnings do not stop, but are reported
  const warned = good();
  warned.auth.signUpsOpen = false;
  warned.auth.emailAutoconfirm = false;
  warned.auth.jwtExpirySeconds = 120;
  const report = checkReadbackSheet(warned, OPTIONS);
  assert.equal(report.ok, true);
  assert.deepEqual(report.findings.map((finding) => finding.code).sort(), ['AUTOCONFIRM_OFF', 'JWT_EXPIRY_UNUSUAL', 'SIGNUPS_CLOSED']);
});

// ---- the document's own claims ---------------------------------------------------------------------------------------------------

test('the document names the sections the gates refer to, the findings of this task, and what was not verified', () => {
  for (const heading of [/^## 3\. /mu, /^## 4\. /mu, /^## 5\. /mu, /^## 6\. /mu, /^## 7\. /mu, /^## 8\. /mu, /^## 9\. /mu, /^## 10\. /mu, /^## 11\. /mu, /^## 12\. /mu, /^## 13\. /mu, /^## 14\. /mu]) assert.match(doc, heading);
  for (const phrase of [
    'NOT_VERIFIED', 'permission denied for table', 'ACCESS SHARE', 'CONNECT', 'verify_jwt', 'supabase/config.toml', 'D-2', 'M12', 'R2′', 'T13', '#233', 'sb_publishable_', 'sb_secret_',
    '--allow-net', 'redirect: \'error\'', 'managed_auth_delete', 'IDP_PREPAUSE_BLOCKED', 'POSTONA_END_SOURCE_ENABLED', 'PRODUCTION_REF_SHA256', 'harness PASS', 'D-3_SPEC',
  ]) assert.ok(doc.includes(phrase), `the document should mention ${phrase}`);
  // the architecture plan's open claims that this package corrects or narrows
  assert.match(doc, /pg_dump[^.]*needs SELECT/u);
  assert.match(doc, /deployed Edge function/u);
  for (const id of ['PG2a', 'PG2b']) assert.ok(doc.includes(id));
  for (const entry of gates.gates.flatMap((gate) => gate.missingToday)) assert.ok(typeof entry === 'string' && entry.length > 0);
});
