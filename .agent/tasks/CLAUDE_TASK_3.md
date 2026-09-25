# Claude Task 3

- task_id: x-autopost-phase1i-exact-account-prex-refresh-writer-20260925
- owner: claude
- slot: claude-3
- status: ready
- next_owner: claude
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: Phase1Hで残っているexact-account単位のpre-X refresh writerをsource-onlyで実装し、claim.social_account_idを唯一の権限元としてそのアカウント自身のVault credentialだけを安全に更新できるようにする。production apply/deploy/token refreshは行わない。

## Previous K3 closure

Previous task:
- `x-autopost-phase1h-pr28-merge-postmerge-verify-20260925`

Final K3 result:
- PASS
- PR #28 reviewed head `ce60d7a29022956d049521ffaeb533a749152a60` merged unchanged
- merge commit `d1fa8a3bbc8ba7c8bab3725573e0cd6a5a3890f3`
- focused Phase1B–1H 102/102 PASS
- x-test-post 467/467 PASS
- _shared 129/129 PASS
- important-news-monitor 450/450 PASS
- greeting/tip/publish_claim 138/138 PASS
- disposable Phase1H behavior PASS
- legacy dispatcher unchanged; v2 gate remains unwired/OFF
- production mutation 0 excluding GitHub merge

## Goal

Add a source-only pre-X refresh boundary that:

1. starts only before provider-start
2. is authorized by exact `social_account_id`
3. reads that account's current refresh/access secret refs
4. performs at most one refresh request
5. writes refreshed credentials only back to that same account's Vault refs/metadata
6. never changes account identity/binding
7. never refreshes after provider-start
8. never falls back to another brand/account/legacy token
9. preserves no-X-call guarantees when refresh setup/write fails
10. remains completely unwired from live production

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read this TASK
5. Read Phase1E and Phase1H source/review reports
6. Fresh fetch origin/main
7. Confirm dedicated independent G3 worktree
8. Inspect G4/H1/H2/G1/G2 for file/API/Vault overlap
9. Audit current OAuth refresh code, Vault helpers/RPCs, social_accounts fields, and all legacy token stores
10. Do not mutate production secrets/tokens

## Scope A — exact authority

Refresh authority must come only from the claim/attempt's exact `social_account_id`.

Required checks before any token endpoint call:
- post is bound to that account
- attempt is current/running/pre_x
- brand/account/platform match
- account is X
- account is verified/eligible for publish
- refresh secret ref exists for that same account
- access secret ref destination belongs to that same account
- no ambiguous duplicate binding

No:
- brand-first lookup
- first-row lookup
- hardcoded account
- env access token fallback
- legacy `oauth_token_store` fallback
- cross-account secret ref input

## Scope B — secret boundary

Design a least-privilege server-only reader/writer contract.

Must:
- avoid exposing token plaintext to client/admin/mobile
- avoid returning refresh token to the dispatcher
- keep token material local to the server refresh helper
- update only the account's own access/refresh refs as returned by the provider
- support rotation of refresh token if provider returns a new one
- leave previous refresh token unchanged if provider omits a rotated token
- never log token values, provider response bodies, secret ids, or Vault plaintext
- use fixed error codes only

If a DB RPC is required:
- SECURITY DEFINER
- empty fixed search_path
- schema-qualified objects
- service_role-only EXECUTE
- no generic secret-id parameter
- exact account/attempt binding inside SQL
- close default PUBLIC window in same transaction

## Scope C — one refresh request

Create a one-request refresh provider seam analogous to the Phase1E one-request publish seam.

Requirements:
- manual redirects
- one POST to X OAuth token endpoint
- no hidden retry
- no second request on 3xx
- timeout/408/5xx/network => pre-X retryable only if no credential mutation occurred
- 4xx/provider rejection => fixed terminal/retry class based on source-backed semantics
- malformed 2xx/no access token => fail closed
- token response parsed without logging body

