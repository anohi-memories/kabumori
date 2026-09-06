# Claude Task 2

- task_id: kabumori-eas-project-and-push-runtime-prep-20260906
- owner: claude
- slot: claude-2
- status: review_required
- purpose: K2承認済みのPush通知本線を土台に、Expo Push Tokenを実機で取得できるようEAS project設定を整え、`send-push-notifications`を本番deployできる直前まで安全に準備する。重要ニュースmonitor/X/Cron/DB schemaには触れない。

## Previous K2 Review

前タスク `kabumori-expo-push-foundation-mainline-20260906` は承認。

承認理由:
- commit `43a2628` がorigin/mainへ反映済み
- `expo-notifications ~57.0.17`、通知plugin、token登録hook、logout時token削除、独立Push senderが安全に本線反映
- Push関連テスト 11/11 PASS
- web/iOS export PASS
- 重要ニュース画面/RPC/monitor/X系/DB/Cronに差分なし
- 本番Edge Function deployなし
- secrets/認証情報のcommitなし

残課題:
- EAS projectId未設定で実機Expo Push Token取得未確認
- `send-push-notifications`のsecret/config/deploy未実施
- 重要ニュース→対象ユーザー→`notifications`生成接続は未実装

## Scope

- origin/main、ORCHESTRATION、CURRENT_STATE、本TASKをfresh-check
- 現在のExpo/EAS設定を確認し、既存Expo projectがあればそのprojectIdを安全に利用する
- projectIdが未作成でExpo/EASログインやユーザー操作が必要なら、勝手に別アカウント/別projectを作らず停止して必要手順をReport
- 安全に解決できる場合のみ `app.json` の `extra.eas.projectId` 等、Expo SDK57/EAS標準の最小設定を反映
- `eas.json` が必要なら最小構成のみ追加し、既存設定がある場合は壊さない
- `npx expo config --type public` / prebuild相当でprojectId・notifications設定を確認
- iOS bundle/exportを再確認
- 実機E2Eは既存安全な端末/セッションが利用できる場合のみ。資格情報新規作成・変更は禁止
- `send-push-notifications`について、既存のsecret運用と `supabase/config.toml` をread-only確認し、本番deployに必要な最小差分を特定
- secret値は表示・記録しない
- 安全に設定ファイルだけ先行commit/pushできる場合は最小差分で反映可
- 本番Edge Function deployはこのタスクでは実施しない

## Forbidden

- `supabase/functions/important-news-monitor/**`変更
- Codex現在task対象の変更
- 重要ニュース画面/RPC/migration変更
- DB migration/schema/GRANT変更
- Cron/X投稿系変更
- 本番Edge Function deploy
- secret新規値の表示/commit
- ユーザー/Expoアカウント/認証情報の勝手な作成・変更
- 他workstream差分の混入

## Completion criteria

- EAS projectIdの有無と安全な設定可否を確定
- 設定可能ならorigin/mainへ最小反映
- Expo config / iOS export結果を報告
- 実機Push Token E2Eの実施可否を報告
- `send-push-notifications`本番deployに必要なsecret/config差分を明示
- 本番deploy・DB変更・Cron/X変更なし
- 完了時status=`review_required`
- TASK末尾に `## Report` を追記
- next_owner: chatgpt

- commit: 安全に分離できるExpo/EAS設定のみ可
- push: fresh-checkで競合なければ可
- deploy: 禁止
- report_mode: inline
- next_owner: chatgpt

## Report

- task_id: kabumori-eas-project-and-push-runtime-prep-20260906
- result: **EAS project設定は未実施のまま停止**。このマシン/リポジトリにはExpo/EASアカウントへのログインが一切存在せず、`app.json`/`eas.json`にも既存projectIdが無いことを確認した。scope指示「projectIdが未作成でExpo/EASログインやユーザー操作が必要なら、勝手に別アカウント/別projectを作らず停止して必要手順をReport」に従い、ユーザー自身のExpoアカウントでの対応が必要なため、ここで停止して報告する。一方、`send-push-notifications`本番deployに必要な差分の特定はread-onlyで完了した。
- eas_investigation（read-only、変更なし）:
  - `npx eas-cli whoami` → `Not logged in`。このマシンにEAS CLIの既存セッションなし
  - `~/.expo/state.json`にはanalytics device id/uuidのみで、認証情報や既存project情報は含まれていない
  - `app.json`に`extra.eas.projectId`なし、`eas.json`はリポジトリに存在しない
  - `npx expo config --type public --json`で`extra`を確認 → `{"router": {}}`のみ、EAS関連キーなし
  - リポジトリ全体を`EXPO_TOKEN`/`EAS_`でgrepしたが、それらしき既存設定・環境変数は見つからなかった
  - 結論: **このリポジトリ／マシンには利用可能な既存Expo/EAS projectが存在しない**。安全に解決できないため、`app.json`への`extra.eas.projectId`追加、`eas.json`作成のいずれも行っていない
