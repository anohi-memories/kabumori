# Codex Task

- task_id: x-multibrand-phase3i-ai-lab-production-prelive-rollout-20260914
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: high
- recommended_model: Sol High
- purpose: Phase 3HでC1 PASSしたAI Labの280文字制限・fingerprint完了処理・Vault-backed dispatchを、本番pre-live状態まで安全に反映する。まだtweet.write追加・live化・実X投稿は行わない。

## Prior approved state

Phase 3H C1 PASS。

Reviewed implementation branch:
- `codex/ai-lab-prelive-safeguards-20260913`
- base: `341e5dc5c03147394a99b2b71d148d2ba06c9c89`
- commits: `6ce4ad8ea983dd617c6227dd6f628e3e3b4f945b` -> `406b53c2a2838a5ac2a446fffb6e6feef954eb7a`

C1 confirmed:
- AI Lab finite 280 Unicode-codepoint policy and future explicit unlimited mode
- independent final dispatch length guard
- cross-brand dedupe before dispatch
- fixed AI Lab Vault-backed route for `ai_salaryman_lab_x` / `kaishain_ai_lab`
- zero fallback to Kabumori legacy token storage
- no refresh on AI Lab live dispatch path
- fingerprint completion path after confirmed X success
- duplicate-resend protection when completion result is uncertain
- migrations use fixed-account/service-role-only safety boundaries
- reported tests 460/460 PASS

Current production AI Lab remains:
- `publish_mode=dry_run`
- `publish_enabled=false`
- OAuth scopes read-only: `tweet.read users.read offline.access`
- no AI Lab posting_window
- no real AI Lab X post

## Start / parallel safety

Before work:
- read `.agent/ORCHESTRATION.md`
- read `.agent/CURRENT_STATE.md`
- read this TASK and `.agent/CODEX_REPORT.md`
- fresh-check `origin/main`
- fresh-check `origin/codex/ai-lab-prelive-safeguards-20260913`
- inspect other active slots for overlap
- use isolated clean worktree/clone
- do not modify/stage unrelated existing changes

Codex slot 2 currently concerns Push delivery hardening (`send-push-notifications`) and must not be touched. If another active slot is changing `x-test-post`, the same Phase 3H migrations, OAuth/Vault account routing, or AI Lab production settings, STOP and report conflict.

## Goal

Bring Phase 3H code to a production **pre-live** state without authorizing an actual AI Lab X post:

1. perform read-only production preflight for both Phase 3H migrations
2. if exact live schema matches assumptions, apply only those two exact migrations
3. read back RPC/index/security definitions and privileges
4. deploy only Phase 3H `x-test-post` source from commit `406b53c2a2838a5ac2a446fffb6e6feef954eb7a`
5. read back deployed Function source/version and byte-compare runtime files
6. run only non-posting/read-only or dry-run verification sufficient to prove 280 guard + brand/Vault route wiring
7. leave OAuth scopes, publish flags, posting windows, Cron, and X posting untouched

## A. Production preflight — mandatory before writes

Inspect live production read-only and verify assumptions for:
- `published_content_fingerprints` columns/indexes/constraints/RLS/grants
- `scheduled_posts` columns/status values/brand attribution
- `post_execution_logs` columns required by completion RPC
- `brands` row for `ai_salaryman_lab`
- `social_accounts` row for `ai_salaryman_lab_x`
- current connection_status / expected handle `kaishain_ai_lab`
- Vault secret-reference columns are present (do not read secret values)
- existing functions/RPCs that may collide with the two new names
- current `x-test-post` version/auth mode

Confirm the following migration files exactly match reviewed commit `406b53c2...`:
- `supabase/migrations/20260913123509_ai_lab_prelive_safeguards.sql`
- `supabase/migrations/20260913151428_read_ai_lab_x_vault_token.sql`

If production differs materially or destructive correction would be needed, STOP before writes.

Production migration history is known to be divergent. Therefore:
- **never run `supabase db push`**
- do not repair/reconcile migration history
- do not mark unrelated versions applied/reverted

## B. Authorized production migration scope

The user has said to proceed with this Phase 3I rollout after C1 PASS. This task authorizes applying **only** the two exact reviewed Phase 3H migration files above, and only after successful read-only preflight.

Apply in dependency-safe order:
1. `20260913123509_ai_lab_prelive_safeguards.sql`
2. `20260913151428_read_ai_lab_x_vault_token.sql`

No other SQL/migration is authorized.

Immediately read back and verify at minimum:

### `complete_ai_salaryman_lab_brand_post`
- expected signature
- `SECURITY DEFINER`
- empty `search_path`
- execute privilege service_role-only
- fixed `brand_id=ai_salaryman_lab`
- fixed `social_account_id=ai_salaryman_lab_x`
- fixed `post_type=brand_post`
- terminal scheduled-post behavior after confirmed X success
- unique `(social_account_id, x_post_id)` fingerprint index exists

