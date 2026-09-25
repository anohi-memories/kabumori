# Claude Task 3

- task_id: x-autopost-phase1i-exact-account-prex-refresh-writer-20260925
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
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

## Report

- task_id: `x-autopost-phase1i-exact-account-prex-refresh-writer-20260925`
- result: **source-only exact-account pre-X refresh writer complete; production mutation 0; token endpoint calls 0; Vault writes 0.** Not wired into the live dispatcher or any v2 entrypoint. Model: Opus 5.5 (as recommended; the user switched from Sonnet 5 before start). Stop for K3.
1. fresh main SHA: started `f913ca3`; pre-commit fetch `481a322` (1 commit, `important-news-monitor` only — unrelated); implementation rebased onto `481a322`.
2. worktree/branch: dedicated G3 worktree `/Users/yuya/Developer/kabumori-g3-phase1d`, branch `claude/g3-phase1i-refresh-writer`. No overlap: G2 in_progress = PR #26 app redeploy; G1/G4/H1/H2 done.
3. exact authority (`supabase/tests/x_autopost_phase1i_account_refresh.md` §1): `begin_x_account_refresh_v2(attempt_id, claim_token, social_account_id, brand_id)` locks the attempt (must be `pre_x`, no outcome), requires caller account/brand = attempt's, post `running` and bound to it, then locks the account row and requires `x` / same brand / `identity_verified` / `publish_enabled` / `oauth_client_ref` / both Vault refs present and distinct / **no other account referencing either ref** (`X_REFRESH_SECRET_REF_SHARED`, blocks both sides). No brand-first or first-row lookup, no hardcoded account, no env token, no `oauth_token_store`, no secret-id parameter anywhere.
4. secret boundary (§2): the refresh token goes only from `begin` to the server helper (`XRefreshLease`, private field, redacted in JSON/String/inspect); the dispatcher sees only `{ postOutcome, code, tokenRequests }`. `commit` writes the new access token (and a rotated refresh token only if X returned one) to the same account's own Vault secrets; omitted `refresh_token` keeps the stored one. Fixed codes only; Vault read/write errors (incl. Vault's own `P0001`) masked — the disposable proof found the write-side leak during development and it was fixed before commit. No `console.*`. RPCs service_role-only, `SECURITY DEFINER`, `search_path=''`; state table SELECT-only; API roles cannot write Vault.
5. provider refresh request (§3): exactly one `POST /2/oauth2/token`, Basic client auth, `redirect: manual`, timeout, no retry. 2xx+access → commit; malformed 2xx / network / timeout / 3xx / 408 / 5xx → `uncertain`; 429 → `not_rotated` retryable; 400 `invalid_grant` → `reauth_required`; other 4xx → `not_rotated` terminal. Begin refusals and unknown `oauth_client_ref` → zero requests. Client: only `'default'` → `X_CLIENT_ID`/`X_CLIENT_SECRET` (the client every account was authorized with).
6. write ordering / partial failure (§4): begin (validate + lease + read, one txn) → one request → commit (lease still held + account unchanged via `updated_at` snapshot + both Vault writes + lease release, one txn; Vault lives in the same Postgres). The unavoidable non-atomic boundary is X's single-use refresh token: failed commit → rolled back and released `uncertain` (or left `refreshing` if release also fails) — both block refresh and provider start, post `pre_x_terminal`, never reported as success; `lease_lost` / `account_changed` (re-connect during refresh) likewise. Unknown X outcome is never replayed. Operator recovery = re-connect + owner-SQL reset.
7. concurrency (§5): per-account lease (state row + account row `FOR UPDATE`) → one winner; provider start and provider-step insert share-lock the account and are refused while leased; begin and mark lock attempt → account in the same order; stale/used leases cannot write or release; other accounts independent; `uncertain`/`reauth_required` block refresh but not posting with a token that still passes identity.
8. changed files: new — `supabase/migrations/20260925150000_x_autopost_phase1i_account_refresh.sql`, `supabase/functions/_shared/x_v2_account_refresh.ts` + `_test.ts`, `supabase/functions/x-test-post/account_refresh_migration_test.ts`, `supabase/tests/x_autopost_phase1i_{fixture.sql,behavior.sql,run.sh,account_refresh.md}`; modified — `supabase/functions/x-test-post/v2_dispatcher.ts` (optional `refreshAccountPreX` port, used only for `X_ACCESS_TOKEN_REFRESH_REQUIRED_PRE_X` before provider start, then settle for re-entry; `refreshRequests` counter), `v2_dispatcher_test.ts` (+4), `supabase/tests/x_autopost_phase1h_gated_dispatcher.md` (activation order now includes 1I); this TASK.
9. ACL/migration safety: single explicit transaction, apply alone after 1H, not re-runnable; fails closed unless Phase1H objects, `vault.update_secret(uuid,text,text,text,uuid)`, `vault.decrypted_secrets` and the 7 required `social_accounts` columns exist; additive (1 table, 4 functions, 2 triggers); no `create or replace`, no drop, no `social_accounts` change.
10. tests: disposable PostgreSQL 17 Phase1I behavior + races **PASS ×3 + 1** (same-account one lease, concurrent provider start refused, cross-account parallel), cleanup PASS; Phase1D/1E/1F/1G/1H proofs re-run PASS; Phase1H behavior stacked on 1I PASS. Deno: refresh helper **12/12**, Phase1I static **6/6**, dispatcher **23/23** (19 + 4); focused Phase1B–1I **124/124**; `x-test-post` **477/477**; greeting/publish_claim/tip **138/138**; `_shared` **141/141**; `important-news-monitor` **451/451** (unrelated main growth), re-run after rebase. `deno check --no-config` + `deno lint` on new/changed TS: PASS; `bash -n`: PASS; `git diff --cached --check`: PASS. All X traffic in tests is fake; global `fetch` throws.
11. commit/push/PR: implementation `12e9fd1`; this Report is a separate control commit; both pushed directly to `origin/main` from the G3 worktree after a fresh fetch. No PR.
12. production mutation: **0** (apply/DDL/DML/RPC 0, db push 0, deploy 0, Cron 0, OAuth/Vault/token 0, real refresh/rotation 0, X API/post/media 0, gate enable 0, scheduler/claim switch 0, legacy claim revoke 0).
13. remaining blockers: Kabumori token still in `oauth_token_store`/env (not refresh-ready); AI Lab refresh ref must be verified on its own row; live read-back listed in §7; stuck `refreshing` / `uncertain` need an operator runbook (re-connect + reviewed reset SQL) and monitoring; resumed multi-step attempts cannot refresh (by design) and wait for a pre-X refresh or re-connect; interaction poll seam; brand_post completion source; real v2 content adapters and the gate-OFF entrypoint; production gates (ordered 1B→1I apply proof, staged rollback plan).
14. next_recommendation: K3, then Codex review of the refresh authority/lease/Vault-write boundary and race proofs (Sol high). Next source-only step: the gate-OFF v2 entrypoint with real content adapters and the refresh port wired (Opus5.5（高）), or the Kabumori credential migration plan into its account's Vault refs.
