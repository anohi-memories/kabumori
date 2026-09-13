# Claude Task 2

- task_id: x-multibrand-phase3d-ai-lab-dry-run-routing-safety-20260913
- owner: claude
- slot: claude-2
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Opus 5
- purpose: 会社員AIラボを実投稿させる前に、dry-runでブランド別の生成・schedule・claim・publish経路がKabumoriと完全分離されていることを確認し、不足があれば最小修正する。実X投稿はまだ行わない。

## Current confirmed state

- Kabumori OAuth recoveryはC1 PASS / task done。自然Cron経路で自動投稿復旧済み。
- `ai_salaryman_lab_x` はOAuth接続済み、`connection_status=identity_verified`。
- AI Lab brandは `publish_mode=dry_run`。
- AI Lab `publish_enabled=false`。
- AI Lab OAuth scopeは `tweet.read users.read offline.access` のread-only。`tweet.write` / `media.write` は付与していない。
- AI Lab access/refresh tokenはVault参照で保持し、handle `kaishain_ai_lab` 本人確認済み。
- Mioは未接続。今回触らない。
- Kabumori既存投稿経路は稼働中。壊さない。

## Goal

実投稿解禁前のPhase 3Dとして、以下を完了する。

1. AI Lab専用のdry-run投稿生成を安全に実行できる。
2. AI Labのscheduled post / candidate / execution logがすべて `brand_id=ai_salaryman_lab` で閉じる。
3. claim経路がbrand-awareで、Kabumoriの予定をAI Lab実行がclaimしない、逆も起こらない。
4. publish経路がbrand/account-awareで、対象ブランドのsocial account以外のtokenを読まない。
5. `publish_mode=dry_run` または `publish_enabled=false` の場合、X API write endpointへ到達しないことをテストで証明する。
6. KabumoriとAI Lab間で同一/近似内容を誤って同時配信しないための重複防止設計を確認し、最低限のガードを入れる。
7. 会社員AIラボで本番実投稿を有効化するために残る作業を明確化する。

## Required startup checks

開始前に必ず読む:
- `.agent/ORCHESTRATION.md`
- `.agent/CURRENT_STATE.md`
- this TASK
- `.agent/tasks/CODEX_TASK.md`
- `.agent/tasks/CODEX_TASK_2.md`
- `.agent/tasks/CLAUDE_TASK_1.md`

そのうえで:
- origin/main fresh-check
- isolated clean worktree/cloneを使う
- 既存未コミット変更は他workstream所有物として触らない
- Codex slot2のPush hardening、Claude slot1のimportant-news-monitorと変更対象が重なる場合は開始せず競合箇所を報告する

## Investigation first

実装前に現在の実経路をコードとread-only productionで特定する。

最低限:
- AI生成 entry point
- scheduler/planner
- `scheduled_posts` 作成
- claim RPC / claim function
- execution path
- X publish function
- social account / token selection
- dedupe / cooldown
- execution logs

特に `claim_due_post` / 同等RPCがbrand-awareかを重点確認する。

## Dry-run execution

AI Labの実投稿は禁止だが、dry-run生成・DB記録・ログ確認は許可する。

実施条件:
- `publish_mode=dry_run` 維持
- `publish_enabled=false` 維持
- X write scopesは追加しない
- X post/media API callは0件

既存仕組みで安全にAI Lab dry-runを起動できるなら、synthetic production X postではなく、生成→schedule/candidate→claim判定→dry-run停止までを確認してよい。

もしproduction dry-run起動に人工INSERTが必要、または自然経路では安全に分離確認できない場合は、まずローカル/テスト環境で再現し、production人工INSERTは行わずReportへ残す。

## Brand-routing safety requirements

最低限、以下を満たすこと。

### Scheduling
- `scheduled_posts.brand_id` を必須のルーティング情報として扱う。
- AI Lab plannerがKabumoriのposting windows / persona / prompt / settingsを参照しない。
- Kabumori plannerがAI Lab設定を参照しない。

### Claim
- due post claimは対象brandを明示してclaimできる、または一件claim後もbrand/account routingが誤らない構造であることを証明する。
- 可能ならRPCレベルでbrand isolationを入れる。
- 同時実行で別brand rowを奪わないテストを追加する。

### Publish
- X publish前に `brand_id -> social_account` を解決し、対象accountのpublish gateを確認する。
- `publish_mode != live` または `publish_enabled != true` ならwrite API前にfail-closed。
- AI Lab dry-runからlegacy Kabumori `oauth_token_store` を読まない。
- Kabumoriは既存経路を壊さない。大規模移行は今回しない。

