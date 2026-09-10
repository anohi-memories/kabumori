# Claude Task 1

- task_id: important-news-push-producer-wire-20260910
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Opus 5
- purpose: 既に完成したPush dispatcher基盤へ、重要ニュースの公開成功時に本人/対象ユーザー向け `notifications` 行を安全に生成するproducerを接続し、自然発生の重要ニュースが自動Pushまで流れる経路を完成させる。

## Context

直前タスク `push-dispatcher-cron-enable-20260910` はChatGPTレビューで承認済み。

確認済み:
- iOS実機Push E2E 1〜9 PASS
- `send-push-notifications` 本番deploy済み
- APNs / Expo Push credentials設定済み
- `device_push_tokens` への本人端末登録済み
- dispatcher Cron `send-push-notifications-dispatch` は毎分active
- Cron自然実行でpending通知を拾い実機着信までPASS
- producer側は未接続で、通常運用では `notifications` 行が自動生成されない
- dispatcherには原子的claimが無いという既知課題があるが、今回はproducer接続を主目的とし、無関係な大改修はしない

## Model

このタスクは `important-news-monitor` の公開確定ロジック、DB通知queue、ユーザー対象判定、本番Edge Function deployをまたぐため **Opus 5を使用する**。Sonnet系へ落とさない。

## Required startup checks

1. `PROJECT_RULES.md`
2. `.agent/ORCHESTRATION.md`
3. `.agent/CURRENT_STATE.md`
4. このTASK
5. `origin/main` fresh-check
6. 共有worktreeの未コミット変更確認
7. `.agent/tasks/CODEX_TASK.md` / `.agent/tasks/CODEX_TASK_2.md` / `.agent/tasks/CLAUDE_TASK.md` をread-only確認
8. 他slotが `important-news-monitor/**`, `notifications` producer, 同じmigration/RPC/production設定を変更中なら開始せず競合報告
9. `important-news-monitor` 現行productionのpublish確定経路とDB schemaを先に監査
10. `send-push-notifications` / `notifications` / `alert_settings` の現在仕様をread-only確認

既存未コミット変更は他workstream所有として扱い、変更・stage・commitしない。

## Goal

重要ニュースが**本当にpublish成功した時だけ**、Push対象ユーザー向け `notifications` 行を重複なく生成し、既存dispatcher Cronが自動配送できる状態にする。

今回の対象は **important_news producerのみ**。
朝刊・大引け・useful tip・morning greeting等は触らない。

## Phase 1: Existing design audit

実装前に以下を確認し、最小安全案を決定する。

- `important-news-monitor` で候補生成→判定→公開claim→X投稿成功→published確定までのauthoritative state
- `important` / `most_important` のpublish条件
- 既存のuser/holding関連テーブルと、重要ニュースをどのユーザーへ届けるべきか判断できる情報
- 現在ユーザーが1人でも、将来複数ユーザーになった時に全員一律Pushにならない設計にできるか
- `notifications` schema（title/body/source_type/source_id/push_status等）
- `alert_settings` のimportant_news opt-outとの責務分担
- 同じimportant newsを複数回producer実行しても通知行が重複しない方法
- X投稿失敗/Fact fail/Voice fail/hold/cooldown/rejected候補では通知を作らないこと

### User targeting

優先順位:
1. 既存DBに「保有銘柄/監視対象」とcandidateの銘柄/コードを安全に対応付ける既存方式があるなら再利用
2. 既存の明確な対象判定方式が無い場合、勝手に全ユーザー配信へ広げない
3. 最小安全な対象判定が作れない場合はPhase 1で停止し、具体的な不足schema/情報をReportする

テスト時に本人だけと断定できる場合は本人対象のself-test可。

## Phase 2: Producer implementation

安全案が確立した場合のみ実装する。

必須:
- publish成功のauthoritative point以後でのみ通知enqueue
- `source_type='important_news'`
- `source_id` 等で元ニュースを一意に追跡可能
- title/bodyは既存の公開済みニュース内容を再利用し、別AI生成を追加しない
- enqueue失敗でXの既存publish成功を巻き戻したり二重X投稿を誘発しない
- producer再実行時にduplicate notificationを作らない
- `push_status='pending'` で既存dispatcherへ渡す
- 既存 `alert_settings` の送信時opt-outを壊さない

