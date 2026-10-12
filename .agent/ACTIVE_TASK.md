# Active Tasks Index

このファイルは共有オーケストレーションの全15枠（Codex H1〜H5 + Claude G1〜G10）インデックスです。詳細指示と割当の正本は各TASK/Reportです。statusだけで空き判定せず、task_idとTASK本文も確認してください。

## Routing preference

- かぶモリアプリ実装は G1 / G2 を使用する。
- X自動投稿・複数ブランドX実装は G3 / G4 を使用する。
- `G5`〜`G10`: 予備のClaude実装スロット。用途は固定せず、ユーザーまたはChatGPTが明示割当した場合のみ使用する。既存の基本ルーティングの自動fallbackにはしない。idleだからという理由だけで自動使用しない。
- 各ペア内の割当は空き状況・競合・依存関係を見てChatGPTが決める。
- `G7` はMIC専用チャットの「Market Intelligence Core」作業担当（ユーザー明示指定2026-10-11）。MICの作業を他G枠へ勝手に割り当てない。各TASKはG7の真の空き・競合確認後のみ割り当てる。
- `G8` はこのチャットの「ニュース改善 A」専用、`G9` はこのチャットの「API最適化 B」専用（ユーザー明示指定2026-10-11）。ほかのG枠や別案件への自動引継ぎ・再割当禁止。各新TASKは対象枠の真の空き・競合を確認してから割り当てる。
- H1〜H4はCodexのレビュー・バグ修正・検証枠（固定プロジェクト専用にしない）。H5はCodex臨時実装専用で原則空けておき、レビュー・検証には使わない。割当時は `return_to` / `completion_code` / 推薦モデルを必ず記入する。
- ユーザーの個別指定がある場合はその指定を優先する。
- 競合防止ルールは常に優先する。

## Project Critical Path — Common Account

- priority: **CRITICAL / project-wide**
- user decision: 共通アカウント完成を、かぶモリ・X自動投稿の次工程より最優先とする。
- G5 owns the shared common-account critical path.
- Existing G1-G4 tasks are preserved. G5 priority is **conflict-based**, not a project-wide freeze: non-conflicting implementation/test/commit/push/PR/merge and non-conflicting production work may continue.
- If a production boundary overlaps G5 (same DB migration/table/RPC/function, Auth/RLS/permission, Edge Function, secret/settings/Cron/workflow/API boundary, or a shared baseline/fingerprint), G5 has priority and the conflicting operation waits.
- Same-Supabase-DB migration/DDL write sections are serialized only for the actual write/read-back window; waiting/review/user-input time must not keep a global lock active.
- next shared milestone: Phase 3a source implementation -> focused security review -> production preflight/apply gates -> final EAS/TestFlight after the common-account feature set is complete.

## Deployment policy

- X自動投稿・Web管理画面の開発中/PR/テスト用PreviewはNetlifyを優先する。
- レビュー完了後の最終production deployのみVercelを使う。
- かぶモリExpo/native本体はVercelを通常開発・merge gateに使用しない。
- Expo native/iOS実機・TestFlightは従来どおり別工程。
- かぶモリ将来WebはPreview/ProductionともNetlifyを使用する。