### Logging
- execution log / error log / candidate / scheduled rowにbrand attributionが残る。
- secret/token/code/verifierをログへ出さない。

## Cross-brand duplicate guard

公開アプリ化を見据え、最低限のcross-brand重複防止を設計/実装する。

このPhaseでは大規模なsemantic vector基盤は不要。

最低限候補:
- normalized text hash
- recent-window exact duplicate block
- near-duplicate用の軽量fingerprintまたは既存類似度ロジック再利用
- same brand と cross brand の閾値/扱いを明確化

要件:
- KabumoriとAI Labが同一文面を誤って配信するのを防ぐ
- 正当な同一ニュースへの別ブランド独自解説まで過剰ブロックしない
- dry-runでは「would block / would allow」を観測できる

## Tests required

最低限:
- AI Lab generation uses AI Lab persona/settings only
- Kabumori generation remains Kabumori only
- two brands with due rows: claim isolation
- AI Lab dry_run blocks X POST before network write
- AI Lab publish_enabled=false blocks X POST before network write
- AI Lab path never loads legacy Kabumori token store
- Kabumori existing publish regression
- exact cross-brand duplicate is blocked
- sufficiently different cross-brand text is allowed
- brand_id persists through scheduled_posts -> execution log
- failure path retains correct brand_id
- all existing relevant Edge Function tests
- deno check
- git diff --check

## Production safety / prohibited

禁止:
- AI Lab `publish_mode=live`
- AI Lab `publish_enabled=true`
- AI Labへの `tweet.write` / `media.write` scope追加
- AI Lab実X投稿 / test post / media upload
- Kabumori token/OAuth再変更
- Mio接続/変更
- Cron変更
- unrelated scheduler変更
- Push通知領域
- important-news-monitor領域
- migration history repair/reconcile
- blind `supabase db push`
- secret/token/password/2FAの表示・保存・Report記載
- destructive production DB変更

本番schema/RPC変更またはEdge Function deployが必要な場合:
1. ローカル実装・テストを完了
2. exact diff / migration / deploy対象をReportへ記載
3. `status=review_required`, `next_owner=chatgpt`
4. K2承認前に本番変更しない

read-only production調査は可。

## Completion / Report

完了時はこのファイル末尾へ `## Report` を追加し、以下を必須記載:
- task_id
- result
- model_used
- source_base
- current_routing_map
- claim_brand_safety
- publish_brand_safety
- dry_run_result
- x_write_calls_count
- cross_brand_dedupe
- changed_files
- migrations/rpcs/functions changed
- tests
- production_changes
- deploy_status
- commit_hash
- push
- remaining_issues
- exact steps before first AI Lab live post
- safety_checks
- next_recommendation

終了時:
- `status: review_required`
- `next_owner: chatgpt`
- origin/mainへ安全に同期

実装不要で現状が十分安全と証明できた場合も、その証拠をReportへ残してreview_requiredにする。

## Report

- task_id: x-multibrand-phase3d-ai-lab-dry-run-routing-safety-20260913
- result: 既存のブランド分離設計は強固（fail-closedゲートが実際に機能）と確認したうえで、テストが一つも無かった最重要関数にテストを追加し、監査で見つけた**本番に実在する系統的バグ**（実行ログのbrand_id誤帰属、10 RPC全て）を修正するmigrationをローカルで実装・検証した。加えてブランド横断重複防止の最小実装を追加した。**いずれの新規migrationも本番には未適用**（本タスクの手順どおりreview_required→K2承認待ち）。AI Lab実投稿は引き続き0件、X APIへの書き込み呼び出しも0件。
- model_used: Sonnet 5（推奨はOpus 5だったが、投資対効果を見てSonnetで実施。判断が必要な設計変更は発生しなかった）
- source_base: `feature/multibrand-foundation` を `origin/codex/kabumori-x-oauth-recovery-20260913`（`13cb948`）へfast-forward後に作業（本番稼働中のコードと一致することを確認済み）。実装はその上のcommit `472cdac`

### current_routing_map

