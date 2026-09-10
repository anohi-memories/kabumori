# Claude Task 1

- task_id: push-dispatcher-cron-enable-20260910
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Opus 5
- purpose: 実機E2Eまで完了した `send-push-notifications` を、安全な定期実行Cronへ接続し、`notifications.push_status=pending` が本番で自動配送される基盤を完成させる。

## Context

直前タスク `expo-ios-push-e2e-resume-20260910` は完了済み。

確認済み:
- iOS development build / 実機インストール成功
- Expo Push Token取得・`public.device_push_tokens`保存成功
- APNs Key設定済み
- `send-push-notifications` 本番deploy済み（v1）
- `SEND_PUSH_NOTIFICATIONS_CRON_SECRET` 本番secret設定済み
- background / foreground / tap-to-`/news` / cold launch を含むPush E2E 1〜9すべてPASS
- テスト用notifications行はクリーンアップ済み
- 現在 `send-push-notifications` はCron未接続で、手動invokeのみ動作確認済み

前タスク完了commit/report: `0bfbe37c459f36ee524d54849f7db6264e99bfb8`。

## Model

このタスクはproduction Cron、認証secret、DB queue、Push配送の安全性をまたぐため **Opus 5を使用する**。Sonnet系へ落とさない。

## Required startup checks

1. `PROJECT_RULES.md`
2. `.agent/ORCHESTRATION.md`
3. `.agent/CURRENT_STATE.md`
4. このTASK
5. `origin/main` fresh-check
6. 共有worktreeの未コミット変更確認
7. `.agent/tasks/CODEX_TASK.md` / `.agent/tasks/CODEX_TASK_2.md` / `.agent/tasks/CLAUDE_TASK.md` をread-only確認し、同じCron / migration / `send-push-notifications` / production設定を他slotが変更中でないことを確認
8. `send-push-notifications` 現行本番実装と認証方式を再確認
9. 既存のSupabase Cron / pg_cron / pg_net / Vault等の運用パターンをrepo内とproduction metadataで確認

既存未コミット変更は他workstream所有として扱い、変更・stage・commitしない。
競合があれば開始せず、具体的な競合箇所をReportする。

## Goal

`notifications.push_status='pending'` の通知が、人手でFunctionを叩かなくても安全に `send-push-notifications` へ流れ、自動配送される状態を作る。

今回は **dispatcherの自動実行だけ** が対象。
重要ニュース・朝刊・大引け等が `notifications` 行を新規生成するproducer側の変更は今回行わない。producer wiringは別タスクに分離する。

## Phase 1: Existing design audit

まず実装せず、以下を確認して最小安全案を決める。

- `send-push-notifications` の認証方式（`X-Cron-Secret` / `SEND_PUSH_NOTIFICATIONS_CRON_SECRET`）
- pending選択条件
- `alert_settings` opt-out
- sent / failed状態遷移
- retryable / permanent failure分類
- 同時実行時の二重送信耐性
- 1回の最大batch / timeout / rate limit
- pending=0のとき安全にno-opになること
- 既存Cronの命名・頻度・HTTP invokeパターン
- secretをmigration SQLやGitへ平文保存せずに呼び出せる方法

### Security requirement

`SEND_PUSH_NOTIFICATIONS_CRON_SECRET` の値を:
- Git
- migration SQL本文
- Report
- shell historyを意図的に残す形
- DBの一般テーブル
へ平文保存してはいけない。

既存の安全なVault/secret参照パターンがあるなら再利用する。
安全にsecretを参照できる既存パターンがない場合は、勝手に弱い方式でCronを作らず停止して設計案をReportする。

## Phase 2: Cron implementation

安全案が確立できた場合のみ実装する。

推奨要件:
- 1分間隔を第一候補とする（重要ニュースPushの遅延を小さくするため）
- 毎回 `send-push-notifications` を1回invoke
- pending=0ならno-op
- Cronの重複jobを作らない
- 既存jobがあれば安全に再利用/置換し、同一Functionを二重スケジュールしない
- auth secretを安全に付与
- Cron失敗が他のX投稿/重要ニュース監視Cronへ波及しない

頻度を1分以外にする合理的理由がある場合は、その理由をReportする。

## Phase 3: Verification

