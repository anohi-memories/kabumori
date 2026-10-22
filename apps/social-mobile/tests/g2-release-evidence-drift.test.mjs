// G2 QA (Issue #317, task postona-g2-release-no-go-evidence-gate-drift-offline-20261022) -- QA only, no product code.
// POSTONA release NO_GO factors as an evidence ledger, and a FAIL-CLOSED release decision over it. The point is evidence
// DRIFT: a gate must never be lifted by a review recorded at an older head, a parent branch that moved after the review,
// a fix that is still Draft / unmerged, a CHANGES_REQUIRED or "re-review required" verdict, a G2 QA PASS standing in for
// a product fix, source evidence standing in for a device or a real-API check, or a QA gate that is still red. G2 #387
// listed the factors on 2026-10-20; this file does not re-list them, it tests the decision rules and their inputs.
// Inputs are OFFLINE: docs/postona/qa/g2-release-evidence-drift/snapshot.json (PR heads / states / base tips collected
// read-only at 2026-10-22 11:57 JST) and the ledger below (verdicts and heads copied verbatim from the Issue REPORT /
// ACCEPT comments). Nothing here asks GitHub or any other service while it runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SNAPSHOT = JSON.parse(await readFile(new URL('../../../docs/postona/qa/g2-release-evidence-drift/snapshot.json', import.meta.url), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));

