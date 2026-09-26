# Claude Task 3

- task_id: x-universal-oauth-refresh-stage3a-rollout-foundation-20260926
- owner: claude
- slot: claude-3
- status: done
- next_owner: none
- priority: high
- recommended_model: Opus5.5（高）
- purpose: AI Labでproduction実証済みのUniversal X OAuth refreshを、将来の全ユーザー運用へ安全に広げるためのStage 3A rollout foundationを実装する。全ユーザー一括ONはしない。

## Background

Stage 0–2 production rollout completed:
- x-test-post v121 live
- reviewed core refresh migration live
- AI Lab scheduled posts recovered
- refresh generation 0→1→2 proven under real expiry/401 behavior
- Kabumori legacy path unchanged
- cross-account mutation 0
- current global refresh gate is ON for existing eligible Vault-backed flow

Known risk:
- current gate can affect future Vault-backed + publish-enabled accounts if they become active
- this is not sufficient as a public multi-user rollout control
- core migration SQL is live but migration history entry is absent; do not blind db push/repair

## Goal

Build the source/schema/observability foundation required so rollout can be controlled **per X account**, not merely by one global environment gate.

Stage 3A must make it possible to safely classify each X account as:
- not eligible / off
- controlled pilot
- generally enabled

Exact schema naming is an implementation decision after inspecting current conventions. Do not invent a parallel authorization model if an existing field/state can safely represent this.

## Mandatory startup

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - prior G3 Stage 0–2 report
   - prior H1/C1 OAuth/Vault/concurrency review
2. Use an independent G3 worktree/checkout.
3. Fresh fetch `origin/main`.
4. Read current Supabase skill.
5. Fetch current Supabase changelog index and relevant docs before implementing:
   - Edge Functions
   - secrets/env handling
   - Postgres/RLS/SECURITY DEFINER
   - migration workflow/history
6. Check current Supabase CLI version and discover needed commands with `--help`.
7. Do not touch G4/Admin Auth PR #33 files.

## Stage 3A requirements

### A. Explicit account-level rollout authority

Introduce one explicit source of truth for whether an X account may use universal Vault refresh.

Requirements:
- global env gate alone must never be enough for a newly eligible account
- eligibility must be exact-account scoped
- no brand-first fallback
- no first-row fallback
- no implicit "publish_enabled means refresh enabled" shortcut
- no cross-account credential lookup
- disabled/unconfigured accounts fail closed before token refresh

Prefer a small durable DB field/state on the exact social account or a dedicated tightly scoped rollout table, whichever fits the existing model best.

If schema is changed:
- RLS/GRANT/SECURITY DEFINER implications must be reviewed
- anon/authenticated must not gain privilege to enable their own rollout unless that is explicitly the intended product authorization model
- service-side mutation path must be explicit and minimal

### B. Rollout modes

Support at minimum:
- OFF
- PILOT
- ENABLED

Semantics:
- OFF: never refresh
- PILOT: refresh only when all pilot safety gates pass
- ENABLED: normal account-scoped automatic refresh

Do not infer mode from brand name, user email, row order, or env-only allowlist.

### C. Refresh eligibility contract

Centralize the exact predicate used before reading Vault credentials.

It must require, at minimum, the existing valid account health and publishability conditions plus account rollout authority.

The contract must be reusable by every future X publishing path.

Tests must prove:
- wrong account cannot inherit another account's rollout state
- disabled account cannot reach Vault read
- account with missing refs cannot reach refresh
- account with invalid health/connection state fails closed
- Kabumori legacy path remains unchanged
- PILOT/OFF/ENABLED behave exactly as specified

### D. Reauth/reconnect state

When refresh returns a terminal user-action case such as `invalid_grant`:
- exact account must move to the existing appropriate reauth/reconnect state if one exists
- if no existing state safely expresses it, add the narrowest required state/schema change
- automatic refresh must stop for that account
- scheduled posting must not silently fall back to stale/other credentials
- operator/user-facing state must be queryable without exposing token values

Do not build the full public reconnect UI in this Stage 3A unless it is already trivial and in-scope. Provide the stable backend contract for it.

### E. Observability

Add a read-safe operational view/query/RPC or existing-admin-compatible data contract for:
- rollout mode
- refresh state
- generation
- last refresh success time
- access expiry if already tracked
- last connection error code
- reauth required / stuck refreshing indication

Constraints:
- no token values
- no Vault secret IDs in end-user surfaces
- no Authorization headers/provider bodies
- least privilege
- if a DB view is used, follow current Supabase `security_invoker` guidance where applicable

### F. Stuck refresh safety

Preserve the current fail-closed concurrency model.

Add tests/detection for:
- stale `refreshing` lease
- reconnect-vs-commit conflict
- second 401
- uncertain token endpoint result
- owner/manual intervention path

Do not auto-replay an uncertain token refresh.

### G. Migration-history debt

The already-live core refresh migration is not currently recorded in `supabase_migrations.schema_migrations`.

