# Claude Task 2

- task_id: x-multibrand-phase3f-ai-lab-production-like-dry-run-20260913
- owner: claude
- slot: claude-2
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sonnet 5
- purpose: 会社員AIラボの既存運用方針をブランド正本として反映し、実OpenAI生成を使う管理者専用dry-run入口を配線して、`ai_salaryman_lab` 名義で生成→schedule/candidate相当→claim/log相当→publish gate停止までを本番に近い形で証明する。実X投稿はまだ行わない。

## Source-of-truth clarification

重要:

- 会社員AIラボの**実際の投稿内容・文体・note送客・ブランド運用の正本は、別の「会社員AIラボ」ChatGPTプロジェクト側のちゃが担当**している。
- この `kabumori` リポジトリ側で、会社員AIラボの人格・投稿戦略を新しく創作し直してはいけない。
- 本タスクでは、既に共有済みのブランド方針を実装可能な profile / settings / prompt へ落とし込む。
- 不明な細部があれば、勝手に設定せず Report に「会社員AIラボ側のちゃで確認が必要」と明記する。

現在共有済みの高位方針:

- 非エンジニア会社員がAIで副業・個人開発に挑む実験記録。
- 成功談だけでなく、失敗・詰まり・費用・試行錯誤も出す。
- 先生・AIインフルエンサー目線ではなく、一緒に試している会社員目線。
- AIツール活用、個人開発、副業、収益化までの過程が主テーマ。
- Xで興味を持ってもらい、深い内容はnoteへつなぐ。
- AIっぽいテンプレ文章にしない。
- Kabumoriとはテーマ・人格・固定ハッシュタグ・文体を完全分離する。
- ただし未確認の個人体験・成果・収益・実績をAIが捏造してはならない。事実として未提供の一人称体験は生成しない。

## Prior approved state

- Phase 3D commit: `472cdac1c066ed62217f0ef80788ff73b9155e13`.
- Phase 3E commit: `60dd7e422bd56799b3ff0f5e24d0a63ea41cf5ab` on `feature/multibrand-foundation`.
- Phase 3E tests: 733/733 PASS、changed files deno check PASS、git diff --check PASS。
- `brand_post_generator.ts` と `brand_post_dry_run.ts` は実装済み。
- AI Labはproductionで `identity_verified` / `publish_mode=dry_run` / `publish_enabled=false` を維持。
- AI Lab OAuth scopeは `tweet.read users.read offline.access` のread-only。`tweet.write` / `media.write` なし。
- Kabumori internal brand id=`kabumori`; actual X handle=`yume_daka`。混同しない。
- AI Lab pathはKabumori legacy `oauth_token_store`を読まない設計。
- 実X write callはまだ0件。
- Phase 3D migration `20260913130000_fix_post_execution_logs_brand_attribution.sql` はK2内容承認済みだが本番未適用。
- `20260913120000_add_published_content_fingerprints.sql` も本番未適用。

## Goal

Phase 3Fで以下を完成させる。

1. 会社員AIラボの既存ブランド方針を `BrandCodeProfile` / `brand_settings` / prompt に反映する。
2. `runBrandPostDryRun()` を呼ぶ**管理者専用の安全なdry-run入口**を実装する。
3. dry-run入口から**実OpenAI Responses APIを1回以上使用**して会社員AIラボ文面を生成できるようにする。
4. 生成結果が `brand_id=ai_salaryman_lab` を保持する。
5. production-likeな schedule/candidate payload → claim/log attribution相当 → publish gate まで通し、X write前に停止する。
6. X POST/media upload = 0 を証明する。
7. AI Lab pathのKabumori legacy token-store read = 0 を証明する。
8. Phase 3Dのログ帰属migrationを安全に本番適用できるなら適用し、read-backする。
9. 初回AI Lab live投稿前に残る差分を最小化する。

## Start / parallel safety

開始前に必ず読む:
- `.agent/ORCHESTRATION.md`
- `.agent/CURRENT_STATE.md`
- this TASK
- `.agent/tasks/CODEX_TASK.md`
- `.agent/tasks/CODEX_TASK_2.md`
- `.agent/tasks/CLAUDE_TASK_1.md`
- Phase 3D commit `472cdac`
- Phase 3E commit `60dd7e4`