### Before production enable

- `send-push-notifications` targeted testsを再実行
- Cron SQL / helper logicがある場合は可能な範囲でテスト
- `git diff --check`
- secret漏洩がdiff/logにないことを確認
- productionの既存Cron一覧を確認し、同名/同目的jobがないことを確認

### Production enable

このTASKでは、上記安全確認がPASSした場合に限り、**`send-push-notifications`のdispatcher Cronだけ本番有効化してよい**。

許可:
- このdispatcher Cronに必要な最小migration / Cron設定
- 必要なら既存の安全なVault参照設定
- このタスク専用の最小helper RPC/function（どうしても必要な場合のみ。既存方式で不要なら作らない）
- commit / push / production apply

禁止:
- `send-push-notifications`以外のEdge Function変更/deploy
- `x-test-post`変更/deploy
- `important-news-monitor`変更/deploy
- stocks sync系変更/deploy
- morning/close producer変更
- alert_settings仕様変更
- Push文面仕様変更
- OAuth変更
- Apple/EAS/APNs credential変更
- 既存secretのrotate/revoke
- App Store submit
- unrelated migration

## Phase 4: End-to-end Cron proof

Cron有効化後、以下を確認する。

1. Cron jobがactive
2. 予定間隔で実行される
3. pending=0時に安全にno-op
4. Function側で401にならず認証成功
5. Function runtime errorなし
6. 二重Cron / 二重配送なし

### Safe self-test

自然なpending通知がまだ無い場合に限り、次の条件をすべて満たす場合は本人端末だけへのテスト通知を1件作成してよい。

- `device_push_tokens` の対象端末/ownerを特定できる
- 他ユーザーのpendingが0件であることを実行直前に確認
- タイトル/本文に明確な `【自動Pushテスト】` 表記
- 手動でFunctionをinvokeせず、**Cronが自然に拾って送ること**を証明する
- 実機着信まで確認
- テスト行は確認後削除
- 他人の端末へ送らない

他ユーザーのpendingが存在する、または安全に本人だけと断定できない場合はテスト行を作らずread-only検証で止める。

## Important non-goal

今回Cronをつないでも、重要ニュース/朝刊/大引け等が自動で`notifications`を生成していない場合、それらのPushはまだ自動化完了ではない。

TASK終了時に必ず:
- dispatcher Cronだけ完成したのか
- producer側も既に自然にnotificationsを作っているのか
をread-onlyで調査し、明確に区別してReportする。

producer側が未接続なら、次タスク候補として具体的に提示するが、今回勝手に変更しない。

## Completion

終了時:
- `status: review_required`
- `next_owner: chatgpt`
- このTASK末尾に `## Report` を追記
- `.agent/ORCHESTRATION.md`規定どおり同期

Report必須:
- task_id
- result
- model_used
- existing_design_audit
- chosen_cron_design
- cron_frequency
- changed_files
- migrations / production changes
- secret_handling（値は絶対に書かない）
- tests
- production Cron job name / active state
- Cron自然実行確認
- self-test実施有無と結果
- duplicate prevention確認
- producer側の現状（read-only）
- commit_hash
- push
- remaining_issues
- safety_checks
- next_recommendation

## Report

- task_id: push-dispatcher-cron-enable-20260910
- result: **完了**。`send-push-notifications`のdispatcher Cronを本番有効化し、Cronが手動介入なしでpending通知を拾い実機まで配信することを実証した。producer側（重要ニュース等がnotifications行を作る部分）は**未接続のまま**で、これは今回のスコープ外。
- model_used: Opus 5（TASK指定どおり。Sonnet 5で起動していたためユーザーに切替を依頼し、切替後に着手）

### existing_design_audit

`send-push-notifications`（本番v1、コード無変更）を実装レベルで確認:

