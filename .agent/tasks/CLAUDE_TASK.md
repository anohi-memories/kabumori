# Claude Task 2

- task_id: kabumori-important-news-mainline-and-ios-e2e-20260906
- owner: claude
- slot: claude-2
- status: review_required
- purpose: K2承認済みのExpo/Auth/MVP共通基盤を土台に、ローカル実装済みのKabumori「重要ニュース」画面・取得コード・newsタブを安全にorigin/mainへ反映し、認証済みユーザー/iOSでのE2E確認へ進める。

## Scope

- 作業開始前にorigin/main、`.agent/ORCHESTRATION.md`、`.agent/CURRENT_STATE.md`、本TASKをfresh-checkする。
- Codexの現在task `important-news-freshness-coverage-fix-20260906` と変更対象が競合しないことを確認する。
- `src/app/news.tsx`、`src/lib/important-news.ts`、`src/components/app-tabs.tsx`、`src/components/app-tabs.web.tsx` の重要ニュース差分だけを、現在のorigin/mainへ安全にrebase/reapplyする。
- 画面は本人のactiveなholding/watch銘柄だけを対象にし、銘柄コード、会社名、保有/監視、見出し、要約、重要/最重要、日時、記事リンクを表示する。
- 最新順・最大50件、初期load、Pull to Refresh、登録0件/該当0件/取得失敗の表示を維持する。
- 取得は既存のauthenticated sessionと `public.get_my_important_stock_news` RPCを使用し、アプリに秘密鍵を追加しない。
- Expo対象TypeScript、iOS bundle/export、webルートを確認する。
- 安全に既存認証sessionを使える場合のみ、ログイン後の重要ニュース表示、本人銘柄限定、Pull to Refresh、empty/error、ログアウト後の残留なしを確認する。
- 認証資格情報が必要なら新規作成や変更は行わず、ユーザー向けの最短確認手順をReportへ残す。
- commit/push直前にorigin/mainを再確認し、競合があれば上書きせず停止する。

## Forbidden

- `supabase/functions/important-news-monitor/**` の変更
- Codexの現在task対象の変更
- Push通知固有差分の実装・反映
- DB migration / schema / GRANT変更
- Edge Function deploy
- Cron / X投稿系変更
- 他workstreamの未コミット変更を混ぜること
- secrets・認証情報の表示/commit

## Completion criteria

- 重要ニュース画面・取得コード・newsタブがorigin/mainへ安全に反映される
- 今回workstream以外の差分を含まない
- Expo対象TypeScript PASS
- iOS bundle/export PASS
- authenticated RPC設計と整合する
- E2E結果または実施不可理由と最短手順をReportに記載する
- 完了時は本TASK末尾に `## Report` を追記し、status=`review_required`
- next_owner: chatgpt

- commit: 今回workstreamの最小差分のみ許可
- push: fresh-checkで競合がなければorigin/mainへpush可
- deploy: 禁止
- report_mode: inline
- next_owner: chatgpt

## Report

- task_id: kabumori-important-news-mainline-and-ios-e2e-20260906
- result: 重要ニュース画面・取得コード・newsタブを`origin/main`ベースの一時worktreeで再構成し、commit/push完了。Codexの現在task（`important-news-freshness-coverage-fix-20260906`、`supabase/functions/important-news-monitor/**`のbreaking_market/market_macro調整）とは対象ファイルが完全に分離しており競合なし。
- changed_files（commit `89cdd20`、`origin/main`へpush済み。base: K2承認済み`a24ba18`の上に構築）:
  - `src/lib/important-news.ts`（新規）— `fetchMyImportantStockNews()`。`supabase.auth.getUser()`で本人確認、`tracked_stocks`のactive件数確認、`public.get_my_important_stock_news` RPC（`p_limit: 50`）呼び出し。秘密鍵の追加・参照なし。
  - `src/app/news.tsx`（新規）— 重要ニュース一覧画面。ticker・会社名・保有/監視バッジ・重要/最重要バッジ・見出し・要約（3行まで）・日時・記事リンク（`https?://`のみ許可しLinking.openURL）を表示。最新順、初期load、Pull to Refresh（`RefreshControl`）、登録0件/該当0件/取得失敗のメッセージ分岐を実装。
  - `src/components/app-tabs.tsx` / `app-tabs.web.tsx` — 「重要ニュース」タブ（`/news`）を検索・登録銘柄タブの後に追加。K2承認済み基盤へのタブ名/ブランド変更は無変更のまま維持。