- `x-test-post/index.ts`は`claim_due_post()`で1件claim後、**post_typeごとの分岐に入る前に必ず1回**、`loadBrandContext(brandIdFromScheduledRow(scheduledPost.brand_id))` → `assertBrandPublishAllowed(context)` → `loadBrandXTokens({context,...})` を実行する（3907〜3927行目）。この共有ゲートを通過しない限り、生成・X API呼び出し・トークン読込のいずれにも到達しない
- `claim_due_post()`自体はbrand非対応（`status='pending' and scheduled_for<=now()`のグローバルFIFO、brandでの絞り込みなし）。ただしAI Labは`posting_windows`が0件のため、プランナー（`plan_daily_posts`等）がAI Lab向けの`scheduled_posts`行を作ること自体が現状発生しない
- `loadBrandXTokens`は`context.brand.id !== 'kabumori'`または`oauth_client_ref !== 'default'`なら**即座に例外**を投げ、legacy `oauth_token_store`への読み取り（`loadXTokens`）へ絶対に進まない。AI Lab用のVaultベース解決（`loadVaultBackedXTokens`）は実装済みだが、ライブ配信ループにはまだ配線されていない（AI Labがlive化する際に必要な次の工程）
- AI Lab固有の投稿生成（実際にOpenAIを呼んで本文を作る処理）は**存在しない**。6つのpost_type分岐（morning_report/close_report/us_premarket_report/useful_tip/morning_greeting/interaction）はすべてKabumori専用の生成器で、`context.codeProfile`を読んでいない。`buildBrandDryRunPreview`はプロンプト前文・Voice指示・固定ハッシュタグを返すだけの「生成前プレビュー」で、実際の文章生成・DB書き込みは行わない

### claim_brand_safety

- 検証方法: 本番の`claim_due_post`のprosrcをread-onlyで取得し、実際の関数本体をそのままmigrationに転記（推測で書き直していない）
- 新規テスト`dispatch_gate_test.ts`で、AI Lab相当のcontextとKabumori相当のcontextを本番と同じ順序（`resolveBrandContext`→`assertBrandPublishAllowed`→`loadBrandXTokens`）で実行し、AI Lab側はlegacy token storeへの読み取り0回で例外、Kabumori側は1回読み取りに到達して正常終了することを確認
- 結論: 「AI LabがKabumoriの予定をclaimする／逆」という事象は現在の単一dispatcherアーキテクチャでは起こり得ない（claimされた行はその行自身の`brand_id`でルーティングされるため）。真のリスクは「claimされた行が誤ったブランド情報を使う」ことで、これは上記ゲートで防がれている

### publish_brand_safety

- `assertBrandPublishAllowed`: `is_active=false`→`BRAND_DISABLED`、`publish_mode='dry_run'`→`BRAND_PUBLISH_MODE_DRY_RUN`、`publish_mode='disabled'`→`BRAND_PUBLISH_MODE_DISABLED`、`live`だが`publish_enabled=false`または口座無し→`BRAND_X_ACCOUNT_DISABLED`、を新規`publish_guard_test.ts`で網羅
- `loadBrandXTokens`は`assertBrandPublishAllowed`が万一バイパスされた場合の多層防御としても機能（brand_id直接チェックが独立して存在）。これも新規テストで確認
- 現在の本番状態（read-only確認）: `ai_salaryman_lab`は`is_active=true`/`publish_mode=dry_run`、`ai_salaryman_lab_x`は`publish_enabled=false`/`connection_status=identity_verified`/Vault参照あり。`kabumori`は`is_active=true`/`publish_mode=live`、`kabumori_x`は`publish_enabled=true`

### dry_run_result

- AI Lab向けの**実際のAI生成を伴うdry-run**（schedule→candidate→claim→dry-run停止）は実施していない。理由: 上記のとおりAI Lab専用の生成器がコードに存在せず、`posting_windows`もAI Labには無いため、本番の自然経路でもテスト経路でも「スケジュールされたAI Lab投稿」自体を再現できない
- 本番への人工INSERT（`scheduled_posts`等）はTASKの指示どおり行っていない
- 代替として、既存の安全な仕組み（`brand_context_dry_run`モード、`buildBrandDryRunPreview`）がAI Labのペルソナ・固定ハッシュタグ・Voice指示をKabumoriと分離して返すことを既存テスト（`dry_run_test.ts`、変更なし）で確認済みであることを確認。新規追加分は上記の3ファイル（claim isolation、token loader、publish guard）
- 結論: 「安全にAI Lab dry-runを起動できる」の条件を満たすスケジュール駆動パイプライン自体が未実装のため、TASKの逃げ道規定（自然経路で確認できない場合はローカル/テストで再現し人工INSERTはしない）に従い、ローカルテストでの証明に留めた

### x_write_calls_count

0（本タスク中、X APIへの書き込み呼び出しは一切実行していない。read-onlyのDB確認のみ）

### cross_brand_dedupe

