# Claude Task 3

- task_id: x-autopost-phase1d-claim-domain-partition-and-planner-authority-20260924
- owner: claude
- slot: claude-3
- status: ready
- next_owner: claude
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: Phase1Cで判明したsplit-brain blockerを解消するため、legacy dispatcherはunbound rowsのみ、v2 dispatcherはexplicitly bound rowsのみをclaimするsource-only Phase1D candidateを完成させる。productionには適用しない。

## Routing

- X自動投稿アプリ実装のためG3で実施する。
- G4は既存のadmin Phase2 continuationを保護する。
- H1/H2はCodexレビュー・検証用に戻す。
- このTASK完了後、ChatGPTがH1/H2の空きと競合を確認してCodexレビュー要否を判断する。

## Existing evidence to inherit

Codexが移管前に未commit・未push候補を独立worktreeで作成し、以下を確認済み:
- base: `f074560`
- disposable PostgreSQL verification PASS
- x-test-post regression: 412 PASS
- Phase1B / Phase1D SQL verification PASS
- two-session concurrent claim proof PASS
- production mutation 0
- X communication 0
- added test standalone typecheck PASS
- whole-project typecheck failed only on 14 existing unrelated errors
- disposable DBs/temp PostgreSQL cluster cleaned up
- PostgreSQL 17 remains installed; Homebrew default cluster stopped

Candidate files reported by previous worker:
- `/private/tmp/kabumori-h1-phase1d-f074560/supabase/migrations/20260924120000_x_autopost_phase1d_claim_domain_partition.sql`
- `/private/tmp/kabumori-h1-phase1d-f074560/supabase/tests/x_autopost_phase1d_claim_domain_partition.md`

These local paths are reference-only. Do not assume the candidate is still present or correct.

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read this TASK
5. Read prior Phase1B/Phase1C reports and latest Codex Phase1D evidence
6. Fresh fetch origin/main
7. Inspect G4/G1/G2/H1/H2 ownership and prove no overlap
8. Re-audit current live-source claim/retry/planner semantics against fresh main
9. If the local unpublished candidate still exists, compare it semantically to fresh main before reusing any part of it
10. Never copy/cherry-pick blindly from the old base

## Scope A — claim-domain partition

Implement a source-only versioned candidate where:
- legacy claim path can claim only `social_account_id IS NULL`
- v2 claim path can claim only `social_account_id IS NOT NULL`
- no row can be eligible for both
- no brand/account-count inference
- no LIMIT 1 fallback
- no implicit binding at claim time
- no silent rebinding through retry
- historical succeeded/terminal rows remain historical

Prefer additive/versioned SQL/RPC changes. Do not replace live production RPCs in this task.

## Scope B — planner authority

Audit each active scheduled_posts producer/planner and classify:
1. trusted social_account_id already available
2. trusted account authority can be introduced explicitly
3. no trusted account authority exists

Only class 1/2 may create bound rows.
Class 3 must remain unbound/legacy or fail closed according to safest compatibility.
Do not infer one account per brand.

Produce:
planner/caller | post type | brand authority | account authority | candidate binding | claim domain | readiness/blocker.

## Scope C — retry/stale/reconcile invariants

Prove:
- legacy retry stays unbound
- v2 retry stays bound
- unbound running/stale rows never enter v2 reconcile
- bound v2 rows never enter legacy reclaim
- uncertain / confirmed-X-db-incomplete remain non-reclaimable
- claim-domain partition survives failure/retry transitions

Do not redesign provider outcome semantics here.

## Scope D — coexistence/cutover seam

Document exact future activation ordering:
- source/migration/RPC order
- when planners may begin writing bound rows
- how legacy cannot take bound rows
- how v2 cannot take unbound rows
- rollback point before provider call
- what remains disabled until later prerequisites pass

No production activation.

## Scope E — disposable verification

Use disposable PostgreSQL only.

Re-run on fresh-main candidate:
- unbound row: legacy yes / v2 no
- bound row: v2 yes / legacy no
- concurrent legacy/v2 workers cannot double-claim
- two accounts remain independently claimable
- retry/stale/reconcile preserve domain
- mismatched brand/account fails
- no automatic legacy binding
- cleanup succeeds

## Scope F — tests

Run:
- focused Phase1D SQL/claim tests
- full relevant x-test-post regression
- git diff --check
- changed-file static/type checks

Whole-project typecheck failures may be reported separately only if proven pre-existing and unrelated.

## Forbidden

- production migration/DDL/DML/backfill
- live RPC replacement
- Edge Function deploy
- Cron/OAuth/Vault/token mutation
- X API calls
- manual production row injection
- migration-history repair
- blind supabase db push
- apps/admin/**
- consumer mobile/**
- G4 files/workflow
- unrelated MIC work

## Production mutation budget

0.

## Completion / K3

When complete:
- status -> review_required
- next_owner -> chatgpt
- report:
  - fresh main SHA
  - exact changed files
  - whether old unpublished candidate was reused/reworked/rejected
  - claim-domain contract
  - planner authority matrix
  - retry/stale/reconcile proof
  - coexistence/cutover design
  - disposable PostgreSQL proof
  - exact test counts
  - existing unrelated type errors separated clearly
  - commit/push status
  - production mutation=0
  - remaining blockers
- STOP for K3.

Do not deploy/apply Phase1D to production.
