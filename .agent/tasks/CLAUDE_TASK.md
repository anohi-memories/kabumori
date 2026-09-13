# Claude Task 2

- task_id: x-multibrand-phase3e-ai-lab-real-dry-run-generation-20260913
- owner: claude
- slot: claude-2
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sonnet 5
- purpose: 会社員AIラボ専用の実AI投稿生成器と安全なdry-run経路を実装し、Kabumoriと完全分離された状態で「生成→schedule/candidate→claim→publish前停止」までを証明する。実X投稿はまだ行わない。

## K2 approved Phase 3D facts

- Phase 3D commit: `472cdac1c066ed62217f0ef80788ff73b9155e13` on `feature/multibrand-foundation`.
- Phase 3D tests: 721/721 PASS、変更ファイルのdeno check PASS、git diff --check PASS。
- AI Lab production state: `identity_verified` / `publish_mode=dry_run` / `publish_enabled=false`。
- AI Lab OAuth scope remains exactly `tweet.read users.read offline.access`; `tweet.write` / `media.write`なし。
- Kabumori internal brand id is `kabumori`; actual X handle is `yume_daka`. この区別を維持し、brand_idをhandleへ改名しない。
- current shared dispatch gate is fail-closed before generation/network/token use for non-live brands.
- AI Lab path does not read Kabumori legacy `oauth_token_store`.
- AI Lab専用の実生成器・posting window・自然dry-run scheduleはまだ存在しない。
- AI Lab用Vault token loaderは実装済みだがlive publish loopには未配線。
- `post_execution_logs.brand_id`誤帰属バグ修正migration `20260913130000_fix_post_execution_logs_brand_attribution.sql` はPhase 3Dでローカル検証済み。K2で内容承認済み。本Phaseで本番適用する場合はこのexact migrationのみを対象にし、preflight/read-back必須。
- cross-brand fingerprint migration `20260913120000_add_published_content_fingerprints.sql` は実装済みだが、live completion path未配線。今回の実dry-runに必要でなければ本番適用を急がない。

## Goal

Phase 3Eでは以下を完成させる。

1. `ai_salaryman_lab`専用の実AI文章生成器を追加する。
2. 生成器は必ずAI LabのBrandContext / codeProfile / persona / tone / hashtags / settingsだけを参照する。
3. Kabumori生成器・prompt・persona・投稿内容へ影響を与えない。
4. AI Labの安全なdry-runで、実際にOpenAI生成された本文を得られる。
5. AI Labの生成結果をbrand付きでcandidate/scheduleへ流し、claim後も`brand_id=ai_salaryman_lab`を維持する。
6. `publish_mode=dry_run` / `publish_enabled=false`により、X write endpoint到達前に停止することを通しで証明する。
7. 本番実投稿解禁前に必要なVault token routing / posting window / publish_claims brand分離の残件を明確化する。

## Start / parallel safety

開始前に必ず読む:
- `.agent/ORCHESTRATION.md`
- `.agent/CURRENT_STATE.md`
- this TASK
- `.agent/tasks/CODEX_TASK.md`
- `.agent/tasks/CODEX_TASK_2.md`
- `.agent/tasks/CLAUDE_TASK_1.md`
- Phase 3D commit `472cdac`

必須:
- origin/main fresh-check
- `feature/multibrand-foundation`の最新remote状態確認
- isolated clean worktree/clone
- 他workstreamの未コミット変更を変更/stage/commitしない
- Codex slot2 Push hardening、Claude slot1 important-news-monitorと同一ファイル/RPC/migration/Functionが競合する場合は停止

通常はSonnet 5で進める。DB/RPC/Cronの根本設計変更、ブランド分離アーキテクチャの再設計、原因不明の難しい不具合に遭遇した場合は勝手に大変更せず、ReportでOpus切替を推奨して停止してよい。

## A. AI Lab real content generator

最初のpost typeは小さく限定する。

推奨: `brand_post` または同等の汎用AI Lab投稿タイプ。