必須:
- origin/main fresh-check
- `origin/feature/multibrand-foundation` fresh-check
- isolated clean worktree/clone
- 既存未コミット変更は他workstream所有物として触らない
- Codex slot2 Push hardening、Claude slot1 important-news-monitorと同じFunction/RPC/migration/fileに触れる必要が出たら停止して競合報告

通常はSonnet 5で進める。DB/RPC/Cronの根本設計変更、ブランド分離の再設計、原因不明の難しい不具合が出たら大変更せず停止し、Opus切替を推奨する。

## A. AI Lab brand profile

既存会社員AIラボ方針を実装に落とす。

最低限:
- audience: AIに興味がある一般会社員 / 非エンジニア / 副業・個人開発層
- pillars: AIツール活用 / 個人開発 / 副業 / 収益化過程 / 失敗・学び / 作業効率化
- tone: 人間的、自然、実験中の当事者目線。権威的・断定過多・煽り・AIテンプレを避ける
- note funnel: 深掘り価値があるテーマだけnote導線を許可。毎投稿リンク化しない
- no fabrication: 未確認の体験・収益・導入実績・顧客事例・数字を作らない
- Kabumori topic leakage: 株価、保有株、投資判断、かぶモリ固定タグ等をAI Labの通常投稿へ混ぜない

既存の会社員AIラボ側の投稿正本をこのrepoから直接読めない場合、上記を暫定実装し、細かい言い回しや投稿比率は「別プロジェクト側のちゃが正本」とReportに残す。

## B. Admin-only real dry-run entry

管理者専用入口を追加する。

要件:
- service/admin authentication必須
- brandを任意指定できる汎用入口にする場合でも、Phase 3Fのproduction実行対象は `ai_salaryman_lab` のみ
- `publish_mode=dry_run` と `publish_enabled=false` を再確認
- 実OpenAI生成は許可
- X token load / X POST / media uploadへ到達するコードパスを持たせない、またはpublish gate前に構造的停止を保証
- dry-run response/logに secret/token を出さない
- generated text全文をproduction logへ不要に残さない。必要なら短いpreview/hash/metadataのみ

既存の巨大 `x-test-post/index.ts` への変更がリスク高い場合、専用Edge Functionを新設してよい。ただしdeploy前にexact diff/認証方式/安全境界をReportへ記載する。

## C. Production-like flow

最低限、以下の意味論を通す:

AI Lab profile/settings
→ real OpenAI generation
→ candidate/scheduled payload with `brand_id=ai_salaryman_lab`
→ claim/log attribution semantics
→ cross-brand dedupe check
→ publish gate
→ dry-run stop

本番 `scheduled_posts` へ人工INSERTが安全でない場合は無理にINSERTしない。専用dry-runテーブル/一時payload/ローカルDBでの再現でもよいが、「本番とどこが同じでどこが違うか」をReportに明記する。

## D. Real OpenAI proof

少なくとも1回、fixture/mockではなく実OpenAI APIを使う。

条件:
- 生成内容は会社員AIラボの安全な一般テーマに限定
- 実X投稿しない
- model / input_tokens / output_tokens / cost を記録
- API key等secretは出さない
- 生成本文がKabumori人格・株テーマ・Kabumori固定タグを含まないことを確認
- 未確認体験の捏造がないことを確認

生成本文の全文をReportへ載せる必要はない。要約・先頭短文・検証結果で十分。

## E. Log attribution migration

`20260913130000_fix_post_execution_logs_brand_attribution.sql` はK2で内容承認済み。

本Phaseで本番適用する場合:
1. 対象10 RPCのsignature/body/privilege/search_pathをread-only preflight
2. exact migrationのみ適用
3. `supabase db push`禁止
4. migration history repair/reconcile禁止
5. 10 RPCすべてのbrand_id伝播をread-back
6. grants / SECURITY DEFINER / search_pathに意図しない変化がないことを確認
7. Kabumori人工retry/test postはしない

live schemaに差異がある場合は適用せず停止。

`20260913120000_add_published_content_fingerprints.sql` は、Phase 3Fのdry-runに不要なら本番適用を急がない。

## F. Cross-brand dedupe

Phase 3Dの `checkCrossBrandDuplicate()` をdry-run入口へ接続する。

