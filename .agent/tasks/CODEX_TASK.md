# Codex Task

- task_id: x-autopost-phase1d-claim-domain-partition-and-planner-authority-20260924
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: GPT-5.6 Sol Medium
- purpose: Phase1C C2で判明したsplit-brain blockerを解消するため、legacy dispatcherはunbound rowsだけ、v2 dispatcherはexplicitly bound rowsだけをclaimできるようにするsource-only claim-domain partition candidateを作り、planner側のsocial_account_id authority境界を明文化・検証する。productionには適用しない。

## Routing rule

- This task belongs to the かぶモリ workstream and is assigned to H1 by explicit user instruction.
- H2 is reserved for the separate X自動投稿アプリ workstream.
- Do not move this task back to H2 unless the user explicitly instructs it.

## Context

Phase1C C2 accepted findings:
- live legacy claim と v2 claim は、そのままでは account-bound row を双方がclaimできるsplit-brain riskがある
- active plannersはまだtrusted social_account_id authorityを持っていない
- legacy pending rowsはunboundのままで暗黙mapping禁止
- credential routing/completion/provider-step modelは別前提として未解決
- production mutation 0

This task addresses only prerequisite #1:
**claim/planner partition design so legacy claims only unbound rows and v2 claims only bound rows, with uniqueness/coexistence proof.**

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read this TASK
5. Read prior Phase1B/Phase1C TASK + CODEX_REPORT_2
6. Fresh fetch origin/main
7. Inspect H1/G1/G2 ownership and prove no overlap
8. Audit current live claim_due_post / retry/fail semantics and all scheduled_posts producer paths
9. Audit the Phase1B v2 migration/RPC candidate without changing its accepted semantics unless this task explicitly requires a versioned additive candidate

STOP if another slot owns the same queue migration/RPC/planner files.

## Scope A — partition contract

Design source-only versioned claim behavior with these hard domains:

- legacy claim path may claim only rows where social_account_id IS NULL
- v2 claim path may claim only rows where social_account_id IS NOT NULL
- no row may be eligible for both claim domains at the same time
- no fallback based on brand/account count
- no implicit mutation from unbound -> bound at claim time
- no silent rebinding of failed/retry rows
- existing terminal/succeeded historical rows remain historical

Prefer additive/versioned SQL/RPC changes. Do not mutate production live RPCs in place in this task.

## Scope B — planner authority classification

Audit every active scheduled_posts producer/planner and classify it:

1. trusted account authority already available
2. trusted authority can be introduced from an explicit caller/account context
3. no trusted account authority exists yet

For class 1/2:
- prepare source candidate to propagate explicit social_account_id only when it is genuinely authoritative
- preserve existing brand_id/content/cadence semantics

For class 3:
- do not infer an account
- either keep rows unbound for legacy-only handling or fail closed, depending on current behavior and safest compatibility
- document blocker precisely

Produce a matrix:
planner/caller | post type | brand authority | account authority | candidate row binding | eligible claim domain | readiness/blocker.

## Scope C — retry/failure partition invariants

Prove that:
- legacy retry cannot convert/bind into v2 implicitly
- v2 retry remains account-bound
- unbound running/stale rows never enter v2 reconcile
- bound v2 rows never enter legacy retry/reclaim
- terminal uncertain/confirmed-X states from Phase1B remain non-reclaimable
- claim-domain partition is preserved through retry/failure transitions

Do not redesign provider outcome semantics here.

## Scope D — coexistence activation seam

Design a future activation sequence that allows legacy and v2 code to coexist safely before full dispatcher cutover.

Must state:
- exact DB/RPC/source ordering
- when planners may begin writing bound rows
- how legacy dispatcher is prevented from taking bound rows before v2 activation
- how v2 is prevented from taking legacy rows
- rollback point before any provider call
- what must still remain disabled until credential resolver/completion contracts/provider-step model are approved

No production activation.

## Scope E — disposable PostgreSQL proof

Use fake/disposable DB only.

Prove at minimum:
- unbound pending row claimable by legacy candidate, not v2
- bound pending row claimable by v2 candidate, not legacy
- concurrent legacy/v2 workers cannot claim the same row
- two bound accounts remain independently claimable
- retry preserves original claim domain
- stale/reconcile preserves original claim domain
- mismatched brand/account integrity still fails
- no automatic binding of legacy rows
- rollback/cleanup complete

## Scope F — tests

Run focused tests plus full relevant x-test-post regression.
Report exact counts.
Run git diff --check and appropriate static/type checks.
No X API/network post calls.

## Production read-only evidence

Read-only production inspection is allowed only to classify current row/planner shapes and confirm assumptions.
Do not expose secrets/tokens.

## Forbidden

- production migration apply
- production DDL/DML/backfill
- live RPC replacement
- Edge Function deploy
- Cron changes
- OAuth/Vault/token changes
- X API calls/posts/media/reposts
- manual production row injection
- legacy row account inference
- LIMIT 1 routing
- credential resolver implementation beyond interfaces needed to prove claim partition
- completion-contract redesign
- provider-step/tip-thread redesign
- apps/admin/**
- consumer mobile/**
- Netlify/Vercel production changes
- blind supabase db push
- migration history repair

## Production mutation budget

0.

## Completion / C1

When complete:
- status -> review_required
- next_owner -> chatgpt
- update .agent/CODEX_REPORT.md with:
  - fresh main SHA
  - exact changed files
  - claim-domain contract
  - planner authority matrix
  - retry/failure partition proof
  - coexistence activation sequence
  - disposable PostgreSQL proof
  - test counts
  - commit/push/fresh-origin status
  - production mutation=0
  - remaining blockers: credential resolver, atomic completion contracts, provider-step outcome model
- STOP for C1.

Do not apply or deploy anything from this task to production.