必要なら最小migration/index/constraint/RPCを追加してよいが、既存schemaで安全に実現できるなら追加しない。

## Phase 3: Tests

最低限以下を固定する。

- published重要ニュース → 1件enqueue
- same source再実行 → duplicate 0
- publish未成功 → enqueue 0
- important/most_importantの対象条件が既存仕様どおり
- 対象外ユーザー → enqueue 0
- enqueue失敗時に既存publish状態を壊さない
- title/body/source metadataがdispatcher互換
- `git diff --check`
- important-news-monitor既存回帰テスト

## Production / deploy

安全確認とテストPASS後に限り、今回のproducer接続に必要な **`important-news-monitor` のみ** 本番deployしてよい。

許可:
- `important-news-monitor` の最小変更/deploy
- producerに不可欠な最小migration/index/constraint/RPC（必要時のみ）
- commit/push/production apply

禁止:
- `send-push-notifications` のコード変更/deploy
- dispatcher Cron変更
- `x-test-post`変更/deploy
- stocks sync変更/deploy
- morning/close producer変更
- Push文面を別AIで生成
- Apple/EAS/APNs変更
- OAuth/secrets変更
- unrelated migration
- 手動X投稿
- 既存backlogの大量Push

## Production proof

本番deploy後:

1. producerがactive codeに入っていること
2. 過去backlogを一括enqueueしないこと
3. 自然発生の新しい重要ニュースで `notifications` が1件生成されることを優先してread-only観測
4. そのnotificationを既存dispatcher Cronが自然に拾うこと
5. 対象が本人端末だけと安全に確認できる場合のみ実機Push着信まで確認
6. duplicate notification / duplicate Pushがないこと

自然発生を待てない場合のself-testは、既存のpublish stateを捏造せず、producer pure logic / isolated DB testを優先する。productionへ偽important-news candidateを注入しない。

## Completion

終了時:
- `status: review_required`
- `next_owner: chatgpt`
- このTASK末尾に `## Report` を追記
- `.agent/ORCHESTRATION.md` 規定どおり同期

Report必須:
- task_id
- result
- model_used
- existing_publish_path
- user_targeting_design
- duplicate_prevention
- changed_files
- migrations/RPC/index（あれば）
- tests
- deploy/version
- production proof
- natural notification enqueue確認
- dispatcher自然配送確認
- 実機着信確認有無
- backlog safety
- commit_hash
- push
- remaining_issues
- safety_checks
- next_recommendation

## Report

- task_id: important-news-push-producer-wire-20260910
- result: **producerの実装・本番投入は完了**（`important-news-monitor` v37 = `a714d21` と17/17ファイルがバイト一致）。対象判定・一律配信の防止・重複防止は本番のread-only dry-runで実証済み。自然経路の「notifications生成 → 実機Push」は、観測時間内に**登録銘柄と一致する重要ニュースのpublishが発生しなかったため未観測**（下記「natural notification enqueue確認」参照）。**途中でdeploy元の取り違えにより本番事故（古いbacklogの誤投稿2件）が発生**し、止血・原因の確定・復旧・再開まで完了した。
- model_used: Opus 5

### existing_publish_path

`publishImportantNewsCandidate()`（`publish_logic.ts`）の authoritative な確定点は `repository.markPublished()` の成功後。`markPublished()` は `status=eq.publishing AND x_post_id=is.null` 条件付きのPATCHで `status=published` / `x_post_id` / `x_published_at` を書き、ちょうど1行更新されなければ throw する。この後でのみ `result.published === true` が返る。

publishに到達しない経路（=通知を作ってはいけない経路）: dry-run、pre-publish check失敗（Fact/Voice未pass、ラベル不一致、source_url欠落等）、overnight hold、rate control、cutover外、claim失敗、X投稿失敗（`markFailed` → `publish_failed`）。これらは全て `published: false` を返す。

