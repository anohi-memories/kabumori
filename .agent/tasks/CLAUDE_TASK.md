# Claude Task 2

- task_id: kabumori-mvp-completion-nonapple-20260907
- owner: claude
- slot: claude-2
- status: in_progress
- next_owner: claude
- priority: high
- purpose: Apple Developer Program加入を後回しにしたまま、Kabumori iPhone MVPを「加入直前まで完成」に近づける。既存のログイン・銘柄検索/登録・重要ニュース・Push foundationを壊さず、アプリ側で残っている主要導線を監査し、Apple有料登録なしで実装・検証できる範囲を完成させる。

## User decision

- Apple Developer Programの有料加入は、アプリがある程度完成してから行う。
- EAS実機development build / Push実機E2Eは今回は保留。
- 今はアプリ本体の完成度を上げることを優先する。

## First checks

1. `.agent/ORCHESTRATION.md` と `.agent/CURRENT_STATE.md` を読む。
2. 最新 `origin/main` とworktreeのdirty/stale状態を確認する。
3. Codex task `important-news-freshness-coverage-fix-20260906` の対象 `supabase/functions/important-news-monitor/**` には触れない。
4. 他workstreamの未コミット差分を変更・stage・commitしない。
5. 現在mainline済みの以下を実コードで確認する。
   - Auth / AuthGate
   - 銘柄検索
   - holding/watch登録・編集
   - 重要ニュース一覧
   - Push token registration foundation
   - EAS projectId / eas.json

## Scope A: MVP gap audit

現行アプリを初心者向けKabumori MVPとして監査し、以下の主要導線の不足を洗い出す。

- ログイン → 銘柄検索 → 保有/監視登録 → 登録銘柄確認
- 重要ニュース一覧 → 記事/詳細への到達
- notificationsテーブルに既存データがある場合のアプリ内通知導線
- Push通知タップ時に最終的に関連ニュース/通知内容へ遷移できる設計
- 通知設定/alert_settingsをユーザーが変更できるUIが既存schemaで安全に実装可能か
- ログアウト時の状態クリア
- 空状態・エラー状態・ローディング

監査だけで終わらず、Apple有料登録不要かつ既存DB schemaで実装可能な高優先度ギャップはこのタスク内で実装する。

## Scope B: implement high-priority app-side gaps

優先順位:

1. Push通知からの遷移先として使えるアプリ内通知/重要ニュース導線を完成させる。
   - 既存 `notifications` / 重要ニュースRPCの設計を尊重する。
   - 本人データだけを読む。
   - Push実機がなくても、アプリ内から同じ到達先を確認できる構成にする。

2. 既存 `alert_settings` schemaが安全に使えるなら、初心者向けに必要最小限の通知設定UIを追加する。
   - 過剰な専門設定は不要。
   - schema変更が必要なら実装せずReportする。

3. 主要画面の空状態/失敗/再試行/ログアウト後の残留状態を整理する。

4. ナビゲーション/タブ名称を初心者に分かりやすく揃える。

不要な大規模リファクタは禁止。今ある構成を活かす。

## Explicitly out of scope

- Apple Developer Program加入
- EAS iOS build実行
- 実機Push Token E2E
- `send-push-notifications` production deploy
- Supabase secret設定
- Cron変更
- `supabase/config.toml`変更
- DB migration / DDL / GRANT
- `important-news-monitor/**`
- X投稿系
- auto_publish変更

DB schema不足を見つけても勝手にmigrationしない。

## UX requirements

Kabumoriは株初心者向け。

- 株価画面を中心にしない。
- 「何が起きたか」「なぜ重要か」「自分の保有/監視株にどう関係するか」を分かりやすくする。
- 専門用語を前面に出しすぎない。
- 通知/ニュースは本人のholding/watch対象を基準にする。
- 既存の重要度 `important` / `most_important` を尊重する。

## Validation

最低限:

- `npx expo export --platform ios` PASS
- web export可能ならPASS
- TypeScript/relevant checks
- 認証前/認証後の主要導線
- holding/watch 0件、ニュース0件、取得失敗の状態
- 追加した通知/設定導線のread/writeが本人スコープであること
- Push実機なしでも遷移先ロジックを可能な範囲で検証

## Completion criteria

- MVP gap audit結果をReportに明記
- Apple加入なしで実装可能な高優先度ギャップを実装
- 変更ファイルと意図を明記
- production DB/Edge/Cron/X/Apple有料領域には触れない
- 安全ならcommitし、`.agent`運用ルールに従ってorigin/mainへ同期
- TASK末尾に `## Report` を追加
- status: review_required
- next_owner: chatgpt
- control-plane更新をorigin/mainへ同期してからK2可能と報告