最低限:
- Kabumoriと正規化後完全一致 → `would_block`
- 十分異なるAI Lab文面 → `would_allow`
- dry-runなので実投稿を止めるだけでよい

## G. Token routing

AI Lab live化前の準備として、`brand_id -> social_account -> Vault refs` の経路をテストする。

ただしPhase 3Fでは:
- X write不可
- `tweet.write` / `media.write`追加不可
- Kabumori legacy storeへのfallback不可
- token値の表示不可

Vault token loaderの実network使用がdry-runに不要なら呼ばず、live化タスクへ残してよい。

## H. Posting windows / publish_claims

Phase 3Fではlive windowを有効化しない。

必要ならAI Lab用posting window設計を作るが、production追加する場合は必ず `is_active=false`。

`publish_claims`のKabumori前提制約は既知。`brand_post`が使わないなら今回は変更不要。AI Lab live機能で必要になる前に別タスクでbrand-aware化する。

## Required tests

最低限:
- AI Lab profile/settingsだけでprompt構築
- Kabumori persona/tag/topic leakageなし
- no fabricated first-person experience/earnings claim fixture
- admin auth required
- real-dry-run handler cannot call X write endpoint
- generated payload brand_id=`ai_salaryman_lab`
- claim/log semantics preserve AI Lab brand
- `dry_run` blocks publish
- `publish_enabled=false` blocks publish
- AI Lab path legacy Kabumori token-store reads 0
- cross-brand exact duplicate `would_block`
- distinct text `would_allow`
- Kabumori existing generation/publish regressions
- all relevant Edge Function tests
- deno check changed files
- git diff --check

## Production prohibitions

禁止:
- AI Lab `publish_mode=live`
- AI Lab `publish_enabled=true`
- AI Lab `tweet.write` / `media.write` scope追加
- AI Lab実X投稿 / test post / media upload
- Kabumori OAuth/token変更
- Kabumori brand idを`yume_daka`へ改名
- Mio操作
- Cron変更
- Push通知領域
- important-news-monitor領域
- blind `supabase db push`
- migration history repair/reconcile
- destructive DB change
- secret/token/password/2FAの表示・保存・Report記載

## Completion / Report

完了時:
- status: `review_required`
- next_owner: `chatgpt`
- task末尾に `## Report`
- origin/mainへ制御情報を安全に同期

Report必須:
- task_id
- result
- model_used
- source_base
- ai_lab_source_of_truth_handling
- brand_profile_changes
- real_openai_generation_result
- admin_dry_run_entry
- dry_run_pipeline_result
- x_write_calls_count
- legacy_kabumori_token_reads_on_ai_lab_path
- log_attribution_migration_status
- cross_brand_dedupe_status
- token_routing_status
- posting_window_status
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

Phase 3F PASS条件:
- 会社員AIラボ側の既存方針を尊重したprofileが実装される
- 実OpenAI生成を1回以上確認
- AI Lab brand attributionがdry-run通し経路で維持
- X write=0
- Kabumori legacy token read=0 on AI Lab path
- Kabumori既存投稿に回帰なし
- live化・実投稿はまだ行わない

## Report

