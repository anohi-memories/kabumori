# Claude G4 — CURRENT TASK — POSTONA Threads text publish + user-facing manual publish V1

- task_id: postona-threads-manual-text-publish-v1-20261011
- owner: claude
- slot: claude-4
- status: review_required
- next_owner: chatgpt
- start_code: G4
- finish_code: K4
- return_to: **POSTONA｜マルチSNS化・開発統括（G4）のちゃ**
- recommended_model: **Opus5.5（高）**
- priority: high
- type: **通常実装 — Threadsテキスト投稿の実API対応可能なprovider adapterと手動投稿UI / source + mock integration tests**
- main_product_goal: **POSTONAからユーザー自身の接続済みThreadsアカウントに1件のテキストを投稿し、投稿結果を確認できる状態（後段で限定実機pilot）**
- immediate_deliverable: implementation PR with real API request builders, explicit server-side publish-authorization boundary, testable two-step publish flow, safe one-shot user UI; **do not claim live functionality until separately authorized activation**
- remote_meta_supabase_x_api_calls: **FORBIDDEN until a separate user-approved tester/pilot TASK**
- production_DB_Auth_RPC_write_or_deploy_or_flags_or_secrets: **FORBIDDEN**
- PR_merge: **FORBIDDEN**
- shared_G5_Auth_schema_deletion_or_G3_scheduler_edits: **FORBIDDEN**
- source_owner: **Threads publication adapter, manual publish backend endpoint, scoped POSTONA manual publisher UI; NOT Threads OAuth**
- worktree: independent fresh G4 checkout; no H5/G3/G5 checkout sharing

## Authority and boundaries

User requested Threads **real posting capability**, authorized parallel G4 development with Codex H5 where useful. Phase 1 target is ONE user-initiated text-only post (not images, auto schedule, bulk posts or Threads+X simultaneous posting). H5 separately owns the **Threads OAuth Edge/Auth trusted-identity/attempt persistence** integration under `postona-threads-oauth-runtime-bridge-h5-20261011`; H5 code and PR cannot be edited here. G3 separately owns the AI/manual **reservation planner** Draft PR138 and related `apps/social-mobile/src/app/(tabs)/schedule.tsx` paths; do not modify G3 composer/schedule or X dispatcher. G5 owns common account lifecycle/entitlement/T13 and Auth deletion, and cannot be changed. H1 accepted source-only PR135; PR124 pending. Existing X OAuth hardening Issue #131 is deferred but is NOT the G4 TASK or authorization to alter X.

**Work toward deployable, testable Threads posting code; do not produce only another prose architecture memo.** Do not use safety-risky authentication circumvention, token harvesting, fake identities or unattended public posting. This code is legitimate user-authorized publication. No production posting, operator token reading, Meta app changes, real auth session or Supabase data writes without separate narrow consent.

## Mandatory baseline and Git isolation

Read `PROJECT_RULES.md`, `AGENTS.md`, `CLAUDE.md`, `.agent/ORCHESTRATION.md`, `.agent/ACTIVE_TASK.md`, `.agent/CURRENT_STATE.md`, this G4 TASK, H5 TASK (ownership only), G3/G5 TASK headers and Reports. Fetch fresh `origin/main` via clean base `/Users/yuya/Developer/kabumori-fresh` and obtain current PR metadata/heads, ensuring no overlapping changed paths/worktree. Check existing app `apps/social-mobile` accounts routes, post UI, X publish permission and selected account/domain models, phase 2a-2 schema; current X publisher `supabase/functions/x-test-post` is reference-only and must remain unchanged. Docs `docs/postona/multi-social-phase1.md` and shared T9/T10/T13 contract. Reverify Meta official Threads publish API contract before hard-coding version/URLs.

Use new G4 branch from **fresh main**, own independent worktree; PR135/PR124/H5 branches must not be checked out/rebased/modified. G4 may import merged main's `threads_connect_contract.ts` only for safe common types; cannot import unmerged H5 or PR124 code until a later integration decision. If independent worktree/current ownership cannot be proven, STOP before editing.

## Implementation — four bounded deliverables

