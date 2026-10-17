// Phase 13 D-3: F4's sandbox preflight (PR #243) REFUSES until every one of its 13 conditions is established, and it agrees with the
// F5 guard on what "production" is. OFFLINE and PURE: the F4 script is imported from a temporary copy of the blob pinned in
// docs/common-account/phase13-migration-dag.json (the wrapper verifies the blob id first); only its pure decision function is called,
// with SYNTHETIC inputs built in memory. Nothing is read from an app directory, no environment file is opened, no network request
// is made, no sign-off record is issued or written, and nothing is printed except check names, counts and booleans.
//
//   bash supabase/tests/common_account_phase13_d3_f4_refusal.sh
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [preflightPath, repoRoot] = process.argv.slice(2);
if (!preflightPath || !repoRoot) throw new Error('usage: node common_account_phase13_d3_f4_refusal.mjs <preflight copy> <repository root>');
const { evaluatePreflight, PRODUCTION_REF_SHA256, SIDE_EFFECTS_ATTESTATION, OTHER_GATES } = await import(pathToFileURL(preflightPath).href);

let failures = 0;
const out = (line) => console.log(`D3_F4_REFUSAL|${line}`);
const check = (name, ok, detail = '') => {
  out(`${name}|${ok ? 'PASS' : 'FAIL'}${detail ? `|${detail}` : ''}`);
  if (!ok) failures += 1;
};
const sha = (text) => createHash('sha256').update(text).digest('hex');

// ---- the production ref(s), read from the repository's own migrations exactly as the F5 harness does (never printed)
const productionRefs = new Set();
for (const name of readdirSync(join(repoRoot, 'supabase', 'migrations'))) {
  if (!name.endsWith('.sql')) continue;
  for (const match of readFileSync(join(repoRoot, 'supabase', 'migrations', name), 'utf8').matchAll(/([a-z0-9]{20})\.supabase\.co/gu)) productionRefs.add(match[1]);
}
const PROD = [...productionRefs][0];
check('deny_list_agreement', productionRefs.size === 1 && PRODUCTION_REF_SHA256.includes(sha(PROD)), `refs_in_migrations=${productionRefs.size} f4_hashes=${PRODUCTION_REF_SHA256.length}`);

// ---- synthetic inputs
const REF = 'c'.repeat(20);
const OTHER = 'd'.repeat(20);
const host = (ref) => `https://${ref}.supabase.co`;
const KEY = `sb_publishable_${'x'.repeat(24)}`;
const SCHEME = 'kabumori-social';
const satisfied = () => ({
  effectiveEnv: { EXPO_PUBLIC_DATA_SOURCE: 'supabase', EXPO_PUBLIC_SUPABASE_URL: host(REF), EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: KEY },
  envFiles: [{ name: '.env.local', values: { EXPO_PUBLIC_DATA_SOURCE: 'supabase', EXPO_PUBLIC_SUPABASE_URL: host(REF) } }],
  scheme: SCHEME,
  endFlag: { head: false, working: true },
  otherGates: OTHER_GATES.map((name) => ({ name, value: false })),
  operator: { sandboxRef: REF, redirects: `${SCHEME}://auth-callback,${SCHEME}://oauth-callback`, signoff: 'synthetic-test-reference', sideEffects: SIDE_EFFECTS_ATTESTATION },
});
const clean = () => ({
  effectiveEnv: {}, envFiles: [], scheme: SCHEME, endFlag: { head: false, working: false },
  otherGates: OTHER_GATES.map((name) => ({ name, value: false })), operator: {},
});
const failing = (result) => result.checks.filter((c) => !c.ok).map((c) => c.code);

const codesFromPackage = JSON.parse(readFileSync(join(repoRoot, 'docs', 'common-account', 'phase13-d3-gates.json'), 'utf8')).f4Conditions.map((c) => c.code);
const allCodes = evaluatePreflight(satisfied()).checks.map((c) => c.code);
check('thirteen_conditions', allCodes.length === 13 && JSON.stringify([...allCodes].sort()) === JSON.stringify([...codesFromPackage].sort()), `count=${allCodes.length}`);

