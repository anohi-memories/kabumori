# F8 — 重要ニュース：直接HTTPを含む完全休止ゲートのオフライン設計

- task_id: kabumori-f8-news-hard-pause-http-ai-offline-design-20261015
- owner: claude
- slot: F8
- status: review_required
- next_owner: chatgpt
- start_code: F8
- completion_code: L8
- return_to: かぶモリアプリG1のちゃ（運用休止・全体統括）
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F8.md
- current_report_path: .agent_v2/tasks/F8.md#report
- dependencies: docs/operations/kabumori-pause/G1_PLAN_20261015.md; F2 delivery design; protected PR129/164/181/185/191/196 and F9
- blocker: production NO_GO; PR129/164 also change important-news-monitor/index.ts; design-only until runtime ownership/integration resolved
- production_mutation_window: FORBIDDEN
- previous_archive: .agent_v2/archive/2026-10-15-F8-news-improvement-a-f8-j1b5-security-review-readiness-20261014/
- assigned_checkout: /Users/yuya/.codex/.chatgpt-projects/g-p-6a8e60a4be3081918ef2c28c1b2cc386/kabumori-f8-pause-design-20261015
- assigned_branch: claude/f8-news-hard-pause-design-20261015

## 目的

ニュース改善AのF8をG1が明示割当。前TASK/ReportはL8受入済み、原文6909 bytes・SHA256・元Git blob・復元一致をappend-only archiveへ保存済み。旧G8の移動でもPR196再開でもない。ニュース専用の費用・投稿・通知の休止ゲートを設計する。本番停止承認・runtime実装承認ではない。

正式開始は、PR207の管理差分がmainへ反映され、fresh origin/mainのTASKとtask_idが一致してから。branch上のreadyだけでは開始しない。main未反映中は登録候補として保留する。

## 開始ゲート・変更範囲

fresh origin/main、PROJECT_RULES/HANDOFF、新旧ACTIVE_TASK/CURRENT_STATE、F2/F8/F9/J1 metadata、未処理L/V、PR HEAD/base/paths、専用checkout/branch/clean状態を確認。所有境界が不明なら上書きせずG1へ返す。他checkout/未コミット変更/serverは操作しない。

変更可：`docs/operations/kabumori-pause/f8/`、`tools/kabumori-pause/f8/` の設計・完全合成fixture・オフライン検証、F8 TASK/Report、完了時ACTIVE_TASKのF8節のみ。CURRENT_STATE/G1_PLANはG1が統合。

読み取りのみ：important-news-monitor全mode/呼出先、publish/generation/app_copy/notification helper、news_discovery caller、関連PR差分。

変更不可：supabase/を含む商品runtime全体・migration・設定、F2 X/予約、共通AI provider/台帳/RPC/Auth/secrets、F3〜F7/F9/J1、既存PR/branch・既存archive。PR129/164は同じindex.tsを変更するため、統合方針が決まるまでruntime差分を作らない。

## 設計指示

