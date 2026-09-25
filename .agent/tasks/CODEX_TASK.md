# Codex Task

- task_id: x-autopost-phase1i-exact-account-refresh-final-review-20260925
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: critical
- recommended_model: Sol（高）
- purpose: K3 PASS済みPhase1I exact-account pre-X refresh writerを、account authority / Vault secret boundary / OAuth rotation / concurrency / provider-start race / ACL/migrationの観点で独立レビューする。production apply/deploy/real token refresh/X API callは禁止。

## Target

Implementation:
- `12e9fd1`

Primary scope:
- `supabase/migrations/20260925150000_x_autopost_phase1i_account_refresh.sql`
- `supabase/functions/_shared/x_v2_account_refresh.ts`
- `supabase/functions/_shared/x_v2_account_refresh_test.ts`
- `supabase/functions/x-test-post/account_refresh_migration_test.ts`
- `supabase/functions/x-test-post/v2_dispatcher.ts`
- `supabase/functions/x-test-post/v2_dispatcher_test.ts`
- `supabase/tests/x_autopost_phase1i_fixture.sql`
- `supabase/tests/x_autopost_phase1i_behavior.sql`
- `supabase/tests/x_autopost_phase1i_run.sh`
- `supabase/tests/x_autopost_phase1i_account_refresh.md`

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read G3 Phase1I TASK/Report and prior Phase1E/1H review history
5. Fresh fetch origin/main
6. Confirm independent H1 worktree/checkout
7. Confirm H2/G1/G2/G3/G4 scopes do not overlap this review
8. Review implementation commit and current-main drift
9. Do not apply/deploy/refresh anything

## Review A — exact-account authority

Verify before token endpoint call:
- attempt/claim owns exact social_account_id
- scheduled post remains running and bound
- brand/account/platform match
- X + identity_verified + publish_enabled
- access/refresh refs belong only to exact account
- shared/ambiguous refs fail closed
- no brand-first/first-row/hardcoded/env/oauth_token_store fallback
- no caller-supplied generic secret-id authority

Attack with wrong account/brand/ref/attempt/stale claim.

## Review B — secret/Vault boundary

Verify:
- refresh/access plaintext never reaches client/admin/mobile/result/log
- refresh token stays only in trusted server helper
- provider response body/token/ref IDs are never logged
- only exact account's own Vault refs are writable
- rotated refresh updates both; omitted refresh preserves existing refresh secret
- Vault error messages are fixed-code masked
- direct API roles cannot write state/Vault through Phase1I public surface
- SECURITY DEFINER + empty search_path + schema qualification
- service_role-only EXECUTE
- no default PUBLIC EXECUTE window

Assess residual production service_role Vault powers explicitly.

## Review C — provider refresh semantics

Verify exactly one POST to token endpoint:
- manual redirect
- timeout
- no retry
- no second request on 3xx
- malformed 2xx fails closed
- invalid_grant -> reauth_required
- unknown/network/timeout/408/5xx -> uncertain and no blind replay
- 429/other 4xx classes match documented source semantics
- no X create/media call in refresh helper

## Review D — ordering / external atomicity

Review:
- DB lease acquired before refresh request
- commit requires unchanged exact account/attempt/lease
- Vault writes and state release are transactionally coherent inside Postgres
- X's external single-use refresh rotation is explicitly non-atomic
- failed/uncertain commit never reports success
- release failure cannot silently allow provider-start
- operator recovery path is explicit and not auto-replayed

## Review E — concurrency / races

Adversarially verify:
- same account concurrent refresh -> one winner
- different accounts independent
- provider-start transition cannot race past refresh lease
- stale attempt cannot overwrite rotated credentials
- reconnect/account mutation invalidates old writer
- used/lost lease cannot commit
- uncertain/reauth_required states cannot be blindly retried
- resumed multi-step/provider-started paths do not refresh

## Review F — dispatcher integration contract

Verify source-only optional refresh port:
- called only for documented pre-X refresh-required condition
- never after durable provider-start
- refresh success settles/re-enters safely
- does not chain refresh + hidden create in unsafe opaque block
- live legacy dispatcher and production v2 entry remain unwired/OFF

## Review G — migration / rollout safety

Verify:
- additive ordered dependency after Phase1H
- explicit transaction
- preflight dependencies are correct
- no create-or-replace/drop of unrelated live objects
- triggers and state table enforce lease invariants
- service_role-only API RPCs; API roles cannot mutate Vault/state
- apply-tool/nested transaction assumptions documented
- production migration remains unapplied
- live-definition/grant/read-back prerequisites are sufficient

## Review H — tests

Rerun at minimum:
- Phase1I focused/helper/static/dispatcher
- Phase1B–1I focused
- x-test-post
- _shared
- important-news-monitor
- greeting/tip-specific
- disposable Phase1I behavior/concurrency
- relevant Phase1D/E/F/G/H proofs
- deno check/lint
- bash -n
- git diff --check

If a concrete bug is found:
- minimal source-only fix is allowed
- add regression
- push safely
- no deploy/apply/real refresh/token/Vault/X mutation

## Forbidden

- production migration/DDL/DML/RPC apply
- db push/history repair
- Edge deploy
- Cron mutation
- real OAuth refresh/token rotation
- production Vault plaintext read/write
- real X API/post/media
- gate enable
- scheduler/claim switch
- apps/admin/**
- consumer mobile/**
- unrelated G2/H2 work

## Production mutation budget

0.

## Completion / C1

Update `.agent/CODEX_REPORT.md` with:
- verdict PASS / PASS-WITH-FIX / FAIL
- findings by severity
- exact-account assessment
- Vault/secret assessment
- refresh provider assessment
- external atomicity/uncertain-result assessment
- concurrency/race assessment
- dispatcher integration assessment
- ACL/migration assessment
- exact tests/counts
- changed files/fix commit if any
- production mutation=0
- production activation decision (expected NO)
- remaining blockers
- next recommendation

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for C1.


## Final C1 — Phase1I

Verdict: **PASS-WITH-FIX for source candidate**.

Accepted reviewed/fixed head:
- PR #30: `94000720e10649612e84cb3811327de1a63364e9`

Accepted fixes:
- P1 cross-account Vault write after silent secret-ref change fixed.
- P2 stale attempt commit after settlement fixed.

Verification accepted:
- Phase1I focused 41/41 PASS
- x-test-post + _shared 618/618 PASS
- important-news-monitor 473/473 PASS
- disposable Phase1D–1I behavior/concurrency proofs PASS
- production mutation=0

Decision:
- source candidate accepted.
- production activation remains NO.
- G3 should perform fresh-main merge of PR #30 and post-merge verification.