## Codex H1
- owner: codex
- slot: codex-1
- status: done
- task_id: postona-h1-threads-oauth-edge-offline-implementation-20261011
- start_code: H1
- finish_code: C1
- completion_code: C1
- next_owner: none
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- source: .agent/tasks/CODEX_TASK.md
- report: .agent/CODEX_REPORT.md
- allocation: C1 2026-10-11 accepted H1 mock-only Threads OAuth Edge candidate as PASS_OFFLINE_CANDIDATE / RELEASE_HOLD. Exact Draft PR135 e38788d6677082138f0990453c7d2f00549666d0 stacked on untouched protected Draft PR124 c30f246409a77080cbc03aef6c4cb72b5481e125, only 4 new source/test/docs files. H1-reported mocked 102/102 tests PASS; GitHub/source inspected by ChatGPT, tests not independently rerun. No actual Supabase/Meta/Threads/X/Auth/Vault calls, no production changes, RPC grant, migration, secret, deploy or merge; static Threads gate false. H1 task/report histories protected. H1 done/unreserved. Real integration still blocked by durable claim/authority transport, G5 T13/T9/T10, Meta/GoTrue/Vault proof and independent release gate. Existing X hardening Issue131 remains deferred; H2/H3-H5/G slots protected.
- recommended_model: Sol（高） (completed)
## Codex H2
- owner: codex
- slot: codex-2
- status: done
- task_id: kabumori-pr149-broadcast-fanout-push-security-review-h2-20261012
- start_code: H2
- finish_code: C2
- completion_code: C2
- next_owner: none
- return_to: かぶモリアプリG2のちゃ
- source: .agent/tasks/CODEX_TASK_2.md
- report: .agent/CODEX_REPORT_2.md
- allocation: C2 2026-10-12 accepted H2 PR149 independent Sol（高） source-only review: CHANGES_REQUIRED P2 six reproduced R1–R6 (feed OFF, source freshness, 91st device, 16parallel burst640, plan1→begin61, malformed ticket retry). H2 ran Deno typed44 and 8 adverse, disposable PG17 ACL/concurrency/scale+19 mutants, review production/PR source writes0. G2 narrow repair TASK assigned, no blanket rereview. H2 done/next_owner none; C2 Report history unchanged, no live Expo/DB/merge/deploy.
- recommended_model: Sol（高） (completed)
## Codex H3
- owner: codex
- slot: codex-3
- status: review_required
- task_id: agent-v2-pr155-dual-slot-migration-review-h3-20261012
- start_code: H3
- finish_code: C3
- completion_code: C3
- next_owner: chatgpt
- return_to: こでくろ連携部屋のちゃ
- source: .agent/tasks/CODEX_TASK_3.md
- report: .agent/CODEX_REPORT_3.md
- allocation: Draft PR #155 exact head 8a28a067a20daec5bd96e09656bdfab144c3c458 の新旧30枠・段階移行型 .agent_v2 基盤を独立READ ONLYレビュー。新旧コード体系、F/F1衝突、旧15枠差分ゼロ、archive/MANIFEST/SHA256/restore、HISTORY_INDEX、F/J/L/V→G/H/K/C復帰、二重割当防止、J1〜J5運用、完全移行条件、merge時の現行G/H互換性を重点確認。PR merge/deploy/production変更禁止。完了はC3。
- review_result: PASS_REVIEW_CANDIDATE / MERGE_READY_FOR_CHATGPT_DECISION. H3 independently reproduced archive33/33+restore, index856 refs, 15 mappings and fresh-main merge preservation. No blocking source finding; final cutover path/code updates remain a separate TASK, raw GitHub mergeability unknown needs future re-check. Candidate edit/merge/deploy/production/AI0. C3 to こでくろ連携部屋のちゃ.
- recommended_model: Sol（高）

## Codex H4
- owner: codex
- slot: codex-4
- status: done
- task_id: common-account-g5-phase4-pr152-pr121-security-review-h4-20261012
- start_code: H4
- finish_code: C4
- completion_code: C4
- next_owner: none
- return_to: 共通アカウントG5のちゃ
- source: .agent/tasks/CODEX_TASK_4.md
- report: .agent/CODEX_REPORT_4.md
- recommended_model: Sol（高） (completed)
- allocation: C4 accepted CHANGES_REQUIRED P2×2 (R1 provider lease ownership check across await; R2 rollback dependency on foreign service triggers). Source SQL/auth/freeze/races E2E candidate PASS offline, production hold. One G5 limited correction recommended, no additional full H review automatically.

