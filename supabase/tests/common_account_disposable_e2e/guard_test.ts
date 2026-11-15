// Deny-by-default guard (Phase 3c offline readiness). Fake refs only; nothing here reaches a project.
import assert from 'node:assert/strict';
import test from 'node:test';

import { EXPERIMENTS, EXPERIMENT_IDS, type ExperimentId } from './catalog.ts';
import { destructiveConsent, PRODUCTION_PROJECT_REFS, typedConfirmation, validateRunRequest, type GuardInput } from './guard.ts';

const here = new URL('./', import.meta.url);
const load = async (name: string) => JSON.parse(await Deno.readTextFile(new URL(`fixtures/${name}`, here)));
const REQUEST = await load('run_request.sample.json');
const MARKER = await load('project_marker.sample.json');
const LEDGER = await load('used_projects.sample.json');
const REPO = '/Users/fixture/kabumori';
const NOW = new Date('2026-10-11T10:00:00+09:00');
const REF = REQUEST.project_ref as string;
const RUN = REQUEST.run_id as string;

// Fixture JSON is edited freely below; the guard itself receives `unknown`.
// deno-lint-ignore no-explicit-any
type Loose = Record<string, any>;
type Mutate = (x: { request: Loose; marker: Loose; ledger: Loose; input: GuardInput }) => void;
function check(mutate?: Mutate) {
  const input: GuardInput = {
    request: structuredClone(REQUEST), marker: structuredClone(MARKER), markerPath: REQUEST.project_marker_path,
    ledger: structuredClone(LEDGER), repoRoot: REPO, now: NOW,
  };
  mutate?.({ request: input.request as Loose, marker: input.marker as Loose, ledger: input.ledger as Loose, input });
  return validateRunRequest(input);
}
const denies = (reason: string, mutate: Mutate, label = reason) => {
  const result = check(mutate);
  assert.equal(result.allowed, false, `${label}: must be denied`);
  assert.ok(result.reasons.includes(reason), `${label}: expected ${reason}, got ${result.reasons.join(', ')}`);
  assert.equal(result.execution, 'NOT_AVAILABLE_IN_THIS_STAGE');
};

test('the sample request is valid -- and still only unlocks a dry run', () => {
  const result = check();
  assert.deepEqual(result.reasons, []);
  assert.equal(result.allowed, true);
  assert.deepEqual(result.scenarios, ['E1', 'E2']);
  assert.equal(result.execution, 'NOT_AVAILABLE_IN_THIS_STAGE');
});

test('default deny: no request, an empty one, or a non-object', () => {
  for (const request of [undefined, null]) {
    const result = validateRunRequest({ request, marker: MARKER, markerPath: REQUEST.project_marker_path, ledger: LEDGER, repoRoot: REPO, now: NOW });
    assert.deepEqual([result.allowed, result.reasons], [false, ['REQUEST_MISSING']]);
  }
  assert.deepEqual(validateRunRequest({ request: [], marker: MARKER, markerPath: null, ledger: LEDGER, repoRoot: REPO, now: NOW }).reasons, ['REQUEST_NOT_OBJECT']);
  const empty = validateRunRequest({ request: {}, marker: undefined, markerPath: null, ledger: undefined, repoRoot: REPO, now: NOW });
  assert.equal(empty.allowed, false);
  for (const reason of ['REQUEST_SCHEMA', 'PROJECT_REF_MISSING', 'RUN_ID_INVALID', 'LEDGER_MISSING', 'MARKER_PATH_MISSING', 'MARKER_MISSING', 'CONFIRMATION_MISMATCH', 'APPROVAL_MISSING', 'SCENARIOS_EMPTY']) {
    assert.ok(empty.reasons.includes(reason), `empty request: ${reason}`);
  }
});

test('the project ref: explicit, well-formed, never production, never reused', () => {
  denies('PROJECT_REF_MISSING', ({ request }) => { delete request.project_ref; });
  for (const bad of ['FAKEDISPOSABLEAAAAAA', 'fakedisposableaaaaa', 'fakedisposableaaaaaa1', 'fake-disposableaaaaa', 'fakedisposable123456', '']) {
    denies(bad ? 'PROJECT_REF_FORMAT' : 'PROJECT_REF_MISSING', ({ request }) => { request.project_ref = bad; }, `ref ${JSON.stringify(bad)}`);
  }
  for (const production of PRODUCTION_PROJECT_REFS) {
    denies('PROJECT_REF_PRODUCTION', ({ request, marker }) => {
      request.project_ref = production;
      marker.project_ref = production;
      request.user_approval.approved_project_ref = production;
      request.typed_confirmation = typedConfirmation(production, RUN);
      request.destructive_consents.E2 = destructiveConsent('E2', production, RUN);
    }, 'the production project, even fully consistent');
  }
  denies('PROJECT_REF_REUSED', ({ request, marker }) => {
    const used = LEDGER.used_project_refs[0];
    request.project_ref = used; marker.project_ref = used; request.user_approval.approved_project_ref = used;
    request.typed_confirmation = typedConfirmation(used, RUN);
    request.destructive_consents.E2 = destructiveConsent('E2', used, RUN);
  }, 'a ref in the used-project ledger, even fully consistent');
  denies('LEDGER_MISSING', ({ input }) => { input.ledger = undefined; });
  denies('LEDGER_SCHEMA', ({ ledger }) => { ledger.schema = 'other'; });
  denies('LEDGER_SCHEMA', ({ ledger }) => { ledger.used_project_refs = 'none'; }, 'ledger list not an array');
});

