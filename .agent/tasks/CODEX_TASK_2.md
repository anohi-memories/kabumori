# Codex Task 2

- task_id: social-mobile-app-phase14-persistent-content-settings-candidate-20260922
- owner: codex
- slot: codex-2
- status: ready
- next_owner: codex
- priority: high
- recommended_model: Luna
- purpose: Phase13 C2 PASS後の次段階として、general-user向け投稿設定をtenant-safeに永続化できるsource candidateを作る。まだCron・scheduled_posts自動生成・X実投稿・publish_enabled=trueは行わない。

## Background

Phase13で以下は本番確認済み:
- dedicated non-admin QA user
- owner-scoped `social_mobile_user_v1` workspace
- dedicated verified X account
- `publish_enabled=false`
- QA-only live Supabase read path
- exactly one real AI preview成功
- X API/media/post 0
- scheduled_posts 0
- tenant isolation PASS

Phase12ではcontent settingsはcode-owned in-memory defaultsだった。
次は、一般ユーザーが自分のworkspaceについて設定を保存・読取できるtenant-safe persistenceを設計・実装候補化する。

## Model policy

- **Lunaで開始・継続する。**
- Solへ上げるのは、RLS/SECURITY DEFINER/権限境界の具体的な矛盾が出てLunaで安全に解決できない場合だけ。
- 本番作業だからという理由だけでSolへ上げない。

## Fresh-start rule

H2開始時は必ず:
1. `git fetch origin main`
2. fresh `origin/main` を確認
3. `.agent/ORCHESTRATION.md`
4. `.agent/CURRENT_STATE.md`
5. この `.agent/tasks/CODEX_TASK_2.md`
6. `.agent/CODEX_REPORT_2.md`
を読み直す。

古いworktree/過去会話/キャッシュ上のstatusを開始判断に使わない。
最新TASKが `ready` / `in_progress` なら開始する。

## Scope A — current schema/read-boundary audit

Read-onlyで確認:
- `brands`
- `brand_memberships`
- 既存 `posting_windows`
- 既存 `brand_settings` 相当の設定保存先
- social-mobileから現在read/write可能なtenant境界
- admin側既存設定との責務重複
- `social_mobile_content_settings.ts` の現在default contract

結論をReportに明記:
- 既存tableを安全に再利用できるか
- 新tableが必要か
- user-JWT direct RLSで十分か
- SECURITY DEFINER RPCが必要か

既存admin運用の `posting_windows` を安易にgeneral-user write対象へ拡張しない。

## Scope B — persistent settings source candidate

以下の一般ユーザー設定をworkspace単位で保存できるcandidateを作る:

- locale
- tone
- themes
- objective
- target frequency / week
- approval mode
- timezone
- preferred generation time/window
- NG words
- freeform guidance/notes

Requirements:
- tenant ownershipで完全分離
- ownerだけ自分のworkspace設定をread/write可能
- 他tenant read/write不可
- admin/global policyを壊さない
- service_roleをmobileへ渡さない
- secrets/tokenを保存しない
- `livePublishingEnabled` のようなpublish permissionをuser settingとして勝手にtrueにできない
- publish permissionとcontent preferenceを別責務にする
- schemaは将来拡張できる形
- updateはidempotent/upsert-safe
- validation/boundsをDBまたはRPC側でも持つ
- migration historyの既知gapを考慮し、blind `db push`前提にしない

## Scope C — mobile settings UI candidate

`apps/social-mobile` に一般ユーザー用設定画面を追加/接続する。

最低限:
- 現在設定の読取
- tone
- themes
- 週あたり投稿目安
- timezone
- 生成希望時間
- NG words
- guidance/notes
- 保存
- 保存成功/失敗表示
- fail closed
- raw backend errorをそのままUIへ出さない

UX:
- 日本語で分かりやすく
- 「自動投稿ON」や「今すぐ投稿」はまだ置かない
- publish enable toggleは禁止
- 設定保存と投稿実行を混同しない

## Scope D — generator integration

Preview generation時に:
- 保存済みsettingsがあればそれを使う
- 未保存ならPhase12の安全なdefaultへfallback
- tenant外settingsを絶対に読まない
- settings値だけでpublish pathへ入らない
- current `social_mobile_user_v1` guardを維持

## Scope E — tests

最低限:
- owner read success
- owner write success
- non-owner read denied
- non-owner write denied
- other tenant isolation
- invalid frequency/timezone/window rejected
- oversized NG words/notes rejected
- publish permissionをsettings経由で変更できない
- fallback defaults
- persisted settings reflected in preview generation input
- raw DB/backend error hidden from visible UI
- no X/schedule/Vault path

可能ならlocal/disposable DB proof。
難しい場合は、静的contract testだけで済ませた箇所を明確にReportへ書く。

Run:
- relevant Deno tests
- social-mobile typecheck
- social-mobile lint
- Expo export
- `git diff --check`

## Scope F — production boundary

このPhase14では **source candidateのみ**。

禁止:
- production migration apply
- production RPC/schema/RLS/ACL mutation
- production settings row creation
- QA fixture mutation
- Cron/scheduler
- scheduled_posts insert
- X API/media/post
- OAuth relink
- Vault read/write
- `publish_enabled=true`
- app-wide production data-source switch
- migration-history repair/reconcile
- blind `db push`

Production mutation = 0 のままC2へ返す。

## Parallel safety

H1の `kabumori-mobile-home-dashboard-v1-20260922` と同じファイルを触らない。
H1が `apps/social-mobile/**`、同じmigration/RPC、同じshared brand generator/settingsへ触れていることが分かった場合はSTOPして競合報告。
push前にfresh `origin/main`確認。

## Completion / C2

完了時:
- status -> `review_required`
- next_owner -> `chatgpt`
- `.agent/CODEX_REPORT_2.md` に:
  1. schema/RLS/RPC設計
  2. changed files
  3. tenant isolation proof
  4. validation rules
  5. mobile UX
  6. generator integration
  7. tests
  8. production mutation = 0
  9. remaining risks
  10. rollout proposal
- source commit/push
- fresh origin/main check
- STOP for C2
