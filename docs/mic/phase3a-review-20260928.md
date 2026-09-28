# MIC Phase 3A source review — 2026-09-28

## Verdict

PASS-WITH-FIX for the isolated foundation candidate. Production readiness is
limited to a separately authorized foundation rollout/manual smoke; consumer
activation is NOT approved by this review. No main merge, production migration,
deploy, invoke, Cron, secret change, or real AI request was made.

Candidate: `85c3a8ebc39ad63c19f311b56065dcdbd2151c45`.
Review branch: `codex/mic-phase3a-scenario-review-20260928`.
Fresh main checked during review: `fd1746fd4ca7d75729808a7226f72deeefea2082`.
Pre-push fresh main: `a306dbffdb04b3e3df6455025df67dcb9334395f`.
No Scenario-file or target-migration overlap was found on main.

## Findings / fixes

| Severity | Candidate issue | Resolution |
| --- | --- | --- |
| P2 | Same State run IDs blocked generation even when prompt version changed | Explicit version-change regeneration; unchanged status/quality refresh still does not call AI |
| P2 | Japanese-only wording guard admitted English price targets/advice/probabilities and plain `70%` | NFKC-normalized Japanese/English guards with adversarial/allowed-conditional tests |
| P2 | Parser depended on provider strict schema for extra keys, and accepted an assessed base case with no supporting domain | Post-parse exact-key validation and non-empty supporting domains for assessed output |
| P2 | Unknown coverage/observation strings were treated as strong; out-of-range State AI confidence was accepted | Fail-closed classification with existing enum/range validation |
| P2 | RPC allowed confidence above Edge's recent/missing-domain/indeterminate caps | DB independently derives freshness/usability and the complete cap; false metadata/stale input fails |
| P2 | RPC could save token/cost/web-search metadata inconsistent with its linked usage row | Exact model/run/feature/token/rounded-cost/web-search linkage validation |
| P2 | No Scenario expiry upper bound; aged source narratives could leave apparently usable current content forever | `valid_until` derived from source narrative expiry; consumer read-time revalidation remains mandatory |
| P2 | SQL CHECK three-valued logic could admit null evidence identity | Coalesce shape predicate to false; require completed timestamps for terminal runs and a complete generated current shape |
| P3 | Initial history saved an empty seed as a superseded Scenario | Do not archive a seed; archive every genuinely superseded Scenario |

The reviewed migration is still unapplied to a shared database; it was edited
in place only under this explicit source-only review authorization. Once it is
applied to a shared environment, corrections must use a new migration.

## DB / concurrency assessment

- Four RLS-enabled tables; anon has no privileges. Authenticated SELECT is
  admin-only via existing `private.is_admin()`. Authenticated has no writes.
- History/evidence grants are SELECT/INSERT only for service_role. Mutation and
  TRUNCATE triggers add defense in depth; owner-trigger and service-role-denial
  tests pass. Superuser/owner disabling triggers is outside the app boundary.
- RPC is SECURITY INVOKER, empty search_path, service_role-only EXECUTE.
  service_role retains direct current/run UPDATE and history/evidence INSERT,
  as in MIC State. This is **not RPC-only authorization**: a server secret is
  trusted. Making it RPC-only would require a separately reviewed role/definer
  design and is not silently introduced here.
- One-running partial unique index prevents concurrent claims. Fingerprint
  uniqueness prevents a second evaluated Scenario for the same prompt/State
  set. Domain ordering is deterministic; aging/quality-only changes do not
  themselves trigger a new AI request. Prompt changes do.
- Lock order: Scenario current -> Scenario run -> source States ordered by
  domain. Existing State RPCs never lock Scenario tables, so no opposing lock
  cycle exists. Real contention tests observed zero deadlocks.
- All 11 snapshot fields are reverified under FOR SHARE. Changed narrative,
  source run, factors/risks, quality/confidence or narrative timestamp rejects
  commit. Changes solely to fields not in the AI input (e.g. `updated_at`) do
  not represent a changed input and are intentionally not compared.
- History/current/evidence/evaluated run commit atomically. Injected failure
  after current UPDATE rolls them all back. Independently inserted usage stays
  linked by `related_table`/`related_id` to the failed run and is not reused on
  retry. Luna/Sol each have their own usage row; final usage ID matches the
  stored final model.
- HTTP response loss is covered by run read-back in Edge and `already_applied`
  in RPC, including retry after a successor Scenario has replaced current.
- Terminal runs cannot be updated; stale reconciliation filters running rows.
  A stale PATCH racing an in-flight commit returns no row after the run commits.
  15-minute recovery exceeds the normal two-model timeout budget (2 x 45 sec).
  It cannot guarantee exactly-once provider cost after an arbitrary process
  crash/network ambiguity; no such guarantee is claimed.

