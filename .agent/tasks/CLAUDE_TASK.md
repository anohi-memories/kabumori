# Claude Task 2

- task_id: x-multibrand-phase3f-ai-lab-production-like-dry-run-20260913
- owner: claude
- slot: claude-2
- status: ready
- next_owner: claude
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
