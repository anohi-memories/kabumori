# Codex Task

- task_id: x-autopost-phase1h-gated-dispatcher-final-review-20260925
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: Sol（高）
- purpose: K3 PASS済みPhase1H gated-OFF v2 dispatcher source candidateを、gate fail-closed、no-legacy-fallback、resume安全性、exact-account credential、provider-start durability、typed completion wiring、ACL/migrationの観点で独立レビューする。production deploy/activation/X API callは行わない。

## Target

Implementation commit:
- `59bd54412eae989400b6ce7e9ecb56dc943db94f`

Primary files:
- `supabase/functions/x-test-post/v2_dispatcher.ts`
- `supabase/functions/x-test-post/v2_dispatch_ledger_rpc.ts`
- `supabase/functions/x-test-post/v2_dispatcher_test.ts`
- `supabase/functions/x-test-post/v2_dispatch_ledger_rpc_test.ts`
- `supabase/functions/x-test-post/dispatch_resume_migration_test.ts`
- `supabase/migrations/20260925120000_x_autopost_phase1h_dispatch_resume.sql`
- `supabase/tests/x_autopost_phase1h_behavior.sql`
- `supabase/tests/x_autopost_phase1h_run.sh`
- `supabase/tests/x_autopost_phase1h_gated_dispatcher.md`

K3 evidence:
- gate hard OFF by default
- live legacy dispatcher unchanged/unwired
- focused Phase1B–1H 99/99 PASS
- x-test-post 464/464 PASS
- _shared 129/129 PASS
- important-news-monitor 431/431 PASS
- greeting/tip 138/138 PASS
- disposable Phase1H behavior PASS
- production mutation/X API calls = 0

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read G3 Phase1H TASK/Report
5. Read Phase1E/1F/1G review history
6. Fresh fetch origin/main
7. Confirm independent H1 worktree/checkout
8. Inspect H2/G1/G2/G3/G4 and prove no overlap
9. Review implementation commit and current main for drift
10. Do not deploy/apply/activate anything

## Review A — hard gate

Verify:
- missing/malformed env => OFF
- only exact documented value enables
- gate evaluated before claim/credential/provider work
- no client/admin/mobile input can enable it
- no partially-started v2 attempt can fall through to legacy posting
- gate OFF causes zero v2 claim/X calls
- live legacy path remains unchanged

Try whitespace/case/alternate truthy values and env-read failure.

## Review B — claim / exact-account authority

Verify dispatcher:
- calls only v2 account-bound claim path
- never calls old unpartitioned claim
- never binds legacy pending rows
- claim.social_account_id remains sole credential authority
- resume credential reader cannot cross account/brand/post/attempt
- no brand-only/first-row/hardcoded/env/legacy token fallback
- wrong-account credential response fails before X

## Review C — resume safety

Review:
- oldest resumable attempt selection
- resumable classes only
- completed/rejected/uncertain/incomplete behavior
- snapshot/plan immutability
- resume cannot regenerate content inconsistently
- resume cannot resend confirmed provider steps
- confirmed-incomplete re-entry performs only DB completion, no provider call
- crash after provider response before finish is blocked/manual, not replayed

Try adversarial stale/newer-attempt and cross-account resume cases.

## Review D — provider-start / one-request guarantee

Single-create:
- provider-start durable before POST
- persistence failure => 0 X calls
- exactly one create after start
- no hidden refresh/retry
- 401/rejection after start => no second create
- network/timeout/408/5xx/3xx/2xx-no-id => uncertain
- completion failure after x_created => same-id confirmed-incomplete

Multi-step:
- durable begin before each media/create/reply request
- one request per step per run
- no in-memory loop across unpersisted steps
- restart between every step remains exact-once
- failed finish write after real provider call never causes replay

## Review E — tip/greeting integration

Tip:
- snapshot part count matches plan
- re-entry uses immutable snapshot content
- reply chain uses ledger ids
- uncertain/rejected stops later parts
- completion only after all confirmed

Greeting:
- stale JST zero provider calls
- attempt-bound publish_claim acquisition
- media confirmation durable before create
- create uses exact media id
- resume never reuploads confirmed media
- uncertain create never replays
- storage receipt callback only after authoritative DB completion

## Review F — unsupported types / poll fidelity

Verify:
- interaction remains disabled because poll seam missing
- no silent text-only degradation
- brand_post remains disabled
- unknown types fail closed
- bound unsupported type settles without provider calls and does not become retryable accidentally

## Review G — ledger/result classes

Review all dispatcher result classes and scheduler implications:
- gate_off
- no_work
- unsupported_type
- pre_x_retryable
- pre_x_terminal
- provider_rejected
- provider_uncertain
- confirmed_db_incomplete
- completed
- in_progress
- blocked_manual_reconciliation

Verify non-reclaimable classes cannot be automatically retried.

## Review H — ACL / migration

Review Phase1H migration:
- ordered dependency on 1B→1G
- additive/versioned semantics
- explicit transaction
- no default PUBLIC EXECUTE window
- SECURITY DEFINER + empty search_path
- service_role-only API RPCs
- snapshot table read-only to API roles
- trigger guard plan+snapshot requirement
- resume credential reader secret boundary
- apply-tool nested transaction risk
- live-definition/grant dependencies

## Review I — tests

At minimum rerun:
- dispatcher/adapter tests
- focused Phase1B–1H
- x-test-post
- _shared
- important-news-monitor
- greeting/tip-specific
- disposable Phase1H behavior
- relevant Phase1D/E/F/G proofs
- deno check/lint
- bash -n
- git diff --check

If concrete bug is found:
- minimal Phase1H-scope source-only fix allowed
- add regression
- push safely
- no deploy/apply/activation

## Forbidden

- production migration/DDL/DML/RPC apply
- db push/history repair
- Edge deploy
- Cron mutation
- OAuth/Vault/token mutation/refresh
- real X API/post/media
- gate enable
- scheduler/claim switch
- old claim revoke
- automatic legacy binding
- apps/admin/**
- consumer mobile/**
- G1/G2 app work
- G4 work

## Production mutation budget

0.

## Completion / C1

Update `.agent/CODEX_REPORT.md` with:
- verdict PASS / PASS-WITH-FIX / FAIL
- findings by severity
- exact changed files/fix commit if any
- gate assessment
- claim/exact-account assessment
- resume assessment
- provider one-request assessment
- tip/greeting assessment
- unsupported type assessment
- result-class/retry assessment
- ACL/migration assessment
- exact tests/counts
- source-candidate acceptance
- production activation decision (expected NO)
- remaining blockers
- production mutation=0
- next recommendation

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for C1.
