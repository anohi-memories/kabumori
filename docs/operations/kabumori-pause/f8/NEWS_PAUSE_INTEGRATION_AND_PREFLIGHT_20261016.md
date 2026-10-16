# F8｜重要ニュース停止ゲートの統合候補と休止前 read-only preflight（source-only）

- 作成: 2026-10-16 JST（F8）。task_id `kabumori-f8-news-hard-pause-runtime-candidate-20261015`（継続フェーズ）。
- **merge・deploy・本番接続・実HTTP/AI/X/Push は一切していない。** PR #164 / #129 / #212 / #213 のHEADは変更していない。PRODUCTION_NO_GO。
- 入力HEAD: #164 `141d851267898ff7e28151a9e7e73121a3bb75aa`、#129 `81251b316ae44a634a1b4108b420a18765d17261`、#212 `b38064c29ceed4f5f786b2cbcbdc75102252191f`、main `ca6c5af7`。

## 1. 統合順と単一owner（提案）

**#164（診断永続化）→ #129（Fed本文／決算facts、既定OFFスイッチ）→ #212（停止ゲート）**。理由: #212 は最も小さく、入口・fetch出口のみに作用するため最後に当て、先行2件の挙動を変えない（ゲートは `is_active===true` のときだけ通す）。#164/#129 の機能（診断・フラグ）は#212の後も同じ入口から動く。

- **単一owner**: important-news-monitor 範囲は **F8**（統合候補のbranch・fixture更新・停止ゲート）。#164/#129 の機能的な正しさは各PRのownerの責任のまま。F2（x-test-post・共通publish_guard）とは独立（本統合は触れない）。
- **本統合で必要な唯一の論理調整**: 先行2PRの実handlerテスト9件が、モックの設定行に `is_active` が無いため（ゲートは「停止」と判定）失敗する。**テストfixtureのみ**に `is_active: true` を追加（5行、3ファイル）。プロダクトコード・ゲート・PR側のアサーションは変更していない。

## 2. 統合候補（独立branch）

- branch: `claude/f8-pause-integration-candidate-20261016`（origin/main 基点。#164 → #129 → #212 を順にmerge、競合は管理ファイル `.agent_v2/tasks/F8.md` のみ＝mainの版を採用）。**PR HEADへのpush・書換えなし。**
- fixture-only 変更（統合候補のみ）: `judgement_body_race_test.ts`（設定モックに `is_active: true`）、`release_flags_test.ts`・`jp_official_diagnostics_persist_test.ts`（設定テーブルのモックに `[{ is_active: true }]`）。
- 追加テスト `pause_integration_test.ts`（3件）: ①停止中に #129/#164 の全フラグ（Fed本文・TDnet facts・JP公式レーン）を有効にしても、外部取得0・Fed声明ページ0・DB書込0・診断書込0・候補insert0（503）／②稼働中は Fed声明本文の取得（4.25〜4.5%据え置き）と run診断（jpOfficial）が共存して動く／③入口通過後にOFF → 以降の外部取得・声明ページ・DB書込・診断が0。

| 検証（実handler、全てmock・実network/DB/SDK/環境変数なし） | 結果 |
|---|---|
| 未修正の統合（#164→#129→#212）の実handlerテスト | 795 PASS / **9 FAIL**（J2の再現と一致: race 4 / Fed 2 / diagnostics 3） |
| fixture-only 修正後の important-news-monitor 全体（pause_gate 23件・統合3件を含む） | **807 PASS / 0 FAIL** |
| PauseCoordinator（入口とegressの停止観測共有）・TTL 0・3秒deadline・OFF後新規X 0 | 統合候補上でも回帰PASS（pause_gate_test 23件） |
| merge-tree（#164 / #129 / #212 / 3者） | いずれも競合なし |

## 3. 停止ゲートの契約（再掲）

- `is_active===true` のときだけ継続。欠落・null・不正値・読取失敗・タイムアウトはすべて拒否（fail closed）。bodyで解除不可、許可リストは空。認証の緩和なし。
- 外向き呼出（AI／X／Push RPC／外部feed／DB書込み・claim）は呼出ごとの自前の権威的な読取（TTL 0、読取の硬い期限3秒）の後だけ送信。入口のOFF/unreadable/timeout観測は同一isolate内の egress 認可を失効させる（古い true は何も許可しない）。
- **停止完了条件**: 「設定OFFのコミット ＋ 読取の観測上限3秒 ＋ in-flightの収束 ＋ no-new-effects のread-back」が揃った後。**過去に送信済みのHTTPの取消や瞬時停止は保証しない**。OFFより前に開始・完了した認可は、読取遅延の間送信され得る。

## 4. 入口・停止漏れ一覧（実装修正はしない。別ownerは次TASK候補）

