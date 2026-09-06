# Claude Task 2

Claude Code（くろちゃん）並列スロット2の現在タスクです。`G2` を受けたClaude Codeは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルを自分の担当タスク正本として扱います。

- task_id: kabumori-expo-push-foundation-mainline-20260906
- owner: claude
- slot: claude-2
- status: in_progress
- purpose: K2承認済みのExpo/Auth/MVP共通基盤と重要ニュース画面本線を土台に、既にローカル実装済みのPush通知固有差分を安全にorigin/mainへ再適用し、Push Token登録・送信基盤を本線へ反映できる状態にする。

## Scope

- 作業開始前にorigin/main、`.agent/ORCHESTRATION.md`、`.agent/CURRENT_STATE.md`、本TASKをfresh-checkする。
- Codexの現在task対象 `supabase/functions/important-news-monitor/**` と競合しないことを確認する。
- 既存ローカルPush差分を再実装せず、K2承認済み基盤の上へ安全にrebase/reapplyする。
- 対象は原則以下のみ。
  1. `app.json`: `expo-notifications` plugin設定
  2. `package.json` / `package-lock.json`: Expo SDK57と整合する`expo-notifications`追加。lockfileは正規installで生成
  3. `src/lib/auth.ts`: logout時のこの端末Push Token削除best-effort
  4. `src/app/_layout.tsx`: ログイン中のPush Token登録hook配線
  5. `src/hooks/use-register-push-token.ts`
  6. `src/lib/push-notifications.ts`
  7. `supabase/functions/send-push-notifications/**`
- `device_push_tokens`既存RLS/unique制約を利用し、DB schema変更は行わない。
- `notifications.push_status`を将来の送信対象として扱える独立Push sender設計を維持する。
- invalid token等の恒久失敗を無限再試行しない。
- 通知payloadのdataに後続のアプリ内遷移用IDを載せられる設計を維持する。
- Expo対象TypeScript、iOS bundle/export、Push関連テストを実施する。
- 実機資格情報・Expo Push Token・Apple Push環境が必要なE2Eは、既存安全手段がある場合のみ実施し、勝手にユーザー/認証情報を作成・変更しない。
- commit/push直前にorigin/mainを再fresh-checkし、競合があれば上書きせず停止する。

## Forbidden

- `supabase/functions/important-news-monitor/**` の変更
- Codex現在task対象の変更
- `src/app/news.tsx` / `src/lib/important-news.ts` / 重要ニュースRPC・migration変更
- ニュース→対象ユーザー抽出→`notifications`生成ロジックの新規実装
- 本番DB migration / schema / GRANT変更
- 本番Edge Function deploy
- Cron / X投稿系変更
- 他workstreamの未コミット変更を混ぜること
- secrets・認証情報の表示/commit

## Completion criteria

- Push通知固有差分がorigin/mainへ安全に反映される
- 重要ニュース画面・RPC・monitor・X系に差分なし
- `expo-notifications`依存とapp設定がExpo SDK57に整合
- 認証済み本人の`device_push_tokens`へ安全にupsertできるコード経路あり
- logout時のtoken扱いが明示/実装される
- Push senderが重要ニュースmonitorから独立し、pending通知を後続接続できる
- invalid token等を無限再送しない
- TypeScript / iOS bundle / relevant testsの結果を報告
- 本番deployは行わない
- 完了時は本TASK末尾に`## Report`を追記し、status=`review_required`
- next_owner: chatgpt

- commit: 今回workstreamの最小差分のみ許可
- push: fresh-checkで競合がなければorigin/mainへpush可
- deploy: 禁止
- report_mode: inline

## K2 Review — previous task

- reviewed_task_id: kabumori-important-news-mainline-and-ios-e2e-20260906
- decision: approved
- implementation_commit: `89cdd20` origin/main反映済み
- approved_points:
  - `src/app/news.tsx` / `src/lib/important-news.ts` / newsタブを安全に本線反映
  - 本人のactive holding/watchのみを既存authenticated RPC経由で取得
  - 最大50件、最新順、Pull to Refresh、登録0件/該当0件/取得失敗UIを維持
  - Web export PASS、iOS export PASS
  - DB/GRANT/migration/Edge/Cron/X/important-news-monitor変更なし
  - Codex並行taskとの競合なし
- remaining_manual_check:
  - 認証済み実ユーザーでのiOS E2Eは資格情報なしのため未実施
  - ユーザー本人の既存アカウントで、重要ニュース表示・Pull to Refresh・記事リンク・logout後残留なしを目視確認する