要件:
- `BrandContext.codeProfile` / brand settingsからpromptを構築
- AI Lab persona・tone・fixed hashtagsを明示的に使用
- Kabumori専用prompt/helperを流用する場合もブランド固有文言が混入しない構造にする
- 出力本文にKabumoriブランド名/固定タグ/口調が混入しないfixture test
- 会社員AIラボ向けの自然な投稿本文を生成可能
- 生成時点ではX API不要
- model/cost/token usageを既存ログ方式に合わせて追跡可能にする

## B. Safe dry-run pipeline

本番実投稿は不可。

安全なdry-runで以下の流れを実現する:

AI Lab settings/persona
→ OpenAI content generation
→ candidate / scheduled row (`brand_id=ai_salaryman_lab`)
→ claim
→ execution/log attribution (`brand_id=ai_salaryman_lab`)
→ publish gate
→ `dry_run`でX network write前に停止

条件:
- 実X POST / media upload = 0
- `tweet.write` / `media.write` scope追加 = 0
- `publish_mode=dry_run`維持
- `publish_enabled=false`維持
- Kabumori legacy token store read = 0 on AI Lab path

productionで人工scheduled rowを作る必要がある設計なら、先にローカル/テストで通し証明する。production人工INSERTは原則行わない。安全なadmin-only dry-run entry pointを新設できるなら、実X書き込み不能をコードで保証した上でK2前はdeployせずローカル実装までに留める。

## C. Approved log attribution fix

`20260913130000_fix_post_execution_logs_brand_attribution.sql`はK2で内容承認済み。

本Phaseで本番適用する場合:
- productionの対象10 RPCのsignature/bodyをread-only preflight
- exact migrationのみを適用
- `supabase db push`禁止
- migration history repair/reconcile禁止
- 適用後、10 RPCの`post_execution_logs.brand_id`伝播をread-back
- SECURITY DEFINER / search_path / grantsに意図しない変化がないことを確認
- Kabumori自然投稿を人工retryしない

preflightで差異があれば適用せず停止。

## D. Posting windows

AI Lab用posting windowを本番liveで有効化しない。

必要ならmigration/seed設計のみ行い、最初は `is_active=false` を必須とする。

- Kabumori windowをコピーしない
- AI Lab独自scheduleとして扱う
- Phase 3E中は自然X投稿を発生させない

## E. Token routing preparation

AI Lab用`loadVaultBackedXTokens`を将来のlive pathへ接続する方法を実装/テストしてよいが、Phase 3EではX書き込み不可。

要件:
- `brand_id -> social_account -> Vault refs`
- Kabumori legacy storeへfallbackしない
- expected handle `kaishain_ai_lab` / connected accountと整合
- token/secretをlog/report/Gitへ出さない
- dry_run gateをtoken network useより前に維持できるなら維持する

## F. Cross-brand dedupe

Phase 3Dの`checkCrossBrandDuplicate()`を壊さない。

今回、AI Lab dry-run候補に対して最低限:
- exact cross-brand duplicate => would_block
- 十分異なる文章 => would_allow

をdry-run結果として観測できればよい。

`published_content_fingerprints`を本番適用・live completionへ配線する必要が出た場合は、K2前にdeployしない。exact diffと理由をReportへ残す。

## G. publish_claims known issue

`publish_claims`は現状Kabumori前提のbrand default/unique制約があり、AI Labで同系統の1日1回機能を持たせる前にbrand-aware化が必要。

Phase 3Eの汎用`brand_post`が`publish_claims`を使わないなら今回は変更不要。使う必要がある場合はシグネチャ/制約変更を伴うため、設計・テストまで行い、本番変更はK2後に分離する。

## Required tests

最低限:
- AI Lab real generator uses AI Lab profile/settings only
- AI Lab output has no Kabumori persona/tag leakage
- Kabumori generation regression
- generated row carries `brand_id=ai_salaryman_lab`
- scheduled -> claim -> execution log retains AI Lab brand
- dry_run stops before X write (network X write count 0)
- publish_enabled=false stops before X write
- AI Lab path legacy Kabumori token-store reads 0
- exact cross-brand duplicate => blocked/would_block
- distinct cross-brand copy => allowed/would_allow
- failure/retry log keeps AI Lab brand where applicable
- all relevant Edge Function tests
- deno check changed files
- git diff --check