1. **Official Threads text publish transport** — provider-specific tested module (e.g. `supabase/functions/_shared/social/threads_publish_contract.ts`, associated `_test.ts`) that performs explicit `POST /me/threads` with `media_type=TEXT` and `text` to create a container, then `POST /me/threads_publish` with `creation_id` to publish. No reliance on `auto_publish_text=true` by default; explicitly consider whether a one-call path changes duplicate safety. Strict Meta API host/path, version and redirect validation, response ID preservation as STRING, provider error classification, content length/UTF-8/empties/newlines, fixed user-safe errors, provider post ID read-back contract; `threads_basic` and `threads_content_publish` confirmed. No client-disclosed access tokens. Inject fake HTTP/network in tests.
2. **Manual one-shot publish orchestration** — distinct account-specific Threads publish path (new isolated server module and/or Edge function source) that requires verified signed-in POSTONA user, active service entitlement, currently connected verified Threads account, **explicit per-account publish authorization**, durable attempt/step idempotency before any provider POST, exclusive exact account ownership, read-only status/read-back, and a fresh DB authorization check immediately before EACH external provider write. Server retrieves only this specific account's credential from Vault through a separately reviewed owner-controlled reader; no caller-supplied provider ID, credential, secret id, workspace/user/account ID as sole authority. Unknown provider/timeout outcomes -> record UNCERTAIN / read-back or human-assisted reconciliation, **never blindly retry either Threads write**. Preserve no credential/token data in logs/response. Connect-created accounts remain publish_disabled until an explicit reviewed user permission change. If migration/RPC required, create a **source-only guarded migration/candidate** with mock PG/RLS/ACL test; do not apply or activate. Never invent an effective service_role/owner privilege bridge absent a proven contract.
3. **User-facing manual posting UI (standalone, no G3 schedule screen modifications)** — scoped Threads-account tab/action in POSTONA accounts/navigation so user can see disconnected/ready/consent/expired/unavailable states, type and edit text, view exactly which Threads account will post, inspect preview, explicitly tap publish once, and see `publishing` / confirmed with provider ID/link / pending-uncertain / failed states. Never display successful posting on optimistic HTTP alone, and do not present mock preview as a live post. Disabled release flag until Auth/Meta/DB prereqs and approved pilot; do not create an always-on public “post now” control. No fake demo token accepted.
4. **Integration contract** with H5 OAuth owner: documented exact `verified_user_id`, `social_account_id`, provider='threads', active lifecycle T13, token-read grant, publish permission and provider result ledger I/O. Keep app/service keys `x_autopost` (POSTONA global entitlement), no new Threads entitlement. If H5/G5 prereqs are absent, implement injectable port with a **nonworking production adapter that fails closed**, report missing exact boundary; never mislabel as connected or deployable. Show the remaining SQL/Meta config and manual pilot gates needed to make actual one-post demo work.

## Independent tests and acceptance

- Auth absent/expired; wrong brand or account; cross-user, cross-brand, X-account routed to Threads; ended/deleting/suspended/no entitlement; publish disabled; token/Vault missing; expired token; expired/revoked connection; duplicate click; concurrent attempts; provider container accepted but publish failed; unknown publish outcome; invalid content/provider errors/429/timeouts; result response malformed; two steps each gets new permission check; no blind retry.
- Text-only one-post golden happy path through fake account, provider, repository, worker & UI. No real POST, real token, paid calls, production data mutation or migrations. Preserve existing X post tests and G3 planner; run focused app TypeScript/lint/tests, Deno tests, mock PG where needed, secret scan, `git diff --check`.
- Ensure safe deployment flags are false by default, no leak to logs, no mobile direct Meta Graph request; read-back result treats publication identity as verified provider-returned ID only after confirmation.
- Document concrete external operator steps to request later (Meta Threads app/tester and callback config; privacy/delete callbacks; minimal real test account) **without asking user to paste app secret into chat/GitHub**.
- Report actual change paths, tests RUN/NOT_RUN, exact PR/commit/push, dependency on H5/G5, remaining release blockers; Draft PR to main if isolated. Do not touch H5/G5/H1/H2/G3 branches, source, tasks, reports or force push.
- After completing source PR and read-back, append G4 Report to current TASK, set `review_required/next_owner:chatgpt`, and send `K4`. Do not silently enable public posting. Recommend targeted Sol（高） security review only when publish+OAuth+T13 boundaries actually integrate.

## Preserve prior G4 idle state and historical pointers

# Claude Task 4 — NO CURRENT TASK

- task_id: none
- owner: claude
- slot: claude-4
- status: idle
- next_owner: none
- start_code: G4
- finish_code: K4
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- recommended_model: **none — select for the next actual G4 implementation task**

## Disposition and preserved history — 2026-10-11 JST