- task_id: x-multibrand-phase3f-ai-lab-production-like-dry-run-20260913
- result: 成功。AI Labプロファイルを共有済み方針へ更新し、実OpenAI生成を使う管理者専用dry-run入口を新設・デプロイし、`brand_id=ai_salaryman_lab`のままcross-brand重複判定→publish gate停止までの本番に近い経路を実呼び出しで証明した。K2content承認済みのpost_execution_logs brand_id修正migrationも本番へ適用し、read-back検証済み。live化・実X投稿は行っていない。
- model_used: Claude Sonnet 5
- source_base: feature/multibrand-foundation を `60dd7e4`（Phase 3E, K2承認済み）から開始し、本タスクの2コミット `b77c8c7` → `215eeff` を積み上げ。origin/mainのCodex/Claude他スロットとの競合なし（Push hardening = review_required・過去分、broad-news-presets = review_required・別領域、important-news-monitor = 別worktree）。
- ai_lab_source_of_truth_handling: 会社員AIラボの実際の投稿内容・文体・note送客・ブランド運用の正本は別の「会社員AIラボ」ChatGPTプロジェクト側にある前提を維持し、本リポジトリ側で新しい人格・投稿戦略は創作していない。今回共有された高レベル方針（読者像、テーマの柱、トーン、note送客ルール、捏造禁止、かぶモリ分離）のみを`_shared/brand/brand_profiles.ts`の`AI_SALARYMAN_LAB_CODE_PROFILE.voiceInstructions`へ実装可能な形で落とし込んだ。個別の文面ニュアンス・投稿タイプ別の配分・具体的なトピック選定などの細部は未確認のため実装しておらず、会社員AIラボ側のちゃで確認が必要（次フェーズの入力待ち）。
- brand_profile_changes: `AI_SALARYMAN_LAB_CODE_PROFILE.voiceInstructions`を7項目へ全面更新（読者像=非エンジニア会社員/副業・個人開発関心層、テーマの柱=AIツール活用・個人開発・副業・収益化過程・失敗と試行錯誤・生産性、トーン=会社員目線でテンプレ口調禁止、note送客=深掘り価値がある時だけ、捏造禁止=人物像・実績・勤務先・投資経験・具体的収益額、かぶモリ完全分離=株式投資禁止+かぶモリの人格/文体/固定ハッシュタグ禁止）。`reportFixedHashtags`は空のまま、`dryRunPostTypes`は`["profile_preview","brand_post"]`のまま変更なし。新規`brand_profiles_test.ts`（4テスト）で上記の必須要素すべてと「KABUMORI_VOICEを一切importしない」ことを検証。
- real_openai_generation_result: 実行済み。管理者（ユーザー本人）がSupabase Dashboardの「Send Request」からデプロイ済み`brand-post-dry-run`を実呼び出しし、実OpenAI Responses APIの結果を確認した。model=`gpt-5.6-luna`, input_tokens=543, output_tokens=256, api_cost_usd=0.000416。生成テキストを確認したところ、かぶモリの人格・文体・固定ハッシュタグ（#日本株 #日経平均 #株式投資 #かぶモリ）は一切含まれず、未確認の一人称体験談・実績・勤務先・具体的収益額の捏造もなし（「〜な気がします」等の一般的な考察トーンに終始）。全文はこのReportに転記せず、上記の要約と検証結果のみ記載（Section D「全文を必須記載しない」要件に準拠）。
- admin_dry_run_entry: 新規の独立Edge Function `supabase/functions/brand-post-dry-run/`（`index.ts` + `dry_run_handler.ts`）を新設・デプロイ（`x-test-post/index.ts`の巨大モノリスは変更していない）。認可はx-oauth-connect既存パターンに合わせ、`resolveAdminAuthorization`（admin_usersテーブル照合）+ Supabase Dashboardのservice role key自動注入バイパスのみを受理し、それ以外は403。`verify_jwt=false`でデプロイ（既存の全デプロイ済みFunctionが実際は全てverify_jwt=falseで運用されており、認可をFunction内部ロジックに委ねる既存アーキテクチャに合わせた）。`brand_id`は`ai_salaryman_lab`のみ許可（それ以外は`loadBrandContext`を呼ぶ前に403 `BRAND_POST_DRY_RUN_TARGET_NOT_APPROVED`）。生成前に`publish_mode=dry_run`かつ`publish_enabled=false`であることをこのエンドポイント独自に再確認し、崩れていれば409 `BRAND_NOT_IN_EXPECTED_DRY_RUN_STATE`でOpenAI呼び出し前に停止。レスポンスは生成テキスト・トークン数・dedupe結果・publish gate結果のみで、秘密情報は一切含まず、DB書き込み自体を一切行わないため生成本文の過剰永続化リスクもなし。
- dry_run_pipeline_result: 実呼び出しで確認: profile/settings読込 → 実OpenAI生成（本文243文字相当、モデル/トークン/コスト記録） → `scheduled_post_payload_preview`に`brand_id=ai_salaryman_lab`のまま伝播 → cross-brand重複判定（`would_block_on_exact_match.blocked=true, matchedBrandId=kabumori` / `would_allow_on_distinct_text.blocked=false`、両方とも意図通り）→ publish gate停止（`blocked=true, reason=BRAND_PUBLISH_MODE_DRY_RUN`）→ `published=false`。本番`scheduled_posts`への実INSERTは行っていない（`toScheduledPostPayload`によるpreviewのみ）。
- x_write_calls_count: 0（構造的に0。`dry_run_handler.ts`/`index.ts`ともにX APIへの経路・importが一切なく、実呼び出しレスポンスでも`x_write_calls: 0`を確認）。
- legacy_kabumori_token_reads_on_ai_lab_path: 0（構造的に0。`token_loader.ts`/`x_oauth2_post.ts`/`loadBrandXTokens`/`loadXTokens`への参照がゼロであることをsource-inspectionテストで検証済み、実呼び出しレスポンスでも`legacy_kabumori_token_reads: 0`を確認）。
- log_attribution_migration_status: 本番へ適用済み。適用前に全10 RPC（claim_due_post / complete_close_report_post / complete_interaction_post / complete_morning_greeting_post / complete_morning_report_post / complete_tip_post / complete_us_premarket_report_post / complete_useful_tip_post / fail_scheduled_post / retry_scheduled_post）の現在の署名・本体・SECURITY DEFINER・search_pathをread-onlyで再取得し、マイグレーション内容と正規化比較して意図したbrand_id追加以外の差分がないことを確認（Phase 3D検証以降の本番ドリフトなし）。適用は`supabase db query --linked --file supabase/migrations/20260913130000_fix_post_execution_logs_brand_attribution.sql`で実行（blind `db push`・migration history repair/reconcileは未使用）。適用後に全10関数を再読込し、全関数がbrand_idを参照するようになったこと、SECURITY DEFINER=true・search_path=publicが全関数で維持されていることを確認。権限(ACL)も比較し、意図しない変更なし（1点、`complete_morning_greeting_post`のみ`proacl`が元からnullだが、`CREATE OR REPLACE FUNCTION`はACLを変更しない仕様のためこのタスク起因ではない既存事象と判断。関連なしとして記録のみ）。実Kabumori行への人為的retry/test-postは行っていない。
- cross_brand_dedupe_status: `_shared/brand/cross_brand_dedupe_probe.ts`（新規）を`brand-post-dry-run`へ配線。`published_content_fingerprints`（Phase 3D由来migration `20260913120000`）が本番未適用のため、実際の最近のかぶモリ投稿本文は読みに行かず、生成テキスト自身から合成した「完全一致ケース（would_block期待）」と「固定の別文言ケース（would_allow期待）」の2窓で判定機構自体が正しく発火することを証明する設計。実呼び出しレスポンスで両方期待通り（block/allow）を確認済み。
- token_routing_status: 本フェーズでは変更なし（Section Gの指示通り）。Vault token loaderの実呼び出しなし、`tweet.write`/`media.write`スコープ追加なし、legacy Kabumoriストアへのフォールバックなし、トークン値の表示なし。
- posting_window_status: 変更なし。AI Lab用の`posting_windows`行は今回作成していない。
- publish_claims_status: 変更なし。`brand_post`は`publish_claims`を使用しないため、本フェーズでの対応は不要（Section Hの通り）。既知のKabumori中心な`brand_id`デフォルト依存は別タスクでの対応が必要な状態のまま。
- changed_files:
  - `supabase/functions/_shared/brand/brand_profiles.ts`（更新）
  - `supabase/functions/_shared/brand/brand_profiles_test.ts`（新規）
  - `supabase/functions/_shared/brand/brand_post_generator_test.ts`（更新、profile文言変更に伴うアサーション調整）
  - `supabase/functions/_shared/brand/cross_brand_dedupe_probe.ts`（新規）
  - `supabase/functions/_shared/brand/cross_brand_dedupe_probe_test.ts`（新規）
  - `supabase/functions/brand-post-dry-run/index.ts`（新規）
  - `supabase/functions/brand-post-dry-run/dry_run_handler.ts`（新規）
  - `supabase/functions/brand-post-dry-run/dry_run_handler_test.ts`（新規）
