# Claude Task 2

- task_id: kabumori-important-news-mainline-and-ios-e2e-20260906
- owner: claude
- slot: claude-2
- status: ready
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
