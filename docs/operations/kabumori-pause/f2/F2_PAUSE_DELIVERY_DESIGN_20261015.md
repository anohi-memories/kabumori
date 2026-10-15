# F2｜かぶモリ休止：ブランド遮断・予約保留・共有配信保護のオフライン設計

- 作成: 2026-10-15 JST（F2）
- task_id: `kabumori-f2-pause-delivery-brand-queue-offline-design-20261015`
- 返却先: かぶモリアプリG1のちゃ（運用休止・全体統括）
- 基準: main `d2309afc88388d441f75919c98e6ceeb22af8b70`
  - 行番号はこの commit のもの
  - 本番の配備版が一致するかは未確認
- 範囲: 設計と合成データのオフライン検証だけ
  - 本番の DB・Cron・Edge・Secret・API キーの変更、X・Push、実 API・課金は0件
  - **本番の停止の GO ではない**

## 0. 結論（G1 への要点）

1. かぶモリの X 投稿を止める正しい境界は、**かぶモリのブランドの X ゲート**（`publish_mode` など）。
   - 予約投稿の全経路は、claim の直後・トークンと生成の前に、このゲートを1回通る。
   - 例外が2つある。
     - ニュースの独自の X 経路（`important-news-monitor` の `publish_ready`）はゲートを通らない。**F8 の入口・送信直前の遮断が必須**。
     - ゲートの判定は claim の後の1回だけ。判定を通った後の数分の生成の途中に閉じても、その投稿は止まらない（in-flight）。
2. **`x_enabled=false` は停止の手段にしない**。旧来の OpenAI の生成と投稿が復活するため。`app_enabled=false` も同様（利用者ごとの旧来の生成が復活する）。
3. 共通の予約 Dispatcher（#1）は、ブランドを区別せずに最古の1行を取る。ゲートが閉じたかぶモリの行は、取られた時点で**終端の failed** になり、二度と取られない。
   - そのため、**他のブランドが飢餓になることはない**（合成検証）。
   - 遅れは、期限が来ているかぶモリの行1件につき最大1分。
4. 予約の「保留」の状態は**存在しない**（status は pending/running/succeeded/failed だけ）。設計では次の組み合わせを推奨する（§4）。
   - 新しい行を作らない: 各 planner の設定を `is_active=false` にする。元に戻せる。
   - 既存の行: 消さず・延ばさず、ゲートで記録つきの失敗にする。
5. 通知は、producer を止めても、待ち行列の pending を Dispatcher #9 が送り続ける。**producer の停止だけで完全停止と言わない**。
6. 共通の部品は止めない。
   - 共通 AI（provider・台帳・RPC）
   - Cron #1・#9
   - OpenAI・Claude のキー
   - 共通 Cron の秘密
   - Supabase Auth・共通 ID
   - POSTONA

## 1. X に送信する経路の一覧（ソースから）

| 経路 | 起動 | ゲート | ブランド |
|---|---|---|---|
| 予約投稿（共通） | Cron #1 → x-test-post → `claim_due_post`（index.ts:3979） | **claim の後**、トークン・生成の前に1回（index.ts:3985-3993） | 行の `brand_id`。NULL・空は kabumori（brand_context.ts:50-56） |
| ├ 共通の朝刊・大引け（`x_enabled=ON`） | morning_report / close_report（index.ts:4270-4285） | 上と同じ | kabumori |
| ├ 旧来の朝刊・大引け（`x_enabled=OFF`） | 同（index.ts:4287〜、OpenAI web search） | 上と同じ。送信の直前の再確認なし | kabumori |
| ├ 米国プレマーケット・豆知識・朝の挨拶（予約）・交流・tip スレッド | 各 post_type（index.ts:4645 / 4681 / 4719 / 4767 / 4811） | 上と同じ。再確認なし | kabumori |
| ├ 会社員AIラボ brand_post | brand_post | 上と同じ。加えて ai_lab_scheduled_brand_post.ts:106 と送信ごとの権限 RPC | ai_salaryman_lab |
| └ Vault アカウント brand_post（POSTONA 等） | brand_post | 上と同じ。加えて vault_account_brand_post.ts:150 と、送信直前の `beforeCreate`（index.ts:4091→3207） | 行のブランド |
| 朝刊の再試行 | `retry_scheduled_post`（index.ts:4447） | 再び claim されたときに同じゲート | 同上 |
| 朝の挨拶・手動投稿 | `mode=morning_greeting_manual_publish`（管理者の認証、index.ts:3346） | トークンの前（index.ts:3374） | kabumori 固定（:3372） |
| dry-run 系7種 | index.ts:3423〜3926 | なし（X には送らない。ただし生成の AI は呼ぶ） | — |
| `v2_dispatcher` | 未接続（index.ts から import されない） | — | — |
| **ニュースの X 公開** | `important-news-monitor` の `mode=publish_ready`（index.ts:1771〜1855） | **ブランドのゲートなし**。`auto_publish` の設定だけ（:683-697、:1788） | 実質 kabumori の旧トークン |