1. Deno.serveの全分岐を調べ、認証→設定→mode dispatch→DB claim/write→外部取得→AI→X→Push enqueueの経路表を作る。mode省略/unknown、trigger指定、手動、直接HTTP、Cron、retry、immediate generation、app_copy fallback、fetchSources、news_discoveryを含む。dry_runも課金なしと扱わない。
2. monitorIsActiveは現状scheduled収集分岐に限定。judge_pending/generate_ready/app_copy_dry_run/各AI dry-runと独立X publishを確認。auto_publishはx-test-postを経由せずトークンを読むため、F2ブランド遮断だけでは停止保証にならない。
3. 候補：既存認証を維持し、mode分岐前にニュース専用停止判定を共通適用。is_activeとの意味統一/専用hard-pauseフラグを比較。欠損/読取失敗/不正値/未知modeでは副作用を拒否し、body/dry_runから迂回不可。課金もwriteもない診断を残すなら狭いallowlistと呼出グラフで証明。共通APIキー/providerは変更しない。
4. 入口に加え、非同期継続・AI/X/Push/claim直前の再確認、処理中停止・並行worker・設定cacheを評価。既に送信済のHTTPを取り消せるとは言わない。in-flight drain/二段階停止/timeout/read-backと完全停止時点を定義。
5. X直前のかぶモリbrand照合とニュース固有pauseをどう組み合わせるか設計。F2がx-test-post/予約、F8がimportant-news-monitor全副作用を所有。共有publish_guardの実変更は未割当とし、必要ならG1が次TASKで単一ownerを決める。
6. ready_for_publish37件は引継ぎ値で未再測定。復旧時の鮮度/cutover/再判定・autoPublish=false維持、既enqueue通知、結果不明送信のblind retry防止/重複防止を設計。停止後のHTTP/cron retryによる新AI費用・新投稿・新通知0を満たす条件を示す。
7. news_discovery/本文取得・外部search/無料APIを含む停止範囲を列挙し、POSTONA/共通AI/MIC専属処理を巻き込まない。F7 S1-AやMICの本番停止は別担当/別工程として保護。

## オフライン検証・完了条件

完全合成のモデルで全mode×active/paused/設定不明/読取失敗を表にし、paused時AI/X/Push/外部取得/候補claim/writeカウンター0を確認。認証失敗、unknown mode、body override、retry、即時生成、空候補→app_copy、処理中pause切替、POSTONA/common-AI不変を含む。negative controlで入口gate削除/dry-run/app_copy/直接X bypass/送信前再確認削除を模擬し検出。モデルPASSと本物のhandler実装証明を区別。実ネットワーク/DB/SDK送信/本番環境変数は禁止。

入口・送信境界の設計、全mode表、停止/復旧/read-back/abort条件、F2依存、PR129/164との将来統合方針、共通基盤保護、残件、コマンド/結果を文書化。自己branchへcommit/push、新規Draft PRはdocs/tools/F8管理差分だけ。merge/deploy、managed DB/SQL/Edge/Cron/Auth/RLS/Secret/APIキー、X/Push/実HTTP/外部API/課金/EASは禁止。production mutation windowを開かない。

Reportを書きstatus:review_required / next_owner:chatgpt、G1へL8。後続runtime候補 Opus5.5（高）、独立検証 Sol（高）は別TASK。本番はPRODUCTION_NO_GOを維持。

## Report

- task_id: kabumori-f8-news-hard-pause-http-ai-offline-design-20261015
- result: DESIGN_DONE / MODEL_PASS（設計と完全合成モデルのみ。runtime・migration・設定・Cron・Secret・本番は不変。PRODUCTION_NO_GO維持、production_mutation_window 開かず）
- design_doc: docs/operations/kabumori-pause/f8/NEWS_HARD_PAUSE_DESIGN_20261015.md
- matrix: docs/operations/kabumori-pause/f8/mode_state_matrix.md（`tools/kabumori-pause/f8/print_table.ts` 生成）
- key_findings（base d2309afc の index.ts を読取り）:
  1. `is_active` 判定は「trigger==="scheduled" かつ収集分岐」のみ（:2039）。`trigger` はbody由来で、省略(=manual)すれば回避できる。
  2. judge_pending / generate_ready / publish_ready / 各AI dry-run（3種）/ unpdf_edge_verification / mode省略・未知mode＋fetchSources は、停止中でもAI・外部取得・書込み・X投稿・Push enqueueに到達。dry-runもAI課金。
  3. generate_ready は候補0件でも app copy AI と Push enqueue を実行。publish_ready は x-test-post を経由せず環境変数のXトークンを直接使い、ゲートは auto_publish＋cutover のみ（is_active は見ない）。
  4. judge_pending の `luna_enabled=false`(409) は既存の別ゲートでAIのみを止め、生成/app copy/Xは止めない。