### `read_ai_salaryman_lab_x_vault_token`
- expected signature
- `SECURITY DEFINER`
- empty `search_path`
- execute privilege service_role-only
- requires fixed account id/brand/platform/handle/identity_verified
- only accepts secret references belonging to that account's access/refresh ref columns
- do not output or inspect decrypted token values in Report/logs

If either application fails transactionally, do not improvise broad fixes; inspect rollback/read-back and STOP.

## C. `x-test-post` deployment

Only after both migration read-backs pass:
- deploy **`x-test-post` only**
- deploy reviewed source at commit `406b53c2a2838a5ac2a446fffb6e6feef954eb7a`
- preserve current production auth mode; if current config is `verify_jwt=false`, keep `--no-verify-jwt`
- do not deploy any other Edge Function
- download/read back deployed source/runtime files and byte-compare against the exact source commit
- verify unrelated Functions' versions/updated_at are unchanged where practical

## D. Non-posting verification after deploy

No real/test X post is authorized.

Allowed verification:
- dry-run/admin request that cannot pass publish gate
- read-only metadata route checks
- verify AI Lab still resolves to `ai_salaryman_lab_x` / `kaishain_ai_lab`
- verify publish gate remains blocked by `dry_run` / `publish_enabled=false`
- verify 280-character rule can be observed through generation/dry-run or unit/runtime evidence without dispatching to X
- verify `legacyFallbackUsed=false` / no Kabumori token-store path
- verify no fingerprint row is inserted by dry-run
- verify no X POST/media call occurred

Do **not** call the Vault reader merely to reveal/check token values. Do not refresh tokens.

## E. Posting window

Do not invent schedule values and do not create/enable a posting_window in this task unless exact source-of-truth values have been supplied separately.

Report the fields still required:
- post_type confirmation
- timezone
- local start/end time or exact desired posting time(s)
- slot count / slot numbers
- `daily_probability` per slot

No Cron change.

## F. OAuth/write scope boundary

Still do not add or request `tweet.write` / `media.write` in this task.

Document the next-step requirement:
- text posting requires adding `tweet.write` while retaining `tweet.read users.read offline.access`
- reauthorization must verify `/2/users/me` is still `kaishain_ai_lab` before saving/replacing usable token refs
- `media.write` remains unnecessary until a media-upload feature is intentionally enabled

## Strictly prohibited

- AI Lab real/test X post or media upload
- `publish_mode=live`
- `publish_enabled=true`
- OAuth reauthorization or scope change
- `tweet.write` / `media.write` addition
- token refresh/liveness write test
- posting_window insert/update without confirmed schedule input
- Cron changes
- Kabumori OAuth/token/handle/publish/Cron mutation
- Mio changes
- any non-Phase-3H migration/RPC/schema change
- `supabase db push`
- migration-history repair/reconcile
- exposing token/secret/password/2FA values

## Tests / verification

Before production operations, rerun relevant local tests from reviewed source:
- Phase 3H brand/shared tests
- `x-test-post` relevant suite
- `git diff --check`
- changed-file `deno check` or baseline-equivalence evidence for existing diagnostics

After production rollout, record:
- exact project ref
- preflight results
- exact SQL files applied and actual recorded migration versions/names if the tooling assigns generated values
- RPC/index/ACL/security read-back
- deployed `x-test-post` version and auth mode
- byte comparison result
- non-posting verification result
- explicit X write count = 0 / media write count = 0

## Completion / Report

When complete:
- set status `review_required`
- next_owner `chatgpt`
- update `.agent/CODEX_REPORT.md`
- safely sync control metadata to origin/main

Report must include:
- task_id
- result
- model_used
- source_commit
- preflight
- migrations_applied
- migration_readback
- x_test_post_deploy
- deployed_source_verification
- non_posting_runtime_verification
- ai_lab_length_guard_result
- vault_route_result
- fingerprint_dry_run_result
- posting_window_status
- write_scope_status
- tests
- production_changes
- unchanged_components
- remaining_issues
- exact_steps_before_first_live_post
- safety_checks
- next_recommendation

## Success gate

Phase 3I PASS requires:
- both exact Phase 3H migrations safely applied/read back, or a clearly documented safe blocker before any partial broadening
- reviewed `x-test-post` deployed and byte-verified if migrations succeeded
- AI Lab still dry_run + publish_disabled
- OAuth write scopes still absent
- no posting window/Cron changes
- no X/media write
- no Kabumori/Mio regression
- next live-post prerequisites explicitly documented

Phase 3I does **not** authorize live publishing or the first real X post.