For this Stage 3A:
- inspect and document the exact state
- do not blind `db push`
- do not blind `migration repair`
- if new schema is needed, devise a migration path that cannot accidentally replay the already-live core SQL
- production history normalization itself is NOT authorized unless a safe exact procedure is proven and separately reported

## Tests

At minimum:
- account A enabled / account B off isolation
- account A pilot / account B enabled isolation
- disabled account reaches zero Vault/token requests
- missing rollout state defaults fail-closed
- invalid_grant -> exact account reauth-required, no cross-account mutation
- uncertain refresh -> no credential commit
- second 401 -> no second refresh
- concurrent refresh lease behavior unchanged
- Kabumori legacy flow unchanged
- existing Phase1B–1I regression suites PASS
- x-test-post regression PASS
- _shared X regression PASS
- relevant scheduler/dispatcher regression PASS

Also run:
- TypeScript/lint/build where applicable
- SQL disposable DB behavior tests if schema/RPC changes
- Supabase advisors for DB security changes
- git diff --check
- targeted secret scan

## Production restrictions

Stage 3A is **source-first**.

Allowed:
- source implementation
- migration file creation using current Supabase CLI workflow
- local/disposable DB verification
- PR creation/update
- Netlify/CI-style source checks where relevant

Not allowed without a new explicit TASK:
- enabling rollout for any additional real X account
- changing AI Lab rollout mode
- generic all-user activation
- bulk Vault migration
- bulk reconnect/replay
- production migration apply
- production Edge deploy
- production env changes
- Kabumori credential migration

## Deliverable

Produce:
1. exact Stage 3A architecture
2. changed files
3. schema/data-contract changes
4. rollout mode semantics
5. reauth contract
6. observability contract
7. migration-history-safe deployment plan
8. tests/results
9. security checks
10. remaining work for:
   - Stage 3B controlled second-account pilot
   - Stage 3C multi-account pilot
   - Stage 4 general user rollout

## Completion / K3

Set:
- status -> review_required
- next_owner -> chatgpt

Report:
- task_id
- result
- changed_files
- tests
- commit_hash
- push/PR
- production_mutation=0 unless explicitly reauthorized
- migration_history_findings
- safety_checks
- remaining_issues
- next_recommendation

STOP for K3.

## Report

- task_id: x-universal-oauth-refresh-stage3a-rollout-foundation-20260926
- result: K3 ready — Stage 3A source/schema/observability foundation complete in PR #38; production mutation 0.
- model: Opus 5.5
- push/PR: branch `claude/g3-stage3a-rollout`, PR https://github.com/anohi-memories/kabumori/pull/38 (head `050d62f`)
- commit_hash: `050d62f`
- architecture: 新 migration `20260926032054_x_account_refresh_rollout_authority.sql`（`supabase migration new` で作成）。
  - `x_account_refresh_rollout`（X アカウントごと1行、行なし = off）
  - 唯一の判定関数 `x_account_refresh_authority(account)`（Vault を読まない、対象アカウント自身の行だけを見る）
  - live の `begin_x_account_refresh_legacy_post` を `create or replace`（core の本文と完全同一＋Vault 読み取り前の判定1行のみ。core ファイルから期待本文を組み立てる static test で固定）
  - `set_x_account_refresh_rollout`（唯一の変更経路、service_role）、`get_x_account_refresh_health`（運用向け、service_role）、`resolve_stale_x_account_refresh_lease`（owner のみ）
  - Phase1I の `begin_x_account_refresh_v2` も同じ判定を Vault 読み取り前に呼ぶ（3A 未適用なら fail-closed）
  - Edge: `X_VAULT_ACCOUNT_REFRESH` は全体の緊急停止スイッチとして残す（単独では不十分）。rollout 拒否時は 401 をアカウントに記録し rollout コードで失敗（token request 0）。期限前 refresh が token request 前に拒否された場合は現トークンで続行し、1回の refresh 枠を消費しない。
