# Codex Task

- task_id: x-multibrand-phase3h-ai-lab-prelive-safeguards-20260913
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sol High
- purpose: 会社員AIラボの初回live投稿前に、280文字制限・fingerprint永続化・Vault-backed dispatch配線・posting window準備を安全に仕上げる。実X投稿、live化、write scope追加はまだ行わない。

## Source of truth

会社員AIラボの実際の投稿内容・文体・note送客・ブランド運用の正本は別の「会社員AIラボ」ChatGPTプロジェクト側。
本repoで人格や投稿戦略を新しく創作しない。

今回ユーザーから追加で確定した要件:
- 現在の会社員AIラボX運用は **280文字以内** が必須。
- 将来アプリ化する際は「280文字以内モード」と「無制限モード」を選べる設計にしたい。
- 固定ハードコードだけで終わらせず、将来ユーザー設定へ一般化しやすい `max_chars` / length mode 相当で設計する。

## Prior approved state

Phase 3G K2 PASS。

- Phase 3G commits: `8f3b789` -> `341e5dc` on `feature/multibrand-foundation`.
- `published_content_fingerprints` table is production-applied and read-back verified.
- `brand-post-dry-run` is deployed and byte-verified.
- real-data cross-brand dedupe proven against 4 real Kabumori published report bodies.
- Vault routing metadata proof succeeded for `ai_salaryman_lab_x` / handle `kaishain_ai_lab`.
- access/refresh Vault refs present; secret values were not read or exposed.
- legacy Kabumori fallback = false / legacy token reads = 0 on AI Lab path.
- `publish_claims` is not required for `brand_post` initial live path.
- AI Lab remains `publish_mode=dry_run`, `publish_enabled=false`.
- OAuth scopes remain read-only: `tweet.read users.read offline.access`.
- posting_windows row for AI Lab has not been added because exact schedule is not yet source-of-truth confirmed.
- Mio untouched.

## Start / parallel safety

Before work:
- read `.agent/ORCHESTRATION.md`
- read `.agent/CURRENT_STATE.md`
- read this TASK
- read other active slot TASK files only for conflict detection
- fresh-check `origin/main`
- fresh-check `origin/feature/multibrand-foundation`
- use isolated clean worktree/clone
- do not touch/stage/commit unrelated existing changes

If another slot is modifying the same Function/RPC/migration/workflow/production config, stop and report exact overlap.

## Goal

Complete the final safeguards before a separately-approved first live AI Lab post:

1. enforce AI Lab X text length <= 280 chars at generation/output boundary
2. design the length rule so future app users can choose a finite max-char mode or unlimited mode
3. ensure over-limit content can never reach X dispatch even if the model ignores prompt instructions
4. wire successful live publish path to `published_content_fingerprints` safely, without changing current dry-run behavior
5. connect AI Lab live dispatch to Vault-backed brand tokens with no fallback to Kabumori legacy storage
6. prepare posting_windows only if exact source-of-truth schedule input exists; otherwise leave production unchanged and report required fields
7. leave AI Lab non-live at task end

## A. Length mode / 280-char enforcement

Implement a generic length policy suitable for later app use.

Preferred semantics:
- finite mode: `max_chars` is a positive integer, AI Lab currently 280
- unlimited mode: explicit null/none/unlimited semantic, not a magic huge number
- generation prompt should request staying within the configured limit
- after generation, server-side validation is mandatory
- if over the limit, either one controlled regeneration/shortening attempt or a deterministic fail-closed error is allowed
- never silently truncate in a way that can cut URLs, mentions, hashtags, multibyte text, or sentence meaning
- final dispatch must independently reject text exceeding configured limit

Character counting must match the product rule selected for this task and be deterministic. Document whether counting is JS Unicode code points or another rule. Do not claim X weighted-length parity unless actually implemented and tested.

Required tests:
- 279/280 allowed
- 281 blocked or regenerated then revalidated
- Japanese text
- emoji / surrogate-pair case
- unlimited mode bypasses finite limit but still preserves other safety gates
- Kabumori existing content remains unaffected unless explicitly configured

## B. Fingerprint persistence on successful live publish

`published_content_fingerprints` exists in production.

Implement the narrowest safe persistence hook so that after a successful X publish, the normalized/hash fingerprint can be recorded with correct brand/account/post metadata.

Requirements:
- write only after confirmed publish success, never before
- preserve `brand_id`
- no full text needs to be stored if schema/hash design does not require it
- failure to persist fingerprint must not cause duplicate X re-posting; define and test failure semantics
- no historical backfill required in this task
- current dry-run must not insert fingerprint rows
- no synthetic production X post merely to test this path

