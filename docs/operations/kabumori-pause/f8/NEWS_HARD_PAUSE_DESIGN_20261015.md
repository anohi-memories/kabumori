# F8｜重要ニュース完全休止ゲート：オフライン設計（直接HTTP・AI・X・Push・外部取得）

- 作成: 2026-10-15 JST（F8）。task_id `kabumori-f8-news-hard-pause-http-ai-offline-design-20261015`。
- 基準: main `d2309afc`（merge済み PR #208）の `supabase/functions/important-news-monitor/index.ts`。**配備版との一致は未検証**（本番read禁止）。
- **設計のみ。** runtime・migration・設定・Cron・Secret・APIキー・X/Push/外部HTTP/課金は一切変更も実行もしていない。本番はNO_GO。`production_mutation_window` は開いていない。
- 検証: `tools/kabumori-pause/f8/`（完全合成のモデル）。**モデルPASSは設計の性質であり、実handlerの実装証明ではない。**

## 1. 結論（先に）

1. **現状、ニュースの `is_active=false` は直接HTTPのほとんどを止めない。** 停止判定（`monitorIsActive`）は「`trigger==="scheduled"` かつ収集分岐」にしか無く、mode分岐より後ろにある（`index.ts:2039`）。判定(`judge_pending`)・生成(`generate_ready`)・独立X公開(`publish_ready`)・各AI dry-run・mode省略/未知＋`fetchSources` は、停止中でもAI・X・Push・書込み・外部取得に到達する（合成モデルで全件確認、§3）。
2. 必要なのは**認証の後・mode分岐の前**に置く共通の停止判定（失敗は閉じる）と、**副作用の直前の再確認**（AI呼出・claim・外部取得・書込み・X送信・Push enqueue）の二段。
3. 入口ゲートだけでは、**既に開始した処理（in-flight）や送信済みHTTPは止まらない**。完全停止の時点は「停止フラグ時刻＋in-flight完了上限＋キャッシュ許容」の後で、**read-backで0を確認**して初めて宣言できる（§6）。
4. 独立X公開（`publish_ready`）は `x-test-post` を通らず、環境変数のXトークンを直接読む。**F2のブランド遮断だけでは停止保証にならない**。ニュース固有の停止ゲートをこの経路の送信直前に置く（§7）。
5. PR #129 / #164 が同じ `index.ts` を変更しているため、**本設計に基づくruntime差分は統合方針が決まるまで作らない**（§9）。

## 2. 入口から副作用までの経路（`index.ts`）

認証: `POST` のみ（405）→ `IMPORTANT_NEWS_CRON_SECRET` の設定検査（500）→ ヘッダ照合（401）→ `SUPABASE_URL`/`SERVICE_ROLE_KEY`（500）→ JSON body。**停止判定はここに存在しない。** 以降は `body.mode` の厳密一致で分岐し、該当しない場合は収集分岐に落ちる。

| 分岐（行） | mode | 停止中でも到達する副作用（コード上） | 備考 |
|---|---|---|---|
| 1705 | `unpdf_edge_verification` | 外部HTTP（固定PDF取得） | AI・書込みなし。外部取得を含む |
| 1709 | `app_copy_dry_run` | AI（app copy 2回）＋使用量台帳書込み | dryでもAI課金 |
| 1735 | `notification_enqueue_dry_run` | DB read のみ | 課金・書込みなし |
| 1771 | `publish_dry_run` | DB read のみ（X呼出は例外で封じられている） | |
| 1771 | `publish_ready` | `auto_publish` 判定→Xトークン読込→**X投稿**→候補更新→**Push enqueue** | `is_active` を見ない。ゲートは `auto_publish`＋cutover |
| 1871 | `generation_dry_run` | AI（生成）＋台帳書込み | dryでもAI |
| 1871 | `generate_ready` | claim→AI(2)→書込み→**app copy AI→Push enqueue** | **候補0件でも app copy と Push enqueue が走る** |
| 1948 | `judgement_dry_run` | AI＋台帳書込み | dryでもAI |
| 1948 | `judge_pending` | AI→台帳/判定書込み→**即時生成（claim＋AI）** | `luna_enabled=false` なら409（既存の別フラグ、AIのみ） |
| 2033〜 | mode省略 / 未知 / 大文字違い | 収集：run行・候補insert・**TDnet/RSS外部取得・breaking_market web検索・headline trigger のAI** | `fetchSources===true` または `candidates` 配列が必要。それが無ければ400 |
| 2039 | 収集のうち `trigger==="scheduled"` のみ | `is_active` を確認し、停止中なら `skipped_inactive` のrun行を1件書く | **`trigger` 省略（=manual）は確認しない** |