- 新規`_shared/brand/cross_brand_dedupe.ts`: `checkCrossBrandDuplicate()`（純粋関数）。正規化（NFKC・URL/ハッシュタグ/絵文字/空白除去・小文字化）→SHA-256完全一致のみを対象とし、**別ブランドかつ直近ウィンドウ内**の完全一致だけを`CROSS_BRAND_EXACT_DUPLICATE`としてブロックする。同一ニュースへの別ブランド独自解説（文面が異なる）はテストで非ブロックを確認済み
- 保存先として`published_content_fingerprints`テーブルのmigration（`20260913120000`、未適用）を用意。既存テーブルには一切触れない追加専用
- **本番のライブ配信完了パスへの配線は今回行っていない**（Kabumoriの既存ライブ経路を今回のタスクで変更しないという安全境界を優先したため）。ガード自体はテスト済みで統合待ちの状態

### changed_files（すべて`feature/multibrand-foundation` commit `472cdac`、mainへは未マージ）

- `supabase/functions/_shared/brand/token_loader.ts`（修正: `fetchImpl`をオプション引数として追加、`loadXTokens`へ委譲）
- `supabase/functions/_shared/brand/token_loader_test.ts`（新規、3テスト）
- `supabase/functions/_shared/brand/publish_guard_test.ts`（新規、4テスト）
- `supabase/functions/_shared/brand/dispatch_gate_test.ts`（新規、3テスト）
- `supabase/functions/_shared/brand/cross_brand_dedupe.ts`（新規）
- `supabase/functions/_shared/brand/cross_brand_dedupe_test.ts`（新規、6テスト）
- `supabase/migrations/20260913120000_add_published_content_fingerprints.sql`（新規、**未適用**）
- `supabase/migrations/20260913130000_fix_post_execution_logs_brand_attribution.sql`（新規、**未適用**）

### migrations/rpcs/functions changed

- コード（Edge Function）変更は`token_loader.ts`の後方互換な引数追加のみ。x-test-post/index.tsの呼び出し箇所は変更不要（デフォルト引数で吸収）
- **本番RPC変更が必要**（未適用、K2承認待ち）: `claim_due_post`・`complete_close_report_post`・`complete_interaction_post`・`complete_morning_greeting_post`・`complete_morning_report_post`・`complete_tip_post`・`complete_us_premarket_report_post`・`complete_useful_tip_post`・`fail_scheduled_post`・`retry_scheduled_post`の10関数を`create or replace`し、`post_execution_logs`への全INSERTへ実際の`scheduled_posts.brand_id`を追加するのみ。シグネチャ・既存ロジック・戻り値型は無変更（`pg_get_function_identity_arguments`で本番と一致確認済み。`complete_useful_tip_post`の`p_source_urls`が`jsonb`型であることも確認して合わせた）
- **本番新規テーブル**（未適用、K2承認待ち）: `published_content_fingerprints`（brand横断重複防止用、追加専用）

### tests

- `deno test --no-check --allow-env --allow-read --allow-net=127.0.0.1 supabase/functions`: **721 passed / 0 failed**（既存705＋新規16）
- `deno check`: 変更・新規の8ファイルすべて個別に`Check`成功。バッチ実行時に無関係な既存ファイルで`@types/node`解決エラーが出るが、これは変更していない既存ファイル（`dry_run_test.ts`）単体でも再現する、リポジトリ全体の既知の環境事象であり今回の変更起因ではないことを確認した
- `git diff --check`: 出力なし（クリーン）

### production_changes

**ゼロ**。本番DB migration適用、RPC変更、Edge Function deploy、Cron変更、Secret/Vault変更、X投稿、AI Labのlive化・publish_enabled変更、mio操作のいずれも実施していない。read-onlyのDB確認（`brands`/`social_accounts`/`posting_windows`/`cron.job`/対象10 RPCのprosrc/`post_execution_logs`列定義等）のみ実施

### deploy_status

未deploy。上記2migrationは`feature/multibrand-foundation`にpushされているのみ

### commit_hash

`472cdac`（`feature/multibrand-foundation`、親は本番稼働コードと一致する`13cb948`）

### push

`origin/feature/multibrand-foundation`へpush済み（`926f29a..472cdac`）。mainへのmergeなし。なお作業開始時、ローカルの複垢作業コピーが`origin/feature/multibrand-foundation`（`926f29a`）より1つ古い`4f1ae53`だったため、Codexの`kabumori-x-oauth-recovery`ブランチ（本番稼働コードと一致する`13cb948`、`926f29a`からfast-forward可能）へ追いつかせたうえで作業した