## Codex H5
- owner: codex
- slot: codex-5
- status: done
- task_id: postona-threads-oauth-runtime-bridge-h5-20261011
- start_code: H5
- finish_code: C5
- completion_code: C5
- next_owner: none
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- source: .agent/tasks/CODEX_TASK_5.md
- report: .agent/CODEX_REPORT_5.md
- allocation: C5 2026-10-11 CHATGPT ACCEPTED PASS_SOURCE_CANDIDATE / RELEASE_HOLD. Exact Draft PR139 head b4fa672f97592e87682671454e868a92098cbd56, OPEN/UNMERGED, one commit 13 entirely new H5 source/test/docs paths stacked on original Draft PR135 exact e38788d6677082138f0990453c7d2f00549666d0. H5 PR reported Deno32 focus/97 combined PASS and fake-PG17 concurrency/ACL/parent integration PASS; tests not independently rerun. Auth+owner SQL state claim candidate implemented but effective production DB owner transport/session privileges/Meta/GoTrue/Vault/T13/T9/T10/mobile callback not proven; new Edge returns 503, static gate false. This C5 was independently recorded by ChatGPT from verified PR/source after Codex Report had NOT been synced; .agent/CODEX_REPORT_5.md explicitly distinguishes assessment authorship. No merge/deploy/real connection/post, no H5 park. H5 now done/unreserved; H1-H4/G1-G10 unaffected, future focused Sol（高） security review required only at integrated release gate.
- recommended_model: Sol（高） (source candidate completed; C5)
## Claude G1
- owner: claude
- slot: claude-1
- status: ready
- task_id: kabumori-g1-home-report-return-and-holdings-count-fix-20261012
- start_code: G1
- finish_code: K1
- next_owner: claude
- return_to: かぶモリアプリG1のちゃ
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: 2026-10-12 five-tab Simulator QA K1 accepted PASS_WITH_FINDINGS and completed; focused G1 P3 home report detail return-to-home + P4 unknown holding count badge fix. One bounded source PR, tests/simulator, no merge/deploy; G2 PR143 report-detail implementation and G5 boundaries protected.
- recommended_model: Sonnet5（中）
## Claude G2
- owner: claude
- slot: claude-2
- status: done
- task_id: kabumori-g2-phase2c-deferred-claude-market-shadow-handler-20261012
- start_code: G2
- finish_code: K2
- next_owner: none
- return_to: かぶモリアプリG2のちゃ
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: K2 2026-10-12 PR153 6c576567328c99a58c2e4beaed86d155fe875769 source PASS_SOURCE_CANDIDATE_WITH_G6_TEST_BLOCKER / PRODUCTION_NO_GO. Single commit/three G2 files handler/index/new shadow_wiring_test, on protected G6 PR150 then PR148; default OFF, legacy OpenAI identity, waitUntil after completed+trace, deadline/cancel/error isolation. G2 reports 313/313 market report tests PASS and 3 mutation detections. G6 shared AI provider isolation 122/123: Phase1a no-import rule obsolete after authorized handler import; G6 must update only G6-owned isolation test allowlist and rerun on stacked integrated tree. Not merge-ready, real API/prod tests NOT_RUN. G2 done/none/free; no G6/new other slot allocation in this K2. PR143/149/148/150/153 still Draft/unmerged, release gates held.
- recommended_model: Opus5.5（高） (completed)
## Claude G3
- owner: claude
- slot: claude-3
- status: done
- task_id: postona-g3-reservation-preview-confirmation-ux-v1-20261012
- start_code: G3
- finish_code: K3
- next_owner: none
- return_to: POSTONA G3のちゃ（AI自動投稿・X予約担当チャット）
- source: .agent/tasks/CLAUDE_TASK_3.md
- allocation: K3 2026-10-12 PASS_UI_SOURCE_LOCAL_PREVIEW_ONLY for PR151 exact head 0cd5c596, 1 commit / 9 G3-owned paths stacked on unchanged Draft PR145 8820fa8d. Per-post user confirmation/edit/retime/cancel, invalidation, account isolation and preview-only OFF release gate accepted. G3 reports app309/309, domain22/22, mutants19/19; ChatGPT inspected source but did not rerun tests; iOS device NOT_RUN. Both PR145/151 stay Draft unmerged, all production/real X operations OFF. G5/G4 auth required before future integration and one focused Sol（高） review; no new G3 task automatically assigned.
- recommended_model: Sonnet5（高）
## Claude G4
- owner: claude
- slot: claude-4
- status: done
- task_id: postona-g4-threads-mobile-oauth-and-cleanup-wiring-v1-20261012
- start_code: G4
- finish_code: K4
- next_owner: none
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- source: .agent/tasks/CLAUDE_TASK_4.md
- report: .agent/tasks/CLAUDE_TASK_4.md#report
- allocation: K4 2026-10-12 PASS_SOURCE_IMPLEMENTATION / REAL_PILOT_HOLD. Verified Draft PR154 exact head 98287392327eabfd5092a3ba89dde51a2e8beff6, OPEN/DRAFT/UNMERGED, 1 commit 19 G4-only files stacked on protected PR144 09fd2c49114b7d26c23b71a3084574dc6a5a7ad6. App Expo browser authenticated Threads OAuth start, HTTPS callback/app-link handoff and RLS account readback (no optimistic connected), new G4 H5-runtime Edge contract strictly validates official URL and success, Threads-specific local cleanup adapter+owner-only SQL candidate matches G5 PR152 port but is unregistered and unapplied. G4 reports app18 connect+18 manual PASS, tsc/lint, Deno105 PASS, disposable PG17 cleanup ACL/inflight/identity mutation4/4 and H5+G5 fake composite smoke PASS; ChatGPT inspected PR/source and tests but did not rerun. Real Meta, managed Supabase Auth/Vault, dedicated H5 owner transport/session privilege, callback app-link, G5 Phase4 actual T13/T10 adapter registration and grants, live test pilot not done. All five static source/app/server flags FALSE, deployed H5 Edge entry 503. No PR merge/deploy/production migration/API/post. G4 status done/none and slot unreserved; G5 current Phase4 review_required unaffected, H5 done/none and separate 臨時実装 only if explicitly allocated. Next G5 K5 and H5 owner-specific integration, one focused Sol高 review before any live permission.
- recommended_model: Opus5.5（高） (completed K4)
## Claude G5
- owner: claude
- slot: claude-5
- status: ready
- task_id: common-account-g5-phase4-h4-c4-r1-r2-repair-20261012
- start_code: G5
- finish_code: K5
- next_owner: claude
- return_to: 共通アカウントG5のちゃ
- source: .agent/tasks/CLAUDE_TASK_5.md
- report: .agent/tasks/CLAUDE_TASK_5.md#report
- allocation: H4 C4 independent review of G5 Draft PR152 stacked on PR121 found 2 P2 defects. G5 Opus5.5（高） narrow code corrections only: R1 owner lease recheck around provider cleanup awaits / before service finish; R2 foreign dependent fence trigger rollback safety, with targeted fail-before/pass-after PG/TS regression. Align observed ACCOUNT_LIFECYCLE_BUSY SQLSTATE 42501 vs documented 55P03. PR152 current protected head 5ad5bb40cadf013f00553acd5509f4f74fdbff7c, PR121 76b50e1e03f82faaa3460bab1603afa8fef3ce44. No managed Supabase/production/merge/deploy/other slot changes. G5 Report history preserved.
- recommended_model: Opus5.5（高）