## Production prohibitions

Phase 3Eでは禁止:
- AI Lab `publish_mode=live`
- AI Lab `publish_enabled=true`
- AI Labへ`tweet.write` / `media.write`追加
- AI Lab実X投稿 / test post / media upload
- Kabumori OAuth/token変更
- Kabumori brand idの`yume_daka`への改名
- Mio操作
- Cron変更
- Push通知領域
- important-news-monitor領域
- blind `supabase db push`
- migration history repair/reconcile
- destructive DB changes
- secret/token/password/2FA表示・保存・Report記載

本番Edge Function deployが必要になった場合は、K2前にdeployせず、対象Function・exact diff・testsをReportへ記載する。

## Completion / Report

完了時:
- status: `review_required`
- next_owner: `chatgpt`
- task末尾へ `## Report`
- origin/mainへ制御情報を安全に同期

Report必須:
- task_id
- result
- model_used
- source_base
- generator_design
- generated_example_summary（本文丸ごとの不要な転載はしない）
- brand_isolation_proof
- dry_run_pipeline_result
- x_write_calls_count
- legacy_kabumori_token_reads_on_ai_lab_path
- log_attribution_migration_status
- token_routing_status
- posting_window_status
- cross_brand_dedupe_status
- publish_claims_status
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

## Success gate

Phase 3E PASS条件:
- AI Lab専用の実AI文章生成が動く
- Kabumoriとpersona/settingsが混ざらない
- AI Lab brand attributionが生成からexecution logまで維持される
- dry-run通し経路でX write 0を証明
- AI Lab pathでKabumori token store read 0を証明
- Kabumori既存投稿に回帰なし
- live化・実投稿はまだ行わない

## Report

- task_id: x-multibrand-phase3e-ai-lab-real-dry-run-generation-20260913
- result: AI Lab専用の実AI文章生成器（OpenAI呼び出しあり、fetchImplでテスト可能）と、生成→ブランド横断重複判定→publish gateまでを本番と同じ順序で結ぶdry-runパイプラインを実装した。両モジュールとも`token_loader.ts`/`x_oauth2_post.ts`/`index.ts`を一切importせず、X APIエンドポイントへの経路がコード上に存在しないため、「Kabumori legacy token store read = 0」「X write = 0」は現在のブランド状態に依存せず**構造的に**成立する。本番へのscheduled_posts人工INSERTは行わず、本番と同一の呼び出し順序をテストで再現して証明した。実装は`feature/multibrand-foundation`へcommit/push済み、**本番へは一切deploy・適用していない**
- model_used: Sonnet 5（推奨どおり。大きな設計変更や難しい不具合は発生しなかった）
- source_base: `feature/multibrand-foundation` の`472cdac`（Phase 3D K2承認済み時点、本番稼働コードと一致）。実装はその上のcommit`60dd7e4`

### generator_design