- rpc_verification（read-only、DB変更なし）:
  - `supabase migration list`で`20260905140638_get_my_important_stock_news`が本番へ適用済み（local/remote一致）であることを確認
  - `supabase/migrations/20260905140638_get_my_important_stock_news.sql`をread-only確認：`security definer`・`set search_path = ''`、`auth.uid()`で本人のactive tracked_stocksのみ結合、`importance in (important, most_important)`かつ`status in (ready_for_publish, generation_failed)`かつ`duplicate_of is null`でフィルタ、`limit greatest(1, least(p_limit, 50))`。GRANTは`authenticated`のみ`execute`可（`anon`/`public`/`service_role`は`revoke`済み）。今回のフロント実装（`p_limit: 50`固定、最大50件）と整合している。
  - migrationの追加・変更は一切行っていない（forbidden通り）
- tests:
  - 一時worktreeで`npx tsc --noEmit`（リポジトリ全体）を実行。今回追加・変更した`src/app/news.tsx`・`src/lib/important-news.ts`・`src/components/app-tabs.tsx`・`app-tabs.web.tsx`に新規エラーなし。既存エラー（`src/`配下2件のCSS module解決、`supabase/functions/x-test-post/**`のDeno向けNode型解決）は今回差分と無関係の既存事象で、K2承認済みタスクの報告と同一。
  - `npx expo export --platform web`：exit code 0。静的ルートが`/`・`/explore`・`/news`・`/_sitemap`・`/+not-found`の5件に増加（`/news`追加を確認）。
  - `npx expo export --platform ios`：exit code 0。iOS bundle（`entry-*.hbc`）とassetの生成を確認。
  - ビルド確認用に`.env`を一時的にworktreeへコピーして使用し、確認後に削除・commit対象からも除外。
- e2e: **未実施**。認証資格情報（テストユーザーのメール/パスワード）が提供されておらず、新規作成もforbidden外の判断のため行っていない。ユーザー向け最短確認手順は以下の通り:
  1. 既存アカウントでログイン
  2. 検索タブで任意の銘柄を保有または監視に登録（登録済みなら不要）
  3. 「重要ニュース」タブを開き、初期表示・Pull to Refreshが動作し、登録銘柄に紐づく重要/最重要ニュースのみ表示されることを確認（該当0件なら案内メッセージが出ることを確認）
  4. 記事の「記事を開く」リンクが機能することを確認
  5. ログアウトし、「重要ニュース」タブ（画面自体）が消え、再ログイン時に前回データが残っていないことを確認（`AuthGate`がsession=nullで`AppTabs`全体をアンマウントする設計のため、コード上は残留しない設計になっている）
- commit_hash: `89cdd20`（`origin/main`へpush済み、親は本タスクの`in_progress`commit `4d8e274`）
- push: 完了。push前に`origin/main`を2回fresh-check（in_progress commit時・実装commit時）し、いずれもdrift無しを確認。
- deploy: 未実施（forbidden通り）。
- remaining_issues:
  - E2E（ログイン後の実データ表示・Pull to Refresh・ログアウト後残留なし）はテスト資格情報が無いため未実施。上記手順でユーザー本人による確認が必要。
  - Push通知固有差分（`kabumori-expo-push-foundation-v1-20260905`のReport記載分）は本タスクでも一切反映していない。引き続き元の作業ディレクトリに手つかずで残存。
- safety_checks:
  - `supabase/functions/important-news-monitor/**`：一切変更していない
  - Codexの現在task（`important-news-freshness-coverage-fix-20260906`）対象ファイル：一切変更していない
  - Push通知固有差分：実装・反映していない
  - DB migration/schema/GRANT：変更していない（read-only確認のみ）
  - Edge Function deploy：未実施
  - Cron・X投稿系：変更していない
  - 他workstream（stocks sync関連、`.env`、`.claude/launch.json`、`apps/admin`、Codexの`.agent`ファイル等）：一切変更・stage・commitしていない。元の共有作業ディレクトリのgit HEAD・staged内容には触れていない（commit/pushはすべて`origin/main`ベースの一時worktreeで実施）
  - secrets・認証情報：commitに含めていない。ビルド確認用`.env`一時コピーはcommit前に削除済み
- next_recommendation: (a) 今回のcommit`89cdd20`をレビューし問題なければK2、(b) 承認後、ユーザー本人に上記E2E手順（1〜5）の実施を依頼、(c) 以降のPush通知follow-upタスクは今回commitされた`origin/main`をベースに、`kabumori-expo-push-foundation-v1-20260905`のReport記載5点を再適用する想定は変更なし
