# Claude Task 2

- task_id: kabumori-push-settings-enforcement-20260907
- owner: claude
- slot: claude-2
- status: review_required
- next_owner: chatgpt
- priority: high
- purpose: 既存の`alert_settings`を実際のPush送信判定に接続し、将来ユーザーが通知ON/OFFを変更したとき本当に効くバックエンド経路を作る。Codexのimportant-news-monitor作業とは競合させず、`send-push-notifications`側だけで完結できる最小実装を優先する。

## Background

前タスクでは通知設定UIを追加したが、`alert_settings.important_news` / `push_enabled`を通知生成・送信側が読んでおらず実際には効かなかったため、K2レビューでUIを撤回した。

今回は先にバックエンド側で設定を本当に効かせる。UI再導入は、このタスクで安全な送信制御が成立した後の別タスクとする。

## First checks

1. `.agent/ORCHESTRATION.md` と `.agent/CURRENT_STATE.md` を読む。
2. 最新`origin/main`とworktree dirty/stale状態を確認する。
3. Codex task `important-news-freshness-coverage-fix-20260906` の対象 `supabase/functions/important-news-monitor/**` には触れない。
4. `supabase/config.toml` はstocks sync側の未コミット差分と競合し得るため変更しない。
5. 他workstreamの未コミット差分を変更・stage・commitしない。

## Scope

主対象:
- `supabase/functions/send-push-notifications/**`
- その既存unit test / logic test

### A. alert_settings enforcement

`send-push-notifications`がpending通知を送る直前に、通知対象ユーザーの`alert_settings`を確認する。

最低限:
- `push_enabled = false` ならPush送信しない
- `source_type = 'important_news'` の通知は `important_news = false` ならPush送信しない
- `alert_settings`行が存在しないユーザーは既存default（true相当）として扱い、既存ユーザーへのPushを意図せず止めない
- 本人以外の設定を誤って参照しない

### B. skipped扱いの安全設計

設定OFFで送らない通知をどう扱うか、既存schema/状態遷移を確認して最小で安全な方法を採用する。

要件:
- 毎回同じpending通知を拾い続けて無限再試行しない
- 「送信失敗」と誤分類しない
- 既存schemaだけで明確なskipped状態を表現できない場合は、勝手にmigrationせずReportする
- 必要なら既存`push_status`の許容値・更新方式を確認し、互換性を壊さない範囲で扱う

### C. tests

最低限以下を追加/確認:
- settings rowなし → 送信対象
- push_enabled=true / important_news=true → 送信対象
- push_enabled=false → 非送信
- important_news=false + source_type=important_news → 非送信
- important_news=false + 将来の別source_type → push_enabled=trueならsource固有設定が無い限り既存挙動を維持
- 複数ユーザー混在時に設定が交差しない
- DeviceNotRegistered等の既存処理を壊さない

## Explicitly out of scope

- `important-news-monitor/**`
- DB migration / DDL / GRANT
- `supabase/config.toml`
- production deploy
- Supabase secret設定
- Cron変更
- X投稿系
- auto_publish変更
- Apple Developer / EAS build / 実機Push E2E
- 通知設定UIの再導入

## Validation

- relevant push logic tests PASS
- TypeScript/Deno check可能な範囲で確認
- 既存pending→send→success/failure処理のregression確認
- production変更なし

## Completion criteria

- `alert_settings.push_enabled` / `important_news`が実際のPush送信判定に反映されるローカル実装完了
- 非送信時の状態遷移が安全、またはschema制約で安全に完了できない場合はmigrationせず明確にReport
- テスト結果・変更ファイル・残課題をReport
- 安全ならcommitし、`.agent`運用ルールに従ってorigin/mainへ同期
- TASK末尾に`## Report`追加
- status: review_required
- next_owner: chatgpt
- control-plane更新をorigin/mainへ同期してからK2可能と報告

## Report

