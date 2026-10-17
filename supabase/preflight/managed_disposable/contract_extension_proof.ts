// Local-database proof of the baseline contract v2 (F5 Phase 13), driven by supabase/tests/common_account_phase13_contract_extension_run.sh.
//
// Input: for every case, the inventory the REAL read-only query produced on a mutated copy of the model baseline, and the REAL
// answer of the chain (does a chain file refuse?). Both contracts read the same inventories:
//   old  the Phase 12 code, unchanged (the base commit, extracted by the runner) with the requirements it derived from Phase 1 only
//   new  contract v2 (this tree): requirements read from Phase 1 and the later chain preflights
// Two questions are asked of every case, because they are different failures:
//   SELF   "production itself looks like this": the owner approves the digest OF THIS inventory, and the disposable copy
//          matches it exactly. Drift cannot fire; only the REQUIREMENT check can. This is the gap: a baseline that lacks an
//          object a later chain file needs passes the Phase 12 gate and is refused only by the chain.
//   DRIFT  "the approved digest is the control's": a copy that differs from the approved baseline. Only the fingerprint can fire.
// Expected (asserted below):
//   C00                   chain OK                        SELF old PASS new PASS    DRIFT old PASS new PASS
//   C01..C06, C08, C09    the chain refuses (the objects the Phase 13 oracle and audit found)   SELF old PASS (the gap)  new STOP with the typed finding
//   C07                   the chain accepts a varchar platform; the contract is stricter on purpose   SELF old PASS  new STOP COLUMN_TYPE
//   C10, C13, C18         the chain accepts; invisible to every refusal   SELF new PASS   DRIFT old PASS  new STOP (the fingerprint)
//   C11                   a replaced body (P4 overwrites it anyway) is deliberately NOT fingerprinted   SELF/DRIFT new PASS
//   C19                   a replaced body that mentions a URL: the chain accepts, contract v2 refuses outright (FUNCTION_MENTIONS)
//   K01..K10              the chain applied through P_k: the baseline read-back must still PASS with the SAME digest (G3b is re-run before every chain file)
//   C12, C15              already covered by Phase 12 (a table ACL, a Phase 1 helper)   DRIFT/SELF old STOP  new STOP
//   C14                   a key-shaped name in the inventory: both STOP on the secret scan, neither verdict echoes it
//   and for EVERY case in which a chain file refuses, the new SELF verdict is STOP: the gate fires before the first chain file.
// Fake data, local sockets, no network: nothing here can reach a managed project.
import { buildRequirements, extractRequirements, PREFLIGHT_MIGRATION, type Phase1Requirements } from './baseline_requirements.ts';
import * as current from './inventory.ts';

const env = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is required (common_account_phase13_contract_extension_run.sh)`);
  return value;
};
const oldDir = env('P13_OLD_DIR');
const owner = env('P13_OWNER');
const repoRoot = env('P13_REPO_ROOT');
const read = (path: string) => Deno.readTextFileSync(`${repoRoot}/${path}`);
// the Phase 12 modules, loaded from the extracted base commit: the same functions, typed as far as this proof uses them
type InventoryApi = Pick<typeof current, 'verifyInventory' | 'canonicalize' | 'contractSubset' | 'parseInventory'>;
const old = (await import(`file://${oldDir}/inventory.ts`)) as InventoryApi;
const oldRequirementsModule = (await import(`file://${oldDir}/baseline_requirements.ts`)) as { extractRequirements: (text: string) => Phase1Requirements };
if ('CONTRACT_VERSION' in oldRequirementsModule) throw new Error('the base commit already carries contract v2');

type Case = { id: string; description: string; text: string; chain: string };
// the local owner role carries the process id in its name: a proof must not depend on it
const cases: Case[] = Deno.readTextFileSync(env('P13_CASES')).split('\n').filter((line) => line !== '').map((line) => {
  const [id, description, file, chain] = line.split('\t');
  return { id, description, text: Deno.readTextFileSync(file).replaceAll(owner, 'db_owner'), chain };
});
const byId = new Map(cases.map((c) => [c.id, c]));

const requirementsNew = buildRequirements(read);
const requirementsOld = oldRequirementsModule.extractRequirements(read(PREFLIGHT_MIGRATION));
const phase1Check = extractRequirements(read(PREFLIGHT_MIGRATION));
const digestOf = async (module: InventoryApi, requirements: unknown, text: string) =>
  (await module.canonicalize(module.contractSubset(module.parseInventory(text), requirements as never))).digest;
