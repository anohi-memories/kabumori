# 現行かぶモリ構成調査（2026-09-10）

本番に変更は加えていない。本番への問い合わせは、読み取り専用のコマンドだけを使った（`functions list` / `secrets list`（名前のみ）/ `cron.job` の SELECT）。

「確認済み」は実際にコマンドで確認したこと、「推定」は migration やコードから読み取ったことを表す。

## 1. Git

- 確認済み: `origin/main` = `910cbeb`。本番共有チェックアウト（`/Users/yuya/Developer/kabumori`）は `main` = `6365c49` で origin より遅れており、他の作業の未コミット変更が多数ある（`important-news-monitor`、`x-test-post`、push、stocks-sync など）。
- 確認済み: 共有チェックアウト上で `20260908110000_add_important_news_publish_ready_cron.sql` が削除状態（`D`）になっているが、この migration の Cron（`important-news-publish-ready`）は本番で稼働中。
- 確認済み: `stocks-master-sync` / `stocks-new-listing-sync` の関数と、それに関係する migration 9本（`20260903180000`〜`20260904160000`）は**git 未追跡**のまま、本番に deploy・適用されている。この worktree（origin/main 起点）には含まれない。
- 確認済み: `/private/tmp` に一時 worktree が22個残っている（うち1つは prunable）。

## 2. Supabase

- プロジェクト: `wsmznyzcvmuitkglfeuj`（1つだけ。新規プロジェクトは作らない方針）
- 確認済み: 本番の Edge Function は5本、すべて `verify_jwt=false`
  - `x-test-post` v93 — 定時投稿の実行（tip / interaction / useful_tip / morning_report / close_report / us_premarket_report / morning_greeting）
  - `important-news-monitor` v37 — 重要ニュースの取得・判定・生成・公開
  - `send-push-notifications` v3 — アプリ向け Push 通知（X とは関係ない）
  - `stocks-master-sync` v6 / `stocks-new-listing-sync` v5 — 銘柄マスタ（X とは関係ない、git 未追跡）
- 注意: 共有チェックアウトの `supabase/config.toml` には「X 系の関数は verify_jwt の既定値（true）のまま」というコメントがあるが、本番は実際にはすべて false。コメントが実態と合っていない。
- 未確認: `supabase migration list --linked` は DB パスワードが必要なため実行できず、migration が本番にどこまで適用されているかは確認していない。

## 3. Cron（本番、確認済み）

| jobid | 名前 | 間隔 | 関係するもの |
|---|---|---|---|
| 1 | dispatch-scheduled-posts | 毎分 | `claim_due_post` → x-test-post |
| 2 | important-news-fetch | 0,20,40分 | important-news-monitor |
| 3 | important-news-judgement | 7,27,47分 | 同上 |
| 4 | important-news-generation | 14,34,54分 | 同上 |
| 8 | important-news-publish-ready | 5分ごと | 同上（X へ公開） |
| 5 | kabumori-stocks-master-sync | 毎日 21:03 UTC | 銘柄マスタ |
| 6 | kabumori-stocks-new-listing-sync | 毎日 21:08 UTC | 銘柄マスタ |
| 9 | send-push-notifications-dispatch | 毎分 | Push |

X 投稿に関係する Cron は 1〜4 と 8。どれもブランドの区別がなく、かぶモリ1アカウントを前提にしている。

## 4. Secrets（名前だけ、確認済み）

- X（OAuth2、コードから参照されている）: `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_OAUTH2_ACCESS_TOKEN`, `X_OAUTH2_REFRESH_TOKEN`
- X（OAuth1、**コードからの参照なし**。昔の名残と推定）: `X_CONSUMER_KEY`, `X_CONSUMER_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`
- 生成: `OPENAI_API_KEY`
- その他: `SEND_PUSH_NOTIFICATIONS_CRON_SECRET`, `STOCKS_MASTER_SYNC_CRON_SECRET`, `SUPABASE_*`（プラットフォームが用意するもの）

## 5. X 認証の仕組み

- `supabase/functions/_shared/x_oauth2_post.ts`
  - `oauth_token_store` からトークンを読み、AES-GCM で復号する。暗号鍵は `SHA-256(X_CLIENT_SECRET)` から作る。
  - トークンを更新したら、同じテーブルへ `on_conflict=provider` で上書き保存する。
  - 行が無いときや復号に失敗したときは、環境変数 `X_OAUTH2_*` にフォールバックする。
- `oauth_token_store`: `provider text primary key` かつ `check (provider = 'x')` → **構造上、アカウントを1つしか持てない**。
- 認証を開始する処理（OAuth の認可フロー）はリポジトリに無い。トークンは Secrets に手動で入れる運用と推定。新しいアカウントを追加するには、ユーザー本人が各アカウントで認可する手順が必要になる。
- 呼び出し元: `x-test-post/index.ts`（定時投稿と朝の挨拶の手動公開）、`important-news-monitor/index.ts`、`x-test-post/morning_greeting_publish_logic.ts`

## 6. DB テーブル（X 自動投稿に関係するもの）