test('ambiguity is refused: every place that names the project must name the same one', () => {
  denies('MARKER_REF_MISMATCH', ({ marker }) => { marker.project_ref = 'otherdisposableaaaaa'; });
  denies('APPROVAL_REF_MISMATCH', ({ request }) => { request.user_approval.approved_project_ref = 'otherdisposableaaaaa'; });
  denies('CONFIRMATION_MISMATCH', ({ request }) => { request.typed_confirmation = typedConfirmation('otherdisposableaaaaa', RUN); });
  denies('CONFIRMATION_MISMATCH', ({ request }) => { request.typed_confirmation = request.typed_confirmation.toLowerCase(); }, 'confirmation case-folded');
  denies('CONFIRMATION_MISMATCH', ({ request }) => { request.typed_confirmation = 'yes'; }, 'a bare yes');
  denies('MARKER_PATH_MISMATCH', ({ input }) => { input.markerPath = '/private/tmp/elsewhere/project-marker.json'; }, 'a symlinked marker');
  denies('MARKER_TASK_MISMATCH', ({ marker }) => { marker.created_for_task = 'another-task'; });
});

test('the marker is a standalone file outside the repository and not the Supabase CLI link', () => {
  const at = (path: string): Mutate => ({ request, input }) => { request.project_marker_path = path; input.markerPath = path; };
  denies('MARKER_PATH_INSIDE_REPOSITORY', at(`${REPO}/project-marker.json`));
  denies('MARKER_PATH_INSIDE_REPOSITORY', at(`${REPO}/supabase/tests/common_account_disposable_e2e/fixtures/project_marker.sample.json`), 'the sample fixture itself');
  denies('MARKER_PATH_IS_CLI_LINK', at('/private/tmp/somewhere/supabase/.temp/project-ref'));
  denies('MARKER_PATH_IS_CLI_LINK', at('/private/tmp/somewhere/project-ref'), 'a file named like the CLI link');
  denies('MARKER_PATH_NOT_ABSOLUTE', at('project-marker.json'));
  denies('MARKER_PATH_NOT_NORMALIZED', at('/private/tmp/x/../project-marker.json'));
  denies('MARKER_PATH_MISSING', ({ request }) => { delete request.project_marker_path; });
  denies('MARKER_MISSING', ({ input }) => { input.marker = undefined; });
  denies('MARKER_SCHEMA', ({ marker }) => { marker.schema = 'x'; });
});

test('the marker must say disposable, fake-only, not a clone, named for the proof, and unexpired', () => {
  denies('MARKER_NOT_DISPOSABLE', ({ marker }) => { marker.environment = 'production'; });
  denies('MARKER_NOT_DISPOSABLE', ({ marker }) => { marker.contains_production_data = true; });
  denies('MARKER_NOT_DISPOSABLE', ({ marker }) => { delete marker.production_clone; }, 'clone flag missing');
  denies('MARKER_NOT_DISPOSABLE', ({ marker }) => { marker.contains_production_data = 'false'; }, 'a string false');
  for (const name of ['kabumori-prod', 'kabumori', 'kabumori-disposable-proof-prod', 'kabumori-disposable-proof-staging-1', 'kabumori-disposable-proof-main', 'kabumori-disposable-proof-live-copy', '']) {
    denies('MARKER_NAME_NOT_DISPOSABLE', ({ marker }) => { marker.project_name = name; }, `name ${JSON.stringify(name)}`);
  }
  denies('MARKER_EXPIRED', ({ marker }) => { marker.expires_at = '2026-10-11T09:59:59+09:00'; });
  denies('MARKER_EXPIRY_INVALID', ({ marker }) => { marker.expires_at = 'next week'; });
});

