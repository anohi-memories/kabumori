# Claude Task 2

- task_id: x-multibrand-phase3e-ai-lab-real-dry-run-generation-20260913
- owner: claude
- slot: claude-2
- status: in_progress
- next_owner: claude
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