- required_user_action（ユーザー本人が実施する必要がある手順）:
  1. https://expo.dev でExpoアカウントにログイン（未作成なら作成）
  2. ローカル環境で`npx eas login`を実行し、そのアカウントで認証する
  3. `npx eas init`（またはExpoダッシュボード上でproject作成）を実行し、`kabumori`用のEAS projectを作成する。これにより`app.json`に`extra.eas.projectId`が自動追記される
  4. 上記のprojectId追加後、次のClaude slotタスクでその設定を`origin/main`へ最小commitできる
  - 本タスクではExpoアカウントの新規作成・ログイン・project作成のいずれも実施していない（forbidden「ユーザー/Expoアカウント/認証情報の勝手な作成・変更」に従う）
- send_push_notifications_deploy_readiness（read-only確認、secret値は非表示）:
  - `supabase secrets list`をread-only実行し、既存secret**名**を確認（値は表示していない。CLIが返す`value`欄はハッシュダイジェストでありsecret本体ではないため安全だが、本Reportにも転記していない）
  - `send-push-notifications`用の専用cron secret（例: `SEND_PUSH_NOTIFICATIONS_CRON_SECRET`、`stocks-master-sync`の`STOCKS_MASTER_SYNC_CRON_SECRET`と同じ命名規約）は**まだ登録されていない**ことを確認
  - `supabase/config.toml`をread-only確認：現在`stocks-master-sync`・`stocks-new-listing-sync`の2関数のみ`verify_jwt = false`が設定されている。**このファイル自体が`git`未追跡（stocks syncワークストリームの未コミット差分）**であるため、`send-push-notifications`のエントリ追加は今回commitしていない
  - 本番deployに必要な最小差分（将来タスク向けに特定、今回は未実施）:
    1. `SEND_PUSH_NOTIFICATIONS_CRON_SECRET`を生成し`supabase secrets set`で登録
    2. `supabase/config.toml`に`[functions.send-push-notifications]\nverify_jwt = false`を追加（ただし同ファイルの他2エントリがstocks syncワークストリームの未コミット差分と混在しているため、コミット方法は次タスクでstocks sync担当と調整が必要）
    3. `supabase functions deploy send-push-notifications`
    4. `kabumori-send-push-notifications`等の名前でcron登録（`stocks-master-sync`と同じ`WITH secret AS (...) SELECT ... FROM secret`パターンを踏襲）
- tests:
  - `npx expo export --platform ios`：exit code 0（前task同様、コード変更なしのため差分なし）
  - `npx expo export --platform web`は前taskで確認済みのため今回省略（コード変更なし）
  - コード変更が一切ないため、TypeScript/node testの再実行は行っていない（変更ゼロ）
- commit_hash: なし（実装差分ゼロ。`.agent/`のin_progressマーカーのみ`9d052fc`としてpush済み）
- push: `.agent/`の状態更新のみpush。実装コードの変更・commit・pushは無し（変更すべき安全な差分が無いため）
- deploy: 未実施（forbidden通り）。
- remaining_issues:
  - EAS project作成はユーザー本人のExpoアカウント操作が必要。上記required_user_actionの1〜3をユーザーに依頼
  - `send-push-notifications`のsecret登録・config.toml変更・deployは、EAS設定完了後の別タスクで実施
  - `supabase/config.toml`が未追跡のままのため、将来これをcommitする際はstocks syncワークストリーム（3エントリ中2つが既にそちらの担当分）との調整が必要である旨を申し送り
- safety_checks:
  - `supabase/functions/important-news-monitor/**`、重要ニュース画面/RPC/migration：一切変更していない
  - Codex現在task対象：一切変更していない
  - DB migration/schema/GRANT：変更していない
  - 本番Edge Function deploy：未実施
  - Cron・X投稿系：変更していない
  - Expo/EASアカウントの新規作成・ログイン・project作成：一切実施していない
  - secret値：表示・記録していない（`secrets list`のハッシュダイジェストも転記していない）
  - 他workstream（stocks sync関連の`supabase/config.toml`含む、`.env`、`.claude/launch.json`、`apps/admin`、Codexの`.agent`ファイル等）：一切変更・stage・commitしていない
- next_recommendation: (a) ユーザー本人にrequired_user_actionの1〜3（Expoログイン・EAS project作成）を依頼、(b) 完了後、`app.json`の`extra.eas.projectId`反映と実機Push Token E2Eを次のClaude slotタスクとして実施、(c) それと並行または後続で、`send-push-notifications`のsecret登録・config.toml調整・deployを別タスクとして計画
