# Claude Task 2

- task_id: x-multibrand-phase3g-ai-lab-live-readiness-20260913
- owner: claude
- slot: claude-2
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Sonnet 5
- purpose: 会社員AIラボの初回実X投稿直前まで安全に仕上げる。cross-brand dedupeを実データへ接続し、AI Lab posting windowを無効状態で準備し、brand_id→social_account→Vault token refsの実経路をread-onlyで証明する。まだlive化・X実投稿・write scope追加は行わない。

## Source of truth

会社員AIラボの投稿内容・文体・note送客・ブランド運用の正本は、別の「会社員AIラボ」ChatGPTプロジェクト側。今回も本repo側で新しい人格・投稿戦略を創作しない。

## Prior approved state

Phase 3F K2 PASS。

- Phase 3F commits: `b77c8c7` → `215eeff` on `feature/multibrand-foundation`
- `brand-post-dry-run` deployed and byte-verified
- real OpenAI generation confirmed with `brand_id=ai_salaryman_lab`
- AI Lab remains `publish_mode=dry_run`, `publish_enabled=false`
- X write calls = 0
- legacy Kabumori token reads on AI Lab path = 0
- AI Lab OAuth scopes remain read-only: `tweet.read users.read offline.access`
- `20260913130000_fix_post_execution_logs_brand_attribution.sql` production-applied and 10 RPCs read-back verified
- `20260913120000_add_published_content_fingerprints.sql` is still production-unapplied
- posting_windows for AI Lab not yet created
- live Vault token loader path not yet proven end-to-end
- Mio untouched

## Start / parallel safety

Before work:
- read `.agent/ORCHESTRATION.md`
- read `.agent/CURRENT_STATE.md`
- read this TASK
- read other active slot TASK files only for conflict detection
- fresh-check `origin/main`
- fresh-check `origin/feature/multibrand-foundation`
- use isolated clean worktree/clone
- do not touch/stage/commit existing uncommitted changes from another workstream

If any other slot is changing the same migration/RPC/Function/workflow/production config, stop and report the exact conflict.

Use Sonnet 5 normally. If a DB/RPC/Cron redesign or unclear production inconsistency appears, stop before broad changes and recommend Opus.

## Goal

Complete the final non-posting live-readiness layer for AI Lab:

1. safely production-apply `20260913120000_add_published_content_fingerprints.sql` if preflight matches expectations
2. replace synthetic cross-brand probe with a real-data dedupe path suitable for live routing
3. verify recent/published Kabumori content can be fingerprinted/read without cross-tenant leakage
4. prepare AI Lab posting window in production only as disabled/inactive
5. prove `ai_salaryman_lab -> social_account -> Vault token refs` resolution in read-only/no-secret mode
6. identify whether `publish_claims` needs brand-aware work before first live `brand_post`
7. leave AI Lab fully non-live at end

## A. published_content_fingerprints production migration

Migration candidate:
`supabase/migrations/20260913120000_add_published_content_fingerprints.sql`

Before applying:
- inspect exact migration SQL
- read-only preflight live schema for target table/index/function dependencies
- confirm no destructive DDL
- confirm no overlap with another slot
- confirm migration history mismatch does NOT require repair/reconcile

If safe and exact:
- apply only this exact migration
- `supabase db push` prohibited
- migration history repair/reconcile prohibited
- read back table/index/constraints/RLS/grants as applicable
- record exact production change

If live schema differs materially, do not apply; stop and report.

## B. Real-data cross-brand dedupe

Replace Phase 3F synthetic-only proof with a production-like real-data path.

Requirements:
- normalized exact duplicate across different brands must block
- distinct wording about the same broad topic must remain allowed
- same-brand behavior must not be accidentally over-blocked
- no full production post bodies in logs unless strictly necessary
- do not expose secrets
- preserve `brand_id` throughout

Use the new fingerprint table for actual recent published content where safe.

At minimum prove:
- a known published Kabumori post fingerprint can be read/represented
- an AI Lab candidate identical after normalization would block as cross-brand duplicate
- a sufficiently distinct AI Lab candidate would allow
- no Kabumori token/OAuth access is required for dedupe

Do not create a real X post just to test dedupe.

## C. AI Lab posting_windows preparation

Inspect current posting window schema/selection logic first.

Prepare AI Lab schedule only if it can be done without changing Kabumori behavior.

Production row is allowed only when:
- `brand_id=ai_salaryman_lab`
- disabled/inactive (`is_active=false` or exact equivalent)
- no Cron behavior can claim/publish it while inactive
- no existing Kabumori row is edited