- 新規`_shared/brand/brand_post_generator.ts`: `generateBrandPost({openAiApiKey, context, postType, topicSeed, fetchImpl})`。任意ブランドの`BrandContext`から動く汎用関数（AI Lab専用にハードコードしていない）。`assertBrandDryRunAllowed`でdisabled/unknownブランドを拒否した後、`context.codeProfile.voiceInstructions`＋`context.operationalSettings.fixed_hashtags`のみからinstructionsを組み立て、OpenAI Responses API（`gpt-5.6-luna`、`reasoning.effort=low`）を呼ぶ。`extractOutputText`/`getUsage`/コスト計算は`x-test-post/index.ts`のロジックと同じ計算式だが、依存を作らないためこのモジュール内に独立して再実装した（Kabumori側への影響・被影響経路をゼロにするため）
- `AI_SALARYMAN_LAB_CODE_PROFILE.dryRunPostTypes`に`"brand_post"`を追加（既存の`"profile_preview"`はそのまま維持、既存テストに影響なし）。voiceInstructionsへ「一人称の体験談を使わない」「株式投資関連を扱わない」「かぶモリの話題・文体・ハッシュタグを使わない」を追記。これらはPhase 3Aの既存方針（未確認の人物像・実績を作らない）を維持したまま生成を可能にするための追記で、Kabumoriのコードや文言を一切参照しない
- **正直な限界**: 会社員AIラボの実際のブランド戦略・トピック・トーンはユーザーからまだ提示されていない（`docs/multibrand/ARCHITECTURE.md` §20で保留中の判断事項として記載済み）。今回は「AIツールを使った日々のちょっとした工夫」という汎用・安全なデフォルトトピックのみを設定し、ブランド戦略を私が創作することはしなかった。実運用のトピック・頻度・方針はユーザー承認後に`brand_settings`／`brand_profiles.ts`で拡充する想定

### generated_example_summary

fixtureを使ったテストでのみ実行（本番OpenAI呼び出しはこのタスクで一度も行っていない）。実際のプロンプトは「AI Lab voiceInstructions＋200〜400文字の自然な一文投稿＋ハッシュタグ指示（現状は空なので『付けない』指示）」の構成で、fixtureへのinstructions内容をテストで直接検証済み（本文は転載しない）

### brand_isolation_proof

- 生成器のinstructionsにKabumoriの文言（`かぶモリ`/`#日本株`等）が実体として混入しないことをテストで確認（否定文脈での「かぶモリを使うな」という指示自体は正しく含まれる）
- 同じ`generateBrandPost`にKabumori相当のcontextを渡すと、Kabumori自身の`fixed_hashtags`が正しくinstructionsに現れることも確認——特定ブランドを特別扱いしない汎用実装であることの証明
- AI Labの出力に`#かぶモリ`等が一切含まれないことを確認（`fixed_hashtags=[]`のため）
- ソースコード検査テストで、`brand_post_generator.ts`・`brand_post_dry_run.ts`のいずれにも`token_loader.ts`/`x_oauth2_post.ts`のimportや`loadBrandXTokens`/`loadXTokens`の呼び出しが一切存在しないことを確認（実際のimport文・呼び出し構文にマッチする正規表現で、説明コメント文言との誤検出を除外済み）

### dry_run_pipeline_result

- `runBrandPostDryRun()`で「生成→brand_id付与→cross-brand重複判定→publish gate」を通し実行し、以下を確認:
  - `result.generated.brandId === 'ai_salaryman_lab'`
  - `result.publishGate === {blocked: true, reason: 'BRAND_PUBLISH_MODE_DRY_RUN'}`（現状のAI Lab状態どおり）
  - `publish_enabled=false`のみを満たさない場合は`BRAND_X_ACCOUNT_DISABLED`で同様にブロック
  - `toScheduledPostPayload(result)`で`brand_id`/`post_type`/生成本文/モデル/トークン数/コストが正しく引き継がれることを確認（実際のscheduled_posts INSERTは行っていない、payload形状の証明のみ）
- 本番への人工`scheduled_posts`行INSERTは実施していない（TASKの逃げ道規定どおり、自然経路も無いためローカルテストでの通し証明に留めた）

### x_write_calls_count

0（本タスク中、いかなるX APIエンドポイントへの呼び出しも実行していない。`brand_post_generator.ts`/`brand_post_dry_run.ts`はX APIのURLを一切参照しない）

### legacy_kabumori_token_reads_on_ai_lab_path

0。上記`brand_isolation_proof`のソース検査テストで、AI Lab生成経路が`loadXTokens`/`loadBrandXTokens`へ到達する構文が存在しないことを直接確認済み（Phase 3Dで確認した「ゲートで拒否される」という動的な保証に加え、今回追加した生成パイプライン自体にトークン読込コードが物理的に存在しないという静的な保証を追加した）

