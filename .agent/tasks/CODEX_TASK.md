# Codex Task

Codex（こでさん）専用の現在タスクです。`G` を受けたCodexは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルだけを自分の担当タスク正本として扱います。

- task_id: kabumori-personal-important-news-v1
- owner: codex
- status: ready
- purpose: 現在ログイン中ユーザーの `tracked_stocks` と、既存X自動投稿システム側の `important_news_candidates` を安全に結びつけ、「自分が登録している銘柄に関係する重大ニュース」をKabumoriアプリ内で確認できる最小機能を作る。今回はPush通知までは実装しない。
- scope:
  - 本番DBと現在コードを最初にread-only確認する
  - `tracked_stocks` / `stocks_master` / `important_news_candidates` / `notifications` / `alert_settings` の実スキーマ・RLS・GRANT確認
  - `important_news_candidates` のKabumori利用可能列とX内部専用列を整理
  - `stocks_master.ticker_code = left(important_news_candidates.company_code, 4)` を基本とする銘柄マッチング設計
  - 現在ログイン中ユーザー本人の `is_active=true` の holding/watch 両方を対象にする
  - Kabumoriアプリへ「ニュース」または「あなたの銘柄ニュース」画面/タブを追加する
  - 銘柄コード、会社名、holding/watch、見出し、短い要約、重要度、日時を表示する
  - 重要度の実値を確認した上で初心者向け日本語表示へ変換する
  - 最新順、最大50件程度、画面表示時取得、可能ならPull to Refresh
  - 登録銘柄0件 / 該当ニュース0件の空状態UI
  - Expo側はpublishable keyのみ使用
  - 必要ならKabumori専用RPC / View / Edge Function等の安全な取得経路を設計・ローカル実装する
  - 実データとしてサンリオ（8136）/ サイバーエージェント（4751）等の登録銘柄に対応候補が存在する場合、表示確認する
- forbidden:
  - Push通知実装
  - メール通知
  - ニュースAI再生成
  - 重要度再判定
  - `important-news-monitor` 変更
  - `x-test-post` 変更
  - X投稿処理変更
  - Cron変更
  - 既存X自動投稿DBロジック変更
  - 株価取得
  - ニュース全文保存
  - `important_news_candidates` へのauthenticated広範SELECT GRANT追加
  - service_role / secret key / Vault secretをExpoコードへ入れる
  - 本番migration適用
  - RPC / View / Edge Functionの本番deploy
  - 本番GRANT変更
  - 他workstreamの未コミット変更を変更・stage・commitすること
- completion_criteria:
  - `important_news_candidates` の実スキーマを確認し、company_code、headline/title相当、summary相当、importance/judgement相当、published_at/created_at相当、source URL相当、X投稿生成専用列、status系列を特定する
  - Kabumoriで返してよい列とX内部専用で返してはいけない列を分離する
  - company_codeがNULL・4文字未満・形式異常の場合はマッチ対象外にする
  - `stocks_master.ticker_code` を5文字化しない
  - 他ユーザーのtracked_stocksを取得・返却しない
  - holding/watch両方、`is_active=true` のみ対象にする
  - ニュース画面で初心者向けに情報量を抑えて表示する
  - 既存 `important_news_candidates` に存在する情報だけで画面を構成し、新しいAI生成処理は追加しない
  - `important_news_candidates` がauthenticatedから直接読めない場合、直接GRANTせず安全なKabumori専用取得経路を採用または提案する
  - 安全な取得経路は auth.uid() 本人のtracked_stocksだけを参照し、必要なニュース列だけ返し、X投稿内部情報・管理情報・他ユーザー情報を返さない
  - `notifications` を今回使うべきか直接取得すべきか現スキーマを見て判断し、不要なら本番INSERTしない
  - 登録銘柄0件では「保有・監視銘柄を登録すると、あなたに関係する重要ニュースがここに表示されます」相当の案内を表示する
  - 該当ニュース0件をエラー扱いにしない
  - Realtime購読は今回不要
  - TypeScript/対象テストを実行し結果を確認する
  - 実データ表示確認を可能な範囲で行う
  - 想定外のDB仕様・RLS・GRANT、または本番DB変更が必要な場合は勝手に適用せず `review_required` で停止する
  - 完了報告に以下を含める: 1) important_news_candidates実スキーマ 2) RLS/GRANT 3) Kabumori利用列 4) X内部専用列 5) 採用した安全な取得方式 6) 変更ファイル 7) 銘柄マッチング仕様 8) ニュース画面 9) holding/watch判別 10) 重要度表示 11) 実データ表示結果 12) セキュリティ確認 13) TypeScript確認 14) テスト結果 15) 未完了事項 16) 本番migration/deploy/GRANT変更要否
- commit: 今回のCodex作業として安全に分離できる変更のみ最小差分でcommit。他workstreamの未コミット変更を含めない
- push: commitした場合はfresh-checkで競合がないことを確認してorigin/mainへpushしてよい。競合・driftがあれば停止して報告
- deploy: 禁止。本番適用が必要なら設計・ローカル実装までに留めて `review_required`
- next_owner: chatgpt

## Important implementation notes

### 1. 銘柄マッチング

既知仕様：

- `stocks_master.ticker_code`: JPX 4文字コード
- `important_news_candidates.company_code`: TDnet系5文字コード（例 `13220`, `146A0`）

基本マッチ：

`stocks_master.ticker_code = left(important_news_candidates.company_code, 4)`

### 2. UI

最低限表示：

- ticker_code
- company_name
- holding / watch
- ニュース見出し
- 短い要約
- 重要度
- 日時

重要度は実DB値を確認してから日本語表示する。例：

- normal → 通常
- important → 重要
- most_important → 最重要

実値が異なる場合は実DBを優先する。

### 3. セキュリティ

ExpoアプリからX自動投稿側の機密テーブルへ広いSELECT権限を追加しない。

`important_news_candidates` がauthenticatedから直接読めない場合は、RPC / View / Edge Function等から最も安全かつ単純なKabumori専用取得経路を選ぶ。

本番migration / deploy / GRANT変更はこのタスクでは禁止。必要になった時点で設計とローカル差分をまとめ、`review_required` でちゃっぴー確認待ちにする。

### 4. 実データ確認

現在のテストユーザーで登録済みのサンリオ（8136）、サイバーエージェント（4751）等について対応する `important_news_candidates` が存在する場合、Kabumori画面への表示を確認する。

追加テストデータが必要なら必要最低限にし、不要なものは残さない。

## Completion report

完了時はこのファイル末尾または `.agent/CODEX_REPORT.md` の運用ルールに従い、task_id / result / changed_files / tests / commit_hash / push / deploy / remaining_issues / safety_checks / next_recommendation を記録する。

## Status values

- `idle`: 有効な指示なし
- `ready`: 作業開始可能
- `in_progress`: 作業中
- `review_required`: 実装済み・ちゃっぴー確認待ち
- `done`: 完了