const control = byId.get('C00');
if (!control) throw new Error('no control case');
const controlOld = await digestOf(old, requirementsOld, control.text);
const controlNew = await digestOf(current, requirementsNew, control.text);

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`P13_CONTRACT_PROOF|${name}|${ok ? 'PASS' : 'FAIL'}${detail && !ok ? `|${detail}` : ''}`);
  if (!ok) failures++;
};

check('model_requirements_are_the_same_phase1_lists', JSON.stringify(requirementsOld) === JSON.stringify(phase1Check));
check('contract_v2_adds_exactly_three_objects', requirementsNew.functions.length === requirementsOld.functions.length + 1 && requirementsNew.columns.length === requirementsOld.columns.length + 1 && requirementsNew.platformFunctions.length === 1);
check('the_two_control_digests_differ', controlOld !== controlNew);
console.log(`P13_CONTRACT_DIGESTS|phase12=${controlOld.slice(0, 16)}...|v2=${controlNew.slice(0, 16)}... (model baseline, not production)`);

type Verdict = { status: string; detail: string; digest?: string; findings: { code: string }[] };
type Row = { id: string; chain: string; selfOld: Verdict; selfNew: Verdict; driftOld: Verdict; driftNew: Verdict };
const rows = new Map<string, Row>();
const word = (verdict: Verdict) => verdict.status === 'PASS' ? 'PASS' : `STOP:${[...new Set(verdict.findings.map((f) => f.code))].join('+') || (/differs from the approved/u.test(verdict.detail) ? 'DRIFT' : 'INPUT')}`;
for (const c of cases) {
  const selfOld = await old.verifyInventory(c.text, requirementsOld as never, await digestOf(old, requirementsOld, c.text).catch(() => undefined));
  const selfNew = await current.verifyInventory(c.text, requirementsNew, await digestOf(current, requirementsNew, c.text).catch(() => undefined));
  const driftOld = await old.verifyInventory(c.text, requirementsOld as never, controlOld);
  const driftNew = await current.verifyInventory(c.text, requirementsNew, controlNew);
  rows.set(c.id, { id: c.id, chain: c.chain, selfOld, selfNew, driftOld, driftNew });
  console.log(`P13_CONTRACT|${c.id}|chain=${c.chain.slice(0, 90)}|SELF phase12=${word(selfOld)} v2=${word(selfNew)}|DRIFT phase12=${word(driftOld)} v2=${word(driftNew)}|${c.description}`);
}
const row = (id: string) => rows.get(id) as Row;
const has = (verdict: Verdict, code: string) => verdict.findings.some((f) => f.code === code);

// ---- the control
check('C00_chain_accepts_the_baseline', row('C00').chain === 'OK', row('C00').chain);
check('C00_every_verdict_passes', ['selfOld', 'selfNew', 'driftOld', 'driftNew'].every((k) => (row('C00')[k as keyof Row] as Verdict).status === 'PASS'));

// ---- FAIL-before / PASS-after: the chain refuses, the Phase 12 gate passes (the gap), contract v2 stops first with a typed finding
const refused: [string, string, string][] = [
  ['C01', 'ENSURE_MY_PROFILE_SHAPE', 'FUNCTION_MISSING'],
  ['C02', 'ENSURE_MY_PROFILE_SHAPE', 'FUNCTION_SHAPE'],
  ['C03', 'ENSURE_MY_PROFILE_SHAPE', 'FUNCTION_SHAPE'],
  ['C04', 'ENSURE_MY_PROFILE_SHAPE', 'FUNCTION_MISSING'],
  ['C05', 'ENSURE_MY_PROFILE_SHAPE', 'FUNCTION_MISSING'],
  ['C06', 'SERVICE_OWNERSHIP_PREFLIGHT_SHAPE', 'COLUMN_MISSING'],
  ['C08', 'auth.uid() does not exist', 'PLATFORM_FUNCTION_MISSING'],
  ['C09', 'operator does not exist: text = uuid', 'PLATFORM_FUNCTION_SHAPE'],
];
for (const [id, refusal, code] of refused) {
  const r = row(id);
  check(`${id}_chain_refuses_with_${refusal.replace(/[^A-Za-z0-9_]+/gu, '_')}`, r.chain.startsWith('FAIL') && r.chain.includes(refusal), r.chain);
  check(`${id}_phase12_gate_passes_its_own_digest_the_gap`, r.selfOld.status === 'PASS', r.selfOld.detail);
  check(`${id}_contract_v2_stops_with_${code}`, r.selfNew.status === 'STOP' && has(r.selfNew, code), `${r.selfNew.status} ${r.selfNew.findings.map((f) => f.code).join(',')}`);
}