### `publish_mode=disabled` が保証する範囲・しない範囲

- 保証する
  - 予約の全経路（朝刊・大引け・旧来の生成を含む、豆知識・交流・挨拶・tip・再試行）
  - 手動の朝の挨拶
  - これらで、claim の後の **新しい** 判定から先の、トークンの読み込み・AI の生成・X への送信が起きない
  - 旧来の生成は判定の後にあるので、`x_enabled` の値に関係なく止まる（§5）
- 保証しない
  - ニュースの X 公開（F8）
  - すでに判定を通って生成・送信の途中の投稿（in-flight）
  - planner による新しい行の作成（planner はブランドを見ない）
  - dry-run の生成の AI 呼び出し（X 送信は無い）

## 2. 共通 Dispatcher #1 と飢餓

- `claim_due_post`（リポジトリ上の最新の定義は migrations/20260901044548:17-46）は、次の順に動く。
  1. 5つの planner を実行する。
  2. `pending` かつ期限到来、`morning_greeting` 以外の行を、`order by scheduled_for ... for update skip locked limit 1` で1件取る。
  3. その行を running にする。
  - **ブランドでも publish_mode でも絞り込まない**。
  - ただし 20260905010000:5-11 に「20260901 は本番に未適用」との記載がある。**本番の関数の本体は未確認**。
- ゲートで失敗した行は、外側の catch で `fail_scheduled_post` が呼ばれ、終端の failed になる（index.ts:4840-4866）。再試行の判定は try の内側にあるので、再試行されない。
- 合成検証の結果（`pause_model_test.ts`）
  - かぶモリ5件（NULL ブランドの1件を含む）と他ブランド3件の混在: かぶモリはすべて失敗。他ブランドはすべて送信。同じ行の再 claim は無い。他ブランドの遅れは最大5分（期限が来たかぶモリの行の数まで）。
  - 停止中に行が追加された場合も、1件につき Cron 1回分で失敗になる。
  - ブランドの表を読めない場合は、全ブランドが送られない（fail closed）。そのため、休止の手段にこれを使ってはいけない。
- **Cron #1 の本番の command・URL・ヘッダー・ブランドの扱いは、リポジトリに無い**。
  - 定義は無く、名前が migrations/20260910163500:19 のコメントと docs/market-report-shared-platform/DESIGN.md:37 に出てくるだけ。
  - 同名の Edge のディレクトリも無い。
  - 推測で jobid や URL を当てはめない。§7 の読み取りの項目で確かめる。

## 3. トークンの更新

- かぶモリ: 単一行の `oauth_token_store` を使い、401 のときだけ更新する（index.ts:3124-3164、token_loader.ts:44-49）。
  - 停止中は更新されない。ニュースの `auto_publish` が ON なら、そこだけが更新を続ける。
  - 長く止めたあとに refresh token が有効かは**未確認**。再開時に確かめる。
- Vault アカウント: アカウントごとに送信時に更新する（vault_account_auth.ts:146-169）。かぶモリの store とは別。
- 注意: `oauth_client_ref="default"` は、かぶモリと同じ `X_CLIENT_ID/SECRET` を使う（_shared/x_v2_account_refresh.ts:339）。
  - **停止のためにこの秘密を消したり差し替えたりしない**（default を使う他ブランドの更新も壊れる）。
  - どのアカウントが default を使うかは、本番で未確認。

## 4. 予約の保留：方式の比較

前提:

- `scheduled_posts.status` は pending/running/succeeded/failed だけ（migrations/20260828203000:20-21）。
- version 列・updated_at は無い。
- 楽観的な排他に使えるのは `id`・`status`・`attempt_count`・`started_at`・`finished_at`。
- 一意キーは `(brand_id, schedule_date, post_type, slot_no)`。
- 行には本文が無い（生成は claim 時）。そのため、行を失っても失われるのは「その枠」だけ。