// ---- the ledger ------------------------------------------------------------------------------------------------------
// kind: product_fix (an owner's fix PR) | security_review (an independent H / Codex review of that fix) | owner_accept
// (the managing chat's ACCEPT of a source candidate) | qa (a G2 QA artifact) | device (a run on a real device / standard
// build) | real_api (a real provider / Auth run approved by the user). `head` is the head the record was made on.
// `requires`: the kinds that must ALL hold, at the CURRENT head of the gate's fix PR, before the gate may lift.
const ALL_PRODUCT = ['product_fix', 'security_review', 'qa'];
export const LEDGER = [
  { id: 'THREADS_T1', severity: 'P2', owner: 'G4', fixPr: null, requires: [...ALL_PRODUCT, 'real_api'], openFindings: ['G2-T1', 'G2-T1-U', 'G2-T1-PU'],
    evidence: [{ kind: 'qa', pr: 391, head: 'e729b2f253b228208ecd4448e3dc65acf0530eb2', verdict: 'FINDING' }, { kind: 'qa', pr: 439, head: '94b3e09b2abbe15963cc60ae21c55c0b4cae30ed', verdict: 'NO_FIX_CANDIDATE / G2-T1_P2_STAYS_OPEN' }] },
  { id: 'THREADS_T2', severity: 'P3', owner: 'G4', fixPr: null, requires: [...ALL_PRODUCT, 'device'], openFindings: ['G2-T2', 'G2-T2-F', 'G2-T2-M', 'G2-T2-P'],
    evidence: [{ kind: 'qa', pr: 393, head: '2f3182319b3e7c2617c5429e5c1269371f3121e6', verdict: 'FINDING' }] },
  { id: 'THREADS_T1X', severity: 'P3', owner: 'G4', fixPr: null, requires: ['product_fix', 'qa'], openFindings: ['G2-T1-X'], knownFailingTests: ['threads-disconnect.test.mjs: parity'],
    evidence: [{ kind: 'qa', pr: 442, head: 'd2845005fbe6b0fccc30ec9553c4d76e669626d8', verdict: 'T1X_IS_TEST_HARNESS_IMPORT_GAP / CONTRACT_INTACT_ON_SAME_HEAD' }] },
  { id: 'X_STALE_NONE_LIVE_RETRY', severity: 'P2', owner: 'G1', fixPr: 435, requires: ALL_PRODUCT, openFindings: ['H1 residual P2 (stale none)', 'H1 #427 CHANGES_REQUIRED (live retry kind)', 'G2-SN5'],
    evidence: [
      { kind: 'product_fix', pr: 427, head: '38bf60cd215c2005c49facc1d2d47e8cb0131acc', verdict: 'PASS_STALE_NONE_P2_SOURCE_CANDIDATE / SECURITY_REREVIEW_REQUIRED / PRODUCTION_NO_GO' },
      { kind: 'security_review', pr: 427, head: '38bf60cd215c2005c49facc1d2d47e8cb0131acc', verdict: 'CHANGES_REQUIRED' },
      { kind: 'product_fix', pr: 435, head: '5a6c51ca8441c636cec10a451cc7ab5356b823a9', verdict: 'PASS_SOURCE_CANDIDATE / SECURITY_REREVIEW_REQUIRED / PRODUCTION_NO_GO' },
      { kind: 'qa', pr: 430, head: '30fbbfba336945ccf960d5c10ab0c355eca75322', measuredOn: { pr: 427, head: '38bf60cd215c2005c49facc1d2d47e8cb0131acc' }, verdict: 'PASS' },
    ] },
  { id: 'X_OAUTH_OWNER_SESSION', severity: 'P3', owner: 'G4', fixPr: 426, requires: [...ALL_PRODUCT, 'real_api'], openFindings: ['independent Auth review', 'real server old-token acceptance'],
    evidence: [
      { kind: 'product_fix', pr: 426, head: '03968e5cab5e5bc462fe585d1a72b81c81e43657', verdict: 'PASS_OFFLINE_SOURCE_FIX_CANDIDATE / INDEPENDENT_AUTH_SECURITY_REVIEW_REQUIRED / PRODUCTION_NO_GO' },
      { kind: 'qa', pr: 433, head: '129287609375da9e173438620a7e0fd7b4d43240', measuredOn: { pr: 426, head: '03968e5cab5e5bc462fe585d1a72b81c81e43657' }, verdict: 'PASS' },
      { kind: 'qa', pr: 436, head: '898a551d3ba4cefc4f82853339d690f309703e20', measuredOn: { pr: 426, head: '03968e5cab5e5bc462fe585d1a72b81c81e43657' }, verdict: 'PASS' },
    ] },
  { id: 'IOS27_UISCENE', severity: 'release', owner: 'undecided (native config)', fixPr: null, requires: ['product_fix', 'device'], openFindings: ['standard build does not start on iOS 27'],
    evidence: [{ kind: 'qa', pr: 397, head: 'a0f66c77e8f7fb978bae0a1a02873ec91d07be61', verdict: 'GATE_DEFINED' }, { kind: 'device', pr: 348, head: 'e3963e1167aecfe349315428c317a1441257ac83', verdict: 'PATCHED_DEV_CLIENT_ONLY' }] },
  { id: 'EXPO_IDENTIFIERS', severity: 'P3', owner: 'undecided (native config)', fixPr: null, requires: ['product_fix', 'device'], openFindings: ['G2-ID1', 'G2-ID5'],
    evidence: [{ kind: 'qa', pr: 401, head: '22e574f869ded0763b6d246117f5d84660ae3eed', verdict: 'FINDING' }] },
  { id: 'ANDROID_DEVICE_APP_LINKS', severity: 'P3', owner: 'G4 / native config', fixPr: null, requires: ['product_fix', 'device'], openFindings: ['no HTTPS App Links', 'android.package not fixed'],
    evidence: [{ kind: 'qa', pr: 362, head: 'a2145eed2abda32b6f545c529b5b11a39c0d1e2c', verdict: 'PASS_OFFLINE / DEVICE_NOT_VERIFIED' }, { kind: 'qa', pr: 419, head: '1ffd1b20f195d07fcc1b4beda3ea0f271c63aef3', verdict: 'PASS_OFFLINE / DEVICE_NOT_VERIFIED' }] },
  { id: 'SESSION_MARK_SM', severity: 'P3', owner: 'G1 / G5 (Auth IF)', fixPr: null, requires: [...ALL_PRODUCT, 'real_api'], openFindings: ['SM2', 'SM3R-T', 'SM4', 'SM4-D'], evidence: [] },
  { id: 'REAL_AUTH_AND_SNS', severity: 'release', owner: 'user approval', fixPr: null, requires: ['real_api', 'device'], openFindings: ['no real Auth / OAuth / X / Threads run'], evidence: [] },
];

// ---- the decision ----------------------------------------------------------------------------------------------------
/** A verdict accepts only when it has an accepting token and NO token that withholds acceptance. */
const WITHHOLD = /CHANGES_REQUIRED|REVIEW_REQUIRED|REREVIEW_REQUIRED|NO_GO|FINDING|NOT_VERIFIED|CANDIDATE|PATCHED|ONLY|GATE_DEFINED|NO_FIX|STAYS_OPEN|GAP|UNKNOWN|BLOCKED|PENDING/u;
const ACCEPTS = /^(ACCEPT|PASS|APPROVED)$/u;
export function verdictAccepts(verdict) {
  const tokens = String(verdict).split(/\s*\/\s*/u);
  return tokens.length > 0 && tokens.every((t) => !WITHHOLD.test(t)) && tokens.some((t) => ACCEPTS.test(t));
}