If the existing publish architecture makes this unsafe to wire without a broader refactor, stop and report a minimal next-step design rather than broadening scope.

## C. Vault-backed live dispatch routing

Wire the AI Lab live dispatch path to the brand-specific Vault-backed token loader.

Requirements:
- `brand_id=ai_salaryman_lab` resolves only to `ai_salaryman_lab_x`
- expected handle remains `kaishain_ai_lab`
- token values must never be printed/logged/reported
- no fallback to Kabumori legacy `oauth_token_store`
- Kabumori behavior must remain unchanged
- Mio unchanged
- this task may test routing with mocks/read-only metadata but must not send an X post

Do not refresh/change scopes unless a non-writing liveness check is both necessary and explicitly safe. If write-scope absence blocks a deeper proof, record it as the expected next gate.

## D. Posting windows

Do not invent schedule values.

If exact AI Lab posting time(s), slot count, and daily_probability are not already available from the source-of-truth:
- do not create production row
- report exact fields needed

If exact values are available and an inactive row can be added without affecting Kabumori:
- only `brand_id=ai_salaryman_lab`
- only `is_active=false`
- no Cron change
- read-back after insert

## E. Write scope preparation

Do not add `tweet.write` / `media.write` in this task.

Document exactly what OAuth scope change/re-authorization will be required for the first live post and how to verify the returned identity is still `kaishain_ai_lab` before enabling publishing.

## F. Non-live end state

Task must end with:
- `publish_mode=dry_run`
- `publish_enabled=false`
- no X POST/media upload
- no write-scope addition
- no Cron change
- no Kabumori OAuth/token mutation
- no Mio mutation

## Required tests

At minimum:
- generic length-policy unit tests, including 279/280/281 and Japanese/emoji
- AI Lab generation obeys max_chars or fails closed
- dispatch-level independent over-limit rejection
- unlimited mode behavior
- fingerprint persistence only after publish success
- fingerprint failure semantics prevent duplicate resend
- AI Lab Vault route uses brand account and no legacy fallback
- Kabumori regression tests
- all relevant Edge Function tests
- `git diff --check`
- `deno check` changed files; known baseline-only issues may be reported with proof

## Production rules

No production change is automatically authorized by this task except read-only verification.

Before any production DB write or deploy, stop and request explicit user approval with exact scope.

Strictly prohibited without separate approval:
- AI Lab `publish_mode=live`
- AI Lab `publish_enabled=true`
- `tweet.write` / `media.write` addition
- AI Lab real/test X post or media upload
- Kabumori manual post/retry
- Kabumori OAuth/token/handle/Cron change
- Mio change
- Cron change
- blind `supabase db push`
- migration history repair/reconcile
- destructive DB changes
- exposing any secret/token/password/2FA value

## Completion / Report

When implementation is complete:
- status: `review_required`
- next_owner: `chatgpt`
- update `.agent/CODEX_REPORT.md`
- sync control metadata safely

Report must include:
- task_id
- result
- model_used
- source_base
- length_policy_design
- ai_lab_280_char_result
- unlimited_mode_design
- dispatch_length_guard_result
- fingerprint_persistence_result
- vault_dispatch_routing_result
- posting_window_status
- write_scope_readiness
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

Phase 3H PASS requires:
- AI Lab finite 280-char mode enforced server-side
- future unlimited mode represented cleanly
- over-limit text cannot reach dispatch
- fingerprint persistence path is safely prepared/wired for successful live publish without dry-run writes
- Vault-backed AI Lab routing is wired with zero legacy fallback
- posting window either safely prepared inactive from confirmed inputs or explicitly left unchanged pending source-of-truth
- AI Lab remains dry_run + publish_disabled
- X writes remain 0
- write scopes remain absent
- no Kabumori/Mio/Cron regression

Phase 3H does NOT authorize the first live X post.

## H1 execution note — 2026-09-13

- result: `review_required` / partial. Generic 280-character enforcement and local fingerprint completion preparation are implemented on `codex/ai-lab-prelive-safeguards-20260913` (`6ce4ad8`).
- The final AI Lab Vault-backed X dispatch was not integrated. A safety review blocked edits that would add Vault token reads and a live X-post path to `x-test-post`; no workaround was attempted. This task remains incomplete pending explicit approval for that code-only integration.
- No migration was applied, no Edge Function deployed, and no production setting/scope/Cron/posting window/X post changed.
