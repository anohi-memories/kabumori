# Claude Task 3

- task_id: x-stage3b-publish-authority-and-ai-lab-exclusion-fix-20260927
- owner: claude
- slot: claude-3
- status: done
- next_owner: none
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: C1 FAILとなったPR #41 Stage 3B準備を修正する。bounded pilotを本当に「投稿停止」できる明示的publish authority/timeboxへ分離し、generic completion RPCからAI Labを明示除外する。source/test only。production activationはしない。

## Review source

- PR #41 reviewed head: `cd7adf5d1eb5a91773f21c7d8959766e1dd38229`
- H1 verdict: FAIL
- production mutation: 0

## Blocking findings to fix

### P1 — rollout refresh authority is not publish authority

Existing Stage 3A rollout OFF/PILOT/ENABLED gates refresh begin, not access-token read/X create.

Therefore a still-valid token can post when:
- rollout is off
- pilot expiry has passed
- pilot generation ceiling is exhausted
- rollout rollback has begun but brand/account disablement has not yet completed

Do NOT silently reinterpret Stage 3A refresh rollout as a publish gate for AI Lab.

Implement a separate explicit publish authority for Stage 3B generic Vault-backed brand_post only.

Required contract:
- checked immediately before generation/X publish and again immediately before X create if necessary to close TOCTOU
- exact social_account_id scoped
- no brand-first/first-row fallback
- no environment fallback
- fail closed when no publish-authority row
- bounded pilot start/end or equivalent explicit expiry
- explicit enabled/off/revoked state
- owner/user consent revocation must stop new posts
- admin disable / publish_enabled false / brand inactive must stop new posts
- revocation/off must stop new X creates even if access token is still valid
- pilot expiry must stop new X creates even if token is still valid
- refresh generation ceiling remains a refresh control only; do not mislabel it as publish lifetime
- AI Lab current production path/authority must remain behaviorally unchanged unless separately designed and approved
- Kabumori legacy path unchanged

Prefer the smallest clean schema/authority model that reuses existing account identifiers and consent settings. Do not invent a broad public policy system.

### P2 — generic completion RPC must exclude AI Lab

Update `complete_vault_account_brand_post` so it refuses:
- Kabumori
- AI Lab
- wrong account
- wrong brand
- non-running row
- rows belonging to legacy/specialized paths

Add the exact regression H1 described:
- matching AI Lab brand_post row + matching `ai_salaryman_lab_x` must still return/not-found/fail-closed and must not write fingerprint/log.

## Product contract for this task

For the Stage 3B pilot, the bounded pilot means:
- consent + admin enablement + explicit Stage 3B publish authority are all required
- expiration or revocation of any one gate stops NEW X posts
- rollback's first safety mutation should be the publish authority OFF/revoked gate because that gate must itself be sufficient to prevent new X creates
- subsequent brand/account/window disablement is defense in depth and cleanup
- owner consent is still required before any future production activation

This source task does NOT record real owner consent or activate a pilot.

## Mandatory startup

