# Claude Task 2

- task_id: kabumori-mvp-completion-nonapple-20260907
- owner: claude
- slot: claude-2
- status: review_required
- next_owner: chatgpt
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

## Report

- task_id: kabumori-mvp-completion-nonapple-20260907
- result: MVP gap監査を実施し、Apple加入なし・既存schemaのみで安全に実装できる高優先度ギャップ3点を実装、commit/push完了（commit `24ee8bb`、親は本タスクの`in_progress`commit `f0dd34d`）。DB migration・important-news-monitor・他workstreamには一切触れていない。

### Scope A: MVP gap audit結果

1. ログイン→検索→保有/監視登録→登録銘柄確認：既存導線で完結しており、大きな欠落なし。空状態（`まだ登録銘柄がありません`等）・ローディング・エラーメッセージは各画面に既に実装済みであることをコード監査で確認。**変更不要と判断**。
2. 重要ニュース一覧→記事到達：`news.tsx`で`Linking.openURL`による記事リンクは既に実装済み。記事詳細のアプリ内画面（本文全文表示等）は無いが、外部記事へのリンクで代替されており、今回のスコープでは妥当と判断。**変更不要**。
3. `notifications`テーブルに既存データがある場合のアプリ内通知導線：**欠落を確認**。テーブル自体（GRANT: authenticated SELECT + UPDATE(read_at)のみ）はあるが、それを読む画面がどこにも無かった。→実装（下記参照）。
4. Push通知タップ時の遷移設計：**欠落を確認**。`send-push-notifications`のpayloadには`notification_id`/`source_type`/`source_id`が乗っているが、タップ時のリスナー登録がどこにも無かった。→実装（下記参照）。
5. `alert_settings`の通知設定UI：**欠落を確認**。テーブル・GRANT（authenticated SELECT/INSERT/UPDATE、DELETE無し、RLSは本人のみ）は既にあるが、読み書きするUIがどこにも無く、`ensureProfile`のようなレコード自動作成も無かった。→実装（下記参照、範囲は限定）。
6. ログアウト時の状態クリア：`AuthGate`が`session`のnullで`AppTabs`全体をアンマウントする設計のため、画面ローカルstate（今回追加した`settingsOpen`含む）は自動的に破棄される。追加調査で新たな残留リスクは見つからず。**変更不要**。
7. ナビゲーション/タブ名称：既存の「検索」「登録銘柄」「重要ニュース」は日本語の平易な単語で初心者にも分かりやすいと判断。**変更不要**（無理な言い換えによる混乱を避けた）。

### Scope B: 実装内容（commit `24ee8bb`）

- `src/lib/notifications.ts`（新規）— `markImportantNewsNotificationsRead()`。`notifications`の`source_type='important_news'`かつ未読行を本人分だけ`read_at`更新（authenticatedのUPDATE(read_at)権限のみで完結、他列は触らない）。
- `src/app/news.tsx` — 画面focus時に上記関数を呼び出す1行を追加。重要ニュースを見た＝該当通知を読んだ扱いにする、既存データに対するアプリ内導線。
- `src/hooks/use-push-notification-navigation.ts`（新規）— `Notifications.addNotificationResponseReceivedListener`でpush tap時のdata（`source_type`）を見て、`important_news`なら`router.push('/news')`。
- `src/app/_layout.tsx` — `AuthGate`内で上記フックをsession付きで呼び出す2行を追加。
- `src/lib/alert-settings.ts`（新規）— `fetchMyAlertSettings()`（行が無ければ列defaultと同じ値を返す）、`upsertMyAlertSettings()`（`onConflict: 'user_id'`で初回保存時に行を作成）。**`important_news`と`push_enabled`の2項目のみ**を対象にした。
- `src/components/notification-settings.tsx`（新規）— 上記2項目のトグルUI（`Switch`）。既存`TrackedStockEditor`と同じモーダルパターン（`Modal` + `pageSheet`）。
- `src/app/explore.tsx` — ヘッダー行に「通知設定」ボタンを追加し、モーダルを開閉するstateを追加。

### 実装しなかった/範囲を絞った理由

