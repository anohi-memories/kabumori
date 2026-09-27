# Claude Task 3

- task_id: x-universal-oauth-refresh-stage3b-second-account-pilot-prep-20260927
- owner: claude
- slot: claude-3
- status: done
- next_owner: none
- priority: high
- recommended_model: Opus5.5（高）
- purpose: Stage 3Aで本番実証済みのUniversal X OAuth refreshを、2つ目の実アカウントへ安全に広げるStage 3B pilot準備を行う。今回は候補確認・投稿経路一般化・pilot契約・テスト・ロールバック設計まで。2つ目アカウントの本番有効化はまだ行わない。

## Current production baseline

Stage 3A is fully live:
- PR #38 merged -> `6717b1fe451db83f80e837bf8104268a2b00423d`
- production x-test-post v125
- Stage 3A DB rollout authority live
- AI Lab only = `enabled`
- one natural AI Lab expiry-cycle observed successfully
- proactive refresh generation 6 -> 7
- no duplicate / second401 / uncertain / reauth / stuck
- cross-account check PASS
- Kabumori remains legacy non-Vault
- migration-history debt remains; blind db push / repair prohibited

Known next gap:
- second real account exists as a potential candidate, but Stage 3B publish/content path is not yet proven/generic enough for a controlled pilot.

## Goal

Prepare a safe Stage 3B controlled second-account pilot without activating it yet.

Deliver a source/test/operational package that makes the next production step narrowly auditable:
- exact pilot candidate identified
- account-bound publish path defined
- no brand-first / first-row fallback
- pilot mode semantics proven
- one-account-only rollout mutation procedure defined
- one natural refresh observation procedure defined
- rollback procedure defined

## Mandatory startup

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - latest G3 Stage 3A final report
   - latest H1/C1 Stage 3A report
2. Use an independent G3 worktree/checkout.
3. Fresh fetch `origin/main`.
4. Read current Supabase skill.
5. Fetch current Supabase changelog/docs relevant to:
   - Edge Functions
   - Postgres/RLS/RPC
   - secrets/env
6. Check current CLI version and relevant `--help`.
7. Do not touch G4/Admin Auth PR #33 files.

## Stage 0 — candidate assessment (read-only)

Inspect production safely and identify whether there is exactly one suitable second X account for pilot.

Required checks:
- user/account ownership and intended project/brand binding are unambiguous
- exact `social_account_id`
- platform = x
- identity verified
- publish status and why it is currently disabled/off if applicable
- credential refs present and distinct
- no shared credential refs
- no current refresh lease
- no terminal connection error
- not Kabumori legacy account
- not AI Lab
- no conflicting scheduler/dispatcher ownership

Do not expose token values, secret IDs, Authorization headers, or provider bodies.

If no suitable second account is unambiguous:
- do not guess
- continue with generic source/test preparation
- report candidate selection as a user/operator gate

## Stage 1 — account-bound publish path preparation

Inspect the current `x-test-post` / scheduler / content dispatcher architecture.

Implement the narrowest source change needed so a second Vault-backed X account can be published through the same exact-account auth/refresh machinery without:
- hardcoded AI Lab identity
- brand-first lookup
- first-row fallback
- env token fallback
- legacy token-store fallback
- cross-account content/account mismatch

Requirements:
- publish attempt must resolve one exact `social_account_id`
- content ownership and account ownership must match
- account rollout authority must be checked before Vault/token use
- existing AI Lab path must remain behaviorally unchanged
- Kabumori legacy path must remain unchanged

If a generic account-bound path already exists and only wiring/tests are missing, do not create a parallel path.

## Stage 2 — pilot mode contract

Use existing Stage 3A `pilot` mode.

Define and test a safe default pilot policy for the second account:
- finite expiry
- finite refresh generation ceiling
- unresolved error blocks pilot
- missing rollout row/off fails closed
- only the exact account may be mutated
- global env gate remains kill switch only, never authority

Do not set the real production rollout row in this task.

## Stage 3 — scheduler/content safety

Prove the second account cannot:
- claim AI Lab content
- claim Kabumori content
- publish another brand's scheduled row
- reuse another account's credentials
- receive duplicate claims

If schema currently lacks enough account binding for this, implement the smallest source/schema preparation necessary, but keep production apply out of scope.

Any schema change:
- create migration with current Supabase CLI workflow
- disposable DB only
- no production apply
- no db push
- no migration repair

## Stage 4 — tests

At minimum prove:
1. AI Lab enabled + second account off => only AI Lab can refresh.
2. second account pilot + AI Lab enabled => each account resolves only itself.
3. second account off/missing rollout => zero Vault read / zero token request.
4. wrong account/content pairing => fail closed before X.
5. wrong brand/account pairing => fail closed.
6. missing credential refs => fail closed.
7. invalid_grant affects exact second account only.
8. uncertain refresh commits no credential.
9. pilot expiry / generation ceiling blocks correctly.
10. concurrent refresh lease remains account-local.
11. second account cannot mutate AI Lab state.
12. AI Lab cannot mutate second account state.
13. Kabumori legacy path unchanged.
14. no duplicate claim/post from pilot path.