## Claude G6
- owner: claude
- slot: claude-6
- status: ready
- task_id: common-ai-provider-g6-phase2c-isolation-test-allowlist-20261012
- start_code: G6
- finish_code: K6
- next_owner: claude
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- source: .agent/tasks/CLAUDE_TASK_6.md
- report: .agent/tasks/CLAUDE_TASK_6.md#report--phase2c-isolationg6記入
- recommended_model: Sonnet5（中）
- allocation: G2 Phase2c PR153 (head 6c576567) now imports AI provider in market-report-analysis/handler.ts. Phase1a isolation_test.ts blanket no-production-import rule must be replaced by exact handler/test allowlist. G6 owns only isolation_test.ts in a separate branch Draft stacked on PR153 (PR148→150→153). All other Edge imports and app/client secret leakage remain forbidden; positive/negative regressions, Provider123 + market report313 offline. No G2 source/PR changes, no prod/paid API, merge/deploy/secrets/DB/Cron.
- previous_result: Phase2b K6 accepted PASS_OFFLINE_SOURCE_CANDIDATE; history retained in own task.
- production_mutation_window: FORBIDDEN

## Claude G7
- owner: claude
- slot: claude-7
- status: done
- task_id: mic-stage1-formal-verification-design-finalization-g7-20261011
- start_code: G7
- finish_code: K7
- completion_code: K7
- next_owner: none
- return_to: MICのちゃ（Market Intelligence Core専用チャット）
- source: .agent/tasks/CLAUDE_TASK_7.md
- report: .agent/tasks/CLAUDE_TASK_7.md#report
- allocation: K7 2026-10-11 PASS_DESIGN_ONLY / TASK_COMPLETE。PR125 exact `aa47e40d2a3ba7ec8bfc7d1d30c8eb51d53f2c48` OPEN/Draft/UNMERGED、G7差分は設計文書のみ(+352/-163)でコード/migration/本番変更なし。U2/U3/U6/U9設計決定・単一事実スナップショット・イベント50件超/同ID改定・ポインタ/rollback/SQL42テスト設計を確認。ローカル静的チェックはClaude報告、GitHub diffをChatGPT read-back。U12/U13、実SQL/競合/権限テストは実装レビューで検証。10/14以降の自然shadow観測まで実装GOなし、PR merge/deploy禁止。G7 TASKは完了・next_owner:noneで解放するがMICの今後のG実装担当はユーザー指定によりG7のみ。別作業は新TASKで明示割当。
- recommended_model: Opus5.5（高）
## Claude G8
- owner: claude
- slot: claude-8
- status: ready
- task_id: news-improvement-a-jp-general-major-financial-coverage-j0-g8-20261012
- start_code: G8
- finish_code: K8
- next_owner: claude
- return_to: ニュース改善API最適化のちゃ
- source: .agent/tasks/CLAUDE_TASK_8.md
- report: .agent/tasks/CLAUDE_TASK_8.md#report
- allocation: USER EXPLICIT。G8ニュース改善A専任で国内の一般重大ニュース（事故/事件/不祥事/訴訟/災害/政策急変）と金融・経済・企業ニュースを充実させ、X投稿だけでなくアプリ内で読める記事を増やす。既存データ7日：jp_* signals173、jp_official candidates11/X公開2、TDnet公開86、アプリPush79（異なるstageの母集団を単純除算禁止）。Phase J0はsource→event→重要度→アプリRPC→home/list/Pushの**read-only実測監査と合法source設計＋オフライン合成ベンチマーク**だけ。次J1実装はK8判断後。**PR129 OPEN/Draft head81251b31 のmerge/deploy/branchは不変更**、PR116の10/13固定本番作業を保護。G9 API最適化B/他全G/H・worktree・本番DBの変更禁止。J0はfresh main別branch/独立G8 worktree、推奨Opus5.5（中）、完了K8。
- recommended_model: Opus5.5（中）
## Claude G9
- owner: claude
- slot: claude-9
- status: done
- task_id: api-optimization-b-g9-r3-clean-history-provider-compare-replacement-20261011
- start_code: G9
- finish_code: K9
- next_owner: none
- return_to: ニュース改善API最適化のちゃ
- source: .agent/tasks/CLAUDE_TASK_9.md
- report: .agent/tasks/CLAUDE_TASK_9.md#report
- allocation: USER EXPLICIT G9=API最適化B専任。K9 2026-10-12 **PASS_OFFLINE_BRANCH_READY / PR_NOT_CREATED / RELEASE_HOLD**。新規Bだけのclean-historyブランチ `claude/b-provider-compare-rights-safe-20261012` commit `c476ef8a` に129新規ファイル、旧本文入り `cases.json` なし。G9報告302 PASS/1 ignored。Draft PR作成はClaude安全機構により拒否、無理に回避せずユーザー作成待ち。TDnet見出し3件の本文重複/旧PR115 Git refsの本文/元main既存重複2ファイルは別の判断事項。PR115/本番/外部AI利用は未変更、merge/deploy不可。新TASK未割当、他案件に転用禁止、G8その他枠不干渉。
- recommended_model: Opus5.5（高） (completed)
## Claude G10
- owner: claude
- slot: claude-10
- status: review_required
- task_id: agent-v2-dual-slot-migration-20261012
- start_code: G10
- finish_code: K10
- next_owner: chatgpt
- source: .agent/tasks/CLAUDE_TASK_10.md
- report: .agent/tasks/CLAUDE_TASK_10.md#report
- allocation: 2026-10-12 ユーザーがチャットで直接提示・明示承認しClaudeが登録。新旧30枠の段階移行用に `.agent_v2/` 新15枠基盤（F1〜F10/L1〜L10、J1〜J5/V1〜V5）・旧.agent完全snapshot・MANIFEST/SHA256・HISTORY_INDEX・移行ルールを別系統で構築し、Draft PRまで。旧G/H TASK・Report変更、merge、deploy、production操作は禁止。2026-10-12 G10報告: Draft PR #155（head 8a28a067a20daec5bd96e09656bdfab144c3c458、未merge）、snapshot 33ファイルのSHA256・復元テスト・HISTORY_INDEX参照856件すべてPASS、旧15枠差分ゼロ。K10待ち。
- recommended_model: Opus5.5（高）

