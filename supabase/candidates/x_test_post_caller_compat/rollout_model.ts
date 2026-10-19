// x-test-post caller-gate rollout model (G3 Issue #318 TASK 5/50, 2026-10-20). SOURCE / TEST ONLY -- imported by no
// Function. It states, as data the tests check against the REAL handlers (before = main, after = PR #349), which
// caller profile the every-minute Cron (dispatch-scheduled-posts, user agent pg_net) may be using and whether the
// scheduled dispatch still runs, and it decides whether a rollout plan can ever stop the dispatch.
//
// What the repository proves about the Cron (docs/kabumori-resume/evidence/2026-10-17-final-audit/observations.json):
//   jobid 1, active, '* * * * *', edge_function x-test-post, command_fingerprint 88b3310282eedc9f49d56878992b1094; in the
//   24 h window every x-test-post invocation came from user agent pg_net/0.20.4 (200 x1221, 201 x11, 500 x2) -- no other
//   caller was observed. The command's HEADERS were never read by any audit: the profile is UNKNOWN.

export type CronProfile =
  | "service_role_bearer"      // Authorization: Bearer <the same legacy service-role JWT the Function's env holds>
  | "x_cron_secret"            // X-Cron-Secret: <X_TEST_POST_CRON_SECRET> (PR #349's recommended shape)
  | "anon_bearer"              // Authorization: Bearer <anon key> (+ apikey)
  | "new_secret_key_bearer"    // Authorization: Bearer sb_secret_... (new API key; the Function env holds the legacy JWT)
  | "apikey_only"              // apikey: <service-role key>, no Authorization
  | "no_auth"                  // Content-Type only (as the important-news cron in this repository)
  | "unknown";                 // what the repository can prove today

export type FunctionEnv = { cronSecretSet: boolean; serviceRoleKeySet: boolean };
export type Deployed = "main" | "pr349";

/** Does the scheduled dispatch pass the caller gate? (main has no gate: always.) */
export function dispatchRuns(deployed: Deployed, profile: CronProfile, env: FunctionEnv): boolean | "unknown" {
  if (deployed === "main") return true;
  switch (profile) {
    case "service_role_bearer":
      return env.serviceRoleKeySet;
    case "x_cron_secret":
      return env.cronSecretSet;
    case "unknown":
      return "unknown";
    default:
      return false;
  }
}

export type RolloutStep =
  | { step: "read_only_preflight"; observedProfile: Exclude<CronProfile, "unknown"> }
  | { step: "set_function_secret" }
  | { step: "switch_cron_to_x_cron_secret" }
  | { step: "deploy_pr349" }
  | { step: "rollback_to_main" };

export type RolloutVerdict = { go: boolean; stopsDispatchAt: number | null; reasons: string[] };

/**
 * Walk the plan from today's state (main deployed, profile UNKNOWN, no cron secret). GO only when the profile was
 * observed read-only first, PR #349 is deployed at most once, and after EVERY step the dispatch provably still runs.
 */
export function evaluateRollout(plan: readonly RolloutStep[], start: { profile: CronProfile; env: FunctionEnv } = { profile: "unknown", env: { cronSecretSet: false, serviceRoleKeySet: true } }): RolloutVerdict {
  let profile = start.profile;
  let env = { ...start.env };
  let deployed: Deployed = "main";
  const reasons: string[] = [];
  for (const [i, s] of plan.entries()) {
    if (s.step === "read_only_preflight") profile = s.observedProfile;
    else if (s.step === "set_function_secret") env = { ...env, cronSecretSet: true };
    else if (s.step === "switch_cron_to_x_cron_secret") {
      if (!env.cronSecretSet) reasons.push(`step ${i + 1}: the Cron would send a header the Function cannot check yet`);
      profile = "x_cron_secret";
    } else if (s.step === "deploy_pr349") deployed = "pr349";
    else if (s.step === "rollback_to_main") deployed = "main";
    const runs = dispatchRuns(deployed, profile, env);
    if (runs !== true) {
      reasons.push(runs === "unknown" ? `step ${i + 1}: deployed with the Cron header UNKNOWN (read-only preflight first)` : `step ${i + 1}: the every-minute dispatch is refused (401)`);
      return { go: false, stopsDispatchAt: i + 1, reasons };
    }
  }
  if (deployed !== "pr349") reasons.push("PR #349 is never deployed by this plan");
  return { go: reasons.length === 0, stopsDispatchAt: null, reasons };
}