- gate_design: 認証→停止判定（`is_active===true` 以外は全拒否、行なし/不正値/読取失敗も拒否、bodyで解除不可、許可リスト既定は空）→mode分岐→副作用直前の再確認（AI/claim/外部取得/書込み/Xトークン読込後・送信直前/Push enqueue）。判定ソースは第1段で既存 is_active を全modeに統一（schema変更なし）、専用hard_pauseフラグは別承認の将来案。
- in_flight_and_readback: 送信済みHTTPは取り消せない。停止完了=T_flag＋設定TTL＋関数最大実行時間の後の観測窓で、ニュース系AI台帳行・run行・候補status遷移・notifications・X投稿が0。最大実行時間・Cron実コマンドは未確認。abort条件を文書化。
- recovery: 設定行のupdated_atトリガによりcutoverが休止・再開どちらの書込みでも進み、再開前に生成済みの ready_for_publish（引継ぎ値37、未再測定）は自動公開されない。再開順は is_active→観測→backlog審査→auto_publish最後。既enqueue通知の鮮度保留はPush Dispatcher側（F8範囲外）。結果不明のX送信は publishing 残留でblind retryなし。通知は一意制約で重複防止。
- boundaries: F2=x-test-post/予約、F8=important-news-monitor全副作用（＋news-discovery-observer/important-news-shadowの外部取得は同型ゲートが別途必要、列挙まで）。共有publish_guardの実変更は未割当（G1が単一ownerを決める）。共通AI provider/台帳/共通Cron/POSTONA/MICは不変更・保護。
- pr_integration: PR129/164 が同じ index.ts を変更するため runtime差分は作っていない。統合順と単一ownerはG1決定後。
- tests: model_test.ts 20件PASS（baselineのbypass実在、全リクエスト形×6非稼働状態でゲート時外向き副作用0・DB readは1回、稼働時は現行と同一、body上書き不可、50回retryで0、in-flight再確認、読取失敗で拒否、共有資源に触れない、negative control7種=入口gate削除/scheduled-only/dry-run除外/空候補app_copy除外/直接X除外/送信前再確認削除/per-effect再確認削除 すべて検出）。deno lint clean、deno check OK、git diff --check clean、secret scan clean。実handler・実network/DB/SDK・実環境変数は未使用。
- limits: 配備版未確認、設定値・対象集合・in-flight・通知キュー未再測定（本番read禁止）。モデルは実handlerの簡約でありPASSは設計の性質。
- changed_files: docs/operations/kabumori-pause/f8/{NEWS_HARD_PAUSE_DESIGN_20261015.md, mode_state_matrix.md}; tools/kabumori-pause/f8/{model.ts, model_test.ts, print_table.ts}; .agent_v2/tasks/F8.md（Report）; .agent_v2/ACTIVE_TASK.md（F8節のみ）
- design_commit: cd937637419b368dbe62d68aeea37475e62fd91b
- branch: claude/f8-news-hard-pause-design-20261015
- merge: not_performed
- deploy: not_performed
- remaining_issues: 実装未着手（別TASK・Opus5.5高→独立検証Sol高）。PR129/164統合順と単一owner、is_active意味統一の運用影響、許可リスト（pause_status/run行）の可否、observer/shadow用ゲート設計、Cron実コマンド/最大実行時間の確認、既enqueue通知の鮮度保留、共有publish_guardの所有者。
- safety_checks: supabase/・migration・設定・Cron・Secret・APIキー・共通AI provider/台帳/RPC/Auth・X/Push/実HTTP/外部API/課金・EASは不使用。PR129/164/181/185/191/196・F2/F3〜F7/F9/J1・既存archiveは不変更。他checkout/serverは未操作。
- next_recommendation: G1が本設計をF2設計と照合し、runtime候補の単一owner・PR統合順を決定→Opus5.5(高)でruntime候補→Sol(高)独立検証→本番直前read-onlyスナップショット→別の明示承認。かぶモリアプリG1のちゃへL8。
