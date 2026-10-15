# F8｜重要ニュース全入口停止ゲート：オフライン実装候補（source-only）

- 作成: 2026-10-15 JST（F8）。task_id `kabumori-f8-news-hard-pause-runtime-candidate-20261015`。設計 `NEWS_HARD_PAUSE_DESIGN_20261015.md`（PR #209 merged）の実装候補。
- **本番にはdeployしていない。** migration・設定・Cron・Secret・APIキー・共通基盤・X/Push・実HTTP・課金は不使用。PRODUCTION_NO_GO維持、`production_mutation_window` は開いていない。
- 基点: main `ded9daa7`。独立checkout `kabumori-f8-pause-rt`、branch `claude/f8-news-hard-pause-runtime-candidate-20261015`。PR #129 / #164 のHEADは変更していない。

## 1. 変更（`supabase/functions/important-news-monitor/` のみ）

| ファイル | 内容 |
|---|---|
| `pause_gate.ts`（新規） | `readNewsPauseState`（`is_active===true` の単一行のみ running。それ以外・読取失敗は paused/unreadable）、`createPauseGuardedFetch`（外向き呼出の直前に設定を再確認）、`installNewsPauseGuard`（グローバル fetch に冪等に適用） |
| `index.ts`（+15行） | ①`installNewsPauseGuard();` を `Deno.serve` の前に、②**認証・環境変数検査の後、mode分岐・body解析の前**に入口ゲート（running 以外は 503 `NEWS_HARD_PAUSED` / `NEWS_PAUSE_STATE_UNREADABLE`、`autoPublish:false`） |
| `pause_gate_test.ts`（新規） | 13件（下記） |

認証は不変（401/405/500 の順序・内容はそのまま。不正なsecretでは設定読取すら行わない）。

## 2. 設計判断

- **二層**: 入口ゲート（全mode・未知mode・body上書きを一括で遮断）＋**外向きfetchの共通ガード**（AI・X・Push RPC・外部feed・DBの書込み/claim/RPCを、呼出の直前に再確認）。ガードは個々の呼出箇所ではなく**fetchの出口**に置いたため、34箇所のfetchと将来の追加箇所が自動的に覆われる（`= fetch` の既定引数は呼出時に解決されるのでガード済みfetchが使われる。モジュールレベルでfetchを保持する箇所が無いことを静的テストで固定）。
- **許可される通信**: `${SUPABASE_URL}/rest/v1/` への GET/HEAD（DB読取）のみ。停止中でもhandlerは応答でき、ガード自身が設定を読める。**それ以外（POST/PATCH/DELETE/rpc/他ホスト/OpenAI/X）は全て設定確認後**。
- **停止判定**: `is_active===true` のみ継続。行なし・複数行・null・文字列・数値・読取失敗・例外は全て拒否（fail closed）。設定が読めない/環境変数がない場合も外向きは拒否。
- **キャッシュ**: 「running」の判定を `PAUSE_RECHECK_TTL_MS = 1000ms` だけ保持（拒否はキャッシュしない＝再開を即反映）。停止完了の時点は「フラグ書込み＋最大1秒＋in-flightの完了」の後。TTLは定数（0にすれば毎回確認）。
- **許可リストは空**: bodyの `mode`/`dry_run`/`trigger`/`force` では解除できない。`notification_enqueue_dry_run` / `publish_dry_run` も停止中は拒否（設計§4.2）。

## 3. 検証（合成・オフライン。実network/DB/SDK/環境変数は不使用）

**`pause_gate_test.ts`（13件PASS、実 `index.ts` handler を fetch mock 上で実行）**
1. 状態読取: 厳密に `[{is_active:true}]` のみ running（false/{}/null/"true"/1/空/複数行/object/500/例外は running でない）。
2. `isDatabaseRead`: GET/HEAD＋自プロジェクトのPostgRESTのみ開放（POST/PATCH/DELETE/rpc/別機能/OpenAI/X/TDnet/類似ドメインは閉）。
3. ガード: 停止中は全外向き拒否・DB読取は通過／TTL内は旧判定・TTL後に拒否・拒否は非キャッシュ／ttl0で毎回確認／不正値・読取失敗・設定なしで拒否。
4. **handler（17リクエスト形 × 6状態: false・null・欠落・不正"true"・不正1・読取失敗）で、外向き（AI/X/外部取得/DB書込み/RPC）が0、全て 503、`autoPublish:false`**。mode: unpdf_edge_verification・各AI dry-run(3)・notification/publish dry-run・publish_ready・generate_ready・judge_pending・scheduled/manual収集・candidates のみ・未知mode＋fetchSources・大文字違い・body上書き3種。
5. 認証不変: 誤secretは設定読取前に401、GETは405（外部呼出0）。
6. 稼働中は通常どおり（judge_pending→AI、generate_ready→書込み/RPC、収集→外部取得/書込み）。
7. 50回のretryでも外向き0。
8. in-flight: 1件目の外向き後にフラグを停止へ変更（時計をTTL超へ進める）→ **flip後の外向きリクエスト0**（push enqueueも `NEWS_HARD_PAUSED` で拒否されることをログで確認）。
9. 静的: 全laneモジュールでfetchのモジュールレベル保持なし／入口ゲートの位置（serve < 認証 < ゲート < body解析）＋ガード導入。