## Freshness / future consumer gate

`valid_until = min(source ai_evaluated_at + domain recent limit)`:

- rates / equity_index: 96 hours;
- macro: 840 hours (35 days).

This is an upper bound only. A future consumer MUST:

1. Reject current without a completed source Scenario run or when expired.
2. Read evidence and current source States; verify source-run identity and
   quality. A same-run no_change downgrade must not leave the old Scenario
   displayed as a fresh, strong view.
3. Recompute fresh/recent/stale labels and a confidence ceiling at read time
   (do not trust stored generation-time confidence as current quality).
4. Hide/restrict expired or invalid inputs; do not silently force AI regeneration
   merely because time elapsed. Regeneration policy is a later design gate.

No consumer is connected in Phase 3A. The expiry column alone is NOT consumer
readiness. The two usable domains (rates + equity_index) are sufficient for a
limited Scenario; missing macro is disclosed in the prompt, decision_detail,
and source_state_domains, and subtracts 0.1 from the confidence cap. It is never
filled by inference from absent data.

## AI / output assessment

- Input is State interpretation, not Fact. Scenario is a further interpretation.
  State text is only user JSON; system rules ignore embedded instructions and
  confidence/needs_sol demands, forbid new material, forecasting and advice,
  require conditional language, disclose conflicts and weaken recent/weak data.
- Source run IDs stay in evidence, not AI text. The AI-visible narrative,
  factors/risks, quality, timestamp and confidence come from those same
  snapshots; there is no second State fetch before persistence.
- Output shape/enums, confidence finiteness/range, domain references, lengths,
  list bounds, blank required strings and forbidden wording are checked after
  parsing, not solely delegated to provider strict JSON schema.
- Percentage wording is conservatively rejected throughout qualitative output,
  including source-derived rate percentages. Qualitative conditional wording
  in Japanese/English remains accepted. This avoids ambiguous probability
  claims but is a deliberate false-positive trade-off.
- Prompt/regex defenses do not mathematically prove natural-language semantic
  grounding or immunity to injection. Controlled output review is still needed
  before consumer activation. Real model behavior was not tested in this task.
- Confidence is min(AI confidence, weakest data-quality x freshness factor,
  minus missing-domain penalty), floored to 3 decimals and non-negative;
  indeterminate is capped at 0.3. Edge and DB now enforce the same policy.

## Verification

- Scenario unit/integration: 55 PASS (candidate: 52).
- State evaluator: 198 PASS with type checking.
- Ingest: 243 PASS using `--no-check`; the existing writer mock tests retain
  10 TS2352 errors from synchronous fetch mocks. Those files were not changed.
- `deno check --no-config`: all three runtime entry points PASS.
- `deno lint --no-config`: Scenario files plus DB concurrency harness PASS.
- `git diff --check`: PASS.
- Clean native PostgreSQL 17 disposable cluster, isolated Unix socket/port
  55483, UTF-8 DB `mic_scenario_review`; no full Supabase migration chain.
  Podman was unavailable; no existing VM/container was modified.
- Migration apply + exact reapply PASS; no duplicate seed/index/trigger/policy.
- SQL suite PASS: RLS/ACL/admin/non-admin/anon, invoker permissions, CAS,
  11-field drift, duplicate domains/fingerprint, usage mismatch, complete cap,
  stale/future/invalid input paths, terminal immutability, initial history,
  response-loss-equivalent retry, rollback and append-only boundaries.
- Four multi-session DB tests PASS: one claim winner (23505 loser), one RPC
  commit plus already_applied retry, live State update wait/fail-closed, stale
  reconcile vs commit. No HTTP or real AI used.

Reproduce in a NEW isolated DB named `mic_scenario_review`:

1. Apply `supabase/tests/fixtures/mic_scenario_phase3a_dependencies.sql`.
2. Apply the Phase3A migration twice.
3. Run `supabase/tests/mic_scenario_phase3a_review.sql`.
4. Set `MIC_SCENARIO_REVIEW_SOCKET` to the dedicated socket directory and run
   `supabase/tests/mic_scenario_phase3a_concurrency_test.ts` with Deno
   `--no-config --allow-run=psql --allow-env=MIC_SCENARIO_REVIEW_SOCKET`.

## Remaining concerns / recommendation

No unresolved blocker for the isolated foundation. Before a separately
authorized production rollout: review this fixed branch's migration bytes and
runtime diff against fresh main; keep consumers/Cron/source settings untouched.
Before consumers: implement and test the read-time freshness/validity gate
above and review controlled real-model outputs. Transport failures/crash before
usage INSERT can leave unobservable provider cost, as in existing State; this
task validates linkage/retention once usage has been recorded, not a durable
exactly-once billing receipt. Recommendation: Sol（高）for the migration/release
boundary. Production changes=0, real AI calls=0.
