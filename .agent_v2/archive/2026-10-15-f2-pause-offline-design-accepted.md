# F2 — かぶモリ休止：ブランド遮断・予約保留・共有配信保護のオフライン設計

- task_id: kabumori-f2-pause-delivery-brand-queue-offline-design-20261015
- owner: claude
- slot: F2
- status: review_required
- next_owner: chatgpt
- start_code: F2
- completion_code: L2
- return_to: かぶモリアプリG1のちゃ（運用休止・全体統括）
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F2.md
- current_report_path: .agent_v2/tasks/F2.md#report
- dependencies: docs/operations/kabumori-pause/G1_PLAN_20261015.md; F8 pause gate design; J1 common-AI review is separate/protected
- blocker: production NO_GO; deployed Dispatcher/brand mapping and current queue unverified; design-only
- production_mutation_window: FORBIDDEN
- previous_archive: .agent_v2/archive/2026-10-15-F2-kabumori-f2-topix-pr201-203-premerge-safety-corrections-20261015/
- previous_disposition: CANCELLED_UNSTARTED_BY_USER; TOPIX/market-quality development remains stopped
- assigned_checkout: /Users/yuya/.codex/.chatgpt-projects/g-p-6a8e60a4be3081918ef2c28c1b2cc386/kabumori-f2-pause-design-20261015
- assigned_branch: claude/f2-pause-delivery-design-20261015

## 目的

G1の休止準備のうち、かぶモリのXブランド遮断・予約保留・朝刊/大引け/Push停止順とPOSTONA/共通AI保護をオフライン設計する。F2は最新mainでidle/task_id:none、G1割当専用の予約済み枠。旧G2 TASKは移動・再開しない。本番停止・runtime実装の承認ではない。

正式開始は、PR207の管理差分がmainへ反映され、fresh origin/mainのTASKとtask_idが一致してから。branch上のreadyだけでは開始しない。main未反映中は登録候補として保留する。

## 開始ゲート・対象範囲

fresh origin/main、PROJECT_RULES/HANDOFF、新旧ACTIVE_TASK/CURRENT_STATE、F2/F8/J1 metadata、未処理L/V、PRのHEAD/base/paths、専用checkout/branch/clean状態を確認。別担当のcheckout/reset/rebase・未コミット変更・serverは触らない。競合や先行更新があれば上書きせずG1へ返す。

変更可：`docs/operations/kabumori-pause/f2/`、`tools/kabumori-pause/f2/` の設計・完全合成fixture・オフライン検証、F2 TASK/Report、完了時ACTIVE_TASKのF2節のみ。CURRENT_STATE/G1_PLANはG1が統合する。

読み取りのみ：x-test-post、_shared/brand、scheduled_posts schema/claim/retry、market-report consumer、Push producer/dispatcher、G6/F6/H5 caller/ledger、関連PR。

変更不可：商品runtime全体・migration、F8ニュース入口、F3/F4/F5 Auth/entitlement/saga、F6/H5/J1、F7/MIC、他TASK/Report・既存archive・既存PR/branch。保護PR201/203の修正・merge・deployを再開しない。

## 設計指示

1. `publish_guard.ts`と`x-test-post/index.ts`の全送信経路を列挙。予約claim前後、手動朝挨拶、朝刊/大引け/米国前、豆知識、交流、生成dry-run、retry、旧NULL brand_idの既存fallbackを調べ、publish_mode=disabledが保証する範囲を示す。important-news-monitorは独自X経路を持つためF8の入口/送信直前遮断を必須依存とする。
2. 本番Cron #1 dispatch-scheduled-postsのcommand/URL/header/呼出先/brand識別は今回repoだけでは未証明。同名Edgeディレクトリはない。将来のread-only snapshot項目を示し、実URL/jobid対応を推測しない。共通Dispatcherを残し、停止brand行で全batchが失敗/飢餓にならず他brandのclaim・retry・token refreshが進む条件を設計。
3. 引継ぎは豆知識4・交流1の予約計5件、ニュースready_for_publish37件。今回DB未再測定。固定ID・現在件数を作らず、実操作前はfresh snapshot必須。実schema/claim条件から可逆保留を比較し、未実在のheld statusを前提にしない。SQLは文書内の非実行テンプレートのみ、実行runnerは禁止。DELETE/無制限の未来延期は採らない。
4. ID/brand/status/version等の利用可能な競合条件、対象集合と件数driftでabort、claim済/in-flight、複数worker、停止中追加、反復保留、部分失敗、X応答不明時のblind retry防止を記載。POSTONA・会社員AIラボ・他brand変更0をread-backする。復旧時はgateを閉じたまま古い予約/ニュースを鮮度・cutover・再審査し、一斉投稿を防ぐ。
5. X遮断/in-flight確認→予約保留→ニュース全入口停止→市況caller/producer停止→通知producer停止の依存順を作る。market_report_consumer_settings.x_enabled=falseのみで旧AIへfallbackする可能性をソース照合し、先にX/AI caller遮断を要求。既enqueue済みPush/実行中通知を別残件にし、producer停止だけで完全停止としない。
6. G6/F6の最新main・関連PRから、かぶモリcallerとPOSTONA/shared callerのマップを作りG1へ返す。共通provider/AI台帳/RPC/認可・予算、OpenAI/Claude key、Supabase Auth/共通ID/entitlement、Cron #1 X Dispatcherと#9 Push Dispatcherを維持。POSTONAのX予約/Threads/Instagram/OAuth refreshを保護。APIキー削除で費用を止めない。J1 PR187→198→205のレビューを本停止のPASSに流用しない。