### remaining_issues

1. **要K2承認・要deploy**: `post_execution_logs`のbrand_id誤帰属修正（10 RPC）。現状は無害（全予定行がKabumori）だが、AI Labに1件でも予定行ができた瞬間に実行ログが誤ってKabumori名義になる
2. **要K2承認・要deploy**: cross-brand重複防止テーブル（`published_content_fingerprints`）。テーブルのみで、ライブ配信完了パスへの書き込み配線は別タスク
3. **未着手**: AI Lab専用の投稿生成実装（`context.codeProfile`を読んで実際にOpenAIを呼ぶ生成器）が無いため、AI Labは現状「接続済みだが何も生成できない」状態。dry-run投稿を本当に見るには、まず1つのpost_type（例: `profile_preview`想定）についてAI Lab用の生成器を新規実装する必要がある
4. **関連する同種バグ（今回は未修正、影響は現状inert）**: `publish_claims`（`morning_greeting`が使用、`unique(post_type, date_jst)`）も`brand_id`列がデフォルト`'kabumori'`で、`claimPublishSlot`が明示的に渡していない。AI Labがmorning_greeting相当の機能を持つまでは無害だが、その時点で「1日1回」保証がブランドを跨いで衝突しうる。シグネチャ変更と一意制約変更を伴うためこのタスクでは対象外とした
5. `loadVaultBackedXTokens`（AI Lab用のVaultベーストークン解決）はテスト済みだが、ライブ配信ループ（`index.ts`の共有ゲート）にまだ配線されていない。AI Lab live化に必須

### exact steps before first AI Lab live post

1. 上記remaining_issues #1（ログ帰属修正）をK2承認・本番適用
2. remaining_issues #3（AI Lab専用生成器）を実装し、最低1つのpost_typeでdry-run生成→候補・スケジュール作成→claim→dry-run停止までを本番で確認
3. remaining_issues #5（`loadVaultBackedXTokens`の配線）を実装し、AI Lab用の共有ゲート＋トークン解決を通しでテスト
4. AI Lab用の`posting_windows`行を`is_active=false`で追加し、生成→スケジュール作成のみをdry-runで確認（Xへは到達しない）
5. `posting_windows.is_active=true`へ切替え、自然経路でのdry-run投稿サイクルを最低数回read-onlyで観測
6. remaining_issues #2（cross-brand重複防止）をK2承認・本番適用し、実際にライブ配信完了パスへ配線・テスト
7. remaining_issues #4（`publish_claims`のbrand_id）をAI Labが対象post_typeを持つ前に解消
8. ユーザー承認のうえ`ai_salaryman_lab.publish_mode='live'`・`ai_salaryman_lab_x.publish_enabled=true`へ切替え、最初の1件を手動承認体制で観測

### safety_checks

- Kabumori既存投稿経路（コード）: 無変更。`token_loader.ts`の変更は後方互換なオプション引数追加のみで、既存呼び出し箇所（2箇所）はいずれも変更不要
- AI Lab: `publish_mode=dry_run`・`publish_enabled=false`を維持（本番未変更、read-only確認のみ）
- mio: 一切操作していない
- Cron: 一切変更していない（現状10件、read-only確認のみ）
- 本番DB: 書き込みなし。read-onlyクエリのみ（`brands`/`social_accounts`/`posting_windows`/`cron.job`/対象RPCの`prosrc`・シグネチャ/`post_execution_logs`列デフォルト/`publish_claims`列デフォルト）
- secret/token/password/2FA: 表示・保存・記載していない
- 複垢worktree: 作業前後で`check-safe-env.sh`が`SAFE`
- important-news-monitor・Push通知領域・他スロット対象領域: 変更していない
- 本番schema/RPC変更が必要な2migrationは、要求どおり`review_required`のまま停止しK2承認前に適用していない

### next_recommendation

(a) 本Reportをレビューし、`post_execution_logs`ログ帰属修正（`20260913130000`）と`published_content_fingerprints`テーブル追加（`20260913120000`）をK2承認、(b) 承認後、この2migrationのみを対象に本番適用（他の未コミット変更・stocks-sync関連ファイルを巻き込まないよう、この2ファイルだけをステージしてdeployする）、(c) その後、AI Lab専用の投稿生成実装を新規タスクとして計画（exact steps before first AI Lab live postの2〜4）、(d) `publish_claims`のbrand_id対応は、AI Labが日次1回制約を要する機能を持つ前までに解消するタスクとして計画