/** Fail-closed: GO only when every requirement holds at the fix PR's CURRENT head, with nothing open. */
export function decideGate(gate, snapshot) {
  const reasons = new Set();
  const fix = gate.fixPr === null ? null : snapshot.prs[String(gate.fixPr)];
  if (gate.fixPr === null) reasons.add('NO_FIX');
  else if (!fix) reasons.add('FIX_PR_UNKNOWN');
  else {
    if (fix.state !== 'MERGED' || !fix.mergedAt) reasons.add('NOT_MERGED');
    if (fix.draft) reasons.add('DRAFT');
    const baseTip = snapshot.baseTips[fix.base];
    if (gate.reviewedBaseTip !== undefined && gate.reviewedBaseTip !== baseTip) reasons.add('PARENT_DRIFT');
  }
  for (const record of gate.evidence) {
    if (record.kind === 'security_review' && /CHANGES_REQUIRED/u.test(record.verdict)) {
      const current = snapshot.prs[String(record.pr)];
      if (current && current.head === record.head) reasons.add('CHANGES_REQUIRED');
    }
  }
  for (const kind of gate.requires) {
    const records = gate.evidence.filter((r) => r.kind === kind);
    const atFix = records.filter((r) => fix && (r.kind === 'qa' ? r.measuredOn?.pr === gate.fixPr && r.measuredOn.head === fix.head : r.pr === gate.fixPr && r.head === fix.head));
    const good = atFix.filter((r) => verdictAccepts(r.verdict));
    if (good.length > 0) continue;
    if (records.some((r) => verdictAccepts(r.verdict))) reasons.add(`STALE_${kind.toUpperCase()}`);
    else if (records.length > 0) reasons.add(`${kind.toUpperCase()}_NOT_ACCEPTED`);
    else reasons.add(`${kind.toUpperCase()}_MISSING`);
  }
  if ((gate.openFindings ?? []).length > 0) reasons.add('OPEN_FINDINGS');
  if ((gate.knownFailingTests ?? []).length > 0) reasons.add('KNOWN_FAIL');
  if ((gate.redQaGates ?? []).length > 0) reasons.add('QA_GATE_RED');
  return { id: gate.id, go: reasons.size === 0, reasons: [...reasons].sort() };
}
export function decideRelease(ledger, snapshot) {
  const gates = ledger.map((g) => decideGate(g, snapshot));
  return { go: gates.length > 0 && gates.every((g) => g.go), gates };
}
/** The naive rule a hand-kept list drifts into: "some PASS for the gate, so it is done". */
const naiveGate = (gate) => gate.evidence.some((r) => /PASS|ACCEPT/u.test(r.verdict));

// ---- the current state -------------------------------------------------------------------------------------------------
test('G2-RE1: on the 2026-10-22 snapshot the release is NO_GO, and every gate is held for its real reasons', () => {
  const release = decideRelease(LEDGER, SNAPSHOT);
  assert.equal(release.go, false);
  const by = Object.fromEntries(release.gates.map((g) => [g.id, g]));
  for (const g of release.gates) assert.equal(g.go, false, g.id);
  for (const id of ['THREADS_T1', 'THREADS_T2', 'THREADS_T1X', 'IOS27_UISCENE', 'EXPO_IDENTIFIERS', 'ANDROID_DEVICE_APP_LINKS', 'SESSION_MARK_SM', 'REAL_AUTH_AND_SNS']) assert.ok(by[id].reasons.includes('NO_FIX'), id);
  assert.ok(by.THREADS_T1X.reasons.includes('KNOWN_FAIL'), 'T1-X: G4\'s parity test still fails; G2 #442 is QA, not a fix');
  assert.ok(by.THREADS_T1X.reasons.includes('PRODUCT_FIX_MISSING'));
  // X stale-none / live-retry: H1's CHANGES_REQUIRED still stands on #427's current head, #435 is an unreviewed candidate,
  // and G2 #430 measured #427, not #435.
  assert.deepEqual(by.X_STALE_NONE_LIVE_RETRY.reasons, ['CHANGES_REQUIRED', 'DRAFT', 'NOT_MERGED', 'OPEN_FINDINGS', 'PRODUCT_FIX_NOT_ACCEPTED', 'SECURITY_REVIEW_NOT_ACCEPTED', 'STALE_QA'].sort());
  // X OAuth owner/session: #426 candidate, no independent Auth review, QA at the current head, real server not verified.
  assert.deepEqual(by.X_OAUTH_OWNER_SESSION.reasons, ['DRAFT', 'NOT_MERGED', 'OPEN_FINDINGS', 'PRODUCT_FIX_NOT_ACCEPTED', 'REAL_API_MISSING', 'SECURITY_REVIEW_MISSING'].sort());
  assert.ok(by.ANDROID_DEVICE_APP_LINKS.reasons.includes('DEVICE_MISSING'), 'offline Android PASS is not a device run');
  assert.ok(by.IOS27_UISCENE.reasons.includes('DEVICE_NOT_ACCEPTED'), 'a patched dev client is not the standard build');
});

