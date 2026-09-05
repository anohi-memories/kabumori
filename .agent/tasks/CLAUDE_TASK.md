# Claude Task 2

Claude Code（くろちゃん）並列スロット2の現在タスクです。`G2` を受けたClaude Codeは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルを自分の担当タスク正本として扱います。

- task_id: kabumori-expo-auth-foundation-mainline-20260906
- owner: claude
- slot: claude-2
- status: review_required
- purpose: 現在ローカルで混在しているExpo/Auth/MVP共通基盤とPush通知差分を、クリーンな`origin/main`ベースの一時worktree等を使って安全に分離・再構成し、まずExpo/Auth/MVP共通基盤だけを`origin/main`へ最小commit/pushできる状態にする。
- scope:
  - 作業開始時に`origin/main`をfresh-checkし、`.agent/ORCHESTRATION.md`、`.agent/CURRENT_STATE.md`、このTASKを確認する
  - 現在の作業ディレクトリにある未コミット変更をread-onlyで調査し、Expo/Auth/MVP共通基盤とPush通知固有差分の境界を整理する
  - 必要に応じてクリーンな`origin/main`ベースの一時worktreeを作り、その上で共通基盤を再構成する
  - Expo共通起動基盤、Auth、Supabase clientなど、Push通知より先に必要なMVP共通基盤だけを本線反映対象にする
  - `package.json` / `package-lock.json`は手編集で無理に切り分けず、必要な依存を段階的に適用し、`npm install`等でlockfileを正しく再生成する
  - 元の作業ディレクトリや他workstreamの未コミット変更を変更・削除・stage・commitしない
  - Push通知差分は後続タスクで安全にrebase・再適用できるよう、対象ファイル・依存・残課題をReportへ明記する
  - fresh-checkで安全が確認できた場合のみ、共通基盤を最小commitで`origin/main`へpushする
- forbidden:
  - Push通知固有差分をこのタスクで原則`origin/main`へ反映しない
  - `expo-notifications`、Push Token登録、Push送信Edge Function、Push通知固有設定を共通基盤commitへ混ぜない
  - `supabase/functions/important-news-monitor/**`を変更しない
  - 重要ニュースの判定・生成・取得・画面・RPC・関連migrationを変更しない
  - X投稿、`x-test-post`、morning greetingを変更しない
  - Cron・GitHub Actions workflowを変更しない
  - 本番DB、migration、GRANT、schema、production dataを変更しない
  - 本番deploy、Edge Function deploy、secret登録をしない
  - 他workstreamの未コミット変更を破壊・stage・commitしない
  - secrets・認証情報をcommitしない
- completion_criteria:
  - Expo/Auth/MVP共通基盤だけが`origin/main`上で単独成立する
  - `package.json`と`package-lock.json`が共通基盤に必要な依存だけで整合し、lockfileが正規のインストール手順で生成されている
  - Auth、Supabase client、Expo共通起動経路について必要なtypecheck・テスト・Expo bundle等がPASSする、または既存エラーと今回差分を明確に切り分けて報告する
  - Push通知固有差分が共通基盤commitに混入していないことを確認する
  - 後続でPush差分を安全にrebase・再適用できる状態と手順がReportに残っている
  - push直前に`origin/main`を再fresh-checkし、競合やdriftがない場合のみ最小commit/pushする
  - 競合や安全に分離できない事情があれば上書きせず停止し、具体的な阻害要因をReportする
  - 完了時はこのファイル末尾に`## Report`を追記し、statusを`review_required`、next_ownerを`chatgpt`にする
- commit: Expo/Auth/MVP共通基盤として安全に分離できる最小差分のみcommit
- push: fresh-checkで競合がなければ`origin/main`へpush可。他workstreamやPush通知固有差分を混ぜない
- deploy: 禁止
- report_mode: inline
- next_owner: chatgpt

## Completion report

完了時はこのファイルの末尾に `## Report` を追加し、task_id / result / changed_files / tests / commit_hash / push / deploy / remaining_issues / safety_checks / next_recommendation を記録する。

## Report

- task_id: kabumori-expo-auth-foundation-mainline-20260906
- result: Expo/Auth/MVP共通基盤を`origin/main`ベースの一時worktreeで再構成し、commit/push完了。Push通知固有差分は元の作業ディレクトリにそのまま残し、今回のcommitには一切含めていない。
- changed_files（commit `a24ba18`、`origin/main`へpush済み）:
  - `package.json` / `package-lock.json` — `@supabase/supabase-js`・`@react-native-async-storage/async-storage`・`react-native-url-polyfill`のみ追加。**`expo-notifications`は含めていない**。lockfileは一時worktreeで`npm install`実行後`npx expo install`で正規に再生成（手編集なし）。
  - `src/lib/supabase.ts`（新規）— Supabase client（AsyncStorage永続化・url-polyfill・processLock）
  - `src/lib/auth.ts`（新規）— signIn/signUp/signOut・profile自動作成・日本語エラーメッセージ。**元の作業ディレクトリ版から`removeThisDevicePushTokenBestEffort()`の呼び出しとimportを除去**（Push固有のため）
  - `src/providers/auth-provider.tsx`（新規）— セッション監視・profile準備・AuthContext
  - `src/components/auth-screen.tsx`（新規）— ログイン/新規登録画面
  - `src/lib/stocks.ts`（新規）— 銘柄/保有・監視の型定義
  - `src/components/tracked-stock-editor.tsx`（新規）— holding/watch登録・編集モーダル
  - `src/app/index.tsx` — 銘柄検索画面（元Expoスターター画面を置換）
  - `src/app/explore.tsx` — 登録銘柄一覧画面（元Exploreスターター画面を置換）
  - `src/app/_layout.tsx` — `AuthProvider`/`AuthGate`配線。**元の作業ディレクトリ版から`useRegisterPushToken`のimportと呼び出しを除去**
  - `src/components/app-tabs.tsx` / `app-tabs.web.tsx` — タブラベルを「検索」「登録銘柄」に変更、ブランド名を「Kabumori」に変更。**元の作業ディレクトリ版には重要ニュースworkstream（Codex）による`news`タブ（`/news`）追加も混在していたため、今回のcommitからは除去**（`src/app/news.tsx`・`src/lib/important-news.ts`は元のまま未commit・未変更）
  - `app.json`は変更なし（`expo-notifications` pluginブロックのみの差分だったため、共通基盤には無関係と判断し含めていない）