- changed_files: `supabase/migrations/20260926032054_x_account_refresh_rollout_authority.sql`（新）、`supabase/migrations/20260925150000_x_autopost_phase1i_account_refresh.sql`、`supabase/functions/x-test-post/vault_account_auth.ts`（+ `_test.ts`）、`supabase/functions/x-test-post/account_refresh_rollout_migration_test.ts`（新）、`supabase/tests/x_account_refresh_rollout_{behavior.sql,run.sh}`（新）、`supabase/tests/x_account_refresh_rollout.md`（新）、`supabase/tests/x_autopost_phase1i_{behavior.sql,run.sh,account_refresh.md}`
- rollout_modes: off/行なし = 更新しない（`X_REFRESH_ROLLOUT_OFF`）／pilot = 期限内（≤30日）・更新回数上限（現在の generation + 1..24）・未解決エラーなしの時だけ（`X_REFRESH_PILOT_EXPIRED` / `_LIMIT_REACHED` / `_BLOCKED_BY_ERROR`）／enabled = 通常の自動更新。判定の前提として健全性・publish・client・自分専用の参照・refresh 状態も必須。ブランド名・ハンドル・メール・行順・env から推測しない。
- grandfathering: migration 内で「committed refresh あり・idle・エラーなし・identity_verified」のアカウントだけ enabled（`GRANDFATHERED_PROVEN_REFRESH`）。本番では現状 AI Lab（generation 2）のみ該当 → 適用しても AI Lab は止まらない（名前指定なし）。
- reauth_contract: 既存 core の意味を維持（invalid_grant / 更新直後の 401 → 対象アカウントのみ `connection_status='failed'` + 固定コード、自動更新停止、生成前に拒否、他資格情報へのフォールバックなし）。ユーザー向けは既存 RLS で会員が読める `social_accounts.connection_status/last_connection_error_code`。authenticated 向けの新しい SECURITY DEFINER は追加していない。
- observability_contract: `get_x_account_refresh_health` の列 = rollout_mode、pilot 期限/上限、refresh_status、generation、last_refreshed_at、access_expires_at、エラーコード、lease 経過秒、stuck_refreshing（10分超）、reauth_required、refresh_block_code（判定結果）。token・secret id・lease token・provider body は含まない。view ではなく関数にした理由: security_invoker view だとテーブルへの直接付与が必要になり lease token / secret id が露出するため。
- tests:
  - 使い捨て PostgreSQL 17（本番形状 fixture、Vault 読み取りを sequence で計数し rollback 後も検出）: `ROLLOUT_BEHAVIOR_PASS` / `ROLLOUT_RACE_PASS`（1アカウント1 lease、reconnect vs commit で新トークンが再接続後のアカウントに入らない）/ `ROLLOUT_CLEANUP_PASS`。再適用拒否・core 再実行拒否を確認。
  - わざと壊した8パターン全て検出（判定呼び出し削除、行なしを許可、pilot 上限・期限削除、stale を idle に、grandfather 条件拡大、setter の設定検査削除、判定を Vault 読み取り後へ移動）
  - Phase1D/E/F/G/H/I・core の既存 DB 検証 PASS（1I に v2 経路の rollout off 拒否テストを追加）
  - Deno: x-test-post 512/0（vault_account_auth 18、3A static 8 含む）、_shared 141/0、important-news-monitor 473/0
  - deno check/lint: 変更ファイル clean（index.ts は既存の6件のみ）; advisors（使い捨て DB）: 新規オブジェクト起因 0; `bash -n`; `git diff --check`; secret scan（コミット対象）0
- migration_history_findings: `supabase migration list --linked`（読み取りのみ）= 一致 31 / ローカルのみ 64 / リモートのみ 27。ローカルのみに live core `20260925140000`（`db query` 適用で未記録）と未適用の Phase1B–1I 等を含む → `db push` は絶対に使わない。core は再実行を拒否、3A は core 必須かつ二重適用拒否・core 再作成なし。正規化案（未実行・別承認）: read-back で一致確認後に単一 version だけ `migration repair --status applied 20260925140000`（3A も適用後に同様）。全体の 64/27 のずれは別タスク。
- production_mutation: 0（`migration list` の読み取りのみ。migration 適用・deploy・env・rollout 変更なし）
- safety_checks: G3 専用 worktree のみ、apps/admin・PR #33 不接触、token/secret 値・secret ID は表示・記録なし、Kabumori legacy 経路はコード不変
- remaining_issues: Stage 3B（2つ目の実アカウントを pilot に。そのアカウント用の投稿処理が x-test-post にまだない）、3C（複数アカウント pilot、stuck/reauth/block のアラート、G4 管理画面から setter/health を呼ぶ）、Stage 4（新規接続アカウントの既定方針、ユーザー向け再接続フロー、履歴正規化、v2 dispatcher 有効化）。詳細は `x_account_refresh_rollout.md` §7–8。
- next_recommendation: ChatGPT K3 → Codex レビュー（H1 が空いていれば、Sol高、範囲は rollout 判定・ACL・live begin 置換・grandfathering・移行手順）。承認後に本番適用は別 TASK（手順は同文書 §7）。


## Final K3 — Stage 3A rollout foundation

Verdict: **PASS for source-first implementation**.

- PR #38 head: `050d62f`.
- explicit account-level rollout authority implemented with OFF/PILOT/ENABLED semantics; row absence fails closed.
- global env gate alone no longer suffices for newly eligible accounts once Stage 3A is applied.
- exact-account eligibility is checked before Vault reads; no brand-first/first-row/cross-account fallback.
- invalid_grant/terminal cases remain exact-account reauth/fail-closed.
- non-secret operational health contract added; no token/secret identifiers exposed.
- migration-history debt was analyzed but not repaired; no blind db push/repair authorized.
- production mutation: 0.
- because this change introduces DB rollout authority, SECURITY DEFINER/RPC ACLs, grandfathering, and a production migration path, one focused Codex review is required before any production apply. This is the single release-boundary review for Stage 3A, not an intermediate review loop.
