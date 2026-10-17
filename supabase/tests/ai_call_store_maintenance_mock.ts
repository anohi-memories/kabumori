// NON-PRODUCTION MOCK of the call-store maintenance job (F6, 2026-10-17). Nothing deployable imports this file and
// no Cron runs it. It fixes the order and the decisions a real job (Edge function or scheduled worker, separately
// approved) would make, against the real RPCs:
//   1. ai_ledger_recover_stale        finalise expired holds (released) and long-sent attempts (unknown, upper bound);
//   2. ai_calls_recovery_candidates   old acquired claims + what the ledger knows of them;
//   3. ai_calls_abandon               only claims with no open attempt, with an audit rebuilt from the bridge
//                                     registration (role / model / policyVersion) and the ledger (attempts, cost,
//                                     basis); a claim of an unregistered feature is left alone and reported;
//   4. ai_calls_purge_content         replace outputs older than the retention window by UNKNOWN tombstones.
// Every step is idempotent: a second tick on the same state changes nothing. Nothing is ever resent.

export type Rpc = (name: string, p: unknown) => Promise<unknown>;
/** The bridge registration of one feature (ConsumerFeature.id -> what the bridge checks on replay). */
export type Registration = Readonly<{ role: string; model: string; policyVersion: string }>;
export type Candidate = Readonly<{
  call_key: string;
  tenant_tag: string;
  application: string;
  feature: string;
  subject_kind: string;
  created_at: string;
  open_attempts: number;
  sent_attempts: number;
  estimated_cost_usd: number;
  includes_upper_bound: boolean;
  models: string[];
  logical_roles: string[];
}>;
export type TickResult = {
  recovered: { released: number; marked_unknown: number };
  abandoned: number;
  waiting: number;
  unregistered: number;
  purged: number;
};

const UNIT = 100_000_000;

export async function maintenanceTick(
  rpc: Rpc,
  registry: Readonly<Record<string, Registration>>,
  options: Readonly<{ abandonAfterSeconds?: number; purgeAfterHours?: number; limit?: number }> = {},
): Promise<TickResult> {
  const abandonAfterSeconds = options.abandonAfterSeconds ?? 1800;
  const recovered = await rpc("ai_ledger_recover_stale", {}) as TickResult["recovered"];
  const candidates = await rpc("ai_calls_recovery_candidates", {
    older_than_seconds: abandonAfterSeconds,
    limit: options.limit ?? 100,
  }) as Candidate[];
  const result: TickResult = { recovered, abandoned: 0, waiting: 0, unregistered: 0, purged: 0 };
  for (const candidate of candidates) {
    if (candidate.open_attempts > 0) {
      result.waiting++; // the ledger has not finalised an attempt yet: a later tick (after recover_stale) closes it
      continue;
    }
    const registration = registry[candidate.feature];
    if (!registration) {
      result.unregistered++; // never guess an audit: an operator decides
      continue;
    }
    const audit = {
      callId: candidate.call_key,
      tenantTag: candidate.tenant_tag,
      feature: candidate.feature,
      role: registration.role,
      model: candidate.models.length === 1 ? candidate.models[0] : registration.model,
      policyVersion: registration.policyVersion,
      attempts: candidate.sent_attempts,
      // Never below the ledger's charge (ledger amounts have 8 decimals).
      estimatedCostUsd: Math.ceil(Number(candidate.estimated_cost_usd) * UNIT) / UNIT,
      costBasis: candidate.sent_attempts === 0
        ? "no_request"
        : candidate.includes_upper_bound
        ? "includes_upper_bound"
        : "measured",
    };
    const answer = await rpc("ai_calls_abandon", {
      call_key: candidate.call_key,
      audit,
      older_than_seconds: abandonAfterSeconds,
    }) as { abandoned: boolean };
    if (answer.abandoned) result.abandoned++;
    else result.waiting++;
  }
  const purged = await rpc("ai_calls_purge_content", { older_than_hours: options.purgeAfterHours ?? 24 }) as { purged: number };
  result.purged = purged.purged;
  return result;
}