1. Read `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK, latest G3 report, latest H1/C1 report.
2. Use independent G3 worktree.
3. Fresh fetch origin/main and PR #41.
4. Read current Supabase skill and current relevant docs/changelog.
5. Verify PR #41 head before modifying.
6. Do not touch G4/PR #33.

## Tests required

At minimum add/verify:

1. valid token + publish authority missing => no generation/X create.
2. valid token + publish authority off/revoked => no X create.
3. valid token + publish pilot expired => no X create.
4. valid token + refresh generation ceiling exhausted but publish authority still valid:
   - if no refresh is required, behavior must follow explicit publish policy, not accidental refresh policy.
   - document the intended result clearly.
5. consent revoked => no X create.
6. brand disabled => no X create.
7. account publish disabled => no X create.
8. wrong account/brand => fail closed.
9. AI Lab cannot enter generic dispatcher/completion path.
10. Kabumori cannot enter generic dispatcher/completion path.
11. generic completion RPC rejects exact matching AI Lab row/account.
12. generic completion RPC rejects cross-account row.
13. rollback publish-authority OFF alone blocks new X create.
14. race/revocation near publish boundary fails closed or has explicitly documented atomicity semantics.
15. AI Lab existing tests unchanged/pass.
16. Stage 3A refresh behavior unchanged/pass.
17. no duplicate claims/posts.

Run:
- x-test-post relevant/full suite
- _shared relevant/full suite
- disposable PostgreSQL behavior/race/ACL tests
- deno check/lint changed files
- bash -n runners
- git diff --check
- targeted secret scan
- advisors for any new DB objects

## Migration/security rules

If a schema change is needed:
- create migration with current Supabase CLI workflow
- disposable/local verification only
- RLS on exposed tables
- SECURITY DEFINER only if truly necessary
- empty/fixed search_path
- revoke PUBLIC EXECUTE
- service_role-only internal mutations where appropriate
- no production apply
- no db push
- no migration repair
- do not replay historical migrations

## Production restrictions

production_mutation=0 required.

Do NOT:
- merge PR #41
- apply migration
- deploy Edge
- set rollout/publish authority in production
- enable candidate account/brand/window
- refresh token
- post to X
- modify AI Lab/Kabumori production state
- touch G4

## Deliverable

Report:
- final PR head
- publish-authority design
- how expiry/revocation blocks valid-token posting
- consent/admin/publish authority interaction
- AI Lab exclusion fix
- changed_files
- schema/migration details
- ACL/security review
- tests/results
- rollback semantics
- production_mutation=0
- whether corrected PR is ready for one focused re-review
- remaining product/operator gates

## Completion / K3

Set:
- status -> review_required
- next_owner -> chatgpt

STOP for K3.

## Report

- task_id: x-stage3b-publish-authority-and-ai-lab-exclusion-fix-20260927
- result: K3 ready — P1/P2 fixed on PR #41; production mutation 0; ready for one focused re-review.
- model: Opus 5.5
- final_pr_head: `6b25305e57bb1d6ad119c06c779042daba210547`（PR #41、reviewed `cd7adf5` + fix commit 1件）
- publish_authority_design（P1）: 新 migration `20260927124300_x_account_publish_authority.sql`（`supabase migration new`）。
  - `x_account_publish_authority`: X アカウントごと1行、`enabled|off|revoked`、`starts_at`/`expires_at`（≤30日）。行なし＝投稿不可。RLS on、service_role は SELECT のみ。
  - `set_x_account_publish_authority`: 唯一の変更経路（SECURITY DEFINER、service_role）。enabled は未終了かつ30日以内の期間が必須。off/revoked はいつでも可で、監査用に最後の期間を残す。kabumori/ai_salaryman_lab のアカウントは拒否。
  - `check_x_account_publish_authority(post, account, brand)`: 単一の投稿判定（SECURITY INVOKER、service_role、stable）。専用ブランド除外 → 実行中 brand_post・同 brand → brand の唯一のアカウント＝指定 → brand active+live → アカウント identity/publish → brand_settings に brand_post → 許可行（off/revoked/未開始/期限切れ）→ 同意（content settings 表なし・行なし・auto_post_preference 以外は拒否）。Vault も refresh rollout も読まない。
- valid_token_blocking: Edge の汎用 dispatcher は、文章生成前（設定読み込み前）と X 作成の直前に判定を2回呼ぶ。期限切れ・取り消し・同意撤回・管理側無効化が2回目の判定より前に commit されていれば、アクセストークンが有効でも X 作成は起きない。
- atomicity: 取り消しは commit 時点で有効。未 commit 中の判定は直前の commit 状態を見る（`PUBLISH_RACE_PASS` で実証）。すり抜けうるのは「取り消し commit 時点で既に2回目の判定を通過していた1件の作成」のみで、以降の投稿はすべて止まる。
- refresh_vs_publish: 独立。publish 有効で refresh 上限到達 → トークン有効な間は投稿可、期限切れ時は refresh 拒否（`X_REFRESH_PILOT_LIMIT_REACHED`、token request 0）で投稿失敗（意図どおり、文書化）。refresh enabled でも publish は許可されない（両方向とも実証）。
- consent_admin_publish_interaction: 3つとも必須（同意 `auto_post_preference`＋管理側有効化＋publish authority）。いずれか1つの期限切れ・取り消しで新規投稿は止まる。rollback の第一手は publish authority `revoked`（それ単独で十分）。以降の brand/account/window 無効化は多重防御と後片付け。
- ai_lab_exclusion（P2）: `complete_vault_account_brand_post` が `brand_id in ('kabumori','ai_salaryman_lab')` を明示拒否。H1 の回帰（AI Lab 自身の実行中 brand_post 行＋`ai_salaryman_lab_x`）→ `VAULT_BRAND_POST_NOT_FOUND`、fingerprint/log の書き込みなし、行は running のまま。加えて publish 判定と setter も両ブランドを拒否し、汎用 dispatcher も brand id で最初に拒否。AI Lab の本番経路・権限（専用 dispatcher と `complete_ai_salaryman_lab_brand_post`、Stage 3A refresh）は不変。
- changed_files: `supabase/migrations/20260927124300_x_account_publish_authority.sql`（新）、`supabase/migrations/20260927101423_vault_account_brand_post_completion.sql`（AI Lab 除外）、`supabase/functions/_shared/brand/vault_account_brand_post.ts`（判定2回・専用ブランド除外・adapter）+`_test.ts`、`supabase/functions/x-test-post/index.ts`（判定の配線のみ）、`supabase/functions/x-test-post/vault_account_brand_post_routing_test.ts`、`supabase/tests/x_account_publish_authority_behavior.sql`（新）、`supabase/tests/x_account_refresh_pilot_{behavior.sql,run.sh}`、`supabase/tests/x_account_refresh_pilot.md`
- acl_security: 新表 RLS on・API ロール権限なし・service_role は SELECT のみ。判定関数は INVOKER（DEFINER 不要）、setter のみ DEFINER（service_role が表に書けないため）。両方 `search_path=''`、PUBLIC/anon/authenticated の EXECUTE なし。advisors（security+performance、使い捨て DB）: 新規オブジェクト起因 0。
- tests:
  - 使い捨て PostgreSQL 17: `PILOT_BEHAVIOR_PASS` / `PUBLISH_AUTHORITY_BEHAVIOR_PASS` / `PILOT_RACE_PASS` / `PUBLISH_RACE_PASS` / `PILOT_CLEANUP_PASS`。TASK 必須 1–17: 行なし・off/revoked・期限切れ・未開始・refresh 上限との独立（両方向）・同意なし/撤回・brand 無効/dry_run・アカウント publish off/未検証・brand_post 無効・誤アカウント/ブランド・AI Lab/Kabumori の判定/setter/完了拒否（書き込みなし）・rollback の revoked 単独で停止・取り消し競合（commit 時点で有効）・二重 claim なし。
  - わざと壊した7パターン全て検出（期限・revoked・同意の確認削除、判定の AI Lab 許可、行なし許可、完了の AI Lab 許可、dry_run 許可）。
  - 既存: rollout / core / Phase1I 検証 PASS（Stage 3A refresh 動作不変）。
  - Deno: x-test-post 518/0（routing pin 4）、_shared 154/0（汎用 dispatcher 13）、important-news-monitor 521/0、social-mobile-brand-dry-run 10/0。AI Lab 既存テスト不変・PASS。
  - deno check/lint（変更ファイル）clean、index.ts は既存の6件のみ; `bash -n`; `git diff --check`; secret scan 0
- rollback_semantics: 第一手 `set_x_account_publish_authority('<account>','revoked','PILOT_STAGE3B_ROLLBACK')`（単独で新規 X 作成を停止）→ refresh rollout off → brand 無効 → window 無効 → account publish off → 当該 brand の pending 行を failed（再実行なし）。global gate と AI Lab は触らない。
- production_mutation: 0（本 TASK は読み取りも実施せず、ソース・使い捨て DB のみ）
- re_review_ready: yes — PR #41 head `6b25305` を H1 で1回の集中再レビュー（P1/P2 と §2a の原子性の記述）。
- remaining_gates: owner の対象確認と自動投稿への同意; content settings 表（`20260922045046`）の製品・セキュリティ判断と適用（判定は INVOKER のため service_role の SELECT 付与が必要）; 3B 用 migration 2本の単独適用と Edge デプロイは別 TASK; pilot アカウントの refresh token は 09-23 から未使用（初回 invalid_grant の可能性）。
- next_recommendation: ChatGPT K3 → H1 集中再レビュー（Sol高、範囲は publish authority・AI Lab 除外・原子性）→ owner 同意取得 → 別 TASK で本番有効化。


## Final K3 — Stage 3B publish authority fix

Verdict: **PASS for source correction; focused re-review required before merge/pilot**.

- PR #41 fixed head: `6b25305e57bb1d6ad119c06c779042daba210547`.
- P1 fixed by adding explicit exact-account publish authority/timebox separate from Stage 3A refresh authority.
- valid token no longer bypasses publish off/revoked/expired/consent/admin disable gates; authority is checked before generation and immediately before X create.
- rollback first step `revoked` is independently sufficient to block new X creates.
- refresh generation ceiling remains refresh-only and is not misrepresented as publish lifetime.
- P2 fixed: AI Lab and Kabumori are explicitly excluded from generic publish setter/check/completion path; matching AI Lab row/account regression now fails closed with no fingerprint/log write.
- disposable DB behavior/race/ACL and Deno suites PASS; AI Lab and Stage 3A regressions PASS.
- production mutation=0.
- one focused H1 re-review is required only for the prior P1/P2 findings and publish-boundary atomicity.