producerの接続点は `index.ts` の `publish_ready` 分岐、`publishImportantNewsCandidate()` が返った**後**（`publish_logic.ts` は無変更）。

### user_targeting_design

優先順位1（既存方式の再利用）を採用。アプリの `/news` 画面が既に使っている `public.get_my_important_stock_news` と**同一の対応付け**:

- `important_news_candidates.company_code` が `^[0-9A-Z]{5}$`（TDnet形式）のとき、先頭4文字 = `stocks_master.ticker_code`
- `tracked_stocks.is_active = true` のユーザーのみ（holding / watch の両方）

これにより「Pushの対象者 ⊆ アプリ内フィードの対象者」が構造的に保証される。

- **company_code が無いニュース（市場全体ニュース）は誰も対象にしない**。全ユーザーへの一律配信は行わない（TASKの規則2どおり）。
- 同一ユーザーが同じ銘柄を複数の `stocks_master` 行経由で追跡していても、`tracked_stock_id` が最小の1件に決定的に絞るため、**1ニュースにつき1ユーザー最大1通知**。
- title / summary は公開済みニュースの既存テキストのみ（AI生成なし）。title = `【会社名】見出し`（60字上限）、summary = `body_summary`（空なら見出し、改行を畳んで140字上限）。本番の `body_summary` は最大5,978字あるため上限は必須。
- **`alert_settings` は producer では参照しない**。`notifications` はアプリ内の記録でもあり、opt-outは送信時にdispatcherが判定して `skipped` にする設計のため（producerでも絞るとopt-outユーザーのアプリ内履歴まで消える）。ただし下記remaining_issues 1のとおり、**現行本番のdispatcherはこのopt-outを実装していない**。

### duplicate_prevention

既存の unique 制約 `notifications_dedupe (user_id, tracked_stock_id, source_type, source_id)` をそのまま使う（migration追加なし）。

- producerの行は `tracked_stock_id` が常に非NULLなので、NULLが別扱いになるunique制約の抜け穴に当たらない。
- 挿入は1行ずつ `POST /rest/v1/notifications`。制約違反はPostgRESTが409を返すので「既に登録済み」として数え、次の行へ進む。1ユーザーの重複が他ユーザーの通知を巻き込んで止めない。
- PostgRESTのupsert構文（`on_conflict` + `resolution=ignore-duplicates`）は、本番で検証できない構文リスクを避けるため**採用しなかった**。
- 同じcandidateに対するproducerの再実行は、行選択が決定的なので必ず同じ重複キーに衝突する（テストで固定）。
- そもそもproducerは `published` への遷移時にしか走らず、既に `published` の候補は pre-publish check の `notPublished` で弾かれるため、同一ニュースのproducer再実行自体が通常経路では起きない。

### changed_files

- `supabase/functions/important-news-monitor/important_news_notification_logic.ts`（新規・純粋ロジック）
- `supabase/functions/important-news-monitor/important_news_notification_logic_test.ts`（新規・17テスト）
- `supabase/functions/important-news-monitor/index.ts`（producer配線 + read-onlyの `notification_enqueue_dry_run` モード）
- `.agent/tasks/CLAUDE_TASK_1.md`（status / Report）

`publish_logic.ts` / `send-push-notifications` / 他Functionは無変更。

### migrations/RPC/index

なし（既存の `notifications_dedupe` 制約と既存のGRANT `service_role: select, insert, update` で足りた）。

### tests

- 新規 `important_news_notification_logic_test.ts`: **17 passed / 0 failed**
  - publish成功＋X post IDあり → enqueue許可 / 未publish → 0 / X post IDなし → 0 / importance が important・most_important 以外 → 0
  - 実際の `publishImportantNewsCandidate()` を通した dry-run と Fact fail → enqueue 0（手組みのオブジェクトではなく本物のpublish経路で固定）
  - ticker抽出が `get_my_important_stock_news` と一致 / company_codeなし → 対象0 / 追跡者なし → 0
  - 行の形がdispatcher互換（`push_status='pending'`、`source_type='important_news'`、importance が制約の許容値）
  - 同一ユーザーの二重追跡 → 1行、入力順を変えても同じ行（再実行時に確実に制約衝突）
  - 文字数上限、summary空時の見出しフォールバック、改行の正規化
