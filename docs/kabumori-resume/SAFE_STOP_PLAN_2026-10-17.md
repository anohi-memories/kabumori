# かぶモリ：新規予約・朝画像生成の安全な停止計画

- 作成日: 2026-10-17 / 推薦モデル: **GPT-6（高）**
- 状態: **調査・停止計画のみ。DB設定変更・Actions無効化・runキャンセルは未承認、未実施。**
- ユーザーが承認した操作はPR #245のmainマージのみ。後述A/B/Cの実行承認とは別。
- 対象: ①かぶモリの新規予約作成、②朝の画像生成GitHub Actions。
- POSTONA・共通アカウント/Auth・共通AI・会社員AIラボを保護。既存予約を投稿してよいという決定を維持する。
- main基準: `872516cd885e70e36c8714e7e972c75cd0229a79`
- 本番DB観測: 2026-10-17 **19:36:40–19:38:58 JST**。workflow観測開始19:38:26 JST。
- [DB証跡](evidence/2026-10-17-stop-plan/db-observations.json)、[読み取りSQL](evidence/2026-10-17-stop-plan/read-only-investigation.sql)、[workflow状態](evidence/2026-10-17-stop-plan/workflow-state.json)。

## PR #245のマージとread-back

PR #245を承認どおりmainへマージした。

