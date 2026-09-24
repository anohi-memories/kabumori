# Codex Task 2

- task_id: kabumori-pr19-report-detail-portfolio-privacy-final-review-20260924
- owner: codex
- slot: codex-2
- status: ready
- next_owner: codex
- priority: high
- recommended_model: Luna（極高）
- purpose: K2 PASS済みのPR #19（朝刊/大引け詳細化＋保有株影響分析）を、LLM validation・本人データ境界・朝刊参照・既存互換性の観点で最終レビューする。production deploy/mergeは行わない。

## Previous C2 closure

Previous H2 task:
- `x-autopost-phase1d-db-rpc-concurrency-final-review-20260924`
- C2 verdict: **PASS-WITH-FIX as source-only candidate**
- H2 fixed two P1 issues in commit `4468a060d368d6d94c205eba1a86ff58195740e4`
- Phase1D remains **NOT authorized for production activation**
- remaining gates: live-definition diff, atomic migration proof, Phase1C prerequisites, staged rollback plan
- production mutation remained 0
- detailed evidence remains in `.agent/CODEX_REPORT_2.md`

## Review target

PR #19:
- branch: `g2-app-report-detail-portfolio-impact-20260924`
- reviewed implementation head from K2: `acbc1b6ceac04d978b7fe6fb8e3d266734d3826a`
- state: open / unmerged

Primary changed files:
- `supabase/functions/personalized-reports/market_detail.ts`
- `supabase/functions/personalized-reports/report_upgrade_test.ts`
- `tests/app/report-impact_test.ts`
- `supabase/functions/personalized-reports/report_logic.ts`
- `supabase/functions/personalized-reports/index.ts`
- `supabase/functions/personalized-reports/report_logic_test.ts`
- `supabase/functions/personalized-reports/shared_market_consumer_test.ts`
- `src/lib/report-presentation.ts`
- `src/app/reports/[id].tsx`

K2 evidence:
- 151 tests passed / 0 failed
- deno check/lint PASS
- no new src TypeScript errors
- Expo web export PASS / 10 routes
- git diff --check PASS
- secret scan 0
- production mutation 0

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read G2 TASK including Report and Final K2
5. Fresh fetch origin/main and PR #19 head
6. Confirm independent H2 worktree/checkout
7. Inspect H1/G1/G3/G4 scopes and prove no overlap
8. Compare PR #19 against fresh main for semantic drift
9. Do not merge/deploy

## Review scope A — user/portfolio privacy boundary

Verify:
- only authenticated user's holdings are used
- morning report lookup is hard-bound to same user
- returned morning row is rechecked for same user
- no cross-user portfolio leakage path
- no user/account IDs leak into LLM output unnecessarily
- service-role is not exposed to mobile
- existing RLS assumptions are not weakened or bypassed

Test adversarial cases where another user's morning report/holding could be present in mocked data.

## Review scope B — LLM prompt/schema/validation

Audit:
- `holdingImpactIssues`
- stance/basis validation
- English-token allowlist relaxation
- Fact vs inference separation
- hedging requirements
- unknown/missing holdings rejection
- duplicate holding rejection
- no unsupported individual-stock causal claim
- no invented material when `no_clear_material`
- existing numeric/source/date/URL/trading-advice safeguards remain effective

Try to construct prompt/output cases that pass local validation incorrectly.

## Review scope C — morning-to-close comparison

Verify:
- morning lookup cannot cross users/dates
- comparison fallback when morning report absent is safe
- 1306-relative thresholds are deterministic and correctly applied
- no schema migration is required
- saved JSON remains backward compatible enough for existing app reader
- old reports without new fields still render safely

## Review scope D — shared market/X invariants

Confirm:
- shared market fact packet remains the authority
- X-specific queue/planner/posting behavior is unchanged
- `formatSharedXPost` behavior is unchanged
- app enrichment cannot mutate shared facts or feed back into X output
- missing data is surfaced as missing rather than fabricated

## Review scope E — UI/backward compatibility

Review:
- old `personalized_reports` bodies still render
- existing `stock_notes` behavior remains intact
- no crash on no holdings / missing market section / partial older JSON
- section ordering is stable
- large output does not create obvious rendering/parser failure paths

## Required tests

At minimum:
- focused personalized-reports tests
- app report-impact/presentation tests
- adversarial cross-user tests
- LLM validation negative tests
- deno check/lint for changed function files
- relevant TypeScript/static checks
- Expo web export if feasible
- git diff --check

If a concrete bug is found, minimal fix is allowed only within PR #19 scope, with rerun of affected tests.

## Forbidden

- merge PR #19
- Edge Function production deploy
- `app_enabled=true`
- production DML/DDL/migration
- Auth/RLS weakening
- service-role exposure
- X queue/planner/posting changes
- G1 release-Web work
- G3 Phase1D files
- G4 admin/Netlify files
- Vercel/Netlify production mutation

## Production mutation budget

0.

## Completion / C2

Update `.agent/CODEX_REPORT_2.md` with:
- verdict PASS / PASS-WITH-FIX / FAIL
- fresh main and PR head
- findings by severity
- exact changed files if any
- privacy/user-boundary assessment
- LLM validation assessment
- backward-compatibility assessment
- X/shared-fact invariants
- exact tests/counts
- whether PR #19 is safe to merge
- remaining deploy/gate requirements
- production mutation=0
- next recommendation

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for C2.