Run:
- x-test-post relevant tests
- _shared relevant tests
- scheduler/dispatcher/account-binding tests
- disposable PostgreSQL behavior/race tests if DB changes
- tsc/check/lint as applicable
- git diff --check
- targeted secret scan
- advisors if DB objects are added/changed

## Stage 5 — production pilot plan only

Write the exact next-step Stage 3B production activation procedure, but DO NOT execute it.

The plan must include:
- exact pilot account identifier
- preflight
- exact rollout setter call
- pilot expiry
- generation ceiling
- content/scheduler enablement step, if needed
- one natural post observation
- one natural expiry/refresh observation
- exact rollback to OFF
- hard-stop conditions
- cross-account verification
- no historical replay

Hard stops for future pilot:
- account mismatch
- shared credential refs
- unexpected eligible account
- duplicate claim/post
- second 401
- invalid_grant
- uncertain token response
- stuck lease
- credential commit mismatch
- cross-account mutation

## Production restrictions

This task is SOURCE/PLAN-FIRST.

Allowed:
- read-only production inspection
- source changes
- migration file creation if strictly needed
- local/disposable DB tests
- PR creation/update
- test/CI/Preview verification

Not allowed:
- changing second account publish_enabled
- changing second account rollout row
- setting pilot/enabled in production
- manual token refresh
- manual X post
- Edge production deploy
- production DB migration apply
- migration repair
- db push
- replaying historical posts
- changing AI Lab rollout
- changing Kabumori credentials
- touching G4/Admin Auth work

## Deliverable

Report:
- exact candidate assessment
- whether candidate is ready or operator-gated
- architecture/path used for second account
- changed_files
- schema changes if any
- tests/results
- pilot policy
- scheduler/content isolation proof
- migration-history implications
- production mutation=0
- exact Stage 3B activation/observation/rollback plan
- remaining risks
- next recommendation

## Completion / K3

Set:
- status -> review_required
- next_owner -> chatgpt

STOP for K3.

## Report

- task_id: x-universal-oauth-refresh-stage3b-second-account-pilot-prep-20260927
- result: K3 ready — Stage 3B source/test/plan package complete in PR #41; candidate identified but **owner/product-gated**; production mutation 0.
- model: Opus 5.5
- push/PR: branch `claude/g3-stage3b-pilot-prep`, PR https://github.com/anohi-memories/kabumori/pull/41, commit `cd7adf5`
- candidate_assessment (read-only): 唯一の候補 `sa_bfdab0e0696ec8e56ed2dd83`（handle `yumeyoasobi`、brand `u_ae343f5caedb67d4af33fc7a`、profile `social_mobile_user_v1`、membership owner 1名）。identity_verified・platform user id あり・接続エラーなし、自分専用の access/refresh 参照あり・別物・共有なし（全体 shared 0）、refresh state なし・lease なし・rollout 行なし（=off）。publish_enabled=false、brand inactive/disabled、brand_settings 行なし、posting window なし、scheduled posts なし。Kabumori/AI Lab ではない。
- candidate_readiness: operator-gated — (1) owner がこのアカウントを pilot 対象として確認し自動投稿に同意、(2) 同意の保存先 `social_mobile_content_settings`（候補 migration `20260922045046`）が本番に未デプロイ、(3) brand/account/windows は管理側で意図的に無効。
- architecture: 新しい並列 auth は作らず、既存の exact-account port（VaultAccountXAuth + Stage 3A DB 判定）を再利用。`x-test-post` の brand_post で AI Lab 以外 → 新 `dispatchVaultAccountScheduledBrandPost`（`_shared/brand/vault_account_brand_post.ts`）。生成・X 前の関門: 承認済み profile（`social_mobile_user_v1` のみ、brand の key と一致必須）→ 実行中投稿の exact account（port のアカウント＝context のアカウント、同 brand、platform x）→ brand_settings で brand_post 有効＋brand live＋account publish_enabled → ユーザー同意（brand 自身の content settings `approvalMode='auto_post_preference'`）。生成は利用者設定＋投稿用長さ上限 140 コードポイント（X の重み付き上限内）、NG 語・ブランド横断重複チェック、X 作成1回、完了は新 RPC。AI Lab dispatcher/完了 RPC・Kabumori legacy は不変。
- changed_files: `supabase/functions/_shared/brand/vault_account_brand_post.ts`（新）+`_test.ts`（新）、`supabase/functions/x-test-post/index.ts`（brand_post 分岐のみ）、`supabase/functions/x-test-post/vault_account_brand_post_routing_test.ts`（新）、`supabase/migrations/20260927101423_vault_account_brand_post_completion.sql`（新）、`supabase/tests/x_account_refresh_pilot_{behavior.sql,run.sh}`（新）、`supabase/tests/x_account_refresh_pilot.md`（新）
- schema_changes: `complete_vault_account_brand_post(uuid,text,text,text)` のみ（SECURITY DEFINER、search_path=''、service_role のみ）。実行中の brand_post 行で、その brand の唯一の X アカウント＝指定アカウントの時だけ完了、Kabumori/Phase1B 結合行は拒否、fingerprint はその brand/account のみ、再報告は冪等、pending/終了行は拒否。Stage 3A 必須・二重適用拒否。
- pilot_policy: 既存 Stage 3A `pilot`: `set_x_account_refresh_rollout('sa_bfdab0e0696ec8e56ed2dd83','pilot','PILOT_STAGE3B', now()+7 days, 3)` — 期限付き・上限3回・未解決エラーで停止・行なし/off は拒否・対象アカウントの行だけ変更。env gate は緊急停止のみ。
- isolation_proof / tests:
  - 使い捨て PostgreSQL 17（本番形状 fixture＋2つ目アカウント `sa_pilot`＋本番形状の fingerprint/log 表＋本番 claim 手順のコピー）: `PILOT_BEHAVIOR_PASS` / `PILOT_RACE_PASS`（AI Lab と pilot の lease は並行で独立、2つ目の pilot lease は拒否、同一行を3並列 claim → 1件のみ）/ `PILOT_CLEANUP_PASS`。TASK 項目 1–14 を全て証明（off=Vault 読み取り0、相互に相手の lease/commit/release 不可、invalid_grant は pilot のみ、uncertain は未保存、上限で Vault 読み取り0、Kabumori は begin/完了とも拒否、完了は1件・冪等）。わざと壊した4パターン全て検出。
  - 既存: rollout / core / Phase1I 検証 PASS
  - Deno: x-test-post 517/0（routing pin 3 含む）、_shared 151/0（汎用 dispatcher 10 含む）、important-news-monitor 521/0、social-mobile-brand-dry-run 10/0
  - deno check/lint: 変更ファイル clean（index.ts は既存の6件のみ）; advisors（使い捨て DB）: 新規 0; `bash -n`; `git diff --check`; secret scan: 一致は長い識別子名のみ（秘密なし）