- migrations/rpcs/functions changed:
  - migration: `supabase/migrations/20260913130000_fix_post_execution_logs_brand_attribution.sql` — 本番適用済み（Phase 3D作成、K2 content承認済み）
  - Edge Function: `brand-post-dry-run` — 新規デプロイ済み（`--no-verify-jwt`, project `wsmznyzcvmuitkglfeuj`）
- tests: `deno test --no-check --allow-env --allow-read --allow-net=127.0.0.1 supabase/functions` で747/747 pass（Phase 3E終了時点の733 + 本フェーズの新規/更新テスト14）。`git diff --check`で空白エラーなし。`deno check`は本フェーズ変更ファイル・既存未変更ファイル双方で既知の`@types/node`解決エラーのみ（環境要因、リグレッションではないことを未変更ファイルへの同一コマンド実行で確認）。
- production_changes:
  1. `post_execution_logs`関連の10 RPCへbrand_id修正migration適用（読み取り専用preflight → 適用 → read-back検証の手順を実施）
  2. 新規Edge Function `brand-post-dry-run` をデプロイ（Kabumori/AI Labの既存Function・OAuth・Cron・トークンには一切触れていない）
- deploy_status: 成功。1回目はエディタ補完用の`import "@supabase/functions-js/edge-runtime.d.ts";`がバンドル時に解決できず400エラー（x-test-post側はこの行自体が無く、x-oauth-connectは専用deno.jsonで解決していたための差異）。原因を特定し当該importを削除して修正コミット後に再デプロイし成功。デプロイ後、`supabase functions download --use-api`でダウンロードしたコードと元コミット(`215eeff`)を、Function本体および全依存ファイル（`_shared/brand/*`, `x-test-post/admin_auth_logic.ts`等）についてバイト単位で比較し完全一致を確認。
- commit_hash: `215eeff`（`b77c8c7`の後続）、feature/multibrand-foundationへpush済み
- push: origin/feature/multibrand-foundationへpush済み（`b77c8c7`, `215eeff`）
- remaining_issues:
  1. AI Labの実際の投稿タイプ別配分・具体的トピック選定・文面ニュアンスは会社員AIラボ側ちゃでの確認が必要（本タスクでは共有済み高レベル方針のみ実装）
  2. `published_content_fingerprints`（migration `20260913120000`）が本番未適用のため、cross-brand重複判定は実データではなく合成probeでの機構確認にとどまる
  3. Vault token loaderの実配線、`posting_windows`のAI Lab設計、`publish_claims`のbrand対応は未着手
  4. `complete_morning_greeting_post`の`proacl`がnull（既存事象、本タスク起因ではないが要調査）
  5. 管理者専用dry-run入口は現状`ai_salaryman_lab`のみ許可のハードコード（他ブランド追加時はallowlist拡張が必要、設計自体はbrand-agnostic）
