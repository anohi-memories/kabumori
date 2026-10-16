# F8｜news-discovery-observer 停止漏れ調査と最小ゲート修正計画（source-only）

- 作成: 2026-10-16 JST（F8）。task_id `kabumori-f8-news-hard-pause-runtime-candidate-20261015`（継続）。基点 main `dbe9e13c`。
- **observer製品コードは変更していない**（別ownerの権限・worktree競合が未確定）。merge・deploy・本番接続・実HTTP/AI/Push なし。PRODUCTION_NO_GO。
- **用語の訂正**: 先行文書にある「observer #43」は**GitHubのPR番号ではない**（現GitHub PR #43 は別件の市況レポートテストPR・closed）。本書は PR番号を使わず、実在するファイル/関数で特定する。先行F8文書の「#43」「#38」は在庫上の通し番号の表記で、PR番号として扱わないこと。

## 1. 特定（GitHub main のソースから）

| 項目 | 事実 | 根拠 |
|---|---|---|
| Edge Function | `supabase/functions/news-discovery-observer/`（`index.ts`、`observer_handler.ts`、`observer_auth.ts`、`stocks_master_reader.ts`、テスト3種） | リポジトリ |
| 共有実装 | `supabase/functions/_shared/news_discovery/`（fetcher / pipeline / source_registry / supabase_store / web_search ほか） | リポジトリ |
| 認証 | 専用secret `NEWS_DISCOVERY_OBSERVER_SECRET`（ヘッダ `x-news-discovery-observer-secret`、定数時間比較）。未設定は503、不一致は401。**重要ニュースのsecretとは別** | `observer_auth.ts` / `observer_handler.ts:147-151` |
| 停止判定 | **存在しない**。`important_news_monitor_settings.is_active` を参照しない。認証後すぐ body 検証→`begin_run` へ進む | handler全体にis_active/pause/settings参照なし |
| 起動元 | **リポジトリ内にCron登録・workflow・他関数からの呼出しは無い**。呼出元は外部（Cron/手動）のみ。`index.ts` の冒頭コメントは「NOT deployed / NOT scheduled」だが、**JP公式レーンが signals を読む運用実績があるため古い**（先行docsも「コメントは古い」と指摘）。本番での実際の起動経路・jobid・頻度は**NOT_VERIFIED** | grep（repo内に呼出元なし）、`.agent` 記録 |
| 書込み | PostgREST RPC のみ: `news_discovery_begin_run` / `_find_duplicates` / `_insert_signals` / `_recent_for_grouping` / `_finish_run` / `_reserve_search` / `_complete_search`（`news_discovery_*` テーブル。RLSは有効・policyなし＝service_roleのみ） | migration `20260929090000` |
| 読取り | `stocks_master`（上場銘柄のalias辞書） | `stocks_master_reader.ts` |
| 外部通信 | 公式RSS/Atom/JSON feed（registry の DIRECT 有効源）、`include_gdelt=true` のとき GDELT（既定OFF）、`search.enabled===true` かつ `OPENAI_API_KEY` ありかつDBの日次予算内で **OpenAI web_search（有料）** | `observer_handler.ts`、`web_search.ts:216` |
| 課金上限 | `news_discovery_search_config`（日次 soft 30 / hard 48、レーン回転・クールダウン）。**予算は上限であって停止ではない** | migration |
| fetch の束縛 | `index.ts` が**モジュール読込時**に `postgrestRpcClient(...)`（`options.fetchImpl ?? fetch`）と `new OpenAiWebSearchProvider(key)`（既定引数 `fetch`）を構築する＝その時点のグローバル `fetch` を保持 | `index.ts:18-22`、`supabase_store.ts:44`、`web_search.ts:207` |

**消費側**: `important-news-monitor` の `jp_official` レーンが `news_discovery_signals` を **SELECT のみ**で読む（取得はしない）。観測は monitor の停止とは独立に動き続けるため、monitor を止めても observer の外部取得・DB書込み・（有効なら）有料検索は止まらない＝**完全停止の漏れ**。

## 2. 残存する発火経路（停止漏れの全体像）