- User explicitly reassigned the prior Threads OAuth Edge offline implementation to Codex H1 (special temporary implementation), task `postona-h1-threads-oauth-edge-offline-implementation-20261011`; H1 start `H1`, finish `C1` in this chat.
- Former G4 Threads task `postona-threads-oauth-edge-offline-candidate-20261011` was interrupted by Claude Code's safety mechanism **before a submitted completion**. It was transferred, not marked implemented/done; original complete task and any future-local-ownership concerns are archived verbatim in `.agent/archive/CLAUDE_TASK_4_threads_edge_pre_codex_20261011.md`.
- Preceding X OAuth containment task remains **deferred and uncompleted**, tracked as [Issue #131](https://github.com/anohi-memories/kabumori/issues/131); preceding detailed record is `.agent/archive/CLAUDE_TASK_4_pre_threads_20261011.md`.
- G4 is **idle and available for a newly allocated separate POSTONA feature**, not an active implementation. Do not interpret a lone `G4` as permission to start old archived work; only a new `ready` TASK can begin. Never use G4 worktree to do H1 work.
- This bookkeeping does **not** grant production deploy, source merge, OAuth security bypass, database modification or provider calls.

## Report — postona-threads-manual-text-publish-v1-20261011（G4 → K4、2026-10-11 JST）

- task_id: postona-threads-manual-text-publish-v1-20261011
- result: **SOURCE_CANDIDATE_COMPLETE / RELEASE_HOLD**。4つの成果物をすべてソースと偽データのテストで実装した。Threads への実投稿は**まだできない**（静的ゲート false・リリースフラグ OFF・DB 候補は未適用）。本番・Meta・Supabase・X への呼び出し 0 件。
  1. 公式2段階投稿の送信部: `POST /{threads-user-id}/threads`（TEXT）→ コンテナ状態 → `POST /{threads-user-id}/threads_publish` → `GET /{media-id}` 読み戻し。2026-10-11 に Meta 公式文書を再確認（500文字・絵文字は UTF-8 バイト数・リンク5個・コンテナ24時間で失効）。`auto_publish_text` は重複安全性のため不使用。id は文字列のまま、エラーは固定コード、書き込みではトークンを URL に入れない。
  2. 手動1件投稿の手順: 呼び出し元 JWT の begin（冪等キー・本文をそのまま保存・1アカウント1件）→ **Threads への書き込みの直前ごとに** DB で再判定（G5 T13 フェンス `x_autopost`・オーナー/管理者・ワークスペース有効・Threads `identity_verified`・Vault 参照・**トークン期限5分以上**・アカウントごとの手動投稿の許可）→ 使い捨て許可証（sha256 のみ保存・60秒・1回・手順ごと）をサーバー専用 `service_role` 関数でトークンと交換 → 1回だけ送信 → 固定の遷移表で記録。公開の結果不明は `uncertain`（**再送しない**）、確認は読み取りのみ（コンテナ状態、24時間で確定）。途中停止・15分超過・許可証発行後の権限変化も「未公開」として確定。Edge ソース `social-mobile-threads-publish` は静的ゲートで常に 503。DB 側は migration ではなく `supabase/candidates/` の未適用候補（前提が無いと何も作らず停止）。
  3. 画面: Threads アカウント詳細のカード（投稿先表示・入力・Threads 基準の文字数・明示確認・結果表示・許可の付与/取消・「続ける」「確認する」）。「投稿しました」は読み戻し確認済み（id＋パーマリンク）のときだけ。リリースフラグ `THREADS_MANUAL_PUBLISH_UI_ENABLED=false` で既定は「準備中」表示のみ。G3 の予約画面は無変更。
  4. 連携契約: `docs/postona/threads-manual-publish-v1.md` §5（H5）・§6（G5）・§7（関門）・§8（Meta 側の準備）。
- changed_files: 20（Draft [PR #140](https://github.com/anohi-memories/kabumori/pull/140)、base main）
  - `supabase/functions/_shared/social/threads_publish_contract.ts`, `threads_publish_contract_test.ts`, `threads_manual_publish.ts`, `threads_manual_publish_test.ts`, `threads_manual_publish_fake.ts`（テスト用参照モデル）
  - `supabase/functions/social-mobile-threads-publish/{index,http,logic,http_test,logic_test}.ts`
  - `supabase/candidates/postona_threads_publish/threads_manual_publish_candidate.sql`
  - `supabase/tests/postona_threads_publish_{fixture,behavior}.sql`, `postona_threads_publish_run.sh`
  - `apps/social-mobile/src/domain/threads-manual-publish.ts`, `src/features/threads-publish/{use-threads-manual-publish.ts,threads-publish-card.tsx}`, `tests/threads-manual-publish.test.mjs`, `src/app/accounts/[id].tsx`（カード追加1行のみ）
  - `docs/postona/threads-manual-publish-v1.md`
- tests（すべて RUN・ローカル・偽データ）:
  - Deno `--no-config`: 86 PASS（新規: 送信部 17・手順 27・Edge 15、既存 provider_domain / threads_connect 含む）。`deno lint --no-config` 15ファイル問題なし。手順の変異4種（不明→失敗扱い、準備待ちなし公開、再送で再処理、FINISHED を公開扱い）すべて検出、検証後に元へ戻したことを確認。
  - DB 候補: Homebrew PostgreSQL 17 の使い捨てクラスタで `postona_threads_publish_run.sh` ALL PASS。前提不足4種（2a-2・G5 フェンス・フェンスがアプリ用ロールから実行可能・期限読み出し口）で停止、適用・再適用拒否、動作確認（ACL・本人・ロール・ワークスペース・接続・許可・トークン期限・冪等・許可証・遷移・試行期限・中断・削除中ガード・連動削除）、2セッション同時実行で1件のみ予約、変異6種すべて検出。G5 フェンスと期限読み出し口は**契約どおりの代役**で、G5/H5 の実装ではない。
  - アプリ: `npm test` 252 PASS（新規 18。サーバーとの文字数規則の一致を含む）、`tsc --noEmit` PASS、`expo lint` 問題なし。
  - `git diff --check` PASS、秘密情報の文字列検査 0 件。
  - NOT_RUN: 実 Meta / 実 Supabase Auth / PostgREST / Vault / 実機・シミュレーター表示（フラグ OFF のため画面は「準備中」のみ）。
- commit_hash: `2e75a6a874b2a5f31e8ec7bac3c80de92e9ac78f`（branch `claude/g4-postona-threads-manual-publish-20261011`、base `origin/main` `9fef4659`）
- push: DONE（上記ブランチ）。Draft PR #140 OPEN/DRAFT/UNMERGED。CI の Vercel は「Deployment rate limited — retry in 24 hours」（ビルド回数上限。コード起因ではない。PR138 と同じ）。
- deploy: NOT_DONE（Edge デプロイ・DB 適用・secret・フラグ変更・EAS すべて無し）。merge: NOT_DONE（TASK で禁止）。
- remaining_issues / 本番までの関門（静的ゲート `THREADS_MANUAL_PUBLISH_PREREQUISITES`）:
  1. Phase 2a-2 の本番適用。
  2. H5 接続ランタイムの本番化。**新しい依存: 資格情報の管理側が `public.threads_account_credential_expires_at(text) returns timestamptz`（所有者＝表の所有者、アプリ用ロール実行不可、NULL＝期限切れ）を提供すること**。H5 PR #139 は期限を OAuth 試行ごと（`token_expires_at`）に持つため、アカウント単位の読み方を H5/トークン管理側で決める必要あり。
  3. G5 T13 フェンス `private.account_lifecycle_assert_active_service_write(uuid,text)` の本番適用。G5 の T10 フットプリントに新しい2表（`social_account_manual_publish_permissions`, `threads_manual_publish_attempts`。どちらも cascade＋既存の削除ガード付き）を追加。
  4. この DB 候補のレビューと本番適用（同日の読み取り事前確認の後、単独ファイルとして）。
  5. Meta アプリ（`threads_basic`＋`threads_content_publish`、テスター招待と承認、HTTPS リダイレクト、連携解除/データ削除コールバック。アプリシークレットはユーザーがダッシュボードで直接登録）。
  6. 接続（H5）＋投稿（G4）＋T13（G5）をまとめた1回の独立セキュリティレビュー。特に「`auth.uid()` で判定 → 最大60秒の許可証で `service_role` 関数がトークンを渡す」新しい境界。
  7. テスター1名・実投稿1件の明示承認。
  - 要検証: 絵文字以外の文字数の数え方、Threads 固有のエラーコード、`owner` フィールドの有無。決めてほしいこと: `publish_mode='dry_run'` で手動投稿を許すか（今は `disabled` のみ停止）、許可の単位（今はアカウントごと）、画面の置き場所（今はアカウント詳細）。
- safety_checks: 専用 worktree `/Users/yuya/Developer/kabumori-g4-threads-publish`（`kabumori-fresh` の fresh `origin/main` から作成、他スロットと非共有）。PR #124 / #135 / #139（H5）/ #138（G3）/ G5 のブランチ・ファイルは checkout も変更もしていない（変更ファイルの重なり 0 を確認）。`x-test-post`・X OAuth（Issue #131）・G3 スケジューラ・G5 Auth/削除は無変更。`THREADS_CONNECT_PREREQUISITES_MET=false` は無変更。本番 DB/Auth/RPC の読み書き、Meta/X/Supabase API 呼び出し、トークン・secret の取得、課金 API は 0。使い捨て PostgreSQL は自分専用の socket `/private/tmp/g4tp-sock` のクラスタのみ使用。
- next_recommendation: K4 で受け入れ判断。Codex レビューは、H5・G5 の本番側の境界が揃って接続＋投稿＋T13 を統合する時点で1回（Sol（高））にまとめるのを推奨（この単体候補のための個別レビューは不要と考える）。並行して、H5/トークン管理側で期限読み出し口の置き場所を決める小さな TASK と、ユーザー側の Meta アプリ準備（§8）を進めると、実投稿までの距離が最短になる。