// ---- a clean checkout is REFUSED, with the ten failures the architecture plan recorded
const cleanResult = evaluatePreflight(clean());
const EXPECTED_CLEAN = ['DATA_SOURCE_SUPABASE', 'SANDBOX_DECLARED', 'SANDBOX_NOT_PRODUCTION', 'URL_NOT_PRODUCTION', 'URL_IS_DECLARED_SANDBOX', 'KEY_IS_PUBLISHABLE', 'REDIRECTS_DECLARED', 'END_FLAG_LOCAL_ONLY', 'OWNER_SIGNOFF', 'SIDE_EFFECTS_ATTESTED'];
check('clean_checkout_refused', cleanResult.ready === false && JSON.stringify(failing(cleanResult).sort()) === JSON.stringify([...EXPECTED_CLEAN].sort()), `failing=${failing(cleanResult).length}`);

// ---- the control: every condition established by synthetic inputs -> READY (so each refusal below is caused by the one change)
const control = evaluatePreflight(satisfied());
check('control_ready_only_when_all_thirteen_hold', control.ready === true && failing(control).length === 0);

// ---- each condition, broken alone, REFUSES
const broken = [
  ['DATA_SOURCE_SUPABASE', (i) => { i.effectiveEnv.EXPO_PUBLIC_DATA_SOURCE = 'mock'; }],
  ['SANDBOX_DECLARED', (i) => { i.operator.sandboxRef = ''; }],
  ['SANDBOX_NOT_PRODUCTION', (i) => { i.operator.sandboxRef = PROD; }],
  ['URL_NOT_PRODUCTION', (i) => { i.effectiveEnv.EXPO_PUBLIC_SUPABASE_URL = host(PROD); }],
  ['URL_IS_DECLARED_SANDBOX', (i) => { i.effectiveEnv.EXPO_PUBLIC_SUPABASE_URL = host(OTHER); }],
  ['ENV_FILES_CONSISTENT', (i) => { i.envFiles[0].values.EXPO_PUBLIC_SUPABASE_URL = host(OTHER); }],
  ['ENV_FILES_NO_MOCK', (i) => { i.envFiles[0].values.EXPO_PUBLIC_DATA_SOURCE = 'mock'; }],
  ['KEY_IS_PUBLISHABLE', (i) => { i.effectiveEnv.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = `sb_secret_${'x'.repeat(24)}`; }],
  ['REDIRECTS_DECLARED', (i) => { i.operator.redirects = `${SCHEME}://auth-callback`; }],
  ['REDIRECTS_DECLARED', (i) => { i.operator.redirects = `${SCHEME}://auth-callback,${SCHEME}://oauth-callback,${SCHEME}://*`; }],
  ['END_FLAG_LOCAL_ONLY', (i) => { i.endFlag = { head: true, working: true }; }],
  ['END_FLAG_LOCAL_ONLY', (i) => { i.endFlag = { head: false, working: false }; }],
  ['OTHER_GATES_OFF', (i) => { i.otherGates[0].value = true; }],
  ['OTHER_GATES_OFF', (i) => { i.otherGates[0].value = null; }],
  ['OWNER_SIGNOFF', (i) => { i.operator.signoff = ''; }],
  ['SIDE_EFFECTS_ATTESTED', (i) => { i.operator.sideEffects = 'no-x'; }],
];
const covered = new Set();
broken.forEach(([code, change], index) => {
  const input = satisfied();
  change(input);
  const result = evaluatePreflight(input);
  covered.add(code);
  check(`broken_${String(index + 1).padStart(2, '0')}_${code}`, result.ready === false && failing(result).includes(code), `failing=${failing(result).length}`);
});
check('every_condition_has_a_refusing_case', covered.size === 13 && [...covered].every((code) => allCodes.includes(code)), `covered=${covered.size}`);

// ---- what D-3 decision E rests on: the F5 default (auth-callback only) is NOT enough for F4
const authOnly = satisfied();
authOnly.operator.redirects = `${SCHEME}://auth-callback`;
const authOnlyResult = evaluatePreflight(authOnly);
check('auth_callback_only_list_is_refused', authOnlyResult.ready === false && JSON.stringify(failing(authOnlyResult)) === JSON.stringify(['REDIRECTS_DECLARED']));

// ---- the preflight never prints a URL, ref, key or token: its result holds codes, booleans and short details only
const productionInput = satisfied();
productionInput.effectiveEnv.EXPO_PUBLIC_SUPABASE_URL = host(PROD);
const text = JSON.stringify(evaluatePreflight(productionInput));
check('result_names_no_host_ref_or_key', !text.includes(PROD) && !text.includes('supabase.co') && !text.includes(KEY));

out(`ALL|${failures === 0 ? 'PASS' : 'FAIL'}`);
process.exitCode = failures === 0 ? 0 : 1;
