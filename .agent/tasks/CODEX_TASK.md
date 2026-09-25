# Codex Task

- task_id: x-autopost-phase1g-multistep-tip-greeting-final-review-20260925
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: critical
- recommended_model: Sol（高）
- purpose: K3 PASS済みPhase1Gのtip thread / morning_greeting multi-step provider-step ledger、atomic completion、publish_claim lifecycle、ACL/migration安全性を独立レビューする。production apply/deploy/X API callは行わない。

## Target

Implementation commit:
- `e0f7785`

Primary files:
- `supabase/migrations/20260925090000_x_autopost_phase1g_multistep_completion.sql`
- `supabase/functions/_shared/x_v2_multistep.ts`
- `supabase/functions/_shared/x_v2_multistep_test.ts`
- `supabase/functions/_shared/x_v2_outcome_ledger.ts`
- `supabase/functions/_shared/x_v2_outcome_ledger_test.ts`
- `supabase/functions/x-test-post/multistep_completion_migration_test.ts`
- `supabase/tests/x_autopost_phase1g_fixture.sql`
- `supabase/tests/x_autopost_phase1g_behavior.sql`
- `supabase/tests/x_autopost_phase1g_run.sh`
- `supabase/tests/x_autopost_phase1g_multistep_completion.md`

K3 evidence:
- tip + morning_greeting source-ready candidate
- focused 72/72 PASS
- x-test-post 437/437 PASS
- _shared 129/129 PASS
- important-news-monitor 431/431 PASS
- greeting/tip-specific 138/138 PASS
- disposable PostgreSQL Phase1G behavior/race PASS ×4
- production mutation/X API/media calls = 0

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read G3 Phase1G TASK/Report
5. Read Phase1F migration/docs and H1 C1 findings
6. Fresh fetch origin/main
7. Confirm independent H1 worktree/checkout
8. Inspect H2/G1/G2/G3/G4 scopes and prove no overlap
9. Review implementation commit/current main for semantic drift
10. Do not deploy/apply anything

## Review A — tip thread plan/step integrity

Verify:
- immutable expected part count and plan kind
- 1..N exact step cardinality
- step1 create_post only
- stepN>1 create_reply only
- reply parent exactly previous confirmed X id
- no extra step beyond plan
- no missing middle step accepted
- no confirmed step replay
- rejected/uncertain step blocks later steps
- confirmed prior parts cannot be duplicated by retry
- attempt with confirmed provider object cannot later be recorded x_rejected

Try adversarial step ordering, parent spoofing, plan mismatch, and duplicate start/finish.

## Review B — tip atomic completion fidelity

Compare with legacy tip completion semantics.

Verify one transaction:
- validates claim/attempt/account/brand/type/running state
- verifies all planned steps confirmed
- preserves all part X ids durably/auditably
- marks scheduled post succeeded
- marks attempt completed
- performs exact tip/topic usage side effects once
- writes one success execution log
- duplicate completion is idempotent
- concurrent completion produces one side-effect set
- forced downstream error rolls back all completion effects

Assess confirmed-incomplete recovery with same root id.

## Review C — morning_greeting claim/media/create integrity

Verify:
- publish_claim belongs to exact brand/day/post/attempt
- competing/stale attempt cannot steal/reuse claim
- media_upload must confirm before create_post
- create_post input media id equals same attempt’s confirmed media output
- confirmed media never re-uploaded after later uncertainty
- uncertain/rejected create blocks replay
- already-published day fails closed safely
- same-day claim lifecycle remains legacy-compatible enough for source candidate

Pay special attention to residual direct service_role DML on publish_claims.

## Review D — morning_greeting atomic completion

Verify completion transaction covers all DB-side authoritative state:
- scheduled_posts
- attempt ledger
- provider-step records/plan state
- publish_claims published state/x_post_id/published_at
- greeting success metadata
- exactly one success execution log

Confirm external Storage receipt is correctly treated as non-transactional/best-effort and cannot undermine DB authority or cause duplicate X create/media upload.

## Review E — multistep helper safety

Review server-only helper(s):
- next safe action only
- no auto-loop through steps
- no retry of uncertain step
- no recreation/reupload of confirmed object
- no brand-only credential routing
- no secret/provider response leakage

Confirm Phase1E exact-account resolver assumptions are preserved.

## Review F — ACL / migration

Review:
- SECURITY DEFINER + empty search_path
- schema qualification
- service_role-only public RPCs
- internal/trigger API EXECUTE closed
- plan/step tables non-writable by API roles
- raw Phase1F begin RPC revocation is safe
- publish_claims residual grants are understood and do not bypass new v2 invariants
- explicit transaction and PUBLIC window
- non-idempotency / ordered 1B→1G apply dependency
- apply-tool nested transaction risk
- live-definition dependencies before rollout

## Required verification

At minimum:
- focused Phase1G
- Phase1B/1D/1E/1F regressions
- x-test-post
- _shared
- important-news-monitor
- greeting/tip-specific tests
- disposable PostgreSQL behavior + concurrency/race
- Deno check/lint
- bash -n
- git diff --check

If concrete defect found:
- minimal Phase1G-scope source-only fix allowed
- add regression
- rerun affected/full safety suites
- push safely
- no deploy/apply

## Forbidden

- production migration/DDL/DML/RPC apply
- db push/history repair
- deploy
- Cron/OAuth/Vault/token mutation
- real X API/posts/media
- dispatcher/producers enable
- apps/admin/**
- consumer mobile/**
- G1/G2 app work
- G4 work
- unrelated MIC work

## Production mutation budget

0.

## Completion / C1

Update `.agent/CODEX_REPORT.md` with:
- verdict PASS / PASS-WITH-FIX / FAIL
- findings by severity
- exact changed files/fix commit if any
- tip plan/step assessment
- tip completion fidelity
- greeting claim/media/create assessment
- greeting completion fidelity
- helper safety
- ACL/migration safety
- exact tests/counts
- whether Phase1G is safe to keep as source candidate
- production activation decision (expected NO)
- remaining blockers
- production mutation=0
- next recommendation

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for C1.