- important-news-monitor 全体の回帰: **282 passed / 0 failed**
- `git diff --check`: clean
- enqueue失敗時にpublishを壊さないこと: `enqueueImportantNewsNotifications()` は例外を握って診断コードで返す構造（`markPublished()` 確定後に呼ばれるため、X投稿の巻き戻しや再投稿は起こりえない）

### deploy/version

| version | 時刻 (UTC) | 中身 | 経緯 |
|---|---|---|---|
| v35 | 09-09 11:03 | `e7391cf` | 事故前の正しい本番 |
| **v36** | **09-10 08:20** | **`e67b825`（09-05）と完全一致** | **deploy元の取り違え。producerは含まれず、5日分の修正が巻き戻った** |
| **v37** | **09-10 08:43** | **`a714d21` と17/17バイト一致** | 復旧deploy。cutover guard と producer を含む |

v37 は `verify_jwt=false` を維持。他4関数（`x-test-post` / `send-push-notifications` / `stocks-master-sync` / `stocks-new-listing-sync`）の `updated_at` は復旧deploy前後で不変。

### 本番事故: deploy元の取り違えと誤投稿2件

**原因（確定）**: Supabase CLI は、カレントディレクトリから上へ `supabase/config.toml` を探して project root を決める。worktree（`.claude/worktrees/ios-push-e2e`）には `supabase/config.toml` が無く（Git管理外のため）、共有checkout `/Users/yuya/Developer/kabumori` には存在する。そのため worktree で実行した `supabase functions deploy` が**共有checkoutの作業ツリーをdeploy**した。

裏付け（バイト比較）: v36 の15ファイル = 共有checkoutの該当ファイル = commit `e67b825` の該当ファイル（30ファイル）で全て完全一致。推測ではなく実物の照合による特定。

**v36 で失われていたもの**: `auto_publish_cutover_logic.ts`（依存グラフから消失）＝cutover以前のbacklogを遮断する仕組み。加えて v36 の rate control は `most_important` がクールダウンを**完全にバイパス**する版だった。

**誤投稿2件**（Xからの削除はユーザー判断で実施。下表は証跡として保存）:

| # | X post ID | X投稿時刻 (UTC) | 元ニュース published_at (UTC) | candidate / 銘柄 |
|---|---|---|---|---|
| 1 | `2097964549857317144` | 2026-09-10 08:25:01.821 | 2026-09-04 06:30:00 | `514d0e92-…` / 4627 ナトコ（通期予想の上方修正） |
| 2 | `2097965809046073439` | 2026-09-10 08:30:02.138 | 2026-09-04 06:30:00 | `554a6ac5-…` / 3320 クロスプラス（通期予想の下方修正） |

誤投稿と判断した理由:
1. 6日前のニュースを「【重大速報】」として投稿している。
2. どちらも `generated_at` が 2026-09-04 で、cutover guard が遮断すべきbacklog。v35 のまま動いていた 08:20:00 の tick は正しく `NO_READY_CANDIDATE` を返しており、**v36 になった直後の 08:25 から投稿が始まった**ことを `cron.job_run_details` と `net._http_response` で確認した。
3. 5分間隔で連続投稿されている（正しい版は10分クールダウン）。

なお、この2件はどちらも登録銘柄と無関係で、producerの本番dry-runでも `NO_TRACKING_USER`（対象0）。**誤投稿に伴うPush通知は発生していない**（`notifications` は0行のまま）。

**止血**: ユーザー承認のもと `important_news_monitor_settings.auto_publish = false`。適用が 08:30 の tick に間に合わず2件目が出たが、08:35 以降の新規投稿は0件。本番Functionへの直接呼び出しで `NEWS_AUTO_PUBLISH_DISABLED` を確認。backlogは変更・削除・再claimしていない。

**再発防止（実施済み）**: worktree に `supabase/config.toml` を作成し（Git管理外のまま）、project root をworktreeに固定。5関数すべて `verify_jwt = false` を明示し、フラグを付け忘れてもCronが401にならないようにした。link情報（`supabase/.temp/`）もworktreeへコピー。以後のdeployは**必ず `functions download` によるバイト照合で中身を検証する**。