**`tools/kabumori-pause/f8/runtime_mutation_check.sh`（変異テスト）**: 未変異コピーが通ること（control）を確認した上で、入口ゲート削除・ガード未導入・ガードが拒否しない・null/欠落を許可・読取失敗を許可・DB書込みをガードから除外・設定なしを許可、の7変異がすべて**検出（テストFAIL）**。

**回帰**: important-news-monitor 全体 740 PASS、lint 97（baselineと同数）、型は既存の TS2322（`x_oauth2_post.ts`）のみ、`git diff --check` clean。

## 4. 既存の停止手段との関係（部分停止では不足）
`luna_enabled=false`（judge_pendingのAIのみ）、`auto_publish=false`（publish_readyのXのみ）、`trigger:"scheduled"` の `is_active`（収集のみ）は、いずれも単独では全停止しない。本ゲートは `is_active` を**全入口に統一**する。F2のx-test-post/ブランド遮断・共通publish_guardとは独立で、ニュース固有の独自X経路（環境変数トークン）の送信直前（`postToXWithRefresh` の fetch）も外向きfetchとして再確認される。

## 5. PR #129 / #164 との統合（source-only）

- **textual**: 候補 vs PR #129 / PR #164 / 両者同時のmerge-treeはいずれも**競合なし**（編集箇所が重ならない）。
- **テスト**: 統合後に **PR側の実handlerテストが失敗する（9件）**。モックの設定行に `is_active` が無い（`luna_enabled` 等のみ）ため、ゲートが「paused」と判定する、設計どおりの結果。PR #129: judgement_body_race（H4-R2）4件・release_flags（Fed）2件、PR #164: jp_official_diagnostics_persist 3件。**各PRの設定モックに `is_active: true` を足すだけ**で解消する（機能・ロジックの変更は不要）。統合順は G1 が決定（推奨: #164 → #129 → 本ゲート、または本ゲートを最後に当ててモックを機械的に更新）。
- 所有: important-news-monitor 範囲は F8。PR #129/#164 のHEADは直接変更していない。

## 6. 重要な運用上の注意（deploy前に必ず確認）

1. **`is_active` は列定義が `not null default false`**。現状 `is_active=false` の運用でも、判定/生成/公開のCronは動いている可能性がある（`is_active` は収集のscheduledにしか効いていなかった）。**本ゲートをdeployした瞬間、`is_active=false` なら全入口が停止する**。deploy前に、設定の現在値（本番read-only）と、現在の運用が「収集だけOFF」を意図していないかを確認すること。
2. 再開は `is_active=true`（＝収集も再開）。`updated_at` トリガにより設定更新のたびに自動公開のcutoverが進む（再開前に生成済みの `ready_for_publish` は自動公開されない。`auto_publish` は最後に有効化）。
3. **in-flight の残り**: ガードが外向きを拒否すると、処理中の候補が `generating` で止まる／run行が `running` のまま残る可能性がある（claim直後にAIが拒否された場合、claimのPATCH後の書込みも拒否されるため）。復旧時の整理手順（`generating` の再投入可否、run行のreconcile）は別途定義が必要（停止時点の対象集合は本番read-onlyで再測定）。
4. 送信済みのOpenAI/X/外部HTTPは取り消せない。
5. 引継ぎの `ready_for_publish` 37件は固定値として使っていない（再開時に cutover・鮮度・二重送信防止・未送信Pushを再確認）。

## 7. 他の入口（本候補の対象外・列挙）
- **news-discovery-observer（#43）**: 別Edge Function。専用secret（`NEWS_DISCOVERY_OBSERVER_SECRET`、未設定なら503）で、`is_active` 等の停止判定を持たない。公式RSS/APIの取得と `news_discovery_*` への書込み、`web_search` は「リクエストが要求し、かつプロバイダ設定がある場合のみ」。**本リポジトリのmigrationにCron登録は無い**（起動経路はリポジトリ外または手動）。同型のガード（読取= `important_news_monitor_settings` もしくは専用設定）は別TASK。runtime編集は未割当のため本候補では変更していない。
- **important-news-shadow（#38）**: 既存OFF維持（本候補は変更せず）。
- 共通AI provider・台帳・RPC・Auth・POSTONA・共通Cron #1/#9・x-test-post・MIC・F2: 不変更（ガードは `important_news_monitor_settings` の1行読取のみを追加）。

## 8. 限界
- 配備版・本番の設定値・Cron・キュー・in-flightは未確認（本番read禁止）。
- ガードは「fetch」経由の外向き通信を覆う。Deno標準fetch以外の経路（WebSocket等）はこのfunctionに存在しないことを確認したが、将来の追加は静的テスト（モジュールレベル保持）では検出できない。
- 実handlerのテストは外向きをmockで数えたもの（実network不使用）。本番deploy・Preview実行の証明ではない。