| 区分 | テーブル | 単一アカウント前提になっている点 |
|---|---|---|
| スケジュール | `posting_windows` | `unique(post_type, slot_no)` |
| | `scheduled_posts` | `unique(schedule_date, post_type, slot_no)`。`claim_due_post` / `plan_*` RPC がブランドを区別しない |
| | `posting_blackouts`, `market_holidays` | 市場の休日などは共通で使ってよい（推定） |
| 実行・履歴 | `post_execution_logs` | ブランド列が無い |
| | `morning_report_runs`, `close_report_runs`, `us_premarket_report_runs`, `important_news_monitor_runs` | 同上 |
| 重複防止 | `publish_claims` | `unique(post_type, date_jst)` = 1日1回の保証もブランドを区別しない |
| | `important_news_candidates` | `x_post_id` / `content_hash` / `source_url` がそれぞれ unique（全体で1つ） |
| ネタ在庫 | `tips`, `useful_tips`, `interaction_topics`, `interaction_post_metrics` | `last_used_at` / `cooldown_days` による再利用制御がブランド共通 |
| | `useful_tip_verifications`, `market_contexts` | ファクト確認のデータは共有してよい可能性がある |
| 設定 | `important_news_monitor_settings`, `morning_report_settings`, `close_report_settings`, `us_premarket_report_settings`, `useful_tip_schedule_settings` | 1行だけのシングルトン（例: `id boolean = true` を PK にしている） |
| 認証 | `oauth_token_store` | 前の節のとおり |
| ニュース取得元 | `important_news_company_ir_sources` | 共有できる |
| アプリ（X とは関係ない） | `profiles`, `tracked_stocks`, `stocks_master`, `alert_settings`, `notifications`, `device_push_tokens`, `admin_users` | 複垢化の対象外 |

- Storage: バケット `morning-greeting-assets`（朝の挨拶の画像、基準画像 `canonical/yume-reference`、公開の記録）。パスにブランドの区別が無い。

## 7. ブランド固有の内容がコードに直接書かれている箇所

`かぶモリ|カブモリ|kabumori` の出現数（テストを除く）:

- `_shared/kabumori_voice.ts`（2）— 文体の定義
- `x-test-post/index.ts`（14）— プロンプトなど
- `x-test-post/fixed_hashtags_logic.ts`（1）— 固定ハッシュタグ
- `x-test-post/morning_greeting_logic.ts`（2）
- `important-news-monitor/post_generation_logic.ts`（4）
- `send-push-notifications/push_send_logic.ts`（1、アプリ向けなので対象外）

このほか、投稿の種類（`post_type`）ごとの分岐が `x-test-post/index.ts` に直接並んでいる。Web 管理画面（`apps/admin`）の ON/OFF 操作の許可リストも、1ブランドを前提にしている。

## 8. 複垢化で変更が必要になりそうな箇所（案、未実装）

1. **ブランドの定義**: `brands` テーブル（`kabumori` / 会社員AIラボ / みお）と、ブランドごとの設定（投稿テーマ、文体、頻度、生成設定、画像方針、note への導線、ハッシュタグ）
2. **X 認証**: `oauth_token_store` の PK を `(brand_id, provider)` に変更。`loadXTokens` / `saveXTokens` にブランドを渡す。環境変数へのフォールバックはかぶモリだけに限定。アカウントごとの認可手順（ツールか手順書）を用意する
3. **スケジュール**: `posting_windows` / `scheduled_posts` の unique 制約に `brand_id` を追加。`claim_due_post` と `plan_*` の RPC がブランドを扱えるようにする。Cron は1本のまま、ブランドを順番に処理する形を推奨
4. **重複防止**: `publish_claims` と `important_news_candidates` の unique 制約をブランド単位にする。ネタ在庫の `last_used_at` もブランド単位にする。あわせて、**ブランド間で同じ・似た内容を投稿しないためのチェック**を追加する（X の規約対策）
5. **設定テーブル**: 1行だけのシングルトンを、ブランドごとに1行ずつ持つ形へ
6. **履歴**: `post_execution_logs` と `*_runs` に `brand_id` を追加し、除外ログもブランドごとに追えるようにする（`PROJECT_RULES.md` の候補選定ルール）
7. **生成**: `kabumori_voice.ts`・ハッシュタグ・プロンプトをブランド設定から読み込む形にする
8. **Storage**: パスに `brand_id` の接頭辞を付ける
9. **管理画面**: ブランドの切り替えと、ブランドごとの ON/OFF
10. **対象外**: Push・アプリ・銘柄マスタ（かぶモリアプリ専用のまま）

## 9. 環境面の制約

- Docker が入っていないため、`supabase start`（ローカル DB）は現在使えない。導入するかどうかはユーザーが判断する。導入するまでは、DB の変更は SQL を読んで確認するか、Deno の単体テスト（モック）で確認する。
- 基準テスト: この worktree で `deno test --no-check --allow-env --allow-read --allow-net=127.0.0.1 supabase/functions` → **680 passed / 0 failed**