test('override-shaped fields and unknown fields are refused, never honoured', () => {
  for (const key of ['force', 'skip_guard', 'override', 'bypass_ledger', 'assume_disposable', 'yes']) {
    denies(`OVERRIDE_NOT_SUPPORTED:request.${key}`, ({ request }) => { request[key] = true; }, `request.${key}`);
  }
  denies('OVERRIDE_NOT_SUPPORTED:marker.force', ({ marker }) => { marker.force = true; });
  denies('OVERRIDE_NOT_SUPPORTED:extra_approvals.force_all', ({ request }) => { request.extra_approvals.force_all = { approval_reference: 'x' }; });
  denies('UNKNOWN_FIELD:request.note', ({ request }) => { request.note = 'hello'; });
  denies('UNKNOWN_FIELD:user_approval.scope', ({ request }) => { request.user_approval.scope = 'all'; });
});

test('scenarios: known, unique, non-empty', () => {
  denies('SCENARIOS_EMPTY', ({ request }) => { request.scenarios = []; });
  denies('SCENARIO_UNKNOWN:E13', ({ request }) => { request.scenarios.push('E13'); });
  denies('SCENARIO_UNKNOWN:all', ({ request }) => { request.scenarios = ['all']; });
  denies('SCENARIO_DUPLICATE:E2', ({ request }) => { request.scenarios.push('E2'); });
});

test('every destructive experiment needs its own exact consent for this project and run', () => {
  const destructive = EXPERIMENTS.filter((e) => e.kind === 'destructive').map((e) => e.id);
  assert.deepEqual(destructive, EXPERIMENT_IDS.filter((id) => id !== 'E1'));
  for (const id of destructive) {
    denies(`CONSENT_MISSING:${id}`, ({ request }) => { request.scenarios = [id]; request.destructive_consents = {}; }, `${id} without consent`);
    denies(`CONSENT_MISMATCH:${id}`, ({ request }) => {
      request.scenarios = [id];
      request.destructive_consents = { [id]: destructiveConsent(id, REF, 'p3c-run-20261011-02') };
    }, `${id} consent for another run`);
    denies(`CONSENT_MISMATCH:${id}`, ({ request }) => {
      request.scenarios = [id];
      request.destructive_consents = { [id]: destructiveConsent(id === 'E2' ? 'E3' : 'E2', REF, RUN) };
    }, `${id} consent of another scenario`);
  }
  denies('CONSENT_FOR_UNREQUESTED:E8', ({ request }) => { request.destructive_consents.E8 = destructiveConsent('E8', REF, RUN); });
  denies('CONSENT_NOT_APPLICABLE:E1', ({ request }) => { request.destructive_consents.E1 = destructiveConsent('E1', REF, RUN); });
  denies('CONSENT_UNKNOWN_SCENARIO:E99', ({ request }) => { request.destructive_consents.E99 = 'x'; });
});

test('E11 (Option D) needs a user approval AND an independent security review; E7 needs a config-change approval', () => {
  const only = (id: ExperimentId): Mutate => ({ request }) => {
    request.scenarios = [id];
    request.destructive_consents = { [id]: destructiveConsent(id, REF, RUN) };
  };
  denies('EXTRA_APPROVAL_MISSING:E11:option_d_security_approval', only('E11'));
  denies('EXTRA_APPROVAL_MISSING:E11:option_d_security_approval', (x) => {
    only('E11')(x);
    x.request.extra_approvals = { option_d_security_approval: { user_approval_reference: 'FAKE-USER-OK' } };
  }, 'E11 with the user approval only');
  denies('EXTRA_APPROVAL_MISSING:E7:project_auth_config_change', only('E7'));
  const e11 = check((x) => {
    only('E11')(x);
    x.request.extra_approvals = { option_d_security_approval: { user_approval_reference: 'FAKE-USER-OK', independent_security_review_reference: 'FAKE-REVIEW-OK' } };
  });
  assert.deepEqual([e11.allowed, e11.reasons], [true, []]);
});

test('all twelve with every consent and approval: valid, still dry run only', () => {
  const result = check(({ request }) => {
    request.scenarios = [...EXPERIMENT_IDS];
    request.destructive_consents = Object.fromEntries(EXPERIMENT_IDS.filter((id) => id !== 'E1').map((id) => [id, destructiveConsent(id, REF, RUN)]));
    request.extra_approvals = {
      option_d_security_approval: { user_approval_reference: 'FAKE-USER-OK', independent_security_review_reference: 'FAKE-REVIEW-OK' },
      project_auth_config_change: { approval_reference: 'FAKE-CONFIG-OK' },
    };
  });
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.scenarios, [...EXPERIMENT_IDS]);
  assert.equal(result.execution, 'NOT_AVAILABLE_IN_THIS_STAGE');
});