| 経路 | 現状 | 停止判定 | 備考 |
|---|---|---|---|
| 専用secret付きHTTP（Cron／手動）→ feeds | 動く | **なし** | `trigger_type` は body 由来（manual/scheduled/local_validation） |
| 同 → GDELT（`include_gdelt`） | 動く（既定OFF要求時のみ） | なし | 429が多い既知の源 |
| 同 → **OpenAI web_search**（`search.enabled`） | provider設定＋予算内で動く | なし（予算のみ） | **費用発生**。`search.scheduled` / anomalies 入力もbodyから |
| DB書込み（run行・signals・search予約/完了） | 動く | なし | 停止中にrun行を作らない設計が必要 |
| 重要ニュース停止後の jp_official レーン | monitorが停止すれば読まれない | monitorのゲート | observer側の停止は別 |
| 外部のCron job（リポジトリ外） | **NOT_VERIFIED** | — | `cron.job` を read-only 照合（§6） |

## 3. 最小のゲート修正計画（実装は別TASK・別owner）

**設定ソース**: 既存の `important_news_monitor_settings.is_active`（行 `id=true`）を**そのまま共用**（ニュースの完全休止の単一スイッチ）。新規列/新設定は migration が必要で本TASKの範囲外。`is_active===true` 以外（false・null・欠落・不正値・読取失敗・タイムアウト）は全て拒否。

**対象ファイル**（想定される変更面。**今回は変更しない**）
1. `supabase/functions/news-discovery-observer/index.ts`: **最初に**（`postgrestRpcClient` / `OpenAiWebSearchProvider` を構築する前に）egress ガードを導入。fetch を module 読込時に束縛するため、導入順序が必須。
2. `supabase/functions/news-discovery-observer/observer_handler.ts`: 認証（401/405/503）の**直後・body解析と `beginRun` の前**に入口ゲート（拒否は 503 `NEWS_HARD_PAUSED` / `NEWS_PAUSE_STATE_UNREADABLE`）。
3. 共有化: 重要ニュースの `pause_gate.ts`（`PauseCoordinator`・TTL0・3秒deadline・stale-true フェンス）を共有モジュール化するか、observer専用に同契約で複製する。**どちらも別ownerの共有コード編集を伴うため、G1が単一ownerを決めるまで着手しない。**
4. 設定読取は `rest/v1/important_news_monitor_settings` の GET のみ（`isDatabaseRead` と同様、DB GET/HEADは開放し、RPC POST・外部HTTP・OpenAIは全て呼出ごとの再確認）。

**契約（重要ニュースと同一）**: 入口＋外向き呼出ごとの自前の権威的な読取（TTL0）、読取の期限3秒、入口で観測した停止は同一isolateの未完了の認可読取を失効。送信済みHTTP（feed取得・OpenAI）の取消は保証しない。停止完了＝「設定OFF＋3秒＋in-flight収束＋no-new-effects read-back」。許可リストは空。

**認証は不変**: secretの検証・503/401の意味は変えない。停止中に診断が必要なら、読取専用で課金も書込みもない `pause_status` のみを別途許可リスト化（実装時にG1判断）。

## 4. オフライン検証計画（合成モデルは本ブランチに作成・PASS）

`tools/kabumori-pause/f8/observer_model.ts`＋`observer_model_test.ts`（6件PASS、lint clean）:
- baseline: **停止判定が無い**ため、`is_active=false` でも全リクエスト形（default / scheduled / GDELT / web search / 組合せ / local_validation / 多数source）で外向き副作用が走る（検証）。
- candidate: 全リクエスト形 × 6つの非稼働状態（false・null・欠落・不正値2種・読取失敗）で、外向き（RPC書込み・外部HTTP・AI検索）**0**、設定読取は1回。認証（401/405）は設定読取前。稼働中はbaselineと同一。
- in-flight: egressガードがあれば、停止後の feed・有料検索・書込みが止まる。100回の反復で0。
- negative control: 入口ゲート無し／egressガード無しを検出。