| 方式 | 内容 | 元に戻せるか | 評価 |
|---|---|---|---|
| A. ゲートだけ | 既存の pending は、期限が来たら claim → ゲートで失敗（記録あり） | 行は戻らない。枠は再開後の planner が新しい日付で作る | **採用（既存の行）**。DB の書き込みが不要で、取り違えの危険が最も小さい |
| B. planner の停止 | `morning_report_settings` / `close_report_settings` / `us_premarket` / `posting_windows` / 豆知識の各設定を `is_active=false` | 元の値の snapshot に戻せる | **採用（新しい行）**。行ごとの失敗とログが増え続けるのを防ぐ。B の対象は、かぶモリ専用の設定か要確認（POSTONA は brand_post で別） |
| C. 期限の先送り | snapshot した id だけ `scheduled_for` を有限に先へ延ばす | 戻せるが、再開時は古い内容 | 不採用。本文は claim 時に作るので、延ばしても価値は無く、再開時に一斉に期限が来る危険がある |
| D. 削除 | DELETE | 戻せない | **不採用**（TASK の指示） |
| E. 架空の held 状態 | 存在しない status を使う | — | **不採用**（CHECK 制約に無い。migration を要する） |

- 推奨: **B（新規作成の停止）＋ A（既存の行はゲートで失敗）**。
- 手動の行の UPDATE は不要。必要になる場合は、そのときに改めて設計する。
- planner がブランドを見ないこと（例: 20260829030000:138、20260828234000:46-47）は、B で補う。

### 競合条件と中止（abort）の条件（`planHold`）

保留の手順に進む前に、新しい snapshot と、承認した対象を比べる。次のどれかで**何も変えずに中止**する。

| 条件 | コード |
|---|---|
| ブランドの表を読めない | `BRAND_TABLE_UNREADABLE` |
| かぶモリのゲートがまだ開いている（X の遮断が先） | `KABUMORI_GUARD_STILL_OPEN` |
| かぶモリの行が running（in-flight。drain を待って snapshot を取り直す） | `KABUMORI_IN_FLIGHT` |
| かぶモリの pending の id の集合が、承認したものと違う（追加・削除・claim・件数が同じでも入れ替わり） | `KABUMORI_PENDING_DRIFT:<承認>-><今>` |
| 他ブランドの pending の数が、承認したものと違う（触らずに見張る） | `OTHER_BRAND_PENDING_CHANGED:<brand>` |

- 合成検証で確かめた場面
  - 5件と他ブランドの混在
  - NULL ブランド
  - 件数のずれ（増えた・減った・入れ替わった）
  - claim 済み（並行の worker）
  - 停止中の追加
  - 同じ判定の繰り返し（同じ結果）
  - 一部が先に失敗した場合（ずれで中止 → 取り直し）
- **X の応答が不明の場合は、やみくもに再送しない**（既存の挙動）。
  - `X_RESPONSE_MISSING_POST_ID` の場合、run は generated のまま、予約は failed にしない（shared_market_report_consumer.ts、index.ts:4855 付近）。
  - 休止中に再送しない。再開時は、実際に投稿されたかを X 上で確かめてから扱う。

## 5. 市況の X 利用側の戻り（fallback）

- `get_shared_market_report` は、`x_enabled=false` のとき `{enabled:false}` を返す（20260920100000:344-350）。
- そのため、index.ts:4273 の分岐を通らず、旧来の生成（OpenAI web search、index.ts:1637-1649、2165-2178）と投稿（:4377 / :4557）に進む。
- 合成検証（`marketReportPath`）
  - ブランドが live のまま `x_enabled=false` → 旧来の AI の生成と投稿
  - ブランドが disabled → `x_enabled` の値に関係なく遮断
- **結論**
  - `x_enabled` は変えない（true のまま）。
  - 遮断はブランドのゲートで行う。
  - 市況の Cron（28〜33）を止めても、`x_enabled=true` なら X は `SHARED_MARKET_REPORT_UNAVAILABLE` で fail closed になる。ただし、ブランドのゲートが先に止めるので、この段階には来ない。

## 6. 止める順番（依存）と再開

`stopOrderViolations` で、順番と禁止の操作を検証済み。