要点:
- **入口は共有されている**: Cron（fetch / judgement / generation / publish-ready の4ジョブ、`20260923110440`）も直接HTTPも同じhandler。止めるべき単位はEdge Function全体のHTTP入口。
- **mode省略・未知modeは通常収集に到達する**（`candidates:[…]` だけで run行とinsertが走る）。モード許可リスト化と、未知modeの副作用拒否が必要。
- **`trigger` はbody由来**（`"scheduled"` 以外は全て manual）。呼び出し側が `trigger` を省略すれば、現行の `is_active` 判定自体を回避できる。
- **dry-runは「無料」ではない**（3種でAI呼出と台帳書込み）。
- **空候補でも副作用**: `generate_ready` は対象0件で app copy AI と Push enqueue を実行する。

## 3. 全mode×状態の表（合成モデル、`mode_state_matrix.md`）

`tools/kabumori-pause/f8/print_table.ts` が生成（`docs/…/f8/mode_state_matrix.md`）。**baseline=現行コードの分岐モデル / gate=§4の完全ゲート**。セルは外向き副作用の件数（ai / http / claim / write / x / push）。

- baseline: `is_active=false`・未設定・不正値・読取失敗のどれでも、`judge_pending`(ai6/claim2/w6)・`generate_ready`(ai6/claim2/w4/push1)・`publish_ready`(w1/x1/push1)・各AI dry-run・manual収集(ai2/http1/w3)・未知mode＋fetchSources が副作用に到達。停止されるのは `trigger:"scheduled"` の収集のみ（run行1件を除く）。
- gate: **全リクエスト形×全非稼働状態（停止・未設定・不正値・null・読取失敗）で、外向き副作用0**（ai/http/claim/write/x/push すべて0、DB readは設定1回のみ）。
- 検証した追加条件（`model_test.ts`）: bodyの `is_active/force/dry_run/trigger/auto_publish` と大文字違いのmodeで解除不可／50回のretryでも全カウンタ0／稼働中は現行と同一挙動（ゲートは通常運用を変えない）／ゲートが触るのはニュース設定行のみ（共通AI provider・台帳・brand guard・POSTONA・MICに触れない）。

## 4. ゲート設計案（比較）

### 4.1 判定ソース
| 案 | 内容 | 利点 | 難点 |
|---|---|---|---|
| **A（推奨・第1段）** | 既存 `important_news_monitor_settings.is_active` を**全modeへ統一**（意味を「ニュースの全副作用を許す」へ拡張） | schema変更なし。現在の運用値と整合。実装は入口1箇所＋再確認 | 既存運用で「収集だけ止める」用途があれば意味が変わる→復旧手順で明示が必要。`updated_at` トリガで cutover が動く点（§8）に注意 |
| B | 専用の `hard_pause` フラグ（列追加） | 通常のOFFと緊急停止を分離できる | migrationが必要（本TASK範囲外・別承認）。二重設定の矛盾状態を設計する必要 |

**推奨**: 第1段はA。Bは、A運用で「通常OFF」と「完全休止」の分離が必要になった場合のみ別TASKで評価。

### 4.2 配置と動作
1. **認証→停止判定→mode分岐**の順（認証の緩和・置換はしない）。停止判定は設定行を1回読む（DB read のみ）。
2. 判定: **`is_active === true` でなければ全て拒否**（行なし/null/文字列"true"/数値/読取失敗/例外 すべて拒否＝fail closed）。応答は 503 とし、本文に詳細（candidate/件数）を載せない。
3. **bodyからの迂回不可**: `mode`/`dry_run`/`trigger`/`force` 等で判定を飛ばせない。許可リスト（allowlist）は**空**を既定とし、診断が必要な場合のみ「課金も書込みもしない読取専用」を狭く追加（候補: 新設の `pause_status` のみ。既存の `notification_enqueue_dry_run` は他テーブル読取を伴うため既定では許可しない）。
4. **未知mode**: 既知modeの許可リストに無ければ、停止中に限らず収集分岐へ落とさず拒否する設計も併せて推奨（収集は明示的な `mode:"collect"` 等へ。ただし**Cronの本文との互換**があるため、本TASKでは「停止中は全拒否」を満たす最小変更を優先し、未知mode拒否は統合時の別判断とする）。
5. **副作用の直前再確認**（§5）。