- tests:
  - 一時worktreeで`npx tsc --noEmit`（リポジトリ全体）を実行。今回変更・追加した`src/app`・`src/lib`・`src/components`・`src/providers`配下に新規エラーなし。`src/`配下の既存エラー2件（`animated-icon.web.tsx`のCSS module解決、`theme.ts`の`global.css`解決）は今回変更していないファイルの既存事象。それ以外の全エラーは`supabase/functions/x-test-post/**`（Deno向けテストファイル、Node型解決の既知の性質）で、今回の変更と無関係。
  - `npx expo export --platform web`：exit code 0で成功。静的ルートは`/`・`/explore`・`/_sitemap`・`/+not-found`の4件（`/news`は含まれず、意図通り）。ビルド確認用に`.env`を一時的にworktreeへコピーして使用し、確認後に削除・commit対象からも除外（`.gitignore`はコミットしていない）。
- commit_hash: `a24ba18`（`origin/main`へpush済み、push前直近の親は本タスクの`in_progress`commit `78bd2d5`）
- push: 完了。push直前に`origin/main`を再fresh-checkし、drift無し（`78bd2d5`のまま）を確認してからpush。
- deploy: 未実施（forbidden通り）。
- remaining_issues（Push通知差分の後続rebase手順）:
  - 元の作業ディレクトリには以下がPush通知固有差分として手つかずのまま残っている。今回のcommit(`a24ba18`)の上に安全に再適用できる:
    1. `app.json`: `expo-notifications` pluginブロック（icon/color設定）を追加
    2. `package.json`/`package-lock.json`: `expo-notifications: ~57.0.17`を追加（`npx expo install expo-notifications`で再生成）
    3. `src/lib/auth.ts`: `signOut()`内に`removeThisDevicePushTokenBestEffort()`呼び出しと対応import（`@/lib/push-notifications`）を再追加
    4. `src/app/_layout.tsx`: `useRegisterPushToken`のimportと`AuthGate`内の呼び出しを再追加
    5. 新規ファイルとして手つかず: `src/hooks/use-register-push-token.ts`、`src/lib/push-notifications.ts`、`supabase/functions/send-push-notifications/**`（`index.ts`・`push_send_logic.ts`・`push_send_logic_test.ts`、いずれも未deploy）
  - これらはすべて`kabumori-expo-push-foundation-v1-20260905`（review_required、旧報告）で実装済みの内容と同一。次のPushタスクでは、今回commitされた`origin/main`をベースに上記5点を再適用し、fresh-checkしてcommit/pushする想定。
  - `src/app/news.tsx`・`src/lib/important-news.ts`、および`app-tabs.tsx`/`app-tabs.web.tsx`の`news`タブ追加分（重要ニュースworkstream/Codex担当）も元の作業ディレクトリに手つかずのまま残存。今回のcommitには一切含めていない。
- safety_checks:
  - `supabase/functions/important-news-monitor/**`、重要ニュース判定・生成・取得・画面・RPC・migration：一切変更・commitしていない
  - X投稿、`x-test-post`、morning greeting：一切変更していない
  - Cron・GitHub Actions workflow：一切変更していない
  - 本番DB・migration・GRANT・schema・production data：一切変更していない
  - 本番deploy・Edge Function deploy・secret登録：一切実施していない
  - 他workstream（stocks sync関連migration/functions、`.env`、`.claude/launch.json`、`apps/admin/next-env.d.ts`、`.agent/CODEX_REPORT.md`、`.agent/tasks/CODEX_TASK.md`等）：一切変更・stage・commitしていない。元の作業ディレクトリはcommit前後で無傷（`git status`で確認）
  - secrets・認証情報：commitに含めていない。ビルド確認用の`.env`一時コピーはcommit前に削除済み
  - commit/pushはすべて`origin/main`ベースの一時worktree（`/private/tmp/.../scratchpad/kabumori-foundation-worktree`）上で実施し、元の共有作業ディレクトリのgit HEAD・staged内容には触れていない
- next_recommendation: (a) 今回のcommit`a24ba18`をレビューし問題なければK2、(b) 承認後はPush通知follow-upタスクとして上記remaining_issuesの5点を`origin/main`ベースで再適用しcommit/push（`kabumori-expo-push-foundation-v1-20260905`のReportに実装済み内容と実質同一のため再実装は不要、rebaseのみ）、(c) 重要ニュースworkstream側でも`app-tabs`への`news`タブ再適用が必要な旨を申し送り
