# Codex Task

- task_id: x-multibrand-phase3i-runtime-reconciliation-deploy-20260914
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
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
- at the time of C1 review, production was x-test-post v107 / verify_jwt=false; the approved deployment result is recorded below

## Production state already completed

The following two migrations are already applied and MUST NOT be reapplied, replaced, repaired, or reconciled:
- `20260913123509_ai_lab_prelive_safeguards.sql`
  - production recorded version `20260913230852`
- `20260913151428_read_ai_lab_x_vault_token.sql`
  - production recorded version `20260913231013`

Their RPC/index/ACL/SECURITY DEFINER/empty search_path read-back already passed.

## Direct deploy authorization — 2026-09-14

The user directly approved the following production action on 2026-09-14:

**Deploy only `x-test-post` from exact commit `c4eb2855f2adc66e5518feaa51eef63bbf139e4d` to the existing production project, preserving `verify_jwt=false`, then perform source read-back/byte verification and non-posting verification.**

This authorization does NOT include any other production change.

## Latest execution status — 2026-09-14

- Deployment completed under the user's direct, exact-scope approval. Only `x-test-post` from candidate commit `c4eb2855f2adc66e5518feaa51eef63bbf139e4d` was deployed; production is ACTIVE v108 with `verify_jwt=false`.
- Immediate read-back returned 39 runtime files, aggregate SHA-256 `5d26b55b0d9474807b152e59461866b52d146fe26a4284dd2f1657abe61f4fef`; every file matched the exact candidate bytes (39/39, no missing, mismatched, or extra files).
- Compared with the pre-deploy snapshot, only `x-test-post` changed (v107 → v108). All other observed Function versions remained unchanged.
- One approved non-posting smoke call returned HTTP 200, `mode=dry_run`, `published=false`. This exercised the synthetic Kabumori voice preview branch, not the AI Lab scheduled-brand branch; `voiceEvaluation.passed=false` was returned by the preview evaluator. It did not reach DB claim, token, X POST, or media-upload paths. The AI Lab-specific production route was not invoked.
- AI Lab read-only state immediately after remained `is_active=true`, `publish_mode=dry_run`, account `ai_salaryman_lab_x`, `connection_status=identity_verified`, `publish_enabled=false`. Fingerprint row count was 0 before and 0 after the dry-run.
- The deployed source retains the C1-reviewed AI Lab 280-code-point guard, fixed Vault-backed account routing, no Kabumori legacy-token fallback, and disabled refresh. The exact candidate's relevant test suite had passed 448/448 in C1; no new test run was needed for this immutable deployment. No token value was read.
- No migration/DB write, other Function deploy, OAuth/scope/token change, Cron or posting-window change, publish flag change, real X post, or media upload was performed. X POST and media-upload calls in this approved verification: 0.
- Candidate worktree's temporary CLI project config and version marker were removed. No implementation source was changed by the deploy/report task.
- H1 is complete for the approved deploy gate and awaits ChatGPT review. First live AI Lab publishing remains unauthorized and requires all separate readiness/approval gates described below.

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