- migration_history_implications: `20260927101423` も未記録のローカル専用に加わる（`db push` 禁止継続）。二重適用拒否・live オブジェクトにのみ依存。content-settings 候補 `20260922045046` も未適用で、適用は別の製品判断。
- production_mutation: 0（読み取りのみ。publish/rollout/brand/migration/deploy/手動投稿・更新 なし）
- stage3b_plan: `supabase/tests/x_account_refresh_pilot.md` §6 — 事前ゲート（owner 同意・content settings 適用・3B migration 適用と Edge デプロイ）、preflight、有効化5手順（rollout pilot → brand_settings → posting window 1枠 → publish_enabled → 最後に brand live）、観測1（初回投稿＝初回 reactive refresh gen 0→1）、観測2（翌日の期限切れ proactive gen 1→2）、hard stop 一覧、OFF への正確な巻き戻し5手順（履歴の再実行なし）。
- remaining_issues: 同意の契約（auto_post_preference＋管理側有効化）は製品判断として要確認; content settings 表が本番未配置; 140 文字上限は保守的; pilot アカウントの refresh token は 09-23 から未使用で invalid_grant の可能性（hard stop → owner 再接続）; pilot 投稿の生成費用は共有 OpenAI キー。
- safety_checks: G3 専用 worktree のみ、G4/Admin Auth PR #33 不接触、token/secret 値・secret ID 非表示、本番は読み取りのみ
- next_recommendation: ChatGPT K3 → owner に候補アカウントの確認と同意を依頼 → Codex レビュー（PR #41）→ content settings 適用の製品判断 → Stage 3B 本番有効化 TASK（§6 手順）。


## Final K3 — Stage 3B pilot prep

Verdict: **PASS for source/plan preparation; production activation remains gated**.

- PR #41 head `cd7adf5d1eb5a91773f21c7d8959766e1dd38229` is OPEN and mergeable.
- one candidate was identified read-only: `sa_bfdab0e0696ec8e56ed2dd83` / handle `yumeyoasobi`; exact account/brand ownership is unambiguous, credentials are account-local, no lease/error, rollout row absent=off.
- candidate is not production-ready yet because owner consent/product enablement is required and the content-settings contract is not yet live.
- generic exact-account brand_post routing was added without creating a parallel auth path; AI Lab and Kabumori paths remain unchanged.
- new completion RPC is service_role-only SECURITY DEFINER with empty search_path and exact brand/account completion semantics.
- Stage 3B isolation/race/off/pilot/invalid_grant/uncertain/Kabumori regression tests PASS; production mutation=0.
- because this adds a new multi-account publish path and a SECURITY DEFINER RPC across the cross-account boundary, one consolidated H1 review is required before any merge/production pilot.
