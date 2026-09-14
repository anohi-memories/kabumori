# Codex Task

- task_id: x-multibrand-phase3i-runtime-reconciliation-deploy-20260914
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: high
- recommended_model: Sol High
- purpose: C1 PASS済みのreconciled candidate `c4eb2855f2adc66e5518feaa51eef63bbf139e4d` を、本番 `x-test-post` にだけ安全にdeployし、非投稿検証まで行う。live化・write scope追加・実X投稿は行わない。

## C1 result

Phase 3I runtime reconciliation candidate is C1 **PASS**.

Approved deploy candidate:
- repository: `anohi-memories/kabumori`
- branch: `codex/x-multibrand-phase3i-runtime-reconciliation-20260914`
- commit: `c4eb2855f2adc66e5518feaa51eef63bbf139e4d`
- production v107 baseline: `25998fc8927d8bd45a89478b1fec8b4bc5ba782b`

C1 confirmed:
- production v107 source baseline was proven byte-identical 27/27 files
- reconciled candidate preserves all unrelated v107 runtime behavior
- `close_report_data_logic.ts`, `close_report_logic.ts`, `fixed_hashtags_logic.ts` remain at v107 bytes
- only `x-test-post/index.ts` changes among existing v107 runtime files; imported Phase 3H brand modules are added
- AI Lab 280 Unicode-codepoint guard remains enforced before X dispatch
- AI Lab route remains fixed to `ai_salaryman_lab_x` / `kaishain_ai_lab`
- no Kabumori legacy token fallback
- refresh disabled on AI Lab route
- fingerprint completion / duplicate-resend safeguards retained
- 448/448 relevant tests PASS
- deno check diagnostics are baseline-equivalent only
- current production is still x-test-post v107 / verify_jwt=false

## Production state already completed

The following two migrations are already applied and MUST NOT be reapplied, replaced, repaired, or reconciled:
- `20260913123509_ai_lab_prelive_safeguards.sql`
  - production recorded version `20260913230852`
- `20260913151428_read_ai_lab_x_vault_token.sql`
  - production recorded version `20260913231013`

Their RPC/index/ACL/SECURITY DEFINER/empty search_path read-back already passed.

## Direct deploy authorization — 2026-09-14

The user said `おk` after C1 PASS. ChatGPT explicitly authorizes the following production action:

**Deploy only `x-test-post` from exact commit `c4eb2855f2adc66e5518feaa51eef63bbf139e4d` to the existing production project, preserving `verify_jwt=false`, then perform source read-back/byte verification and non-posting verification.**

This authorization does NOT include any other production change.

## Mandatory startup checks

Before deploy:
- read `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK, `.agent/CODEX_REPORT.md`
- fresh-check `origin/main`
- fresh-check exact candidate branch/commit
- verify no other active slot is modifying `x-test-post`
- use isolated clean worktree/clone
- verify project ref and worktree-local Supabase config before deployment
- confirm production is still `x-test-post` v107 / `verify_jwt=false`; if it changed, STOP and report
- do not modify/stage unrelated existing changes

## Authorized action

1. Deploy **only `x-test-post`** from exact candidate commit `c4eb2855f2adc66e5518feaa51eef63bbf139e4d`.
2. Preserve production auth mode `verify_jwt=false` (`--no-verify-jwt` if using CLI convention).
3. Do not deploy any other Edge Function.
4. Immediately read back the deployed Function source/runtime files and byte-compare them against the exact candidate source.
5. Verify version/auth mode and, where practical, that unrelated Function versions/updated_at are unchanged.

If source byte comparison fails or the deploy source is not exact, STOP. Do not improvise another deploy.

## Non-posting verification after deploy

Allowed:
- dry-run/admin invocation that is guaranteed to remain behind `dry_run` / `publish_enabled=false`
- read-only metadata verification
- verify AI Lab resolves to `ai_salaryman_lab_x` / `kaishain_ai_lab`
- verify final 280-character guard through dry-run/runtime evidence without X dispatch
- verify no Kabumori legacy fallback path is used
- verify refresh remains disabled on AI Lab route
- verify dry-run does not insert `published_content_fingerprints`
- verify X POST count = 0 and media write count = 0

Do not invoke the Vault reader merely to expose/check token values. Do not refresh tokens.

## Production boundaries — still strictly prohibited

- no DB migration/write (the two migrations are already applied)
- no `supabase db push`
- no migration history repair/reconcile
- no OAuth reauthorization/scope change
- no `tweet.write` / `media.write` addition
- no `publish_mode=live`
- no `publish_enabled=true`
- no real/test X post or media upload
- no token refresh/liveness test
- no AI Lab posting_window insert/update
- no Cron change
- no Kabumori OAuth/token/handle/publish/Cron mutation
- no Mio change
- no broad privilege cleanup for the separate anon/authenticated grant observation
- no secret/token/password/2FA output

## Completion

If deploy + byte verification + non-posting verification pass:
- update `.agent/CODEX_REPORT.md`
- set this TASK to `status: review_required`, `next_owner: chatgpt`
- safely sync only control/report metadata as needed

Report:
- exact candidate commit deployed
- production Function version after deploy
- verify_jwt state
- runtime file count/hash and byte-compare result
- non-posting verification result
- AI Lab dry_run/publish_enabled state
- 280-char guard evidence
- Vault route / legacy fallback / refresh evidence without token disclosure
- fingerprint dry-run evidence
- explicit X/media write counts
- unchanged components
- remaining requirements before first live post

If any safety check fails, STOP without broadening scope and leave `review_required` with the blocker documented.

## Success gate

This deploy task passes only when:
- exact `c4eb2855f2adc66e5518feaa51eef63bbf139e4d` candidate is deployed to `x-test-post`
- deployed source is byte-verified
- `verify_jwt=false` preserved
- AI Lab remains `dry_run` + `publish_enabled=false`
- OAuth write scopes remain absent
- no posting_window/Cron change
- X/media writes remain 0
- Kabumori/Mio behavior remains unchanged

This task does **not** authorize first live posting.