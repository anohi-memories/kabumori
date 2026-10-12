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
- status: done
- task_id: postona-threads-pr144-auth-publish-p1-security-review-h3-20261012
- start_code: H3
- finish_code: C3
- completion_code: C3
- next_owner: none
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- source: .agent/tasks/CODEX_TASK_3.md
- report: .agent/CODEX_REPORT_3.md
- allocation: C3 2026-10-12 accepted H3 independently completed review of exact Draft PR144 d4a1e87b77d1fbd362dc51809ce2d998afda15ea stacked on PR140 exact 2e75a6a842e70f3de78558681803b60935fb4251. Verdict CHANGES_REQUIRED/REAL_PILOT_HOLD with one reproducible P2: auth.sessions FOR KEY SHARE in threads_publish_release_candidate.sql:229-232 allows concurrent non-key not_after expiry UPDATE to commit before credential release; local PostgreSQL17 two-session reproduction and FOR SHARE control PASS. Deno93 and composite176 (overlap), app258 and disposable SQL/mutations PASS as H3-run; ChatGPT source/report inspected only. Actual managed GoTrue revocation not proven. Protected H5 PR139 session KEY SHARE concern noted for future separate H5 interface, not modified. H3 product edits0, no prod/Meta/DB apply/deploy/merge. H3 done/unreserved; one narrow G4 correction assigned instead of repeated broad review. Other H/G slots protected.
- recommended_model: Sol（高） (C3 accepted)
## Codex H4
- owner: codex
- slot: codex-4
- status: done
- task_id: news-improvement-a-pr129-phase7-r2-final-focused-review-h4-20261012
- start_code: H4
- finish_code: C4
- completion_code: C4
- next_owner: none
- return_to: ニュース改善API最適化のちゃ
- source: .agent/tasks/CODEX_TASK_4.md
- report: .agent/CODEX_REPORT_4.md
- allocation: C4 2026-10-12 CHANGES_REQUIRED。独立H4がPR129 head `7bf9b8a0` で既存968 PASS、独立12probe=9 PASS/3 FAILを実施。H4-R1 P1:決算表折返し誤Fact、R2 P2:本文更新と判定保存のCAS競合、R3 P2:過去FOMC決定を現在決定と誤認。レビュー完了、コード未変更、本番アクセス・merge・deployなし。G8ニュース改善Aだけへ限定修正TASKを戻す。H4はdone/unreserved、他案件を勝手に引継がない。
- recommended_model: Sol（高） (completed)
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
- task_id: kabumori-g1-five-tab-release-simulator-qa-20261012
- start_code: G1
- finish_code: K1
- next_owner: claude
- return_to: かぶモリアプリG1のちゃ
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: 2026-10-12 prior portfolio Simulator QA K1 PASS and done; new read-only five-tab release Simulator QA assigned. Home/銘柄/ニュース/レポート/メニュー navigation, 375pt/402pt, fixtures, regressions; no G2/G5/G8/G9 work, production data editing, EAS or deploy.
- recommended_model: Sonnet5（中）
## Claude G2
- owner: claude
- slot: claude-2
- status: ready
- task_id: kabumori-g2-phase2c-deferred-claude-market-shadow-handler-20261012
- start_code: G2
- finish_code: K2
- next_owner: claude
- return_to: かぶモリアプリG2のちゃ
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: K2 2026-10-12 PASS_SOURCE_FIX G2 PR149 H2 R1–R6 (exact new head e9bb86c44808d87ad8cbd3de4f1d1564066f958a, 1 commit/8 paths, claimed synthetic SQL PG17/26 mutants and focused Deno/app tests PASS; ChatGPT diff/source examined but tests not rerun), no recurring Codex review. PR143 889ca1b4 + PR149 e9bb86c4 both OPEN/Draft/unmerged, no production. G2 released then assigned Phase2c user/G6 agreed: source-only integrate G6 deferred Claude shadow after completed market report into G2 market-report-analysis handler/index+focused tests, default OFF, preserve OpenAI packet/delivery, time-bound waitUntil, NO paid/real API, NO deploy/merge. G6 PR148 a71de72b, PR150 18d9058a both OPEN/Draft; create separate G2 branch stacked ON PR150, DO NOT modify G6 PRs/branches or PR143/149/other slots, verify worktree/head at start. Return K2. Production NO_GO.
- recommended_model: Opus5.5（高）
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
- task_id: postona-threads-pr144-c3-r1-session-expiry-lock-fix-g4-20261012
- start_code: G4
- finish_code: K4
- next_owner: none
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- source: .agent/tasks/CLAUDE_TASK_4.md
- report: .agent/tasks/CLAUDE_TASK_4.md#report
- allocation: K4 2026-10-12 PASS_SOURCE_FIX / C3_R1_REMEdIED_OFFLINE / REAL_PILOT_HOLD. Original G4 PR144 head d4a1e87b77d1fbd362dc51809ce2d998afda15ea advanced with ONE non-force commit to 09fd2c49114b7d26c23b71a3084574dc6a5a7ad6, exactly four G4-only files (session-lock SQL, PG race runner, behavior fixture, documentation); parent PR140 unchanged, OPEN/DRAFT/unmerged. H3's local P2 R1 FOR KEY SHARE nonkey session expiry UPDATE race corrected with FOR SHARE lock and both-order two-connection regression plus explicit fail-before mutation. G4 reports PG17 and 9/9 mutations, combined Deno176, focused93 PASS; ChatGPT inspected diff/test source but did not rerun. No H3 re-review needed for this narrow source change. Real managed GoTrue revocation, H5 protected KEY SHARE owner transport, G5 real T13/T10 and deletion audit, Vault credentials, Meta tester/callback, external provider/post and public flag remain blocked. App/server gates all FALSE and Edge 503. No merge/deploy/grant/migration/real API. G4 done/unreserved; prior task Report preserved; H5/G5/G3 and other slots unchanged.
- recommended_model: Opus5.5（高） (completed K4)
## Claude G5
- owner: claude
- slot: claude-5
- status: review_required
- task_id: common-account-phase4-core-end-to-end-implementation-20261012
- start_code: G5
- finish_code: K5
- next_owner: chatgpt
- return_to: 共通アカウントG5のちゃ
- source: .agent/tasks/CLAUDE_TASK_5.md
- report: .agent/tasks/CLAUDE_TASK_5.md#report
- allocation: User 2026-10-12「そのほうがいい！全然実装が進んでないから テストばかりにトークン消費させてては時間もトークンももったいないよ」。G5 Phase4 IMPLEMENTATION-FIRST: complete G5-owned backend shared Auth ID + per-app entitlement and idempotency, B1/B2 locked status guard, practical bounded delete/freeze/reconcile implementation or explicitly blocked interface, connection contracts. NO further documents-only/synthetic-model-only or repeated review loops. Only focused local tests; no other slot worktree/source changes. Prior G5 PR heads immutable, new independent G5 branch and draft PR source implementation. Photos/managed auth/prod unchanged; E11 Option D and managed_auth_delete BLOCKED. At K5 decide one focused Sol高 review for high-risk source. 
- latest_result: Phase4 IMPLEMENTED_SOURCE_CANDIDATE (PR152 Draft, stacked on PR121, local PG17 proof incl. real orchestrator E2E; not production ready, no merge/deploy). Report: .agent/tasks/CLAUDE_TASK_5.md#report--phase4. One focused Sol高 review of PR152+PR121 recommended at K5.
- recommended_model: Opus5.5（高）
## Claude G6
- owner: claude
- slot: claude-6
- status: done
- task_id: common-ai-provider-g6-phase2b-market-report-wiring-offline-20261012
- start_code: G6
- finish_code: K6
- next_owner: none
- latest_result: K6 ACCEPTED PASS_OFFLINE_SOURCE_CANDIDATE / PRODUCTION_NO_GO — Draft PR #150 (18d9058a, stacked on unchanged PR148): deferred market report shadow wiring (records during the report, sends after complete within the time left), not wired; handler-boundary harness 11/11 with real openAiRequester/generateSharedAnalysis + fixtures, also under --deny-net and denied key env; mutants 11/11; provider 123 / report 283 / _shared 626; G2 handler patch contract + canary/stop thresholds documented; production=0, paid calls=0. Report: .agent/tasks/CLAUDE_TASK_6.md
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- source: .agent/tasks/CLAUDE_TASK_6.md
- report: .agent/tasks/CLAUDE_TASK_6.md#report--phase2b
- recommended_model: Opus5.5（高）
- allocation: K6 completed; Phase2b **offline-only** full generator-boundary wiring/harness and synthetic tests/docs, new independent G6 Draft PR only. G2 protected PR143/149, market-report handler/notification/worker/migration files; no other G/H edits. If actual handler edit required, document handoff contract and STOP.
- production_mutation_window: FORBIDDEN; no paid API, real report/shadow, Edge secrets, DB/Cron, deploy, merge or live cutover.
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
- status: done
- task_id: news-improvement-a-pr129-release-safety-env-switches-g8-20261012
- start_code: G8
- finish_code: K8
- next_owner: none
- return_to: ニュース改善API最適化のちゃ
- source: .agent/tasks/CLAUDE_TASK_8.md
- report: .agent/tasks/CLAUDE_TASK_8.md#report
- allocation: USER EXPLICIT G8ニュース改善A専任。K8 2026-10-12 PR129 R5デフォルトOFFの独立Fed/TDnetスイッチはソース確認でPASS、branch head `81251b31`、G8報告 important-news768 / extraction34 / discovery+observer162 / shadow20 PASS。新フラグを明示`enabled`しない限り従来ルート、PR129現在OPEN/Draft/未merged、Vercel build-rate-limit失敗をCI greenとしない。G8現TASKはdone/next_owner none、次TASK未割当（同専任を維持し別案件へ引き継がない）。**PR129マージ・本番deployは未承認・未実施**。PR116固定production反映のread-back後にPR129マージ/両フラグOFF deployを検討。G9/他G/Hと別案件不干渉。
- recommended_model: Sonnet5（高） (completed)
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
- status: idle
- task_id: none
- start_code: G10
- finish_code: K10
- next_owner: none
- source: .agent/tasks/CLAUDE_TASK_10.md
- report: .agent/tasks/CLAUDE_TASK_10.md#report
- allocation: 未割当（2026-10-11追加）。用途を固定しない予備枠。ユーザーまたはChatGPTの明示割当時だけ使用し、idleだけで作業開始・自動投入しない。
- recommended_model: none

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