test('G2-RE2: the snapshot is what the ledger says -- every fix / QA PR is OPEN and Draft, none merged; the ledger\'s QA heads are the PRs\' heads', () => {
  for (const [n, pr] of Object.entries(SNAPSHOT.prs)) {
    assert.equal(pr.state, 'OPEN', `#${n}`);
    assert.equal(pr.draft, true, `#${n}`);
    assert.equal(pr.mergedAt, null, `#${n}`);
  }
  for (const g of LEDGER) for (const r of g.evidence) if (SNAPSHOT.prs[String(r.pr)]) assert.equal(SNAPSHOT.prs[String(r.pr)].head, r.head, `${g.id} #${r.pr}`);
  assert.equal(SNAPSHOT.baseTips['claude/g1-postona-stale-none-after-uncertain-p2-20261021'], '38bf60cd215c2005c49facc1d2d47e8cb0131acc', '#435 sits on #427');
});

// ---- drift: each would lift the gate under the naive rule, none may under the strict one ------------------------------
/** A world in which X_OAUTH_OWNER_SESSION is genuinely done: merged, reviewed, QA'd and run for real at its head. */
function doneWorld() {
  const snapshot = clone(SNAPSHOT);
  snapshot.prs['426'] = { ...snapshot.prs['426'], state: 'MERGED', draft: false, mergedAt: '2026-11-01T00:00:00Z' };
  const head = snapshot.prs['426'].head;
  const gate = {
    ...clone(LEDGER.find((g) => g.id === 'X_OAUTH_OWNER_SESSION')), openFindings: [], reviewedBaseTip: snapshot.baseTips.main,
    evidence: [
      { kind: 'product_fix', pr: 426, head, verdict: 'ACCEPT' },
      { kind: 'security_review', pr: 426, head, verdict: 'PASS' },
      { kind: 'qa', pr: 433, head: 'q', measuredOn: { pr: 426, head }, verdict: 'PASS' },
      { kind: 'real_api', pr: 426, head, verdict: 'APPROVED' },
    ],
  };
  return { snapshot, gate };
}

test('G2-RE3 (positive control): a gate that is really done lifts -- the decision is not a constant NO_GO', () => {
  const { snapshot, gate } = doneWorld();
  assert.deepEqual(decideGate(gate, snapshot), { id: 'X_OAUTH_OWNER_SESSION', go: true, reasons: [] });
});

const DRIFTS = {
  'D1 review made at an OLDER head; the PR moved since': (w) => { w.snapshot.prs['426'].head = 'f'.repeat(40); w.gate.evidence.find((r) => r.kind === 'product_fix').head = 'f'.repeat(40); return ['STALE_QA', 'STALE_REAL_API', 'STALE_SECURITY_REVIEW']; },
  'D2 the PARENT branch moved after the review': (w) => { w.snapshot.baseTips.main = 'e'.repeat(40); return ['PARENT_DRIFT']; },
  'D3 accepted but still Draft / not merged': (w) => { Object.assign(w.snapshot.prs['426'], { state: 'OPEN', draft: true, mergedAt: null }); return ['DRAFT', 'NOT_MERGED']; },
  'D4 the review says CHANGES_REQUIRED at the current head': (w) => { w.gate.evidence.find((r) => r.kind === 'security_review').verdict = 'CHANGES_REQUIRED'; return ['CHANGES_REQUIRED', 'SECURITY_REVIEW_NOT_ACCEPTED']; },
  'D5 an owner ACCEPT that still requires a re-review counts as the review': (w) => { w.gate.evidence.find((r) => r.kind === 'security_review').verdict = 'PASS_SOURCE_CANDIDATE / SECURITY_REREVIEW_REQUIRED / PRODUCTION_NO_GO'; return ['SECURITY_REVIEW_NOT_ACCEPTED']; },
  'D6 a G2 QA PASS stands in for the product fix': (w) => { w.gate.evidence = w.gate.evidence.filter((r) => r.kind !== 'product_fix'); return ['PRODUCT_FIX_MISSING']; },
  'D7 source / offline evidence stands in for the real-API run': (w) => { w.gate.evidence.find((r) => r.kind === 'real_api').kind = 'qa'; return ['REAL_API_MISSING']; },
  'D8 a QA gate is still red (todo failing)': (w) => { w.gate.redQaGates = ['G2-SN1']; return ['QA_GATE_RED']; },
  'D9 a known failing test is still there': (w) => { w.gate.knownFailingTests = ['threads-disconnect.test.mjs: parity']; return ['KNOWN_FAIL']; },
  'D10 an open finding is still on the gate': (w) => { w.gate.openFindings = ['G2-CB5']; return ['OPEN_FINDINGS']; },
  'D11 QA measured on the PREVIOUS fix PR (#427 -> #435 style)': (w) => { w.gate.evidence.find((r) => r.kind === 'qa').measuredOn = { pr: 999, head: 'd'.repeat(40) }; return ['STALE_QA']; },
};