## Deferred

- PR #15 is closed with Final K4 PASS. PR #33 remains unmerged; its Auth/security review/merge decision can now be scheduled separately after fresh slot review.
- Kabumori Expo Web Netlify Preview task is also deferred because it is not currently needed for the native app workflow.

## Control codes

- `H1`〜`H5`: Codex H1〜H5開始。ready / in_progressのTASKのみ。
- `G1`〜`G10`: Claude G1〜G10開始。ready / in_progressのTASKのみ。
- `C1`〜`C5`: ChatGPTが対応Codex枠だけ完了確認（H1→C1、H2→C2、H3→C3、H4→C4、H5→C5）。単独 `C` は使用しない。
- `K1`〜`K10`: ChatGPTが対応Claude枠だけ完了確認（G1→K1 … G10→K10）。
- 単独 `G` / `K`: G1〜G10（G5〜G10は明示割当済みの場合のみ）から、対象が1枠だけと明白な場合のみ使用。
- `F`: H1〜H5 + G1〜G10の全15枠の状態・競合・実際の空き状況を確認する統括コード。完了コードではなく、別チャット担当のTASKを完了・再割当しない。

並行実行はtask_idと変更対象が分離され競合しない場合に限る。同じファイル・DB migration/RPC・Edge Function・workflow・production設定等を複数枠で同時変更しない。