| 順 | 手順 | 依存・確認 |
|---|---|---|
| 0 | 読み取りの snapshot（§7） | 以降のすべての前提 |
| 1 | かぶモリのブランドの X ゲートを閉じる（`publish_mode=disabled` など） | x_enabled より先。予約の全経路を遮断 |
| 2 | X の in-flight の drain を確認 | かぶモリの running が0、直近の post_execution_logs |
| 3 | 予約の保留（§4: B と A。snapshot と照合し、中止の条件を確認） | 2 の後 |
| 4 | **F8: ニュースの全入口と送信直前の遮断** | 1 の後。ニュースの X は 1 で止まらない |
| 5 | 一斉通知の `sending_enabled=false` → `enabled=false` | 処理中の chunk の終了を確認してから Cron 44 |
| 6 | `ondemand_requests_enabled=false`（受付と job の引き取りの停止）→ queued の job を確認 → worker の Cron | — |
| 7 | 市況の Cron（28〜33）の停止。`x_enabled` / `app_enabled` は変えない | 1 と 5 の後 |
| 8 | MIC・news_discovery の専用の Cron | 7 の後。#5/#6 のマスターの同期の扱いは G1 で決める |
| 9 | 通知の待ち行列の判断（§8） | 4・5・6 の後 |
| 10 | POSTONA・会社員AIラボ・他ブランド、共通 AI の台帳・課金、実行履歴の読み戻し | 3・9 の後 |

- **禁止**（`stopOrderViolations` が `FORBIDDEN` を返す）
  - `x_enabled=false`
  - `app_enabled=false`
  - Cron #1・#9 の停止
  - API キーの削除
  - 共通の Cron の秘密（`SEND_PUSH_NOTIFICATIONS_CRON_SECRET`）の差し替え
- 依存が解決しない手順に来たら、そこで止める。共通の Dispatcher やキーで代わりに止めない。
- **再開**（`planResume`）
  - ゲートを閉じたまま、たまった分（予約・ニュースの ready・通知）を、鮮度と cutover で仕分ける。
  - 古いものは期限切れにする。新しいものは再審査する。
  - **自動で一斉に送らない**（autoSend は常に空）。
  - 予約は、失敗した行が再び取られることは無く、planner が新しい日付で作る（合成検証: 再開で古い投稿は出ない）。

## 7. 本番の直前の読み取りの項目（実行しないテンプレート）

以下は**実行しないテンプレート**。実行の runner は作っていない。実際の値（jobid・件数・ID）は、操作の直前の新しい snapshot で確かめる。

- 引継ぎの値（豆知識4・交流1の予約、ニュースの ready 37、Cron 38本）は**今の値ではない**。

```sql
-- テンプレート（実行しない）: 集計と状態だけ。秘密・command の本文・個人の識別子は取り出さない
-- 1) ブランドとゲート（表名・列名は未確認: brands の DDL はリポジトリに無い。X アカウントの publish_enabled は別の表）
select id, is_active, publish_mode from public.brands order by id;
-- 2) 予約: ブランドごと・状態ごとの件数（NULL は kabumori として別に数える）
select coalesce(nullif(brand_id, ''), '(null→kabumori)') as brand, status, count(*)
  from public.scheduled_posts where scheduled_for > now() - interval '2 days' group by 1, 2 order by 1, 2;
-- 3) かぶモリの pending の id（承認の対象。件数と集合を固定する）
select id, post_type, scheduled_for from public.scheduled_posts
 where coalesce(nullif(brand_id, ''), 'kabumori') = 'kabumori' and status = 'pending' order by scheduled_for, id;
-- 4) 実行中（in-flight）
select count(*) from public.scheduled_posts where status = 'running';
-- 5) Cron: 名前・予定・active だけ。command は「URL に含まれる関数名」の真偽だけを見る
select jobid, jobname, schedule, active,
       command like '%/functions/v1/x-test-post%' as calls_x_test_post
  from cron.job order by jobid;
-- 6) planner の設定（元に戻すための値）
select 'morning' as k, is_active from public.morning_report_settings
union all select 'close', is_active from public.close_report_settings;
-- 7) 通知の待ち行列
select source_type, push_status, count(*) from public.notifications
 where push_status in ('pending', 'processing') group by 1, 2;
-- 8) 市況・一斉通知のゲート（変えないことの確認）
select x_enabled, app_enabled from public.market_report_consumer_settings;
select enabled, sending_enabled from public.market_report_broadcast_settings;
```

- 配備版: x-test-post の版と中身を main と比べる（ダウンロードしてバイト単位で比べる）。ゲートの位置（claim の後）が本番でも同じかを確かめる。
- `claim_due_post` の本番の本体（`pg_get_functiondef`）を、リポジトリの定義と比べる。

## 8. 通知（Push）

| producer | 止め方 | 停止後に残るもの |
|---|---|---|
| important-news-monitor（`enqueue_important_news_notifications`） | F8。`generate_ready` は対象が0件でも enqueue する（index.ts:1893） | pending |
| personalized-reports | Cron 10/11（記録上は inactive）、または `ondemand_requests_enabled=true` の skip | pending |
| personalized-analysis-worker | `ondemand_requests_enabled=false` | pending |
| market-report-broadcast-worker | `sending_enabled` / `enabled`。送る直前の再確認と、120分の期限切れあり | 古い一斉通知は自然に失効 |