- `alert_settings`には`earnings`/`tdnet`/`large_shareholding`/`price_move`/`morning_report`/`close_report`/`email_enabled`の列も存在するが、**これらに対応する通知生成ロジックはアプリ側にもimportant-news-monitor側にも一切存在しない**（`grep`で無使用を確認）。存在しない機能のトグルを見せると初心者を混乱させるため、実際に意味のある`important_news`と`push_enabled`の2項目のみに絞った。「過剰な専門設定は不要」という要求にも合致すると判断。
- 今回のUIは`alert_settings`への書き込みまでで、**この設定値を実際に読んで通知有無を判定するロジック（important-news-monitor側、send-push-notifications側のいずれにも）はまだ無い**。つまり現時点ではトグルを切っても実際の通知量は変わらない。これは今回のforbidden（important-news-monitor変更禁止、DB migration禁止）の範囲内では実装不可能なため、正直に制限として報告する。
- 独立した「通知一覧（inbox）」画面は追加しなかった。`notifications`テーブルの実体的な内容は現状ほぼ重要ニュースと重なるため、既存の`news.tsx`を「見た＝既読」の到達先として再利用する設計にし、画面の重複・大規模リファクタを避けた。
- 新規route（`/settings`等）は追加しなかった。`expo-router/unstable-native-tabs`は実験的APIで、tabに登録されていないrouteのnavigation挙動が不明だったため、既存の`TrackedStockEditor`と同じ「画面内モーダル」パターンに倣い、navigation層に触れないようにした。
- DB schema変更が必要な機能（記事詳細ページ、通知の個別既読管理UIなど）は実装せず、ここで報告するに留めた。

### tests

- `npx tsc --noEmit`（リポジトリ全体）：今回変更・追加した7ファイルに新規エラーなし。既存の`src/`2件・`supabase/functions/**`のDeno向け既知事象のみ（前task群と同一）。
- `npx expo export --platform ios`：exit code 0
- `npx expo export --platform web`：exit code 0、静的ルート5件は前task同様
- `npx expo start --web`でdev serverを起動し、Browserペインで実際にログイン画面までロード。コンソールエラー0件を確認（新規importグラフのbundle崩壊が無いことのsanity check）。**ログイン後の画面（通知設定モーダル・重要ニュース既読化・push tap遷移）はテスト資格情報が無いため実機/ブラウザでの目視確認は未実施**。コードレビューレベルでの正しさ（既存パターンとの整合、RLS/GRANT範囲内であること）は確認済み。
- ビルド確認用の`.env`は一時的にworktreeへコピーし、確認後に削除・commit対象からも除外。
- Push tap遷移（`use-push-notification-navigation.ts`）は実機push配信が無いと動作確認できない（既存のPush実機E2E自体が保留中のため、これも同様に未検証）。

### commit_hash

- `24ee8bb`（`origin/main`へpush済み、親は`in_progress`commit `f0dd34d`）
- push前に2回（in_progress commit時・実装commit時）`origin/main`をfresh-checkし、いずれもdrift無し

### push / deploy

- push: 完了
- deploy: 未実施（本タスクにEdge Function/DB変更は含まれない）

### remaining_issues

- `alert_settings`の`important_news`/`push_enabled`トグルは、それを実際に読んで通知生成/送信を制御するロジックがまだ無いため、現時点ではUIのみで効果が無い。将来important-news-monitorまたはsend-push-notifications側でこの設定を尊重する接続が必要（DB schema変更は不要、読み取りロジックの追加のみ）
- ログイン後の新規UI（通知設定モーダル、既読化、push tap遷移）は認証資格情報が無いため未検証。ユーザー本人による目視確認を推奨
- 実機Push Token E2E・EAS development buildは引き続き保留（ユーザーの判断通り）

### safety_checks

- `supabase/functions/important-news-monitor/**`、Codex現在task対象：一切変更していない
- DB migration/schema/GRANT：変更していない（既存`alert_settings`/`notifications`のGRANT範囲内でのみ読み書き）
- Cron・X投稿系・auto_publish：変更していない
- 本番Edge Function deploy：未実施
- Apple Developer Program・EAS build：一切触れていない
- 他workstream（stocks sync関連、`.env`、`.claude/launch.json`、`apps/admin`、Codexの`.agent`ファイル等）：一切変更・stage・commitしていない。元の共有作業ディレクトリのgit HEAD・staged内容には触れていない（commit/pushはすべて`origin/main`ベースの一時worktreeで実施）
- secrets・認証情報：commitに含めていない

### next_recommendation

(a) 今回のcommit`24ee8bb`をレビューし問題なければK2、(b) ユーザー本人によるログイン後の目視確認（通知設定モーダルの表示・トグル保存、重要ニュース閲覧後に`notifications`が既読化されること）を依頼、(c) 将来のタスクとしてimportant-news-monitor/send-push-notifications側で`alert_settings.important_news`/`push_enabled`を尊重する接続を計画、(d) EAS development build・実機Push E2Eはユーザーの意向通り保留のまま次の優先度を待つ