## オフライン検証

全I/Oをfake・合成データに限定し、実HTTP/DB/SDK自動送信/実SNS/Push/課金を禁止。最低限、かぶモリ/旧NULL brand/他brand/不正brand、off/on/設定読取失敗、5件＋他brand混在/件数drift、claim済/並行worker/停止中追加、反復保留/部分失敗/復旧/backlog、他brand batch継続、市況fallback、既存Pushキューを検証。モデルPASSと実runtime/本番証明を区別し、コマンド/結果/限界を記載。

## 完了条件・安全制約

経路表、停止/再開順、所有境界、snapshot/read-back/abort条件、共通AI保護、F8依存、合成検証と未確認事項を文書化。自己branchへcommit/push、新規Draft PRはdocs/tools/F2管理差分のみ。main merge・本番Cron/DB/Edge/Secret/APIキー変更、X/Push、実API/有料呼出/EASは禁止。production mutation windowを開かない。

Reportを更新しstatus:review_required / next_owner:chatgpt、G1へL2。本番停止GOを報告しない。後続runtime実装 Opus5.5（高）、独立検証 Sol（高）は成果物と競合確認後の別TASK。

## Report

- task_id: kabumori-f2-pause-delivery-brand-queue-offline-design-20261015
- result: **PASS_OFFLINE_DESIGN / PRODUCTION_NO_GO**（設計と合成検証だけ。本番の停止の GO ではない）
- 基準: main `d2309afc88388d441f75919c98e6ceeb22af8b70`
  - 割り当ての checkout は `38dc7af1…` から早送りした（差分は管理ファイル4コミットだけ）
