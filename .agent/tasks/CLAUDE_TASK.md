# Claude Task 2

Claude Code（くろちゃん）並列スロット2の現在タスクです。`G2` を受けたClaude Codeは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルを自分の担当タスク正本として扱います。

- task_id: kabumori-expo-push-foundation-mainline-20260906
- owner: claude
- slot: claude-2
- status: review_required
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

## Report

- task_id: kabumori-expo-push-foundation-mainline-20260906
- result: Push通知固有差分を`origin/main`ベースの一時worktreeで再実装なしに再適用し、commit/push完了。重要ニュース画面・RPC・monitor・X系・Codex現在taskには一切触れていない。
- changed_files（commit `43a2628`、`origin/main`へpush済み。base: K2承認済み`89cdd20`の上に構築）:
  - `app.json` — `expo-notifications` plugin（icon: `./assets/images/icon.png`, color: `#208AEF`）を追加。他のplugin/設定は無変更。
  - `package.json` / `package-lock.json` — `expo-notifications: ~57.0.17`を`npx expo install`で追加（Expo SDK57整合、正規lockfile再生成、手編集なし）。
  - `src/lib/push-notifications.ts`（新規）— 権限要求・Expo Push Token取得（EAS projectId未設定時は`skipped`で安全に処理継続）・`device_push_tokens`への`onConflict: 'expo_push_token'`upsert・サインアウト時のこの端末分best-effort削除。
  - `src/hooks/use-register-push-token.ts`（新規）— セッションごとに1回だけ登録（`useRef`で重複防止）、エラーは`console.warn`のみでアプリをブロックしない。
  - `src/app/_layout.tsx` — `AuthGate`内で`useRegisterPushToken(session)`を呼び出す2行を追加。K2承認済みのAuth配線自体は無変更。
  - `src/lib/auth.ts` — `signOut()`内で`removeThisDevicePushTokenBestEffort()`をSupabase signOut前に呼び出す3行を追加。他の関数は無変更。
  - `supabase/functions/send-push-notifications/index.ts` / `push_send_logic.ts` / `push_send_logic_test.ts`（新規、**未deploy**）— `notifications.push_status='pending'`を読み取りExpo Push APIへ送信する独立関数。`important-news-monitor`は一切import/参照しない。認証は`X-Cron-Secret`ヘッダ＋`SUPABASE_SECRET_KEYS`読み取り（stocks-syncと同じ規約）だが、今回はsecret登録・config.toml追加・deployのいずれも行っていない。
- device_push_tokens_design:
  - 既存のunique制約（`expo_push_token`）とRLS（本人のみALL）をそのまま利用。DB schema/migration/GRANT変更なし
  - 同一デバイスがアカウントを切り替えた場合は`expo_push_token`一致で新しい`user_id`へ上書きされる設計（重複行を作らない）
  - `DeviceNotRegistered`（Expo Push APIが返す唯一の恒久失敗）のみtoken削除。それ以外は一時エラーとして次回送信に委ねる（無限再試行はしない）
  - 通知payloadの`data`に`notification_id`/`source_type`/`source_id`を含め、後続のアプリ内タップ遷移に対応できる設計を維持