**cutover境界について**: 境界は `important_news_monitor_settings.updated_at`（トリガ `set_important_news_updated_at` で更新）。止血の UPDATE で 08:30:27 に、再開の UPDATE で **08:53:08** に前進した。どちらも安全側への移動で、設計どおりの挙動（再開時刻以降に生成された候補だけが対象になる）。この結果、08:47:53 に自然生成された `29830`（important）も対象外になった。

### production proof

- **producerが本番のactive codeに入っていること**: v37 のダウンロードで `important_news_notification_logic.ts` が依存グラフに存在（downloadは index.ts が実際にimportするモジュールしか返さない＝アップロードではなく到達可能であることの証明）。`index.ts` に `enqueueImportantNewsNotifications` を確認。
- **対象判定（本番dry-run、書き込みなし）**:

| candidate | company_code | 結果 |
|---|---|---|
| `cea56cd6-…`（市場全体ニュース） | null | `NO_COMPANY_CODE` / targetCount 0 |
| `10234e28-…` | 61910 | `NO_TRACKING_USER` / targetCount 0 |
| `514d0e92-…`（誤投稿①） | 46270 | `NO_TRACKING_USER` / targetCount 0 |
| `554a6ac5-…`（誤投稿②） | 33200 | `NO_TRACKING_USER` / targetCount 0 |

  company_code の無いニュースも、登録外の銘柄のニュースも**対象0**＝全ユーザー一律配信になっていないことを本番で実証。偽candidateは一切投入していない。
- **過去backlogを一括enqueueしないこと**: producerは `published` への遷移時にしか走らず、履歴を走査するコードは無い。再開後も `notifications` は0行。

### E2E確認の区分（完全E2Eとは扱わない）

| 区間 | 確認方法 | 結果 |
|---|---|---|
| ① 登録銘柄の実在ニュース → 対象ユーザー判定 | 本番producerのread-only dry-run | **確認済み**: `WOULD_ENQUEUE` / `targetCount=1` |
| ② notifications → 毎分Cron → 実機Push | 実在ニュースを使った**手動enqueue**（1件） | **確認済み**: Cronが自然に拾い、実機着信・タップ起動まで |
| ③ 自然publish → producer → notifications → Cron → 実機Push | 自然発生の観測 | **未観測**（観測期間中に自然publishが0件） |

#### ① 対象ユーザー判定（本番dry-run）

ユーザーが追加したテスト用ウォッチ銘柄のうち、ソフトバンクグループ（9984）に一致する実在の重要ニュースが1件あった: candidate `e8c063ef-27df-4733-95ae-72c08944a289`（company_code `99840`、important、2026-09-04付「第70回無担保普通社債の条件決定に関するお知らせ」、status `generation_failed`、X未投稿）。本番の `notification_enqueue_dry_run` の結果は `reason: WOULD_ENQUEUE` / `tickerCode: 9984` / `targetCount: 1`、title `【ソフトバンクグループ】第70回無担保普通社債の条件決定に関するお知らせ`。これで「登録銘柄のニュース → 対象ユーザー1名 → 1行」という正の経路を本番で確認した。

#### ② 手動enqueue → 毎分Cron → 実機Push

実行直前の確認: profiles 1 / Pushトークン1件（所有者1名）/ 9984を追跡しているのはトークン所有者本人の1名・1行 / `notifications` の pending 0件（全体0行）/ 元candidateは `x_post_id=null`（未投稿）。