- task_id: kabumori-push-settings-enforcement-20260907
- result: `alert_settings.push_enabled`/`important_news`を`send-push-notifications`の送信判定に接続完了。commit `7742bff`を`origin/main`へpush済み（親は本タスクの`in_progress`commit `ab0756e`）。`important-news-monitor`・DB migration・`supabase/config.toml`には一切触れていない。
- changed_files（commit `7742bff`、対象は`supabase/functions/send-push-notifications/**`のみ）:
  - `push_send_logic.ts` — `AlertSettings`型と`shouldSendNotification(notification, settings)`を追加。純粋関数（DB/network無し、既存の設計方針を踏襲）。設定行が無い場合は列defaultと同じ`{push_enabled: true, important_news: true}`として扱う。`push_enabled=false`は`source_type`に関わらずブロック、`important_news=false`は`source_type='important_news'`のときだけブロックし、それ以外の（将来の）`source_type`には影響しない設計。
  - `index.ts` — 新規`fetchAlertSettingsForUsers()`で対象user_idの`alert_settings`を一括取得。`pending`を`shouldSendNotification()`で`sendable`/`settingsSkipped`に分割し、`settingsSkipped`は device token取得やExpo API呼び出しを一切行わず直接`push_status='skipped'`に更新。device token取得も`sendable`のuser_idだけに絞り、無駄な問い合わせを増やしていない。レスポンスに`settingsSkippedCount`を追加。
  - `push_send_logic_test.ts` — `shouldSendNotification`のテスト6件を追加（設定行なし/有効時送信/push_enabled=false/important_news=falseで重要ニュースのみブロック/将来の別source_typeには影響しない/2ユーザー間で設定が交差しない）。
- B. skipped扱いの安全設計:
  - **既存の`push_status='skipped'`をそのまま流用**した。この値は元々「登録デバイス無し」用に`decideNotificationPushStatus`が返す値であり、意味的にも「送信しないと決めた」で一致するため、新しい値やmigrationは不要と判断。
  - `settingsSkipped`になった通知は一度`push_status='skipped'`に更新されるため、次回以降のcron実行では`push_status=eq.pending`条件に一致せず再取得されない＝無限再試行しない。
  - 「送信失敗」（`failed`）とは明確に区別：`failed`は実際にExpo APIへ送って全デバイスが失敗したケースのみに限定され、設定でスキップした通知は`decideNotificationPushStatus`のロジックにすら入らない（`sendable`側のループでしか呼ばれない）。
- tests:
  - `node --test supabase/functions/send-push-notifications/push_send_logic_test.ts`：**17/17 pass**（既存11件＋新規6件、既存回帰なし）
  - `npx tsc --noEmit`（リポジトリ全体）：新規エラーなし。`index.ts`のDeno関連エラー（`Deno`未定義、`.ts`拡張子import）は変更前から存在する、変更していない`important-news-monitor`等でも同一パターンが出る既知のtsconfig事象（Deno向けコードをNode向けtscでチェックしているため）であり、今回の変更固有ではない。
  - Deno CLIがこの環境に無いため`deno check`は実行不可（過去taskでも同様）。`index.ts`は目視レビューで型・null安全性を確認済み。
- commit_hash: `7742bff`（`origin/main`へpush済み、親は`in_progress`commit `ab0756e`）
- push: 完了。push前に2回（in_progress commit時・実装commit時）`origin/main`をfresh-checkし、いずれもdrift無し
- deploy: 未実施（forbidden通り。この関数自体が引き続き未deployのまま）
- remaining_issues:
  - 通知設定UI自体は前task（`b6814fa`）で撤回済みのまま。今回のバックエンド実装が承認されれば、UIを再導入しても実際に効く状態になった
  - `important_news`以外の`alert_settings`列（`earnings`/`tdnet`等）に対応する`source_type`はまだ存在しないため、それらは今回のenforcementの対象外のまま（`push_enabled`のみが効く）
  - `send-push-notifications`自体のsecret登録・`config.toml`追加・deployは引き続き別タスク
- safety_checks:
  - `supabase/functions/important-news-monitor/**`、Codex現在task対象：一切変更していない
  - DB migration/schema/GRANT、`supabase/config.toml`：一切変更していない（既存`alert_settings`テーブルを読むだけ）
  - 本番Edge Function deploy、secret設定、Cron、X投稿系、auto_publish、Apple/EAS：一切触れていない
  - 通知設定UIの再導入：行っていない（forbidden通り、バックエンドのみ）
  - 他workstream（stocks sync関連、`.env`、`.claude/launch.json`、`apps/admin`、Codexの`.agent`ファイル等）：一切変更・stage・commitしていない
- next_recommendation: (a) 今回のcommit`7742bff`をレビューし問題なければK2、(b) 承認後、`kabumori-mvp-completion-nonapple-20260907`で撤回した通知設定UIを、今回のバックエンドを前提に再導入するタスクを計画、(c) `send-push-notifications`のsecret/config/deployタスクも引き続き計画可能
