# Codex Task

- task_id: x-multibrand-phase3i-ai-lab-production-prelive-rollout-20260914
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sol High
- purpose: Phase 3H C1 PASS済み実装を、本番pre-live状態へ安全に反映する。AI Labの実X投稿・live化・write scope追加はまだ行わない。

## Reconciled C1 state

ChatGPT C1 review is **PASS** for Phase 3H implementation at commit `406b53c2a2838a5ac2a446fffb6e6feef954eb7a`.

Confirmed in C1:
- AI Lab finite 280 Unicode-codepoint policy and explicit future unlimited mode
- independent final dispatch length guard
- cross-brand dedupe before dispatch
- fixed AI Lab Vault-backed route for `ai_salaryman_lab_x` / `kaishain_ai_lab`
- zero fallback to Kabumori legacy token storage
- refresh disabled on the AI Lab dispatch path
- fingerprint completion only after confirmed X success
- duplicate-resend protection when completion result is uncertain
- both new RPC designs use fixed-account / service-role-only safety boundaries
- implementation branch is visible on GitHub and points to reviewed commit `406b53c2a2838a5ac2a446fffb6e6feef954eb7a`

Current production AI Lab remains:
- `publish_mode=dry_run`
- `publish_enabled=false`
- OAuth scopes read-only: `tweet.read users.read offline.access`
- no AI Lab posting_window
- no real AI Lab X post
- `x-test-post` currently v107 before this task

## Direct production authorization — 2026-09-14

The user said to proceed, and ChatGPT is explicitly authorizing the following exact production pre-live actions for private project `anohi-memories/kabumori`:

1. After a fresh read-only production preflight confirms compatibility, apply **only** these two reviewed Phase 3H migrations from commit `406b53c2a2838a5ac2a446fffb6e6feef954eb7a`:
   - `supabase/migrations/20260913123509_ai_lab_prelive_safeguards.sql`
   - `supabase/migrations/20260913151428_read_ai_lab_x_vault_token.sql`
2. Immediately read back and verify the resulting RPCs/index/ACL/security properties.
3. Only if both migration read-backs pass, deploy **only** `x-test-post` from the exact reviewed commit `406b53c2a2838a5ac2a446fffb6e6feef954eb7a`.
4. Preserve the current production auth mode (`verify_jwt=false` if still current) and byte-verify deployed runtime source against the reviewed commit.
5. Perform only non-posting/read-only/dry-run verification that cannot send an X post or media upload.

This is a direct authorization for the above production DB migration application and `x-test-post` deployment only. It is **not** authorization for live publishing, OAuth write scopes, posting windows, Cron changes, or any real/test X post.

## Phase 3I rollout checkpoint — 2026-09-14

- Both exact migrations were applied and their RPC/index/security read-backs passed. Supabase recorded versions `20260913230852` (`ai_lab_prelive_safeguards`) and `20260913231013` (`read_ai_lab_x_vault_token`).
- Before deploying, a read-only comparison found production `x-test-post` v107 differs from the exact reviewed commit in four existing runtime files; three (`close_report_data_logic.ts`, `close_report_logic.ts`, `fixed_hashtags_logic.ts`) are not changed by Phase 3H. The reviewed commit also adds 13 brand helper modules absent from the current deployment. Deploying the exact commit would replace the current versions of those existing files, potentially regressing other post types in the shared Function.
- Therefore no Function was deployed. Production remains `x-test-post` v107 / `verify_jwt=false`; no X or media call occurred. The two additive migrations remain applied.
- Keep this task `review_required`. Do not deploy until the user either approves a newly reviewed source that includes the current runtime changes, or explicitly confirms that replacing those exact live files with commit `406b53c2a2838a5ac2a446fffb6e6feef954eb7a` is intended.

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

Codex slot 2 concerns Push delivery hardening (`send-push-notifications`) and must not be touched. If another active slot is changing `x-test-post`, either Phase 3H migration, OAuth/Vault account routing, or AI Lab production settings, STOP and report conflict.

## Mandatory preflight

Perform read-only production inspection first and verify assumptions for:
- `published_content_fingerprints` columns/indexes/constraints/RLS/grants
- `scheduled_posts` columns/status values/brand attribution
- `post_execution_logs` columns required by completion RPC
- `brands` row for `ai_salaryman_lab`
- `social_accounts` row for `ai_salaryman_lab_x`
- current connection_status / expected handle `kaishain_ai_lab`
- Vault secret-reference columns present (do not read secret values)
- existing functions/RPCs that may collide with the two new names
- current `x-test-post` version/auth mode