No X post/media request in this task.

## Scope D — write ordering / atomicity

Safest target:
1. validate exact account/attempt in DB
2. read exact refresh credential
3. call one refresh request
4. atomically persist returned access token + optional rotated refresh token to the same account's Vault refs / account metadata
5. return success without exposing plaintext

If Vault update + DB metadata cannot be atomic across systems, model the authoritative boundary explicitly and make partial state fail closed.

Do not claim atomicity you cannot prove.

## Scope E — dispatcher integration contract

Add a source-only integration seam for Phase1H, but do not activate/import into live dispatcher entrypoint.

Expected future behavior:
- identity precheck says refresh required
- if phase is pre_x and retry budget allows, call exact-account refresh once
- after successful committed refresh, rerun identity check on next dispatcher invocation or a clearly bounded same invocation only if it cannot create a second provider request
- once provider-start is durable, refresh forbidden

Prefer restart/re-entry after refresh rather than chaining refresh + X create in the same opaque block.

## Scope F — concurrency

Prove:
- two concurrent refresh attempts for same account/attempt do not both rotate credentials
- different accounts can refresh independently
- stale attempt cannot overwrite credentials after a newer attempt/account state change
- provider-start transition races fail closed
- failed writer does not mark refresh success
- retry after uncertain refresh response does not blindly rotate again unless source-backed safe evidence exists

If refresh endpoint outcome is uncertain, return manual/operator or retry-blocked state; do not assume safe replay.

## Scope G — migration/ACL

If migration needed, make it:
- additive/versioned after 1H
- explicit transaction
- preflight current 1E/1H objects
- least-privilege grants
- no direct API-role Vault writes
- no PUBLIC EXECUTE
- document non-idempotency/apply-tool assumptions
- production-unapplied

## Scope H — adversarial tests

At minimum:
- account A can only read/write A refs
- account A cannot inject B ref/id
- wrong brand/account/attempt rejected before token call
- no refresh ref => zero provider calls
- provider-started => zero refresh calls
- token endpoint exactly one request
- redirect => no follow
- timeout/5xx/network => no blind retry in same run
- malformed 2xx => fail closed
- access-only response updates only access token
- rotated refresh response updates both
- writer failure => no success result
- concurrent same-account refresh => one committed winner / no corruption
- stale attempt cannot overwrite
- cross-account parallel refresh independent
- secret/token never appears in logs/result objects
- all tests use fake transport/fake Vault or disposable DB only

## Scope I — regressions

Run:
- new Phase1I focused tests
- Phase1E credential resolver/provider seam
- Phase1H dispatcher tests
- x-test-post
- _shared
- important-news-monitor
- disposable PostgreSQL relevant proofs
- deno check/lint
- bash -n
- git diff --check

Report exact counts.

## Scope J — activation safety doc update

Update rollout documentation with:
- exact refresh prerequisites
- what live Vault read-back is required
- how refresh credentials are provisioned per account
- what happens on uncertain refresh
- rollback before/after credential rotation
- which account types remain blocked until Vault refs exist

Kabumori account must not be considered ready while still relying on legacy token storage.

## Forbidden

- production DB migration/apply
- supabase db push/history repair
- Edge deploy
- Cron change
- real OAuth refresh/token rotation
- Vault plaintext read/write in production
- real X API/post/media
- gate enable
- scheduler/claim switch
- old claim revoke
- apps/admin/**
- consumer mobile/**
- G1/G2 work
- G4 work

## Production mutation budget

0.

## Completion / K3

Report:
1. fresh main SHA
2. worktree/branch
3. exact authority model
4. secret boundary
5. provider refresh request model
6. write ordering/partial-failure model
7. concurrency model
8. changed files
9. ACL/migration safety
10. exact tests/counts
11. commit/push/PR
12. production mutation=0
13. remaining blockers
14. next recommendation

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

Do not activate or deploy refresh.
