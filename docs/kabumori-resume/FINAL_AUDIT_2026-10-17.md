# かぶモリ休止・最終read-only監査（2026-10-17）

**総合判定: BLOCKED — 「既存予約消化後は、新規投稿・生成・Pushが自動発生しない」という完全休止条件を満たさない。**
停止済みCronと引き継ぎ保存は有効だが、共有投稿Dispatcher内の予約再作成とGitHub Actions画像生成が残る。今回は監査のみ。停止設定やコードの修正、予約キャンセルは行っていない。

- 依頼: G1会話からの直接監査。slotの新規割当・完了処理はしていない。
- 推薦モデル: Sol（高）。本番の書込み・実SNS呼出し・有料AI呼出し・deployなし。
- Supabase: stock-x-autopost / `wsmznyzcvmuitkglfeuj`
- main照合基準: `3c7480b7ba6aed548afdc683c73a796369ec0287`
- DB観測: **2026-10-17 19:17:11–19:27:01 JST**（10:17:11–10:27:01 UTC）
- Edgeログの固定取得窓: **10/16 19:20–10/17 19:20 JST**（24時間）。取得時点の到着遅延・欠落の可能性あり。
- 停止後比較: **10/17 11:00 JST以降**（02:00 UTC）。停止中Cronの最後の観測実行は10:45 JST。この比較境界は正確な停止操作時刻を証明するものではない。
- [構造化証跡](evidence/2026-10-17-final-audit/observations.json)、[DB観測SQL](evidence/2026-10-17-final-audit/postgres-observations.sql)、[ログ観測SQL](evidence/2026-10-17-final-audit/log-observations.sql)、[GitHub Actions](evidence/2026-10-17-final-audit/github-workflows.json)、[実行履歴](evidence/2026-10-17-final-audit/github-runs.json)。

## 判定一覧

| 対象 | 判定 | 確認した状態 |
|---|---|---|
| 指定Cron停止 | PASS | 43件中39件inactive。今回停止対象36件＋従来停止3件。稼働4件は合意済みの共有Dispatcher2件と銘柄同期2件 |
| 既存かぶモリ予約 | CONDITIONAL | 19:27時点pending 2件、running 0件。既存分の投稿許可を維持。監査開始時3件から1件が失敗処理され減少 |
| 新規予約の自動作成遮断 | **BLOCKED** | 配備済みx-test-post → claim_due_post → plan_daily_postsほかの経路が残る。ブランドlive、投稿windowと週間設定がON |
| ニュース候補・生成 | CONDITIONAL | 11:00以降の候補作成・更新・monitor runは0。古いready_for_publish 30件、generation_failed 332件が残り、設定is_active/auto_publishはtrue |
| Push・レポート配信 | CONDITIONAL | 通知212件はすべてsent、未送信0。broadcast 6件completed、chunk 6件done、delivery 6件sent。生成・送信の本番設定はONのため、将来の投入を全経路で遮断した保証はない |
| Cron外の画像生成 | **BLOCKED** | morning-greeting-imageのGitHub workflowはactive、日次4回。朝の挨拶windowがONで、OpenAI画像生成→Storage保存の経路が有効 |
| 外部自動起動の完全網羅 | CONDITIONAL | GitHub webhook登録0、DBの非内部trigger 62件で直接HTTP/Webhook呼出しを示す対象なし。未知の外部スケジューラ・手動起動・間接RPC経路までは不在証明しない |
| POSTONA・共通Auth/AI・会社員AIラボの保護 | PASS（監査の変更境界） | これらへの変更・実行依頼なし。共有Cron #1/#9を維持。AIラボの成功ログ・残存予約を確認。サービス全機能のE2E健全性を証明する監査ではない |

## 1. Cron実状態と継続処理

稼働は次の4件だけ。scheduleはUTC。

| jobid | jobname | schedule |
|---|---|---|
| 1 | dispatch-scheduled-posts | * * * * * |
| 9 | send-push-notifications-dispatch | * * * * * |
| 5 | kabumori-stocks-master-sync | 3 21 * * * |
| 6 | kabumori-stocks-new-listing-sync | 8 21 * * * |

今回停止対象36件は [PAUSE_STATE.md](PAUSE_STATE.md) と一致。#10/#11/#38も従来どおりfalse。**43件=稼働4件＋停止39件**であり、「36件」は全inactive数ではない。
監査前後で43件のactive/schedule/command MD5が全件一致した。command本文・認証値は保存していない。

36時間分のcron.job_run_detailsで、停止対象の最終実行はMIC #27の10/17 10:45:00 JST。ニュース#3とbroadcast #44は09:07 JSTが最後。11:00 JST以降にこれら停止対象の実行は観測されなかった。Cron履歴のsucceededはSQL/HTTP投入成功で、外部処理の成功を意味しない。