### 4.3 run行の扱い
現行の `skipped_inactive` run行（scheduled収集の停止時に1件書込み）は観測性のために有用だが、**「副作用0」とは矛盾する**。選択肢: (i) run行も書かない（完全0）、(ii) `monitor_runs` への1件のみを許可リストに入れる（コスト0・外部への影響なし）。**推奨は(ii)を明示的に許可リスト化した上で、完全停止の宣言（書込み0）からは除外して記述**する。判断はG1。

## 5. 非同期継続・副作用直前の再確認

再確認を入れる境界（すべて「外向き」）: ①各AI呼出の直前（判定/生成/app copy/web検索/headline triage）、②候補のclaim（`ready_for_generation→generating` 等）直前、③外部取得（TDnet・RSS・company IR・PDF）直前、④DB書込み（run行・候補insert・判定保存・usage台帳）直前、⑤**X送信（トークン読込の後、`postToXWithRefresh` の直前）**、⑥通知enqueue（RPC）直前。

- 設定の**キャッシュ許容は0を既定**（各境界でread）。DB負荷が問題なら短いTTL（秒）を明記して「停止完了＝T_flag＋TTL＋in-flight完了上限」に加算。
- in-flight：一括処理（`limit`最大20件・候補ループ）は**候補単位**で再確認し、停止後に残りを継続しない。モデル（`in-flight` テスト）は、flip後の副作用が「flip前に開始した分」以下に収まることと、再確認なしでは継続してしまうことを示す。
- **送信済みHTTPは取り消せない**（OpenAI・X・外部）。再確認の効果は「次の境界以降を止める」まで。
- 並行worker（複数Cron同時・retry）：claimは既存のDB原子操作（`generating`/`publishing`）で二重処理を防ぐ。停止判定は各workerが独立に行う。

## 6. 停止・復旧のread-back設計（実行しない）

**停止の完了条件（案）**: ①停止フラグのwrite→read-back、②`T_stop = T_flag + 設定TTL + 関数の最大実行時間（実値は本番read-onlyで確認）`、③`T_stop` 以降を観測窓として次が0であること：
- `ai_usage_events` のニュース系 feature の新規行、
- `important_news_monitor_runs` の新規行（許可リスト分を除く）、
- `important_news_candidates` の status 遷移（`generating`/`publishing`/`published` への新規）、
- `notifications`（source_type=`important_news`）の新規行、
- X投稿（candidate の `x_post_id` 付与時刻）、
- 外部取得の痕跡（news_discovery の run/signals、観測できる範囲）。
観測窓はCronの最大間隔（5分）＋retryを覆う長さに。**窓内で1件でも出れば停止未完了**として中止/再設定。

**abort条件（案）**: 読取失敗、フラグが想定値でない、窓内に副作用が出た、共有基盤（共通AI台帳・POSTONA）に変化が出た場合。

## 7. X送信との組合せ（F2との境界）

- `publish_ready` は `loadXTokens`（DB read＋トークン更新の書込みあり）→ `postToXWithRefresh`。**ゲートは「トークン読込の前」と「送信の直前」の2点**（refreshで更新書込みが発生するため）。
- **F2（x-test-post/予約）と F8（important-news-monitor 全副作用）の所有境界**: 共有 `publish_guard`（exact brand の active/live/account）の実変更は未割当。ニュースのX投稿は単一アカウント（環境変数トークン）で、brand列による照合の対象ではなく、**ニュース固有の停止フラグが唯一の確実な遮断**。将来 `publish_guard` をニュース経路にも呼ぶ場合は、G1が単一ownerと呼出面を決める（F2の成果物と整合）。
- 旧brand fallback（NULL/欠落→kabumori）は、**かぶモリ休止の判定にPOSTONA行が巻き込まれない**ことに留意（F2側の設計事項。F8のゲートはbrandに依存しない）。