- 09:44:48 UTC: dry-runが返した行を**そのまま1件だけ**挿入した（title/summaryはproducer出力を使い、user/tracked_stockはproducerと同じ規則で解決）。notification id `cf9a53c8-7a21-4b18-ade5-ae08595fd8c1`
- **09:45:00 UTC の毎分Cronが自然に拾った**（Functionは手動invokeしていない）: `{"status":"completed","processedCount":1,"messagesSent":1,"deactivatedTokenCount":0}`、行は `sent` に遷移
- **実機着信**: 18:45 JST にlock画面へ着信（ユーザーのスクリーンショットで確認）。**タップでアプリが開いた**
- **重複防止**: 同じdedupe keyで再挿入すると `ERROR 23505: duplicate key value violates unique constraint "notifications_dedupe"` で拒否され、`notifications` は1行のまま
- 後片付け: 今回作った通知行 `cf9a53c8-…` の1件だけを削除（削除1件、`notifications` は0行に戻った）。元candidateは `generation_failed` のまま、backlog（`ready_for_publish` 30件）も無変更。X投稿は行っていない

**注意**: ②はenqueueを手動で行っており、自然publishを起点にした経路ではない。

#### ③ 自然publish起点（未観測）

`auto_publish` 再開（08:53:08 UTC）後の publish-ready Cron（08:55〜09:45のtick）は、すべてHTTP 200 / `NO_READY_CANDIDATE`。自然publishが0件だったため、**自然publishを起点にした実機Push E2Eは未観測**。上流パイプライン（fetch / judgement / generation）は正常に稼働しており、publish可能な新しい候補が出ていないだけ。TDnetの開示は平日15時JST前後に集中するため、次に登録銘柄と一致する重要ニュースがpublishされた時点で観測できる。

### natural notification enqueue確認

**未観測**（上記③）。自然publish時にproducerが呼ばれた場合は、publish_readyのレスポンスの `notificationEnqueue`（`attempted` / `reason` / `targetCount` / `insertedCount` / `duplicateCount`）と、Function logの `important_news_notification_enqueue` イベントで追跡できる。

### dispatcher自然配送確認

**確認済み**（②）。毎分Cron `send-push-notifications-dispatch` は手動invokeなしで pending行を拾い、`sent` へ遷移させた。

### 実機着信確認有無

**あり**（②、手動enqueue経由）。18:45 JST 着信、タップでアプリ起動。

### backlog safety

- 再開時にcutover境界が 08:53:08 UTC へ前進し、`ready_for_publish` 30件（2026-08-31〜09-10 08:47生成）はすべて境界より前 → cutover以降のready候補は0件
- 再開後の publish-ready 全tickが `NO_READY_CANDIDATE`、`publishing` 0件、**誤投稿の再発なし**（`last_publish` は 08:30:02 のまま）
- producerは履歴を走査せず、backlogから通知が作られることもない

### 観測時点のまとめ（自然publish未発生でも確認済みの事項）

- 復旧後の誤投稿再発なし
- cutover正常（本番コードに復帰、境界 08:53:08、backlog 30件は対象外）
- producer本番投入済み（v37 = `a714d21` とバイト一致）
- 対象ユーザー判定はdry-run/read-onlyで検証済み（正の経路1件、負の経路4件）
- dispatcher Cron稼働済み（自然pickupと実機着信まで）

### テスト用ウォッチ銘柄（E2E確認後に削除する対象）

ユーザーがE2E目的で 2026-09-10 09:31〜09:37 UTC に追加した `watch` 17件。元からある 4751 / 7974 / 4671 は対象外。
7203 トヨタ自動車 / 6758 ソニーグループ / 9434 ソフトバンク / 9984 ソフトバンクグループ / 8035 東京エレクトロン / 6857 アドバンテスト / 6146 ディスコ / 7011 三菱重工業 / 6501 日立製作所 / 8306 三菱UFJフィナンシャル・グループ / 8316 三井住友フィナンシャルグループ / 8411 みずほフィナンシャルグループ / 9432 NTT / 9433 KDDI / 9983 ファーストリテイリング / 285A キオクシアホールディングス / 4755 楽天グループ

③の自然E2Eを観測するまでは残しておくのが望ましい（削除すると自然一致の機会がほぼ無くなる）。

### commit_hash

- `a714d21` — Enqueue important news pushes on publish success（producer本体・本番v37の中身）
- 本Reportはこの直後のcommitで追記

### push

- `origin/main` へpush済み

### remaining_issues