**実装時に追加すべきテスト**（今回は未実施・別TASK）: 実 `observer_handler` を `deny-net` / `deny-env` の下で mock fetch と mock RPC に対して実行し、(a) 全body形（search.enabled / anomalies / include_gdelt）× 非稼働状態で RPC・fetch・OpenAI が0、(b) 認証不変、(c) 入口とegressの停止観測共有（古いtrue失効）、(d) 構築順序（ガード導入が `postgrestRpcClient` / provider より前）の静的検査、(e) 変異テスト（ゲート除去・fail-open・順序入替）。

## 5. owner・返却先・想定独立TASK（G1決定まで割当しない）

- **owner候補**: observer（`news-discovery-observer` ＋ `_shared/news_discovery`）の編集権限は現状未確定（他slot/旧owner）。重要ニュース停止ゲートの契約owner＝F8。**提案**: G1が単一ownerを決める（F8に統合するか、observer ownerが F8契約で実装する）。
- **想定独立TASK**: 「observer停止ゲート（入口＋egress、重要ニュース `is_active` 共用）」。推奨モデル Opus5.5（高）、独立検証 Sol（高）。返却先 かぶモリアプリG1のちゃ。
- **blocked条件**: (1) observer実装ownerと独立worktreeが未確定、(2) 共有 `_shared/news_discovery` を他TASKが変更中、(3) 配備版のobserverコードがリポジトリと一致しない（NOT_VERIFIED）、(4) `is_active` の意味を全ニュース機能の単一停止と見なす運用承認がない。

## 6. 運用runbook（実行しない。別TASK・明示承認が必要）

**Cron（4 news + observer）**: ニュース4ジョブ（`important-news-fetch` / `-judgement` / `-generation` / `-publish-ready`）は重要ニュースのゲートで503応答になるが**ジョブ自体は動き続ける**。停止提案: ゲートdeployと設定OFFの後、no-new-effects確認を経て、**G1の別承認**で対象ジョブのみを `active=false` にする（`cron.job` の jobname/schedule/active/command_md5 を事前snapshot）。**共通Cron #1 X Dispatcher と #9 Push Dispatcher は停止・変更しない。** observer のCronは、リポジトリに定義が無いため `cron.job.command ~ 'news-discovery-observer'` で read-only 特定（preflight SQL が jobname/schedule/active/md5 のみ返す）。

**Push**: ニュースproducer（enqueue）は停止するが、既に enqueue された `pending/processing` は共通Dispatcherが送信し得る。**停止時の保留・復旧時の鮮度審査は別owner（共通Push/F2）**。ニュース側は「新規enqueue 0」まで。

**滞留キュー・結果不明**: `generating`/`running` の残骸、`publishing`/`publish_failed`（X送信結果不明）は自動で戻さない。preflight（`preflight_readonly.sql`＝重要ニュース、`observer_preflight_readonly.sql`＝observer）で件数と最古年齢を測り、Xの実投稿と手動照合する。

**read-only preflight（今回は実環境に接続しない。全てNOT_VERIFIED）**
1. 配備版: `supabase functions list` で `news-discovery-observer` の version / updated_at / bundle hash（コードとの一致）。
2. `tools/kabumori-pause/f8/observer_preflight_readonly.sql`（SELECT1本・集計のみ・ローカルPGで構文確認済み）: 直近24hのrun数（status/trigger別）、`running` のrun（件数・最古年齢）、最終起動時刻、今日の有料検索の予約状況（status別）と予算行、直近24hのsignals件数、observerを参照するCronジョブ（名前・スケジュール・active・commandのmd5のみ）。
3. 重要ニュース側: `preflight_readonly.sql`（PR #225 の統合候補ブランチ、または統合後のmain）。
4. snapshot / abort: 停止前に上記の値を保存。abort＝読取失敗・停止後の窓内にrun行/検索予約/signals増加が出た場合。復旧は自動実行しない（`is_active=true` は収集も再開する点に注意）。

## 7. 限界
- 本番の配備版・Cron・起動頻度・現在の `is_active`・キューは未確認。モデルは設計の性質で、実handlerの実装証明ではない。
- observerは「観測専用」で、公開・X・Push・Fact/Voiceには接続しない（コードコメント）。完全休止の目的は**外部取得・DB書込み・有料検索の停止**であり、他の停止とは独立に行える。