## 2. 新規予約が今後も作られる経路（最優先の未達条件）

次の接続を**本番配備済みEdgeの取得と本番DBの関数定義のSELECT**で確認した。RPC自体は呼んでいない。

`Cron #1 → x-test-post v145 → claim_due_post() → plan_morning_report / plan_close_report / plan_daily_posts / plan_weekly_useful_tips / plan_us_premarket_report → scheduled_posts`

- 配備済みx-test-postはclaim_due_postを呼び、予約取得後にブランドのpublish guardを評価する。
- 本番claim_due_postは予約を取り出す前に上記5個のplannerを呼ぶ。
- 本番plan_daily_postsはposting_windows.is_active、brands.is_active、publish_modeを見て新しい日付の予約をINSERTする。
- かぶモリブランドはis_active=true / publish_mode=live。
- かぶモリのmorning_greeting 1枠、interaction 2枠、tip 3枠はis_active=true。週間useful_tip_schedule_settingsもis_active=true、posts_per_week=7。
- morning_report / close_report / us_premarket_reportのposting_windowsはfalse。ただし朝刊・大引けの専用settingsはtrueで、専用plannerも呼ばれる。window/専用設定を同じ停止ゲートとは扱えない。
- 比較窓内の新規予約作成は0件。これは同日の予約が既に存在する状態と整合し、翌日以降の作成遮断の証拠にはならない。