1. **【重要】`send-push-notifications` の本番が古い共有checkout版**（v3、09-10 07:28 deploy）。今回の事故と同じ原因で、origin/mainではなく共有checkoutの作業ツリーがdeployされていた。本番の `push_send_logic.ts` には `shouldSendNotification` / `AlertSettings` が存在せず、**`alert_settings` の `push_enabled` / `important_news` のopt-outを一切見ていない**。前タスク `push-dispatcher-cron-enable-20260910` のReportにある「alert_settings opt-outを通す」という記述は誤りで、訂正が必要。worktreeからの再deploy（`functions download` によるバイト照合付き）で解消できる。
2. **【重要な品質課題】Push本文がTDnetの生テキストで読みにくい**。summary に `body_summary` をそのまま使うため、実機では `本店所在地 東京都港区海岸一丁目 7 番 1 号 会 社 名 …` とPDFの定型の書き出しが表示された。見出しは読めるが、本文は内容を伝えていない。案: 本文にはFact/Voiceを通過した生成済みX投稿文（`generated_text`）を使う、または定型ヘッダを除去する。ただし `generated_text` は `generation_failed` の候補には無いため、フォールバックの設計が必要。
3. **`important-news-monitor` / `x-test-post` の認証不足**。どちらも `verify_jwt=false` で、アプリ層の認証が無い。呼び出し元のCron（important-news系4本、dispatch-scheduled-posts）も認証ヘッダーを送っていない。URLを知る第三者が `publish_ready` を叩けばX投稿を起こせる。`send-push-notifications` / stocks sync系と同じVault + `X-Cron-Secret` 方式への統一を推奨。
4. **`get_my_important_stock_news` が `published` を含まない**（`status in ('ready_for_publish','generation_failed')`）。producerは `published` になった時点で通知を作るため、自然経路のPushをタップして `/news` を開いても、そのニュースが一覧に出ない。今回の②は元candidateが `generation_failed` だったため、この問題に当たっていない。
5. **自然publish起点のE2E（③）が未観測**。テスト用ウォッチ銘柄を残し、次に一致する自然publishで観測する。
6. **`supabase/config.toml` / `supabase/.temp/` がリポジトリ管理外**。今回の事故の直接原因。worktreeにはローカルで作成済み（未commit）。リポジトリで管理するかどうか判断が必要（`.temp` は秘密を含み得るので管理外が妥当。`config.toml` は管理対象にする価値がある）。
7. dispatcherに原子的claimが無い既知課題（前タスクから継続）。
8. deployされたコードの検証手段として `version` / `updated_at` だけでは不十分だった。deploy後は必ず `supabase functions download` + バイト照合で中身を確認する運用を推奨。

### safety_checks

- 偽candidate・本番テスト用ニュースは投入していない。②で使ったのは実在ニュースで、enqueueした通知1行だけを後から削除した
- 元candidate・backlog・他ユーザーのデータは変更していない（本番のユーザーは1名のみ）
- X投稿を手動で行っていない。誤投稿2件の削除はユーザー判断
- 本番設定の変更は `important_news_monitor_settings.auto_publish` のみ（ユーザー承認の上で false → true）
- DB migration / RPC / Cron / secrets / OAuth / 他Functionのコードは変更なし
- 他Functionの `updated_at` は不変（`x-test-post` / `send-push-notifications` / stocks sync系）
- 共有checkoutの未コミット変更には触れていない（読み取りによるバイト照合のみ）
- Expo Push Tokenの全文はReportやリポジトリに残していない

### next_recommendation

1. **`send-push-notifications` を origin/main 版で再deployし、`alert_settings` のopt-outを本番に反映**（remaining_issues 1）。deploy後は `functions download` でバイト照合する。
2. **Push本文の品質改善**（remaining_issues 2）。
3. **`get_my_important_stock_news` に `published` を含める**（remaining_issues 4）。自然経路のPushタップが `/news` で行き止まりにならないようにする。
4. **important-news-monitor / x-test-post の認証追加**（remaining_issues 3）。Cron側のSQL変更も伴うので単独タスクとして扱う。
5. 自然publish起点のE2E観測（remaining_issues 5）。テスト用ウォッチ銘柄17件は観測後に削除する。