// ---- stricter than the chain on purpose, and drift no refusal can see
check('C07_the_chain_accepts_a_varchar_platform_the_contract_does_not', row('C07').chain === 'OK' && row('C07').selfOld.status === 'PASS' && row('C07').selfNew.status === 'STOP' && has(row('C07').selfNew, 'COLUMN_TYPE'), row('C07').chain);
for (const id of ['C10', 'C13', 'C18']) {
  const r = row(id);
  check(`${id}_chain_applies_the_shape_is_fine_and_only_the_fingerprint_sees_it`, r.chain === 'OK' && r.selfNew.status === 'PASS' && r.driftOld.status === 'PASS' && r.driftNew.status === 'STOP' && /differs from the approved one/u.test(r.driftNew.detail), `${r.chain} ${r.driftNew.detail}`);
}

check('C11_a_replaced_body_is_not_baseline_drift_the_chain_overwrites_it', row('C11').chain === 'OK' && row('C11').selfNew.status === 'PASS' && row('C11').driftNew.status === 'PASS' && row('C11').driftOld.status === 'PASS', `${row('C11').chain} ${row('C11').driftNew.detail}`);
check('C19_a_replaced_body_that_reaches_out_is_refused', row('C19').chain === 'OK' && row('C19').selfOld.status === 'PASS' && row('C19').selfNew.status === 'STOP' && has(row('C19').selfNew, 'FUNCTION_MENTIONS'), `${row('C19').chain} ${row('C19').selfNew.detail}`);

// ---- the read-back is re-runnable before every chain file: after each prefix of the chain it passes with the approved digest
for (let k = 1; k <= 10; k += 1) {
  const id = `K${String(k).padStart(2, '0')}`;
  const r = row(id);
  const same = r.driftNew.status === 'PASS' && r.driftNew.digest === controlNew;
  check(`${id}_the_read_back_passes_with_the_approved_digest_after_the_chain_prefix`, r.selfNew.status === 'PASS' && same && r.driftOld.status === 'PASS' && r.driftOld.digest === controlOld, `${r.selfNew.status} ${r.driftNew.detail}`);
}

// ---- unchanged invariants of Phase 12
check('C12_a_table_acl_change_is_drift_before_and_after', row('C12').driftOld.status === 'STOP' && row('C12').driftNew.status === 'STOP', `${row('C12').driftOld.status}/${row('C12').driftNew.status}`);
check('C15_a_missing_phase1_helper_is_stopped_before_and_after', row('C15').selfOld.status === 'STOP' && row('C15').selfNew.status === 'STOP' && has(row('C15').selfNew, 'FUNCTION_MISSING'));
check('C15_chain_refuses_the_missing_phase1_helper', row('C15').chain.startsWith('FAIL P1'), row('C15').chain);

// ---- hostile content: both stop on the secret scan; no message echoes the planted token
check('C14_both_contracts_stop_on_the_secret_scan', row('C14').selfOld.status === 'STOP' && row('C14').selfNew.status === 'STOP' && /secret-shaped/u.test(row('C14').selfOld.detail) && /secret-shaped/u.test(row('C14').selfNew.detail));
const planted = 'P13Planted';
check('no_verdict_echoes_the_planted_name', [...rows.values()].every((r) => !JSON.stringify([r.selfOld, r.selfNew, r.driftOld, r.driftNew]).includes(planted)));

// ---- the safety property: wherever a chain file refuses, contract v2 has already stopped
const unguarded = [...rows.values()].filter((r) => r.chain.startsWith('FAIL') && r.selfNew.status !== 'STOP').map((r) => r.id);
check('wherever_the_chain_refuses_contract_v2_has_already_stopped', unguarded.length === 0, unguarded.join(','));
const gap = [...rows.values()].filter((r) => r.chain.startsWith('FAIL') && r.selfOld.status === 'PASS').map((r) => r.id);
console.log(`P13_CONTRACT_GAP|the chain refuses but the Phase 12 gate passed its own digest: ${gap.join(',')}`);
check('the_gap_was_real_in_eight_cases', gap.length === 8 && gap.join(',') === 'C01,C02,C03,C04,C05,C06,C08,C09', gap.join(','));

console.log(failures === 0 ? 'P13_CONTRACT_PROOF|ALL|PASS' : `P13_CONTRACT_PROOF|ALL|FAIL|${failures}`);
if (failures > 0) Deno.exit(1);