## 8. 復旧・backlog・重複防止

- **`updated_at` と cutover**: `autoPublishIsEnabled` は設定行の `updated_at` を `cutoverAt` に使い、これ以前に生成された候補は自動公開されない（`isCandidateAfterAutoPublishCutover`）。設定行の更新トリガ（`important_news_monitor_settings_updated_at`）により、**休止・再開のどちらの書込みでも cutover が現在時刻へ進む** → 再開時点より前に生成済みの `ready_for_publish`（引継ぎ値37件、**未再測定**）は、再開後も自動公開されない（古い内容の一斉投稿を防ぐ既存の挙動）。再開手順で `auto_publish` を最後に有効化する順序が重要（有効化の書込みでもcutoverが進む）。
- 再開順（案）: ①`is_active=true`（`auto_publish=false` 維持）→②収集/判定/生成の再開を観測→③backlogの鮮度審査（再判定・失効）をユーザー承認で実施→④`auto_publish` を有効化。**`autoPublish=false` 維持**を既定。
- **既にenqueueされた通知**: ニュース側の停止ではキュー内の `pending` 行は消えない。送信はPush Dispatcher（共通・停止対象外）が担うため、**復旧時の古い通知の一斉送信を防ぐ鮮度フィルタ／保留は別担当**（F2/共有Push設計）。F8の設計範囲では「ニュースproducerからの新規enqueueを0にする」まで。
- **結果不明の送信**: X投稿後にDB更新が失敗した場合、候補は意図的に `publishing` のまま残り自動retryされない（`publish_logic.ts` のコメント）。→ blind retry なし。復旧時は `publishing` 行を人が照合（Xの実投稿と突合）してから扱う。通知は `(user_id, tracked_stock_id, source_type, source_id)` の一意制約で重複防止。

## 9. PR #129 / #164 との将来統合方針

- いずれも `important-news-monitor/index.ts` を変更（#129: fedフラグ/ctrl系、#164: 診断永続化）。**本ゲート実装は同じ入口部分（Deno.serve冒頭）を触る**ため、統合順（#164 → #129 → ゲート、または別の順）と単一ownerを G1 が決めるまで runtime差分を作らない。
- ゲートは入口と各境界への小さな挿入で、診断構造（#164）やFed/TDnetフラグ（#129）とは独立。統合後に境界リスト（§5）を再点検する。

## 10. 停止範囲（ニュース専属）と保護範囲

**停止対象（ニュース専属）**: `important-news-monitor` のHTTP全入口と、そのCron（`important-news-fetch` / `-judgement` / `-generation` / `-publish-ready`）、そこから呼ぶ外部取得（TDnet一覧・PDF/unpdf、RSS、company IR、news_discoveryシグナル読取）・OpenAI（判定・生成・app copy・breaking_market web検索・headline trigger triage）・X直接投稿・通知enqueue。別Edgeの `news-discovery-observer`（公式RSS/API取得→`news_discovery_*` 書込み）と `important-news-shadow`（評価専用feed取得）も**ニュース専属の外部取得**で、同じ型の入口ゲートが別途必要（本TASKでは範囲を列挙するまで）。

**保護（巻き込まない）**: 共通AI provider・台帳・RPC・認可/予算（ニュースは `usage_ledger`/`usage_metering` に書くだけで、providerを止めない）、共通Cron（#1 X Dispatcher / #9 Push Dispatcher）、`x-test-post` 全体、POSTONA（X/Threads/Instagram予約・OAuth・token refresh・共通ID/entitlement）、`market-report-*`（共通市況）、MIC（F7）。F7 S1-A、MICの本番停止は別担当/別工程。

## 11. 限界・未確認
- 配備版は未確認（本番read禁止）。設定の現在値、対象集合（`ready_for_publish` 37件・予約5件・Cron38本は引継ぎ値）、in-flight、通知キューは未再測定。
- Edge Functionの最大実行時間・Cronの実コマンド/jobidは未確認（`T_stop` の式にのみ現れる）。
- モデルは分岐の簡約（実際のhandlerは更に多くのエラー分岐・上限・並列を持つ）。**実handlerの実装証明ではない。**
- `news-discovery-observer` / `important-news-shadow` のhandler詳細は未精査（列挙のみ）。