- **認証**: `X-Cron-Secret`ヘッダーと関数env `SEND_PUSH_NOTIFICATIONS_CRON_SECRET`の完全一致のみ許可。env未設定なら常に401（`typeof expected === "string" && expected.length > 0`）。
- **pending選択**: `notifications?push_status=eq.pending&limit=200`。producer/importance判定は一切行わない純粋なdrainer。
- **alert_settings opt-out**: `shouldSendNotification()`で`push_enabled=false`または`important_news=false`（source_type=important_news時）を除外し`skipped`へ。settings行が無いユーザーはデフォルト有効（既存ユーザーを黙って遮断しない設計）。
- **状態遷移**: 端末が1台でもok→`sent`、全滅→`failed`、対象端末0台→`skipped`。
- **失敗分類**: `DeviceNotRegistered`のみ恒久失敗として当該token行をDELETE（unique制約により同一端末の再登録を妨げないため）。それ以外は一時失敗として次回リトライに委ねる。
- **batch/timeout**: 1回あたり通知200件上限、Expoへは90件ずつチャンク送信。
- **pending=0**: Expo APIに触れず即`{"status":"completed","processedCount":0}`を返す安全なno-op。実測でも確認済み。
- **同時実行耐性**: **原子的なclaimが無い**（pending取得→送信→status更新の順で、取得時に行をロック/予約しない）。実行が60秒を超えて次のtickと重なると同一行を二重送信し得る。実測の1回あたり所要は約1秒で、現在の対象は1端末のみのため実運用リスクは極小だが、設計上のギャップとして下記remaining_issuesに記載。

### chosen_cron_design

既存の`kabumori-stocks-master-sync`と同一の**Vault参照方式**を採用（新方式を発明せず既存パターンを再利用）:

- `vault.decrypted_secrets`から**名前のみ**でsecretを引き、`X-Cron-Secret`ヘッダーに載せて`net.http_post`する。
- **fail-safe**: vaultエントリが欠落/空ならCTEが0行になり`net.http_post`自体に到達しない。secret誤設定時は「無認証で送信」ではなく「静かなno-op」になる。
- 冪等生成（`if not exists (select 1 from cron.job where jobname=...)`）で、既存の`important-news-publish-ready` migrationと同じ書式。

`send-push-notifications`の`verify_jwt`を**false**へ変更（`--no-verify-jwt`で再deploy、コードは無変更）。理由: 他4関数すべてfalseであり、この関数自身のコードコメントも「stocks-master-sync/new-listing-syncと同じ規約（verify_jwt=false + 専用X-Cron-Secret）で書いた」と明記していた。前タスクで私がconfig.tomlの無いworktreeからdeployしたため既定のtrueになっており、この関数だけが規約から外れていた状態を是正した。gateway認証を外してもアプリ層のX-Cron-Secret照合は維持される。

### cron_frequency

**毎分（`* * * * *`）**。TASKの第一候補どおりで、既存`dispatch-scheduled-posts`と同じ刻み。重要ニュースPushの遅延を最小化するため。pending=0のtickはExpo APIに触れずHTTP 1回で終わるためコストは軽微。`timeout_milliseconds`は30000（実測約1秒に対し十分な余裕を持たせつつ、60秒の周期より短くして重なりの窓を狭める意図）。

### changed_files

- `supabase/migrations/20260910163500_add_send_push_notifications_dispatch_cron.sql`（新規）
- `.agent/tasks/CLAUDE_TASK_1.md`（status/Report）

コード変更は0件（`send-push-notifications`のTS実装は無変更のまま再deployのみ）。

### migrations / production changes

1. `send-push-notifications`を`--no-verify-jwt`で再deploy（コード同一、`verify_jwt: true → false`）。
2. Vaultへ`send_push_notifications_cron_secret`を登録。
3. 関数env `SEND_PUSH_NOTIFICATIONS_CRON_SECRET`を新しい値へ再設定（ユーザーの明示承認を得て実施。詳細はsecret_handling参照）。
4. cron job `send-push-notifications-dispatch`（毎分・active）を作成。

**`supabase db push`は使用していない**。本番の最新適用migrationは`20260905140638`で、リポジトリの`20260908110000_add_important_news_publish_ready_cron.sql`は未適用のまま残っている（対応するcron自体は本番に別経路で作成済み）。`db push`を実行すると当該の無関係migrationまで適用してしまうため、今回のcron文だけを`supabase db query -f`で個別適用した。この**リポジトリ/本番のmigration履歴の乖離は今回作り込んだものではなく既存の状態**で、下記remaining_issuesに記載する。