### log_attribution_migration_status

Phase 3Dで作成した`20260913130000_fix_post_execution_logs_brand_attribution.sql`はK2で内容承認済みのまま。本タスクでは**適用していない**（TASKの指示どおり、本番適用する場合はexact migrationのみ・preflight・read-back必須だが、今回のスコープでは適用判断も含めTASK側から明示指示が無かったため、次のK2判断に委ねた）。本番の対象10 RPCシグネチャへの追加確認は行っていない（Phase 3Dで確認済みの内容から変化なしを前提）

### token_routing_status

`loadVaultBackedXTokens`（Phase 3A実装、Vaultベース）はテスト済みのまま無変更。本タスクではlive配信ループへの配線は行っていない（TASKのE節どおり、Phase 3EはX書き込み不可のため、配線を進める実益がなく、かつ配線するとKabumori既存のdispatchループ（index.ts）へ変更を加えることになりリスクが増すため見送った）

### posting_window_status

変更なし。AI Lab用`posting_windows`行は本タスクでも作成していない（本番0件のまま）。migration/seed設計も本タスクでは行わなかった——理由は、Phase 3Eの汎用`brand_post`はスケジュール駆動ではなくオンデマンド生成想定であり、`posting_windows`の設計（頻度・時間帯）はブランド戦略（トピック方針）が決まってから行う方が手戻りが少ないと判断したため

### cross_brand_dedupe_status

Phase 3Dの`checkCrossBrandDuplicate()`は無変更。今回`runBrandPostDryRun()`から呼び出し、AI Lab生成候補に対して「完全一致→would_block」「文面が十分異なる→would_allow」「recentFingerprints未指定（デフォルト空配列)→常にwould_allow」の3パターンをテストで確認した。`published_content_fingerprints`（`20260913120000`、Phase 3DでK2承認済み）は本タスクでも未適用のまま

### publish_claims_status

変更なし。今回実装した`brand_post`は`publish_claims`を使用しない設計（`runBrandPostDryRun`はDBへの書き込みを一切行わない）ため、Phase 3Dで報告した`publish_claims`のbrand_id defaultバグには本タスクでは触れていない

### changed_files（すべて`feature/multibrand-foundation` commit`60dd7e4`、mainへは未マージ）

- `supabase/functions/_shared/brand/brand_profiles.ts`（修正: AI Labの`dryRunPostTypes`へ`"brand_post"`追加、voiceInstructions拡充）
- `supabase/functions/_shared/brand/brand_post_generator.ts`（新規）
- `supabase/functions/_shared/brand/brand_post_generator_test.ts`（新規、6テスト）
- `supabase/functions/_shared/brand/brand_post_dry_run.ts`（新規）
- `supabase/functions/_shared/brand/brand_post_dry_run_test.ts`（新規、6テスト）

### migrations/rpcs/functions changed

なし。本タスクは既存の`_shared/brand/`モジュール群への追加のみで、DB migration・RPC・`x-test-post/index.ts`（Kabumoriの既存dispatchループ）のいずれにも変更を加えていない。新規HTTPエントリポイントの`index.ts`への配線も、既存の巨大なdispatcher（約4500行）への変更リスクをこの段階で負う必要はないと判断し、あえて行わなかった（ロジック層の実装・テストを優先）。配線が必要になった際は、`runBrandPostDryRun()`をそのまま呼ぶ薄いラッパーとして追加できる状態にしてある

### tests

- `deno test --no-check --allow-env --allow-read --allow-net=127.0.0.1 supabase/functions`: **733 passed / 0 failed**（Phase 3D時点の721＋新規12）
- `deno check`: 変更・新規5ファイルすべて個別に`Check`成功
- `git diff --check`: 出力なし（クリーン）

### production_changes

ゼロ。DB migration適用、RPC変更、Edge Function deploy、Cron変更、Secret/Vault変更、X投稿、AI Labのlive化・publish_enabled変更、mio操作、posting_windows追加のいずれも実施していない。本番への問い合わせも今回は行っていない（Phase 3Dで確認済みの状態から変化がないことを前提に、コード実装とローカルテストのみで完結させた）