- Dispatcher #9（`claim_pending_push_notifications`）は source_type で絞らず、pending を送る。
- `notifications.push_status` は pending/processing/sent/failed/skipped だけ（20260912100000:10-11）。保留の状態は無い。
- **producer の停止だけでは完全停止にならない**（合成検証: `pushStillSent`）。
- processing は送信の途中なので、戻さない・再送しない。
- 待ち行列の扱い（G1 で決める）は2択。
  - 少数・新しいなら、そのまま送らせる。
  - 送りたくなければ、操作の直前の snapshot の id だけを `skipped` にし、`last_error_code` に休止の印を残す（戻すには別手順）。
- repo 上、notifications の producer はすべてかぶモリのもの。POSTONA は Push を送らない。そのため、#9 は空回りになるだけで止めない。

## 9. 共通 AI と POSTONA の保護（caller の地図）

| Edge Function | AI の経路 | 区分 |
|---|---|---|
| market-report-analysis | `_shared/ai_provider/market_report_primary.ts`（Anthropic と台帳）、または OpenAI | かぶモリの caller。provider と台帳は共通 |
| important-news-monitor | OpenAI 直接（usage_metering → ai_usage_events） | かぶモリ専用（F8） |
| important-news-shadow | OpenAI 直接（Cron 38 は記録上停止済み） | かぶモリ専用 |
| personalized-reports / personalized-analysis-worker | OpenAI 直接 | かぶモリ専用 |
| market-intelligence-*（MIC）/ news-discovery-observer | OpenAI 直接 / web search | かぶモリ専用 |
| **x-test-post** | 旧来の生成・挨拶・画像（かぶモリ）と、brand_post_generator（AI Lab・POSTONA） | **共通**（1つの関数の中に両方） |
| social-mobile-consult / social-mobile-brand-dry-run | OpenAI 直接 / brand_post_generator | POSTONA 専用 |

- **キーを消して費用を止めてはいけない根拠**
  - x-test-post は `OPENAI_API_KEY` が無いと、claim の前に 500 を返す（index.ts:3328-3332）。そのため、POSTONA・AI Lab の予約投稿を含む Dispatcher #1 全体が止まる。
  - `ANTHROPIC_API_KEY` は、共通 AI の基盤（PR187→198→205 は未 merge。J1 がレビュー中）でも使う前提。
  - J1 のレビューを、この休止の PASS に流用しない。
- 止めるのは、かぶモリの caller と producer だけにする。共通の provider・台帳・RPC・認可・予算は止めない。

## 10. F8 への依存

- ニュースの X 公開は、ブランドのゲートを通らない（§1）。
- ニュースの設定（`monitorIsActive`）は、scheduled の収集の分岐にしか効かない（index.ts:2039、G1_PLAN）。
- **手順4（F8 のニュースの全入口と送信直前の遮断）が終わるまで、「かぶモリの X は止まった」と判定しない**。
- ニュースの ready のたまった分（引継ぎでは37件、今の値ではない）は、F8 の設計で扱う。再開時は §6 の再審査に合流させる。

## 11. オフライン検証

```bash
deno test --no-config --deny-net --deny-env --deny-run --deny-write --allow-read tools/kabumori-pause/f2/pause_model_test.ts
```

- 結果: **16件 PASS**（通信・環境変数・プロセス・書き込みは禁止）。
- わざと壊したモデル6種類で、どれも落ちることを確認した。
  - NULL を kabumori にしない
  - disabled を通す
  - 失敗した行を pending に残す
  - in-flight を無視する
  - 再開で自動送信する
  - `x_enabled=false` を許す
- `deno lint`: 問題なし。
- **限界**
  - モデルは main のソースを写したもの。本番の配備版・`claim_due_post` の本体・Cron の command は未確認。
  - モデルの PASS は、本番の runtime の証明ではない。

## 12. 未確認の事項（本番の読み取りで確かめる）

- x-test-post の配備版がこの main と一致するか（ゲートの位置）
- `claim_due_post` の本番の本体
- `brands` テーブルの DDL と制約、`scheduled_posts.brand_id` / `social_account_id` の列の有無
- Cron #1 の command・URL・ブランドの扱い、jobid の対応（#5/#6 を含む）
- planner の設定のうち、かぶモリ専用のもの（B の対象の確定）
- 通知の待ち行列・予約・ニュースの ready の今の件数
- かぶモリの refresh token の、長期停止後の有効性
- `oauth_client_ref="default"` を使うアカウント