その他の変更なし: `x-test-post` / `important-news-monitor` / stocks sync系のコード・deployとも無変更（`updated_at`で確認、後述）。alert_settings仕様・Push文面仕様・OAuth・Apple/EAS/APNs credential・他secretのrotate/revoke、いずれも0件。

### secret_handling（値は記載しない）

- Supabaseの仕様上、関数env secretの値は**digestしか読み戻せない**。前タスクで設定した値はローカル一時ファイルも削除済みで復元不可能だった。Vault側とFunction側で同一値を突き合わせる必要があるため、**同じ名前のsecretへ新しい値を設定し直す**しか手段が無く、これはTASK禁止事項「既存secretのrotate」に該当するため、実施前にユーザーへ理由と影響範囲（当該secretは1時間前に私がこの関数専用に作成したもので他に消費者なし）を提示し、明示承認を得たうえで実施した。
- 生成〜設定はローカルスクリプト内で完結させ、値は**会話・Report・Git・migration SQL・通常テーブルのいずれにも出力していない**。関数envへは`--env-file`経由（値をargvに載せない）、Vaultへは`vault.create_secret`/`update_secret`で投入し、一時ファイルは即削除した。
- 検証は値を扱わずに行った。Cronと同一のSQL（Vaultから名前で引く経路）を1回手動実行し、`net._http_response`で結果だけを確認している。
- staged diffに32桁以上のhex文字列が含まれないことを機械的に確認済み。

### tests

- `deno test --no-check --allow-read --allow-env push_send_logic_test.ts`: **17 passed / 0 failed**（deploy前に再実行）。
- `git diff --check`: clean。
- secret漏洩チェック: staged diffに長いhex列なし。
- Cron SQL自体の事前検証: 本番適用前に同一SQLを手動実行し、HTTP 200 / `processedCount:0`（vault参照→認証成功→安全なno-op）を確認。

### production Cron job name / active state

- jobname: **`send-push-notifications-dispatch`**
- schedule: `* * * * *`
- active: **true**
- 本番のcron job総数: 7 → **8**（既存7本の名称・頻度・activeはいずれも無変更）

### Cron自然実行確認

`cron.job_run_details`で毎分`succeeded`を連続確認（07:34:00 / 07:35:00 / 07:36:00 UTC）。`net._http_response`側も全て`status_code=200`・`error_msg=null`で、内容は`{"status":"completed","processedCount":0}`（pending=0時の安全なno-op）。**401は一度も発生していない**＝Vault経由の認証が成立している。同時刻の他Cron（`dispatch-scheduled-posts`の`idle`、`important-news-publish-ready`の`NO_READY_CANDIDATE`）も正常のままで、相互影響なし。

### self-test実施有無と結果

TASKの安全条件をすべて満たしたため実施した（実施直前に`device_push_tokens`が1件・所有者1名＝本人のみ、`notifications`のpendingが0件であることを確認）。

- 07:36:47 UTC に`【自動Pushテスト】`表記のテスト行を1件作成（`source_id='cron-selftest-20260910'`）。
- **手動invokeは一切行わず**、次の自然tickである**07:37:00 UTCのCron実行**が`{"status":"completed","processedCount":1,"messagesSent":1,"deactivatedTokenCount":0}`を返した。
- 当該通知の`push_status`は`sent`へ遷移。
- **実機（本人のiPhone）での着信をユーザーが確認済み**。
- 確認後にテスト行を削除し、`notifications`は0件に戻したことを確認済み。他人の端末への送信は0件。

### duplicate prevention確認

- 作成前に`jobname`一致および`command`に`send-push-notifications`を含むjobが**0件**であることを確認してから作成。作成後のjob一覧でも該当は1本のみ。
- migrationは`if not exists`ガード付きで、再実行しても二重登録されない。
- 配信面では、self-test前後のtickが`processedCount:0`、該当tickのみ`processedCount:1`であり、**同一通知の二重配送は発生していない**。
- ただし関数側に原子的claimが無い点は設計上の残課題（remaining_issues参照）。

### producer側の現状（read-only）

**producerは未接続**。read-onlyで以下を確認した:

- リポジトリ全体で`notifications`へINSERTするコードは**存在しない**（`send-push-notifications`は読み取り＋status更新のみ、アプリ側`src/lib/notifications.ts`は`read_at`更新のみ）。
- DB側にも`notifications`へINSERTするfunction/triggerは**0件**。
- 本番の`notifications`テーブルは**総数0行**（今回のテスト行削除後）。