- branch: `claude/f2-pause-delivery-design-20261015`（割り当ての checkout）
- PR: [#210](https://github.com/anohi-memories/kabumori/pull/210)。Draft、base main
- 設計の commit: `9d1efeb662c79e7d2cb0ac4254adfa7092279a54`
- changed_files（新規、docs/tools と F2 の管理差分だけ）
  - `docs/operations/kabumori-pause/f2/F2_PAUSE_DELIVERY_DESIGN_20261015.md`
  - `tools/kabumori-pause/f2/pause_model.ts`
  - `tools/kabumori-pause/f2/pause_model_test.ts`
  - `.agent_v2/tasks/F2.md`（この Report）
  - `.agent_v2/ACTIVE_TASK.md`（F2 の節だけ）
- 変えていないもの: runtime・migration・publish_guard・x-test-post・F8・他の担当のファイル。CURRENT_STATE と G1_PLAN は G1 が統合する
- tests: `deno test --no-config --deny-net --deny-env --deny-run --deny-write --allow-read tools/kabumori-pause/f2/pause_model_test.ts`
  - **16件 PASS**
  - わざと壊したモデル6種類で、どれも落ちることを確認（NULL を kabumori にしない／disabled を通す／失敗した行を pending に残す／in-flight を無視／再開で自動送信／`x_enabled=false` を許す）
  - `deno lint` 問題なし、`git diff --check` 問題なし、`git merge-tree` で main と衝突なし
- push: 自分の branch だけ ／ merge: not_performed ／ deploy: not_performed ／ 本番の DB・Cron・Edge・Secret・キー・X・Push・実 API・課金: 0

### 設計の要点（詳しくは設計の文書）

1. **遮断の境界**は、かぶモリのブランドの X ゲート（`assertBrandPublishAllowed`、publish_guard.ts:7-19）。
   - 予約の全経路（共通・旧来の朝刊と大引け、米国プレマーケット、豆知識、交流、tip、予約の挨拶、再試行）と、手動の挨拶が、claim の直後・トークンと生成の前に通る（x-test-post/index.ts:3985-3993、:3374）。
   - 保証しないもの
     - ニュースの X 公開（important-news-monitor の publish_ready はゲートなし → **F8 が必須**）
     - 判定の後の in-flight
     - planner による新しい行の作成
     - dry-run の生成の AI
2. **`x_enabled=false` / `app_enabled=false` は停止に使わない**。旧来の OpenAI の生成が復活するため（shared_market_report_consumer.ts:4、index.ts:4270-4290、personalized-reports shared_gate）。合成検証で確認した。
3. **共通 Dispatcher #1** の `claim_due_post` は、ブランドを区別せず最古の1行を取る。
   - ゲートで失敗した行は終端の failed（index.ts:4840-4866）で、再び取られない。
   - 他ブランドは飢餓にならず、遅れは期限の来たかぶモリの行の数の分だけ（合成検証: 最大5分）。
   - ブランドの表を読めない場合は全ブランドが fail closed になるので、休止の手段にしない。
   - Cron #1 の command・URL は repo に無い（未確認）。`claim_due_post` の本番の本体も未確認（20260905010000 の記載）。
4. **予約の保留**: 保留の状態は無い（status は4つ）。
   - 推奨は、B（planner の設定の `is_active=false`、元に戻せる）＋ A（既存の行はゲートで記録つきの失敗）。
   - 削除・架空の held・無制限の延期は採らない。
   - 中止の条件（`planHold`）: ブランドの表を読めない／ゲートがまだ開いている／running がある／承認した pending の id の集合とずれた（件数が同じ入れ替わりも含む）／他ブランドの pending の数の変化。
5. **止める順**（`stopOrderViolations` で検証）
   - snapshot → X ゲートを閉じる → in-flight の drain → 予約の保留 → F8 のニュースの遮断 → 一斉通知の sending→enabled → オンデマンドの受付 → 市況の Cron 28〜33 → MIC・news_discovery → 通知の待ち行列の判断 → POSTONA・台帳の読み戻し
   - 禁止: `x_enabled=false`、`app_enabled=false`、Cron #1・#9 の停止、キーの削除、共通の Cron の秘密の差し替え
6. **通知**: producer を止めても、#9 は source_type を問わず pending を送る（`pushStillSent`）。
   - 保留の状態は無い（pending/processing/sent/failed/skipped）。
   - 待ち行列は「送らせる」か「snapshot の id だけを skipped にする」かを G1 が決める。
   - POSTONA は Push を送らないので、#9 は止めない。
7. **共通 AI の caller の地図**
   - x-test-post は、かぶモリと POSTONA・AI Lab の生成が同じ関数の中にある（共通）。
   - `OPENAI_API_KEY` が無いと、claim の前に 500 になり、#1 全体が止まる（index.ts:3328-3332）→ キーで費用を止めない。
   - 共通の provider・台帳は止めない。J1 のレビュー（PR187→198→205）を、この休止の PASS に流用しない。
8. **再開**（`planResume`）: ゲートを閉じたまま、たまった分を鮮度で仕分ける。自動の一斉送信は無い。予約の古い行は再び取られない。

### remaining_issues（本番の読み取りで確かめる。設計の §7・§12）

- 配備版の x-test-post が main と一致するか（ゲートの位置）
- `claim_due_post` の本番の本体
- `brands` テーブルの DDL、`scheduled_posts.brand_id` / `social_account_id` の有無
- Cron #1 の command とブランドの扱い、jobid の対応（#5/#6 を含む）
- planner の設定のうち、かぶモリ専用のもの
- 通知・予約・ニュースの ready の今の件数（引継ぎの5件・37件・38本は今の値ではない）
- 長期停止後のかぶモリの refresh token
- `oauth_client_ref="default"` を使うアカウント
- 通知の待ち行列の扱いの決定

### safety_checks

- 本番への書き込み・読み取り・実 API・SNS・Push・課金: すべて0（今回は本番の読み取りもしていない）
- SQL は文書の中の実行しないテンプレートだけ。実行の runner は作っていない
- 保護された PR（201/203/204/205/206/198/187/196/129/164）・他の担当の checkout・未コミットの変更・server には触れていない
- 合成データだけを使用（実際の ID・件数・アカウントは無い）

### next_recommendation

1. G1 が F8 の設計と合わせて照合し、本番の read-only の snapshot（§7）の実施を判断する。
2. runtime の候補が必要か（例: planner へのブランドの判定、通知の待ち行列の扱い）を決め、別 TASK で単一の担当に割り当てる（推薦 Opus5.5（高））。
3. そのあとに、Sol（高）による独立のレビューを行う。

Return: **かぶモリアプリG1のちゃ（運用休止・全体統括）へ L2**