mainの[claimDuePost呼出し](https://github.com/anohi-memories/kabumori/blob/3c7480b7ba6aed548afdc683c73a796369ec0287/supabase/functions/x-test-post/index.ts#L3288)と[実行入口](https://github.com/anohi-memories/kabumori/blob/3c7480b7ba6aed548afdc683c73a796369ec0287/supabase/functions/x-test-post/index.ts#L3979)も照合した。
mainと本番全体が同一バイトであるとは主張しない。配備済みbundle SHAと重要箇所の行番号は構造化証跡に保存した。

**共有#1を止めればよい、とは判断しない。** POSTONA・会社員AIラボを保護しつつ、かぶモリの新規計画だけを遮断する別の承認済み対処が必要。

### 残存予約と自然実行

最終観測時のかぶモリpendingは次の2件。既存投稿許可どおり変更していない。

| post_type | 予約日時 JST | 作成日時 JST |
|---|---|---|
| interaction | 2026-10-17 20:41:36 | 2026-10-17 00:00:02 |
| useful_tip | 2026-10-18 19:27:47 | 2026-10-12 00:00:01 |

監査開始時にあった10/17 19:17:26予約のuseful_tipは、既存workerにより19:19:01 started、19:19:40 failedとなった。監査者が処理を起動したものではない。11:00以降のかぶモリ成功記録はinteraction 1件（最終15:02:10）、tip 2件（最終18:02:06）。すべて既存予約と整合する。X実画面・実APIへ検証投稿はしていない。

会社員AIラボ（DB brand_id `ai_salaryman_lab`）はlive、11:00以降brand_post成功5件、最終19:18:07。最終観測のpending 2件も維持した。

## 3. ニュース・Push・実行ログ

- ニュース状態: published 430 / ready_for_publish 30 / generation_failed 332 / rejected 3,369 / duplicate 115。
- ready_for_publishは9/10作成・更新の古い行。Cron停止だけで行が無害化された、再開時に公開される、とも断定しない。再開前は鮮度・公開条件の確認が必要。
- 最新候補作成10/17 08:00:14 JST、最新更新08:07:04、最新X公開記録06:50:02。比較窓11:00以降の作成・更新・monitor runはいずれも0、未完了のactive monitor runも0。
- notificationsはimportant_news 187件、personalized_report 25件、すべてsent。最新作成10/17 06:50:02。11:00以降の新規通知0、非sent 0。
- personalized_analysis_jobsは0件。ondemand_requests_enabled=false。public_market_feed_enabled=true。
- broadcast 6件completed、chunk 6件done、delivery 6件sent。最終更新10/16 16:22:07。古いmarket_report_cyclesにはreport_status=pending 4件が残る（blocked 3件＋completed 1件）。進行中broadcastはないが、再開前の古い作業確認は必要。
- consumer x_enabled/app_enabled=true、broadcast enabled/sending_enabled=true。news is_active/auto_publish=true、配備済みmonitor v104は認証付きmode入口を残している。manual/他トリガーによる再投入に対する完全封鎖は未達。

24時間のEdge HTTPログをpath/status/User-Agentで集計。観測された呼出しのUser-Agentはすべてpg_net/0.20.4で、11:00以降のニュース・MIC・broadcast呼出しは0。共有x-test-post/Pushの定期実行は継続。ログ窓内でmarket-report-analysis/data-packet/personalized-reports等の呼出しは観測されなかった。**ログに無いことだけで未実行を完全証明しない。**

## 4. Cron外自動起動と設定経路

### GitHub画像生成

[workflow](https://github.com/anohi-memories/kabumori/blob/3c7480b7ba6aed548afdc683c73a796369ec0287/.github/workflows/morning-greeting-image.yml#L10)はGitHub API上active。日次UTC 15:17/17:47/19:17/20:17、JST翌00:17/02:47/04:17/05:17に起動可能。

[生成スクリプト](https://github.com/anohi-memories/kabumori/blob/3c7480b7ba6aed548afdc683c73a796369ec0287/scripts/morning-greeting-image.ts#L264)はposting_windowsのkabumori/morning_greetingを読み、ONなら既存画像確認後に生成・Storage保存へ進む。そのwindowは本番でtrue。既存画像がある日の後続起動はskip可能だが、日が変われば費用・書込みが再発し得る。

- [10/17 03:48 JSTの生成run](https://github.com/anohi-memories/kabumori/actions/runs/38950193306)はsuccess。
- Storageの `morning-greeting-assets/generated/2026-10-17.png` は03:51:04 JST作成。これは停止後比較境界11:00より前であり、「停止後に画像生成した」とは主張しない。
- その後の生成runもsuccessだが、既存画像skipか否かはこのステータスだけでは判別しない。**今後の自動生成経路が有効である点がBLOCKED理由。**
- morning-greeting-image-checkもactive（日次2回）。ソース上read-only確認。
- ai-lab-diary-snapshotもactiveだが、対象diaryファイルpushまたはworkflow_dispatchのみ。日次scheduleなし。会社員AIラボ用として保護。

### 他の起動可能性と確認限界

- mainのworkflowは上記3件。GitHub repository webhookはGET結果0件。
- public/auth/storageの非内部trigger 62件を列挙し、URL引数付きtriggerおよびtrigger関数本文でnet.http/http_post/http_request/dblink/pg_notifyを直接参照する対象は0。静的パターン検出であり、間接呼出し全体の証明ではない。
- Edgeの一覧・配備状態を取得しただけで、endpointへの試験POST、dry-runを含む機能実行は一切していない。
- mainのEdgeソースにDeno.cronやsetIntervalによる常駐起動は見つからなかった。クライアント側timerは表示更新/読取りpollingであり、外部スケジューラの全設定までは監査対象から確認できない。
- mainのNetlify設定・EAS設定にかぶモリ投稿/ニュースを定期起動する記述は見つからなかった。ホスティング側の実設定、未知の外部scheduler、他repo/端末のジョブ、保有者による手動呼出しは未確認。
- Draft PR #212/#213等の休止ゲート候補を本番配備済みと扱わない。監査中のmain更新は別担当の管理文書更新であり、休止変更を実施したとは扱わない。

## 5. 次の判断（実施していない）

1. **Sol（高）**: 共有#1を維持し、かぶモリだけの新規予約作成を止める方法を、既存予約許可と整合させて確定する。既存F2/F8候補と担当範囲を尊重し、無条件merge/deployしない。
2. **Luna（高）/必要ならSol（高）**: かぶモリ画像workflowまたは朝挨拶の設定を停止する具体案を作り、会社員AIラボworkflowを維持する。実設定変更は別途明示承認後。
3. **Sol（高）**: ニュース・Pushの「手動/別起動も封鎖する」要件を採る場合のみ、brand/生成/送信直前ゲートを承認済みTASKで適用。共有Auth/AI/Secrets/Cronは一括停止しない。
4. **Luna（中）**: 上記対処後、翌JST日付・週間planner境界で新規かぶモリ予約/画像/通知が作られないことをread-onlyで再確認する。既存予約の失敗・再試行と新規作成は分けて確認する。

現状は「主要Cron停止済みの選択的休止」。完全休止PASSや無人・無課金保証は出さない。

## 監査の安全制約と検証

全DB観測を明示READ ONLY transactionで実施。外部送信、mutation RPC、DML/DDL、Cron変更、設定変更、Auth操作、Vault/secret/token取得、Edge呼出し、AI生成、SNS投稿、deploy、PR mergeは行っていない。稼働中の既存workerの自然実行は継続している。
監査で変更するリポジトリの範囲は `docs/kabumori-resume/**` のみ。既存rooms原本・SOURCE_REGISTER・archive・他担当TASKは変更しない。

公式ログ仕様参照: [Supabase Logs](https://supabase.com/docs/guides/observability/logs)（保持期間・ログ種別の限界を確認）。機能実装は行っていない。