Do NOT guess final posting times if not already specified by the AI Lab source-of-truth. If exact times are not known, either:
- create only a structurally valid disabled placeholder with clearly non-operational semantics, if safe, or
- leave DB unchanged and report the exact required input.

No Cron changes in Phase 3G.

## D. Vault token routing read-only proof

Verify the intended live routing:

`brand_id=ai_salaryman_lab`
→ social account lookup
→ Vault access_token/refresh_token references
→ token loader result metadata

Safety:
- do not print token values
- do not refresh tokens unless strictly required for a non-writing verification and explicitly safe
- no X POST/media upload
- no fallback to Kabumori legacy `oauth_token_store`
- no Kabumori OAuth/token mutation

Preferred proof returns only metadata such as:
- brand/account matched
- expected handle/account identity
- token refs present / resolvable
- token source = Vault-backed brand account
- legacy fallback used = false

If validating token liveness would require changing scopes or writing to X, do not do it in this phase.

## E. publish_claims readiness

Inspect whether `brand_post` requires `publish_claims` in the first live path.

- If not required for initial live AI Lab posting, document why and leave unchanged.
- If required and existing logic is Kabumori/default-brand dependent, draft the minimal brand-aware change and tests.
- Do not production-apply a broad publish_claims redesign in this task unless the change is trivially isolated and clearly required; otherwise leave for the next live-post task.

## F. Brand/account isolation

Add/keep tests proving:
- `ai_salaryman_lab` never resolves to `kabumori`
- AI Lab handle is `kaishain_ai_lab`
- Kabumori internal id remains `kabumori`, X handle remains `yume_daka`
- dedupe data lookup is cross-brand content-only, not cross-brand credentials
- AI Lab token route has zero legacy Kabumori token reads
- Mio is unaffected

## Required tests

At minimum:
- fingerprint normalization exact-match tests
- cross-brand real-table/proxy repository tests
- same-brand non-regression
- distinct-text allow case
- AI Lab brand attribution preserved
- AI Lab posting window inactive/non-claimable test if a row/path is added
- Vault route metadata-only test
- legacy Kabumori token fallback = 0 on AI Lab path
- existing Kabumori publish/generation regression tests
- all relevant Edge Function tests
- `git diff --check`
- `deno check` changed files; if blocked by known environment issue, prove same issue on unchanged baseline and report it

## Production changes allowed in Phase 3G

Allowed only after read-only preflight:
- exact `20260913120000_add_published_content_fingerprints.sql` migration
- an AI Lab posting-window row only in disabled/inactive state, if exact schedule semantics are known and safe
- deployment of a narrowly scoped read-only/dry-run helper Function if needed for proof

## Production prohibitions

Strictly prohibited:
- AI Lab `publish_mode=live`
- AI Lab `publish_enabled=true`
- `tweet.write` / `media.write` scope addition
- AI Lab X post/test post/media upload
- Kabumori manual test/retry post
- Kabumori OAuth/token/handle/Cron changes
- Mio changes
- Cron changes
- blind `supabase db push`
- migration history repair/reconcile
- destructive DB change
- secret/token/password/2FA output or storage in Report

## Completion / Report

When finished:
- set status `review_required`
- set next_owner `chatgpt`
- append `## Report`
- safely sync control info to origin/main

Report must include:
- task_id
- result
- model_used
- source_base
- fingerprint_migration_status
- real_data_dedupe_result
- posting_window_status
- vault_token_routing_result
- publish_claims_readiness
- brand_isolation_result
- changed_files
- migrations/rpcs/functions changed
- tests
- production_changes
- deploy_status
- commit_hash
- push
- remaining_issues
- exact steps before first AI Lab live post
- safety_checks
- next_recommendation

## Success gate

Phase 3G PASS requires:
- cross-brand dedupe proven against real production-backed fingerprint data or an equivalently faithful production table path
- AI Lab posting window either safely prepared inactive or explicitly blocked pending exact source-of-truth schedule input
- Vault-backed AI Lab credential routing proven without exposing secrets and with zero Kabumori legacy fallback
- publish_claims requirement for first live post clearly resolved
- Kabumori regression tests pass
- AI Lab remains dry_run + publish_disabled
- X write = 0
- write scopes still absent
- no Kabumori/Mio/Cron regression

Phase 3G does NOT authorize the first live X post. That requires a separate explicit next task and user approval.