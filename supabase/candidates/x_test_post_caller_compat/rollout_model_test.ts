// Rollout-order tests for the x-test-post caller gate (G3 Issue #318 TASK 5/50). Pure, no network.
import assert from "node:assert/strict";
import { type CronProfile, dispatchRuns, evaluateRollout, type RolloutStep } from "./rollout_model.ts";

const ENV = { cronSecretSet: false, serviceRoleKeySet: true };

Deno.test("today: the Cron profile is UNKNOWN, so deploying PR #349 is NO_GO whatever else the plan does", () => {
  for (const plan of [[{ step: "deploy_pr349" }], [{ step: "set_function_secret" }, { step: "deploy_pr349" }]] as RolloutStep[][]) {
    const v = evaluateRollout(plan);
    assert.equal(v.go, false);
    assert.match(v.reasons.join(" "), /UNKNOWN/u);
  }
});

Deno.test("every Cron profile: which plans keep the every-minute dispatch running at EVERY step", () => {
  const safe: RolloutStep[] = [{ step: "set_function_secret" }, { step: "switch_cron_to_x_cron_secret" }, { step: "deploy_pr349" }];
  const deployFirst: RolloutStep[] = [{ step: "deploy_pr349" }, { step: "set_function_secret" }, { step: "switch_cron_to_x_cron_secret" }];
  const cronFirst: RolloutStep[] = [{ step: "switch_cron_to_x_cron_secret" }, { step: "set_function_secret" }, { step: "deploy_pr349" }];
  const profiles: Exclude<CronProfile, "unknown">[] = ["service_role_bearer", "x_cron_secret", "anon_bearer", "new_secret_key_bearer", "apikey_only", "no_auth"];
  for (const p of profiles) {
    const pre: RolloutStep = { step: "read_only_preflight", observedProfile: p };
    assert.equal(evaluateRollout([pre, ...safe]).go, true, `${p}: preflight -> secret -> Cron header -> deploy`);
    const df = evaluateRollout([pre, ...deployFirst]);
    const expectedBreak = p !== "service_role_bearer"; // only a service-role Bearer Cron survives a deploy before its header changes
    assert.equal(df.go, !expectedBreak, `${p}: deploy first`);
    if (expectedBreak) assert.equal(df.stopsDispatchAt, 2, `${p}: the dispatch stops right at the deploy`);
    assert.equal(evaluateRollout([pre, ...cronFirst]).go, false, `${p}: the Cron header before the Function secret is refused by the plan check`);
  }
  // A service-role Bearer Cron needs no change at all: preflight + deploy is enough.
  assert.equal(evaluateRollout([{ step: "read_only_preflight", observedProfile: "service_role_bearer" }, { step: "deploy_pr349" }]).go, true);
});

Deno.test("rollback restores the dispatch; a plan that never deploys is not a rollout", () => {
  const v = evaluateRollout([{ step: "read_only_preflight", observedProfile: "anon_bearer" }, { step: "deploy_pr349" }, { step: "rollback_to_main" }]);
  assert.deepEqual([v.go, v.stopsDispatchAt], [false, 2]);
  assert.equal(dispatchRuns("main", "anon_bearer", ENV), true);
  assert.equal(evaluateRollout([{ step: "read_only_preflight", observedProfile: "x_cron_secret" }, { step: "set_function_secret" }]).go, false);
});

Deno.test("dispatchRuns: main never gates; PR #349 passes only a matching, configured internal credential", () => {
  for (const p of ["service_role_bearer", "x_cron_secret", "anon_bearer", "new_secret_key_bearer", "apikey_only", "no_auth"] as const) assert.equal(dispatchRuns("main", p, ENV), true);
  assert.equal(dispatchRuns("pr349", "service_role_bearer", { cronSecretSet: false, serviceRoleKeySet: true }), true);
  assert.equal(dispatchRuns("pr349", "service_role_bearer", { cronSecretSet: true, serviceRoleKeySet: false }), false);
  assert.equal(dispatchRuns("pr349", "x_cron_secret", { cronSecretSet: false, serviceRoleKeySet: true }), false);
  assert.equal(dispatchRuns("pr349", "x_cron_secret", { cronSecretSet: true, serviceRoleKeySet: true }), true);
  for (const p of ["anon_bearer", "new_secret_key_bearer", "apikey_only", "no_auth"] as const) assert.equal(dispatchRuns("pr349", p, { cronSecretSet: true, serviceRoleKeySet: true }), false, p);
  assert.equal(dispatchRuns("pr349", "unknown", ENV), "unknown");
});