- exact steps before first AI Lab live post:
  1. 会社員AIラボ側ちゃでの実際の投稿方針（トピック配分・文面ニュアンス）確定
  2. `published_content_fingerprints`テーブルの本番適用と、実データを使ったcross-brand dedupeへの本配線
  3. AI Lab用`posting_windows`設計・追加（`is_active=false`で開始）
  4. `publish_claims`のbrand対応（brand_postが将来1日1回制限等を必要とする場合）
  5. Vault token loaderの実配線とX投稿用スコープ（`tweet.write`等）の追加判断
  6. 管理者による最終レビューと、`publish_enabled=true`/`publish_mode=live`への切り替え判断（段階的・手動承認ゲート付き）
- safety_checks:
  - AI Lab: `publish_mode=live`にしていない / `publish_enabled=true`にしていない / write scope追加なし / 実X投稿・メディアアップロードなし
  - Kabumori: OAuth/token/ハンドル/Cron一切変更なし
  - Mio: 一切触れていない
  - Push通知領域・important-news-monitor領域: 一切触れていない
  - DBマイグレーション: blind `db push`なし、migration history repair/reconcileなし、destructive changeなし、事前read-only比較+事後read-back検証を実施
  - 秘密情報: token/password/2FA/service role keyの値をチャット・ログ・Reportに一切記載していない
- next_recommendation: `published_content_fingerprints`の本番適用とcross-brand dedupeの実データ配線を次の技術タスクとして進めつつ、並行して会社員AIラボ側ちゃとの間でトピック配分・文面ニュアンスの確定を進めるのが良い。両方揃った時点で`posting_windows`設計（`is_active=false`）→ 最終レビュー → 段階的live化、という順序を推奨。
