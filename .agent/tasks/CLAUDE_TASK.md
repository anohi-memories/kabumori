# Claude Task 2

Claude Code（くろちゃん）並列スロット2の現在タスクです。`G2` を受けたClaude Codeは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルを自分の担当タスク正本として扱います。

- task_id: kabumori-expo-auth-foundation-mainline-20260906
- owner: claude
- slot: claude-2
- status: ready
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