Confirm both migration files exactly match reviewed commit `406b53c2...`.

If production differs materially or destructive correction would be needed, STOP before writes.

Known migration-history divergence remains. Therefore:
- never run `supabase db push`
- do not repair/reconcile migration history
- do not mark unrelated versions applied/reverted

The broad table-grant finding (`anon` / `authenticated` including TRUNCATE-like privileges despite RLS) is outside this Phase 3I scope. Do not change it here. Record it separately for owner review unless it directly blocks the two approved migrations.

## Exact migration application

Apply in this order only:
1. `20260913123509_ai_lab_prelive_safeguards.sql`
2. `20260913151428_read_ai_lab_x_vault_token.sql`

No other SQL/migration is authorized.

Immediately read back and verify:

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
- fixed account id/brand/platform/handle/identity_verified checks
- only accepts secret refs belonging to the AI Lab account's access/refresh ref columns
- do not output or inspect decrypted token values in Report/logs

If either migration fails transactionally, do not improvise broad fixes; inspect rollback/read-back and STOP.

## `x-test-post` deployment

Only after both migration read-backs pass:
- deploy **`x-test-post` only**
- deploy reviewed source at commit `406b53c2a2838a5ac2a446fffb6e6feef954eb7a`
- preserve current production auth mode; if current config is `verify_jwt=false`, keep `--no-verify-jwt`
- do not deploy any other Edge Function
- download/read back deployed runtime files and byte-compare against exact source commit
- verify unrelated Functions' versions/updated_at remain unchanged where practical

## Non-posting verification after deploy

No real/test X post is authorized.

Allowed verification:
- dry-run/admin request that cannot pass publish gate
- read-only metadata route checks
- verify AI Lab resolves to `ai_salaryman_lab_x` / `kaishain_ai_lab`
- verify publish gate remains blocked by `dry_run` / `publish_enabled=false`
- verify 280-character rule through dry-run/runtime evidence without dispatching to X
- verify no Kabumori legacy token fallback
- verify no fingerprint row is inserted by dry-run
- verify X POST/media calls remain 0

Do not call the Vault reader merely to reveal/check token values. Do not refresh tokens.

## Posting window

Do not create/update/enable an AI Lab posting_window in this task. Exact source-of-truth values are still required:
- post_type confirmation
- timezone
- local start/end time or exact desired posting time(s)
- slot count / slot numbers
- `daily_probability` per slot

No Cron change.

## OAuth/write scope boundary

Still do not add/request `tweet.write` or `media.write`.

Next-step requirement after Phase 3I:
- text posting needs `tweet.write` while retaining `tweet.read users.read offline.access`
- reauthorization must verify `/2/users/me` remains `kaishain_ai_lab` before replacing usable token refs
- `media.write` remains unnecessary until a media-upload feature is intentionally enabled

## Strictly prohibited

- AI Lab real/test X post or media upload
- `publish_mode=live`
- `publish_enabled=true`
- OAuth reauthorization or scope change
- `tweet.write` / `media.write` addition
- token refresh/liveness write test
- posting_window insert/update
- Cron changes
- Kabumori OAuth/token/handle/publish/Cron mutation
- Mio changes
- any non-Phase-3H migration/RPC/schema change
- `supabase db push`
- migration-history repair/reconcile
- broad privilege cleanup from the unrelated table-grant finding
- exposing token/secret/password/2FA values

## Tests / verification

Before production writes, rerun relevant local tests from reviewed source where environment permits:
- Phase 3H brand/shared tests
- `x-test-post` relevant suite
- `git diff --check`
- changed-file `deno check` or baseline-equivalence evidence for existing diagnostics

After rollout, record:
- exact project ref
- preflight results
- exact SQL files applied and actual recorded migration versions/names if tooling assigns generated values
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
- both exact Phase 3H migrations safely applied/read back
- reviewed `x-test-post` deployed and byte-verified
- AI Lab still dry_run + publish_disabled
- OAuth write scopes still absent
- no posting window/Cron changes
- no X/media write
- no Kabumori/Mio regression
- next live-post prerequisites explicitly documented

Phase 3I does **not** authorize live publishing or the first real X post.