- tests:
  - 一時worktreeで`node --test supabase/functions/send-push-notifications/push_send_logic_test.ts`：11/11 pass。
  - `npx tsc --noEmit`（リポジトリ全体）：今回変更・追加した`src/app/_layout.tsx`・`src/lib/auth.ts`・`src/lib/push-notifications.ts`・`src/hooks/use-register-push-token.ts`に新規エラーなし。`supabase/functions/send-push-notifications/**`のDeno向け`Deno`未定義/`node:`型解決エラーは、変更していない`important-news-monitor/**`や`x-test-post/**`でも同一パターンが再現する、リポジトリ全体の既知のtsconfig事象（DenoコードをNode向けtscでチェックしているため）であり、今回差分固有の問題ではない。`src/`配下の既存エラー2件（CSS module/`global.css`解決）も今回変更と無関係の既存事象。
  - `npx expo export --platform web`：exit code 0。静的ルート5件（`/`・`/explore`・`/news`・`/_sitemap`・`/+not-found`）は前task同様、`[expo-notifications] Listening to push token changes is not yet fully supported on web`という想定通りの情報ログのみ。
  - `npx expo export --platform ios`：exit code 0。iOS bundle生成を確認。
  - `npx expo config --type prebuild --json`：exit code 0。`expo-notifications`がplugin一覧に解決され、参照アイコン（`assets/images/icon.png`）の存在も確認済み。
  - ビルド確認用に`.env`を一時的にworktreeへコピーし、確認後に削除・commit対象からも除外。
- e2e: **未実施**（前task同様、テスト資格情報が未提供のため新規作成せず）。加えて、EAS `projectId`が`app.json`/`eas.json`に未設定のため、実機であっても現状は`registerForPushNotificationsAsync()`が`skipped`扱いになり、実際のExpo Push Token取得はEAS設定後でないと確認できない（コードはこの状態を検知して安全にスキップする設計）。ユーザー向け最短確認手順:
  1. EAS project作成・`app.json`の`extra.eas.projectId`設定（別タスク推奨、DB/Cron等には影響しない設定作業）
  2. 実機（シミュレータ不可、`Device.isDevice`でガード済み）でログイン→通知権限許可
  3. `device_push_tokens`に新しい行がupsertされることを確認
  4. ログアウトし、該当行が削除される（best-effort）ことを確認
  5. 送信側は`send-push-notifications`のsecret登録・`config.toml`追加・deployが別途必要（本タスクでは未実施、forbidden通り）
- commit_hash: `43a2628`（`origin/main`へpush済み、親は本タスクの`in_progress`commit `0f9c3eb`）
- push: 完了。push前に2回（in_progress commit時・実装commit時）`origin/main`をfresh-checkし、いずれもdrift無し。
- deploy: 未実施（forbidden通り）。
- remaining_issues:
  - EAS projectId未設定のため、実機での実際のExpo Push Token取得は依然未確認（コード上は安全にskip）
  - `send-push-notifications`のsecret登録・`supabase/config.toml`への`verify_jwt=false`追加・deployは別タスクで実施が必要
  - ニュース→対象ユーザー抽出→`notifications`生成ロジック（重要ニュース→push対象への接続）は本タスクのforbidden対象のため未実装。次のPush配信タスクで検討
- safety_checks:
  - `supabase/functions/important-news-monitor/**`、`src/app/news.tsx`、`src/lib/important-news.ts`、重要ニュースRPC/migration：一切変更していない
  - Codex現在task（`important-news-freshness-coverage-fix-20260906`）対象：一切変更していない
  - DB migration/schema/GRANT：変更していない（`device_push_tokens`は既存のまま利用）
  - 本番Edge Function deploy：未実施
  - Cron・X投稿系：変更していない
  - 他workstream（stocks sync関連、`.env`、`.claude/launch.json`、`apps/admin`、Codexの`.agent`ファイル等）：一切変更・stage・commitしていない。元の共有作業ディレクトリのgit HEAD・staged内容には触れていない（commit/pushはすべて`origin/main`ベースの一時worktreeで実施）
  - secrets・認証情報：commitに含めていない。ビルド確認用`.env`一時コピーはcommit前に削除済み
- next_recommendation: (a) 今回のcommit`43a2628`をレビューし問題なければK2、(b) 承認後、EAS project作成・projectId設定を別タスクとして計画、(c) `send-push-notifications`のsecret登録・config.toml追加・deployを別タスクとして計画、(d) 重要ニュース→対象ユーザー抽出→notifications生成ロジックの実装を、上記(b)(c)完了後の後続タスクとして検討

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