つまり今回でdispatcher（配送基盤）は完成したが、重要ニュース・朝刊・大引け等が通知行を生成していないため、**それらのPushはまだ自動化完了ではない**。producer wiringは次タスク候補として下記に提示する（今回は一切変更していない）。

### commit_hash

- `7e56146` — Enable send-push-notifications dispatch cron（migration追加＋本Report追記）。本行の追記のみ直後のcommitで反映。

### push

- `origin/main`へpush済み。

### remaining_issues

1. **同時実行時の二重送信リスク（設計上）**: `send-push-notifications`はpending取得時に原子的なclaimを行わないため、1回の実行が60秒を超えて次tickと重なると同一通知を二重送信し得る。現状は1端末・実測約1秒で実質リスクは極小だが、通知量が増える前に`push_status='pending' → 'sending'`のような原子的claim（`update ... where push_status='pending' returning *`）を関数側へ入れることを推奨する。今回はTASKのGoalが「dispatcherの自動実行だけ」であり、実機E2E検証済みの関数へ挙動変更を加えないほうが安全と判断して見送った。
2. **リポジトリと本番のmigration履歴の乖離（既存問題）**: 本番の最新適用は`20260905140638`だが、リポジトリには未適用の`20260908110000_add_important_news_publish_ready_cron.sql`が残っている（当該cronは別経路で本番作成済み）。今回追加したmigrationも同様に、ファイルは記録として置きつつ本番へは個別適用した。`db push`が安全に使えない状態が続いているため、履歴の整合（`schema_migrations`へのbaseline登録等）を別タスクで検討することを推奨する。
3. **`supabase/config.toml`がGit管理外**: そのためworktreeからdeployすると`verify_jwt`が既定値に戻る事故が起きうる（前タスクで実際に発生し、今回是正した）。config.tomlをリポジトリに含めるかどうかは別途判断が必要。
4. `notifications`テーブルにproducerが無い件（上記producer側の現状）。

### safety_checks

- deploy対象は`send-push-notifications`のみ。`updated_at`で厳密に確認（当該関数のみ実行直後のタイムスタンプ、他4関数は数時間〜6日前のまま無変更）。なお`version`番号はプロジェクト全体の連番として振られるらしく、他関数の番号も同時に動いて見えるため**per-functionのdeploy判定には使えない**ことが判明した（判定は`updated_at`で行うこと）。
- DB変更は本タスク専用のcron job作成とVault secret登録のみ。schema/RLS/GRANT/RPC/テーブル定義の変更は0件。
- 既存Cron 7本の名称・スケジュール・activeはいずれも無変更。他Cronの実行結果にも異常なし。
- テスト送信は常に本人の登録済み1端末のみを対象とし、実施直前に「所有者1名・pending 0件」を機械的に確認した。他ユーザーへの誤配信0件。
- テスト行は確認後すべて削除し、`notifications`が0件であることを確認済み。
- secretの値はGit・migration・Report・通常テーブルのいずれにも保存していない（詳細はsecret_handling）。
- 共有worktree（`/Users/yuya/Developer/kabumori`本体）の他agent未コミット変更には一切触れていない。全作業を隔離worktree内で実施。
- 他slotとの競合確認: Codex slot 1 = done、Codex slot 2 = `x-test-post`のclose_report系（別領域）、Claude slot 2 = idle。Cron/migration/`send-push-notifications`/production設定の同時変更なし。

### next_recommendation

1. **producer wiring（最優先）**: 重要ニュースの`most_important`判定時に`notifications`行を作る経路を`important-news-monitor`へ追加する別タスク。これが入って初めて「重要ニュースが自動でPushされる」状態になる。alert_settings・文面仕様・二重生成防止の設計を含めて別途スコープ化することを推奨。
2. **原子的claimの導入**: 上記remaining_issues 1。producer接続で通知量が増える前が望ましい。
3. **migration履歴の整合**: 上記remaining_issues 2。
4. worktree（`.claude/worktrees/ios-push-e2e`）は今回も作業場所として使用した。不要になれば削除して構わない。