for (const [name, apply] of Object.entries(DRIFTS)) {
  test(`G2-RE4 ${name}: NO_GO with that reason (the naive "some PASS" rule would have lifted it)`, () => {
    const world = doneWorld();
    const expected = apply(world);
    const decision = decideGate(world.gate, world.snapshot);
    assert.equal(decision.go, false);
    for (const reason of expected) assert.ok(decision.reasons.includes(reason), `${reason} in ${decision.reasons.join(',')}`);
    assert.equal(naiveGate(world.gate), true, 'the naive rule lifts it');
  });
}

// ---- negative controls on the rules themselves ---------------------------------------------------------------------
test('negative controls: each strict rule, removed, lets at least one drift lift the gate -- the drift cases really depend on it', () => {
  const variants = {
    'no head check': (g, s) => decideGate({ ...g, evidence: g.evidence.map((r) => ({ ...r, head: s.prs[String(g.fixPr)]?.head ?? r.head, measuredOn: r.measuredOn && { pr: g.fixPr, head: s.prs[String(g.fixPr)]?.head } })) }, s),
    'no merge check': (g, s) => decideGate(g, { ...s, prs: { ...s.prs, [String(g.fixPr)]: { ...s.prs[String(g.fixPr)], state: 'MERGED', draft: false, mergedAt: 'x' } } }),
    'verdict = contains PASS': (g, s) => decideGate({ ...g, evidence: g.evidence.map((r) => ({ ...r, verdict: /PASS|ACCEPT/u.test(r.verdict) && !/CHANGES_REQUIRED/u.test(r.verdict) ? 'PASS' : r.verdict })) }, s),
  };
  const lifted = {};
  for (const [label, decide] of Object.entries(variants)) {
    lifted[label] = Object.entries(DRIFTS).filter(([, apply]) => { const w = doneWorld(); apply(w); return decide(w.gate, w.snapshot).go; }).map(([n]) => n.split(' ')[0]);
  }
  assert.deepEqual(lifted, { 'no head check': ['D1', 'D11'], 'no merge check': ['D3'], 'verdict = contains PASS': ['D5'] });
  assert.equal(verdictAccepts('PASS_STALE_NONE_P2_SOURCE_CANDIDATE / SECURITY_REREVIEW_REQUIRED / PRODUCTION_NO_GO'), false);
  assert.equal(verdictAccepts('ACCEPT_PR426_REAL_SDK_OFFLINE_QA / SECURITY_REVIEW_REQUIRED / PRODUCTION_NO_GO'), false);
  assert.equal(verdictAccepts('PASS'), true);
});

test('G2-RE5 (offline): the file imports only node:test / node:assert / node:fs, and the decision runs with every network door shut', async () => {
  const source = await readFile(new URL(import.meta.url), 'utf8');
  assert.deepEqual([...source.matchAll(/^import .* from '([^']+)';$/gmu)].map((m) => m[1]), ['node:test', 'node:assert/strict', 'node:fs/promises']);
  const saved = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
  let attempts = 0;
  globalThis.fetch = () => { attempts += 1; throw new Error('network forbidden'); };
  globalThis.WebSocket = function WebSocket() { attempts += 1; throw new Error('network forbidden'); };
  try { assert.equal(decideRelease(LEDGER, SNAPSHOT).go, false); } finally { Object.assign(globalThis, saved); }
  assert.equal(attempts, 0);
});
