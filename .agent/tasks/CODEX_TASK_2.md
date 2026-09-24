# Codex Task 2

- task_id: x-autopost-phase1d-db-rpc-concurrency-final-review-20260924
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: Sol（高）
- purpose: K3 PASS済みのPhase1D claim-domain partition candidateを、DB/RPC/permission/concurrency観点で最終レビューする。production applyは行わない。

## Review target

Primary implementation commit:
- `238247a57287c3bb835b6e2a0ca8ee4a2d910fdf`

Primary changed files:
- `supabase/migrations/20260924160000_x_autopost_phase1d_claim_domain_partition.sql`
- `supabase/functions/x-test-post/claim_domain_partition_migration_test.ts`
- `supabase/tests/x_autopost_phase1d_fixture.sql`
- `supabase/tests/x_autopost_phase1d_behavior.sql`
- `supabase/tests/x_autopost_phase1d_run.sh`
- `supabase/tests/x_autopost_phase1d_claim_domain_partition.md`

G3/K3 evidence:
- disposable PostgreSQL PASS
- concurrent legacy/v2 claim proof PASS
- focused static tests 13/13 PASS
- x-test-post regression 416/416 PASS
- production mutation 0
- runtime dispatcher unchanged by design

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read G3 TASK including Report and Final K3
5. Fresh fetch origin/main
6. Confirm independent H2 worktree/checkout
7. Inspect G2/G4/H1/G1 ownership and prove no overlap
8. Review exact implementation commit and current main for semantic drift
9. Do not infer production state from source; live-definition uncertainty must remain explicit

## Review scope A — migration safety

Review:
- additive/versioned behavior claim
- dependency on Phase1B
- rename-to-core mechanics for all 9 Phase1B v2 functions
- recreation of public wrapper signatures/defaults/return types
- grants/revokes after rename
- behavior on partially-applied / failed migration
- idempotency expectations and migration re-run behavior
- interaction with existing Supabase default EXECUTE grants
- SECURITY DEFINER + `search_path = ''` correctness
- function ownership / callable-core exposure risks

Flag any case where applying this migration could strand or break existing runtime even before activation.

## Review scope B — claim-domain guard

Verify the trigger and helper guarantee:
- unbound rows remain legacy-only
- bound rows remain v2-only
- no bind/rebind/unbind of existing rows
- no bound lifecycle mutation outside v2 path
- no v2 mutation of unbound rows
- accidental re-grant of old `claim_due_post()` fails closed
- historical terminal rows are not unexpectedly blocked by unrelated updates
- direct SQL writes cannot bypass intended invariants through unchanged columns/status combinations

Review whether the selected guarded columns are complete enough for all relevant lifecycle mutations.

## Review scope C — wrapper/session-state correctness

Audit every v2 wrapper:
- sets `kabumori.x_queue_domain='v2'` transaction-locally
- restores prior value correctly
- restoration behavior on exception
- PL/pgSQL `RETURN QUERY` control flow correctness
- no path can leak v2 domain state to subsequent calls in the same transaction
- nested v2 calls behave safely
- no caller can spoof the custom GUC to bypass the trigger without also having inappropriate DB privileges

If exception restoration is not guaranteed but transaction-local rollback makes it safe, document why.

## Review scope D — ACL / auth boundary

Verify:
- *_core functions are not callable by anon/authenticated/service_role
- public wrapper functions have only the intended callable roles
- trigger/helper functions are not unintentionally executable
- `has_function_privilege` gate correctly models the API-role threat
- role membership / owner privileges do not create a bypass that matters in Supabase runtime
- no service_role exposure of unintended primitives

## Review scope E — concurrency and correctness

Re-run/inspect:
- legacy unbound vs v2 bound separation
- two lanes cannot double-claim the same row
- two accounts remain eventually independently claimable
- Phase1B turn-row locking observation does not violate correctness
- stale/retry/reconcile paths preserve domain
- uncertain / confirmed-X-db-incomplete remain non-reclaimable
- race tests actually contend and are not false positives

## Review scope F — activation seam

Validate G3's required ordering:
1. live-definition diff first
2. apply Phase1B + Phase1D source migrations
3. deploy one-line legacy dispatcher switch to `claim_due_post_legacy_unbound_v2`
4. drain/verify
5. revoke old `claim_due_post()` EXECUTE
6. keep bound producers/v2 dispatcher disabled until remaining Phase1C prerequisites pass

Check for any unsafe interval or rollback gap.

## Required tests

At minimum:
- focused Phase1D tests
- relevant Phase1B tests
- full x-test-post regression if feasible
- disposable PostgreSQL behavior/concurrency proof if local environment permits
- git diff --check / shell syntax/static checks as applicable

If a test cannot run, state exactly why; do not replace evidence with assumption.

## Bugfix authority

If a concrete correctness/security bug is found:
- make only the minimal source-only fix within the Phase1D migration/tests/docs
- do not apply anything to production
- do not edit runtime dispatcher unless strictly necessary to fix a source-only correctness defect and explicitly explain why
- rerun affected tests
- report exact changed files and commit/push status

## Forbidden

- production migration/DDL/DML/backfill
- live RPC replacement
- `supabase db push`
- migration-history repair
- Edge Function deploy
- Cron/OAuth/Vault/token mutation
- X API calls
- production row injection
- apps/admin/**
- consumer mobile/**
- PR #15 work
- unrelated G2/G4 work

## Production mutation budget

0.

## Completion / C2

Report in `.agent/CODEX_REPORT_2.md`:
- verdict PASS / PASS-WITH-FIX / FAIL
- fresh main SHA
- reviewed commit SHA
- findings by severity
- exact changed files if any
- migration/RPC/trigger/ACL assessment
- concurrency assessment
- activation-order assessment
- exact tests and counts
- whether Phase1D is safe to keep as a source candidate
- whether it is safe for production activation now (expected answer should remain NO unless all prerequisites and live-definition checks are separately satisfied)
- remaining blockers
- production mutation=0
- next recommendation

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for C2.