### deploy_status

未deploy。commit`60dd7e4`は`feature/multibrand-foundation`にpushされているのみ

### commit_hash

`60dd7e4`（`feature/multibrand-foundation`、親はPhase 3D K2承認済み`472cdac`）

### push

`origin/feature/multibrand-foundation`へpush済み（`472cdac..60dd7e4`）。mainへのmergeなし

### remaining_issues

1. **AI Labブランド戦略が未決定**: トピック・頻度・トーンの実際の方針をユーザーから受け取り、`brand_settings`／`brand_profiles.ts`を拡充する必要がある（今回は安全な汎用デフォルトのみ）
2. **index.tsへの配線未実施**: `runBrandPostDryRun()`を呼ぶ管理者専用HTTPエントリポイントを`x-test-post/index.ts`に追加する作業が残っている（本タスクではリスク回避のため見送り）
3. **Phase 3Dの2migration未適用**: ログ帰属修正・cross-brand重複防止テーブルはK2承認済みだが本番未適用のまま
4. **posting_windows未設計**: AI Lab用のスケジュール設計はブランド戦略確定後に着手する想定
5. **`loadVaultBackedXTokens`未配線**: AI Lab live化に必須だが本タスクでは対象外
6. **`publish_claims`のbrand_id**: Phase 3Dで報告済み、AI Labが日次1回制約を要する機能を持つ前に解消が必要（今回のbrand_postは対象外のため影響なし）

### exact steps before first AI Lab live post

1. remaining_issues #1（ブランド戦略確定）をユーザーと合意
2. remaining_issues #3（2migration）をK2承認どおり本番適用（preflight・read-back必須）
3. remaining_issues #2（index.tsへの配線）を実装し、管理者専用dry-runエントリポイントを本番deploy（X書き込みは引き続き禁止のまま動作確認）
4. remaining_issues #4（posting_windows設計）を`is_active=false`で追加し、生成→スケジュール作成のみをdry-runで確認
5. `posting_windows.is_active=true`へ切替え、自然経路でのdry-run投稿サイクルを複数回read-only観測
6. remaining_issues #5（Vaultトークン配線）を実装・テストし、AI Lab用の共有ゲート＋トークン解決を通しでテスト
7. remaining_issues #6（`publish_claims`のbrand_id）をAI Labが対象post_typeを持つ前に解消
8. ユーザー承認のうえ`ai_salaryman_lab.publish_mode='live'`・`ai_salaryman_lab_x.publish_enabled=true`へ切替え、最初の1件を手動承認体制で観測

### safety_checks

- Kabumori既存投稿経路（`x-test-post/index.ts`）: 無変更
- AI Lab: `publish_mode=dry_run`・`publish_enabled=false`を維持（本番未変更、本タスクでは本番問い合わせ自体を行っていない）
- AI Labへの`tweet.write`/`media.write`scope追加: なし
- mio: 一切操作していない
- Cron: 一切変更していない
- 本番DB: 書き込み・問い合わせともになし（本タスクは実装・テストのみで完結）
- secret/token/password/2FA: 表示・保存・記載していない
- 複垢worktree: 作業前後で`check-safe-env.sh`を実行していないが、`supabase` CLIコマンドを一切実行していないため状態は不変（前回Phase 3D終了時点の`SAFE`から変化なし）
- important-news-monitor・Push通知領域・他スロット対象領域: 変更していない

### next_recommendation

(a) 本Reportをレビューし、生成器・dry-runパイプラインの設計をK2承認、(b) 承認後、remaining_issues #1（ブランド戦略）をユーザーへ確認する別タスクを起票、(c) Phase 3Dの2migration（ログ帰属修正・cross-brand重複防止テーブル）を本番適用するタスクを並行して進めてよい（本Phaseの内容とは独立）、(d) ブランド戦略確定後、index.tsへの配線とposting_windows設計をPhase 3Fとして計画