| 対象 | 状態 | 本ゲートでの扱い | 次の対応 |
|---|---|---|---|
| `important-news-monitor` HTTP全mode（判定・生成・publish_ready・各AI dry-run・unpdf・収集・未知mode） | 入口＋egressで停止（#212） | 対象（実装済み候補） | 統合PR・Sol(高)限定レビュー |
| 重要ニュース独自X直投稿（`publish_ready` / 環境変数トークン / refresh） | egressのfetchで停止（トークン読込後・送信前も再確認） | 対象（実装済み） | F2 `x-test-post` とは別経路（F2は触れない） |
| app_copy／空候補時のapp_copy・Push enqueue（`generate_ready`） | 入口＋egressで停止 | 対象（実装済み） | — |
| Cron（`important-news-fetch/-judgement/-generation/-publish-ready`、`20260923110440`） | HTTPを受けるため入口で503。**Cronジョブ自体は動き続ける**（呼出は503応答になる） | 本ゲートの範囲外（Cron変更は別承認・別TASK） | preflightで jobname/active/schedule を確認。停止手順はG1が別TASK化 |
| `news-discovery-observer`（#43） | **停止漏れ**: 別Edge Function・専用secret・`is_active` 等の停止判定なし。起動経路はmigration上にCron登録なし（リポジトリ外または手動） | 対象外（別ownerの実装ファイル） | **別TASK候補**: 同型の入口ゲート＋egressガード（読取先設定の選定を含む） |
| `important-news-shadow`（#38） | 既存OFF維持（本候補は変更なし） | 対象外 | preflightで稼働痕跡なしを確認 |
| `send-push-notifications`（Push送信、共通Push Dispatcher #9） | ニュースproducer（enqueue）は停止するが、**既にenqueue済みの `pending/processing` 通知は送信され得る** | 共通基盤のため停止対象外 | **別TASK候補**: 復旧時の鮮度保留（F2 resume／共有Push側）。ニュース側は「新規enqueue 0」まで |
| `market-report-*`・MIC（`market-intelligence-*`、`mic-*` Cron）・共通市況 | ニュース専属ではない | 対象外・不変更 | F7/F6/G1の別工程 |
| 共通AI provider・台帳・RPC、共通Auth/Secrets/OAuth、POSTONA | — | 不変更・保護 | — |

## 5. 本番適用前の read-only preflight 手順（今回は実環境に接続していない）

**すべて NOT_VERIFIED。古い件数（`ready_for_publish` 37件・予約5件・Cron38本など）は現状とみなさない。**

1. **配備版**（read-only）: `supabase functions list --project-ref wsmznyzcvmuitkglfeuj` で `important-news-monitor` / `news-discovery-observer` / `important-news-shadow` / `send-push-notifications` の version・`updated_at`・ezbr_sha256 を記録。`verify_jwt` の値も確認（認証前提の確認）。リポジトリのコードと一致するか（デプロイ済みbundleのhash）を照合し、**ゲート入り候補が未配備であることを確認**（現行配備の停止判定は scheduled収集のみ）。
2. **設定・状態**: `tools/kabumori-pause/f8/preflight_readonly.sql`（集計のみ・個人情報なし・SELECT 1本。ローカルPGで構文を確認済み）。内容: 設定行（`is_active`/`auto_publish`/`luna_enabled`/`updated_at`）、候補のstatus別件数、`generating`/`publishing` の in-flight 件数と最古年齢、`ready_for_publish` の件数と最古年齢、`publishing`/`publish_failed`（X送信結果不明の要手動照合）、`running` のrun行、直近24hのrun状況、ニュース通知キュー（`pending/processing`）、直近60分のAI使用feature別件数、observerの最終起動、Cronジョブ（名前・スケジュール・active・commandのmd5のみ。**command本文は出さない**）。
3. **`is_active` の意味確認（重要）**: 列は `not null default false`。従来は scheduled収集にしか効かなかったため、現在値が false でも判定・生成・公開のCronが動いている可能性がある。**ゲートdeploy直後に全入口が止まる**ことを前提に、現在値と運用意図を確認する。
4. **in-flight / キュー**: `generating` / `running` / `publishing` / 通知 `processing` を drain するか分離するかを決める（ゲートが外向きを拒否すると残骸が残り得る）。`publishing` と `publish_failed` は自動で戻さない（Xの実投稿と突合）。
5. **観測窓**: OFF後、Cronの最大間隔（5分）＋3秒＋in-flight完了を超える窓で、AI使用feature・run行・候補status遷移・通知の新規行・X投稿が **0** であること（no-new-effects read-back）。1件でも出たら停止未完了として abort/再設定。
6. **snapshot / abort / 復旧**: 停止前の設定行・Cron一覧（jobname/schedule/active）・件数を記録。abort条件=読取失敗・想定外の値・窓内の副作用・共有基盤（共通AI台帳・POSTONA）の変化。復旧は **自動実行しない**。再開順は `is_active=true`（`auto_publish=false` 維持）→観測→backlogの鮮度審査（F2 resumeReadiness／未処理queue／他ブランド非影響の確認）→`auto_publish` を最後に有効化（設定更新ごとにcutoverが進む）。

## 6. 限界・未確認
- 実handlerの検証はmockの下（実network・DB・SDK・環境変数なし）。配備版・本番設定・Cron・キューは未確認。
- 統合候補はsourceのみ。実mergeは別承認。Sol(高)の限定再レビューは、統合差分に新しい重大変更が生じた場合のみ（本統合はfixtureのみ）。
- Cron・observer・Push dispatcherの停止／保留は別owner・別TASK。