- merge commit: [872516cd885e70e36c8714e7e972c75cd0229a79](https://github.com/anohi-memories/kabumori/commit/872516cd885e70e36c8714e7e972c75cd0229a79)
- merged_at: 2026-10-17 19:36:31 JST
- 承認対象HEAD: `a8abe86785f4cb2265daa4a8862650eaddcecc22`
- GitHubからmerge commitの文書9件を取得し、ローカル承認対象とサイズ・SHA256・全バイト一致。
- compare APIでmainがmerge commitを含むこと、およびその時点で監査9パスに後続変更がないことを確認。
- [9件の検証記録](evidence/2026-10-17-stop-plan/pr245-main-readback.json)。
- マージ操作中にmainが他担当によって進み、一度GitHubが再確認を要求した。最新状態を取得後に通常マージした。force/admin bypassなし。
- PRチェックのVercel failureは事前からのDeployment rate limited、Netlify Deploy Previewはcanceled/successだった。deployの再試行はしていない。文書以外の変更は含めていない。

## 調査結論

**推奨はA（既存設定9行のOFF）＋B（画像生成workflowのみ無効化）。C（画像確認workflowの無効化）は独立した付帯提案。**
既存の停止スイッチを使うため、DB関数・schema・Edge・共通AI・Authの変更やdeployを必要としない。

この計画で止めるのは「今後の通常plannerによるかぶモリ予約作成」と「朝画像workflow起動」。すでに許可された予約投稿、手動の直接X/AI呼出し、ニュース・Pushの全入口は別の境界であり、この2件の対処だけで全システム完全休止PASSとはしない。

### A. 新規予約：共有Dispatcherを維持し、かぶモリ設定だけOFF

実経路は次のとおり。

`Cron #1 → 配備済みx-test-post v145 → claim_due_post → 5個のplanner → scheduled_posts`

本番catalogでscheduled_postsへ直接INSERTするpublic関数を検索し、次の5個だけを確認した。文字列検索による直接参照確認であり、未知の動的SQLやサービス権限による直接INSERTまで禁止する証明ではない。

| planner | 本番で読む停止スイッチ | 現在 | 提案 |
|---|---|---|---|
| plan_daily_posts(date) | posting_windows.is_active ＋ brandsの稼働状態 | かぶモリ6枠ON、3枠OFF | かぶモリON 6枠だけOFF |
| plan_weekly_useful_tips(date) | useful_tip_schedule_settings.is_active | singleton id=trueがON | この1行をOFF |
| plan_morning_report(date) | morning_report_settings.is_active | id=true / brand_id=kabumoriがON | この1行をOFF |
| plan_close_report(date) | close_report_settings.is_active | id=true / brand_id=kabumoriがON | この1行をOFF |
| plan_us_premarket_report(date) | us_premarket_report_settings.is_active | id=true / brand_id=kabumoriがOFF | 変更せずOFF確認 |

更新候補は**合計9行**。posting_windowsはmorning_greeting slot1、tip slot1/2/3、interaction slot1/2の6行。UUID・現在値・他列・関数fingerprintを証跡に保存した。実行時はこのsnapshotをそのまま流用せずfresh read-backし、UUID・brand_id・post_type・slot_noの一致も確認する。

**朝刊・大引けはposting_windowsが既にOFFでも専用設定がONのため、新規作成経路が残る。** 土曜の現在予約が増えないことは、次の営業日にも増えない証拠にならない。週間useful_tipも専用設定を止める必要がある。

#### 保護対象と既存予約への影響

- plan_daily_postsはwindowとbrandをJOINする。変更をbrand_id=kabumoriの既存6行に限定すれば、AIラボの10枠やPOSTONAのu_*ブランド枠を対象にしない。
- 専用plannerはsingleton設定を読む。週間設定にbrand_id列は無いが、本番関数のINSERT先brand_id defaultがkabumoriであり、この設定のDB内参照元は週間plannerだけだった。朝刊・大引け・米国設定も現在かぶモリ専用。既存adminソースもこれらをKabumori-ownedとして扱っている。
- posting_windowsの既存triggerはsocial_mobile_account_deletion_guard。関数本文ではkabumoriなどu_*以外は即returnする。trigger変更・共通退会操作は不要。
- scheduled_posts・post_execution_logsは更新/削除しない。pending 2件（interaction 10/17 20:41:36 JST、useful_tip 10/18 19:27:47 JST）を維持する。自然実行によるstatus変化は許容し、監査者が送信・再試行を起動しない。
- 本番claim_due_postはplannerの後にpending行を取得し、取得条件にposting_windows.is_activeを使わない。前監査で取得した配備済みx-test-post bundle内にも上記5設定テーブルへの直接参照はない。したがって設定OFFは新規計画を止める境界であり、既存行を自動でキャンセル/failedにするものではない。適用直前に配備bundleが同じであることを再確認する。
- brands.is_active / publish_mode / enabled_post_types / OAuth / token / 共通Secretsを変更しない。ブランド全体をdisabledにすると既存予約の生成・送信が失敗するため採用しない。
- 共通Cron #1/#9は維持。銘柄同期#5/#6も維持。market_report_consumer_settings.x_enabled/app_enabledを停止手段にしない（旧生成fallbackの問題がある）。
- 停止境界を既に通過したDB statementは旧snapshotのまま少数予約を作る可能性がある。設定COMMIT時刻だけで「即時ゼロ」を保証しない。

#### 実行する場合の手順（別途承認後）

1. 実行担当を単一ownerにする。新旧ACTIVE_TASK/TASKとF2/F8・共通Auth/AIの実write区間が競合しないことを確認。現計画でTASKを再割当していない。
2. fresh main、Edge bundle、5planner＋claim_due_postのfingerprint、table構造・brand default・trigger、9行の正確な値を再取得。対象数/所有brandが想定と違えば中止して再計画する。
3. 全brandのposting_windowsとbrandsの設定snapshotを比較用に保存（本文・token・個人情報は取得しない）。他brandの通常のキュー増減は停止しない。共有Cronのactive/schedule/command fingerprintも保存。
4. 直前にmutation windowを開く。1回の短いtransactionで対象9行だけをロックし、expected-beforeと行数が一致する場合だけis_active=falseへ変更。singletonのupdated_atを更新する場合も監査対象に含める。既にOFF/対象不足/値変更などの差異は自動補完せずROLLBACK・再計画。
5. 同一transaction内で変更行9件のRETURNING結果、かぶモリ全9windowがOFF、週間/朝刊/大引けがOFF、米国設定もOFFであることを確認。無関係な行・brands・共有Cronを変更していないことを確認してCOMMIT。エラーなら全件ROLLBACK。
6. COMMIT後のfresh transactionでread-backし、mutation windowを閉じる。以降は読み取りだけ。queueをmanual claimしたりplanner RPCを「試験実行」しない。
7. pg_stat_activityの対象statementの収束を確認し、通常Cron 2周期以上を挟んだキュー作成時刻・ログを確認する。2周期だけで完了保証とはしない。長時間statementが残ればCONDITIONALのまま扱う。停止前に開始した処理が作った予約は時刻・件数を記録し、勝手に削除/キャンセルせずユーザー判断へ戻す。
8. 次のJST日付変更と次の週境界を越えた時点でも、新規かぶモリ行が作られず、他brandの設定/通常処理が維持されることを確認する。通常の定期起動を観測するだけで、人工的な予約・SNS投稿・有料生成を起こさない。確認のための自動監視は今回登録しない。

予定件数9は観測時の値。事前確認で既にOFFになっていた場合も、承認外の不足分を推測して補わない。

### B. 朝画像生成：専用workflow 1件だけ無効化

| 項目 | 値 |
|---|---|
| repository | anohi-memories/kabumori |
| workflow id | **347498805** |
| path | .github/workflows/morning-greeting-image.yml |
| 現状態 | active |
| 希望状態（実行承認後） | disabled_manually |
| 変更しないもの | YAML、生成スクリプト、OpenAI key、Supabase key、Storageの既存画像 |

[GitHub公式仕様](https://docs.github.com/en/rest/actions/workflows#disable-a-workflow)で、対象workflowの無効化とGETによるstate確認が可能。ファイル削除・schedule改変・全Actions停止は不要。

Aで朝挨拶windowをOFFにすると、現在mainの生成スクリプトはOpenAI/Storage write前にskipする。Bはworkflow自体の起動を止め、残存定期runをなくすために併用する。DB側OFFとworkflow無効化は別システムの操作なので、結果は別々に記録する。

19:38 JSTのGETでは、生成・確認の両workflowでqueued/in_progress/waiting/pending/requestedは各0件。ただし実行直前に再確認する。

**承認後の操作候補**: workflow id 347498805をdisableし、GETでdisabled_manuallyを確認する。これは今回実行していない。
既存runの停止とは分けて扱う。実行直前に非終端runが見つかった場合、対象run idと段階を確認し、キャンセルを別の承認範囲に含める。既にOpenAIリクエスト/Storage uploadを送出済みなら、取消しによる費用・書込みゼロを保証しない。無効化後に新runが増えないこと、既存runの終端とStorage最終作成時刻をread-only確認する。
[runのキャンセル](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/cancel-a-workflow-run)は無効化とは別操作であり、今回の調査から自動実行しない。

### C. 朝画像確認workflow：付帯提案、独立承認

- workflow id **376087886** / .github/workflows/morning-greeting-image-check.yml / 現在active。
- ソース上は画像有無のread-only確認で、画像生成・SNS投稿はしない。
- 生成を停止すると翌日以降の画像欠損で失敗通知・runner利用が続き得るため、休止期間はこのworkflowも無効化する案を推奨する。
- Bのみ承認ならこのworkflowは維持する。Cも承認された場合だけdisabled_manuallyにする。
- **371309016 / ai-lab-diary-snapshot.ymlはactiveのまま保護する。** リポジトリ全体のActions無効化は禁止。

## 安全な順序、失敗時、復旧

推奨順序は**fresh確認 → Aの9行をatomic OFF/read-back → Bのみdisable/read-back → Cは承認された場合だけdisable/read-back**。
Aは画像生成にも既存ゲートを効かせるため、Bへ進むまでの間も生成抑止に寄与する。

- Aが失敗: transaction全体をROLLBACKし、B/Cへ自動的に進まない。状態差異を報告する。
- Aが成功してBが失敗: Aを維持し、Bは未完了として報告する。Aを自動でONへ戻さない（予約作成が再開するため）。
- B後に未知のrunや予期しない副作用を観測: 完了扱いにせず、特定された境界だけ調査。共通Cron/Auth/AIを緊急停止しない。
- 復旧も別の明示承認を必要とする。fresh値と停止後状態が一致する対象だけを、snapshotに基づき元のis_activeへ戻す。元からOFFだった3window/米国設定はOFFのまま。他担当変更があれば自動復元しない。
- workflow復旧はB/Cで実際に無効化したidだけをenableし、state=activeをread-backする。DBゲートOFFのままenableすれば生成はskipするが、両方をONにすると日次生成が再開するため順序を事前決定する。
- 再開時は古いpending・failed予約、古いニュース・通知・画像の日付を審査し、一括再送・一括ONをしない。既存画像は削除しない。

## 今回の完了判定と次の承認単位

**調査・計画作成: 完了。停止実行: 未実施。完全休止の判定は引き続きBLOCKED。**

次回は少なくとも次を分けて承認する。
- **A**: かぶモリ専用設定9行のOFF（件数・fingerprintが同一であるfresh事前確認とread-backを含む）。
- **B**: 画像生成workflow 347498805の無効化。
- **C（付帯提案）**: 画像確認workflow 376087886の無効化。
- 非終端runがその時点で存在する場合は、特定runのキャンセル範囲も追加確認。

本番write・Actions状態変更・実SNS/AI呼出し・新規deployは今回0件。保護対象のTASK・PR・worktree・共通設定を変更していない。F2/F8の未配備候補を一括mergeする必要はなく、計画文書を保存したことは本番GOを意味しない。
