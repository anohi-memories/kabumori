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
- status: ready
- task_id: kabumori-pr149-broadcast-fanout-push-security-review-h2-20261012
- start_code: H2
- finish_code: C2
- completion_code: C2
- next_owner: codex
- return_to: かぶモリアプリG2のちゃ
- source: .agent/tasks/CODEX_TASK_2.md
- report: .agent/CODEX_REPORT_2.md
- allocation: K2 G2 PR149 one independent Sol（高） source-only review: 17-path single commit stack PR143, market morning/close all opted-in dedicated high-scale Expo sender. Focus RLS/SECURITY DEFINER, DB lease/claim/fencing, fanout and source idempotency, project wide 600 msg/sec, ambiguous Expo/individual device >90 risk, sending_enabled OFF mid-flight, silent misses, 10k/100k realistic latency vs mock, important-news isolation, app deep-link and off-by-default rollout. Exact PR149 head 31c509df1c08ecc437ca4b70541284f223c836e2, PR143 base 889ca1b44cf82bd3ecb913818dca568456849feb. No product changes, no merge/deploy/live API. Return C2 to this G2 chat.
- recommended_model: Sol（高）
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
- task_id: kabumori-g1-portfolio-watchlist-simulator-qa-20261012
- start_code: G1
- finish_code: K1
- next_owner: claude
- return_to: かぶモリアプリG1のちゃ
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: 2026-10-12 G1 read-only Simulator QA authorized after PR142 squash merge 4d0d0660831c1bf7403a908592c337c284332cdf. Verify 375pt/402pt portfolio/watchlist/detail navigation with synthetic stale-valuation fixtures. No real user data edits, G2/G5 work, native tabs changes, EAS or deploy. Original K1 report archived in TASK.
- recommended_model: Sonnet5（中）
## Claude G2
- owner: claude
- slot: claude-2
- status: done
- task_id: kabumori-market-report-scalable-broadcast-push-v1-20261012
- start_code: G2
- finish_code: K2
- next_owner: none
- return_to: かぶモリアプリG2のちゃ
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: K2 2026-10-12 accepted PR149 exact head 31c509df1c08ecc437ca4b70541284f223c836e2 stacked on protected PR143 exact 889ca1b44cf82bd3ecb913818dca568456849feb: PASS_SOURCE_CANDIDATE_REVIEW_REQUIRED / PRODUCTION_NO_GO. 17 paths 1 commit source-only, dedicated broadcast PG/Edge (500-user chunk/4 parallel/300 msg-sec cap), opt-in/Fact/late worker unknown/dedup, separate from existing push important-news queue, app market report notification deep-link and off-by-default runbook; G2 reported PG17 local 10k/100k simulations + 19 mutant detection and 1,669 Deno/app runtime tests PASS; ChatGPT inspected source and current PR heads, not independently rerun. Simulated 1万 ~0.7min/10万 ~7.5min at300msg/s; NOT live/receipts. Vercel build-rate-limit not green. H2 Sol（高） risk-focused independent review assigned. G2 slot released/no immediate correction until C2. PR149/PR143/PR141 UNMERGED, no DB/Cron/Edge/Expo/paid/API/prod application.
- recommended_model: Opus5.5（高） (completed)
## Claude G3
- owner: claude
- slot: claude-3
- status: review_required
- task_id: postona-x-reservation-store-offline-v1-g3-20261011
- start_code: G3
- finish_code: K3
- next_owner: chatgpt
- return_to: POSTONA G3のちゃ（AI自動投稿・X予約担当チャット）
- source: .agent/tasks/CLAUDE_TASK_3.md
- allocation: K3 PR145 exact 1306cdc5d37e8b28b4819484846aed00875654b2 CHANGES_REQUIRED two P2. R1 SQL finish() accepts expired lease if claim_due() sweeper did not run; enforce deadline independent of sweep and add real PG regression (no duplicate posting; preserve published idempotence). R2 manual_interval mode accepts arbitrary irregular timestamps because app sends no cadence metadata and SQL checks only 60min gap; transmit intended interval and validate on server atomically with interval tests. Same PR145 source-only candidate, G5/G4 deny stubs / client store flag stay OFF; past reported PG/mutation/Deno/app tests accepted as evidence only, not independently rerun. Do not modify G4/H5/G5 or other worktrees, no live DB/Edge/Cron/OAuth/X/Meta/AI/deploy/merge/EAS. Return K3. Sol（高） independent review only before real G5/G4-integrated Auth/RLS/publisher rollout.
- recommended_model: Opus5.5（中）
## Claude G4
- owner: claude
- slot: claude-4
- status: review_required
- task_id: postona-threads-pr144-c3-r1-session-expiry-lock-fix-g4-20261012
- start_code: G4
- finish_code: K4
- next_owner: chatgpt
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- source: .agent/tasks/CLAUDE_TASK_4.md
- report: .agent/tasks/CLAUDE_TASK_4.md#report
- allocation: User Threads actual text post milestone; H3 independent C3 result one P2 R1 on PR144 session expiry race. Opus5.5（高） G4 task narrowly fixes its owned threads_publish_release_candidate.sql auth.sessions FOR KEY SHARE lock to FOR SHARE/equivalent, and adds deterministic 2-connection fail-before/pass-after proof covering both orderings, member/entitlement/consent regressions and role privilege checks. Exact protected PR144 head d4a1e87b77d1fbd362dc51809ce2d998afda15ea, parent PR140 2e75a6a842e70f3de78558681803b60935fb4251; append scoped fix only if original G4 branch clean/exclusive, else new Draft stacked on PR144. Avoid source work on H5 protected PR139 auth.sessions KEY SHARE, G5 Auth/T13/T10, G3 X scheduler, other slots. No real Supabase/Meta/Auth/API, external post, DB migration apply, GRANT, secret, merge, deploy, EAS or flags. All real Threads connection/pilot gates OFF. K4 exact source+race review when complete, no mechanical repeated full H review.
- recommended_model: Opus5.5（高）
## Claude G5
- owner: claude
- slot: claude-5
- status: done
- task_id: common-account-phase3i-local-findings-safe-lifecycle-plan-20261012
- start_code: G5
- finish_code: K5
- next_owner: none
- return_to: 共通アカウントG5のちゃ
- source: .agent/tasks/CLAUDE_TASK_5.md
- report: .agent/tasks/CLAUDE_TASK_5.md#report
- allocation: K5 2026-10-12 PASS_OFFLINE_DESIGN / READY_FOR_OFFLINE_IMPLEMENTATION_LIMITED / MANAGED_RELEASE_HOLD. Verified Draft PR147 38051f023bfd150f29829a075b6f87fa7c1e3e5f, 1 commit, 8 new design/model/test files, OPEN/DRAFT/UNMERGED, previous G5 PR heads unchanged. G5 reports 32 Deno and 32 mutation checks PASS, ChatGPT inspected source without independent test rerun. U1 Storage policies, U2 actual boundary implementation, U3 managed roles/audit and cross-service same-time verification unproven. No managed/paid/photo/production actions or PR merge; E11, Option D, managed_auth_delete and IDP_PREPAUSE all BLOCKED. Task completed; no next G5 reservation. Future bounded B1 PostgreSQL lock-order offline proof recommended. Other slots protected.
- recommended_model: Opus5.5（高） (completed)
## Claude G6
- owner: claude
- slot: claude-6
- status: ready
- task_id: common-ai-provider-g6-phase2b-market-report-wiring-offline-20261012
- start_code: G6
- finish_code: K6
- next_owner: claude
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- source: .agent/tasks/CLAUDE_TASK_6.md
- report: .agent/tasks/CLAUDE_TASK_6.md#report--phase2b
- recommended_model: Opus5.5（高）
- latest_result: Phase2a K6 PASS_SOURCE_CANDIDATE (PR148 open/Draft, default OFF, not wired), prior Phase1g one paid smoke done/closed. Histories protected in own TASK.
- allocation: Phase2b **offline-only** full generator-boundary wiring/harness and synthetic tests/docs, new independent G6 Draft PR only. G2 protected PR143/149, market-report handler/notification/worker/migration files; no other G/H edits. If actual handler edit required, document handoff contract and STOP.
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
- status: ready
- task_id: news-improvement-a-pr129-release-safety-env-switches-g8-20261012
- start_code: G8
- finish_code: K8
- next_owner: claude
- return_to: ニュース改善API最適化のちゃ
- source: .agent/tasks/CLAUDE_TASK_8.md
- report: .agent/tasks/CLAUDE_TASK_8.md#report
- allocation: ユーザー明示指定 G8=ニュース改善A専任。K8でPR129 R4のQA報告 `MERGE_CANDIDATE(source-only)` を確認、mainとのmerge-treeと一時checkout競合0、G8実施761+34+162+20既存スイートPASS。新規Fed公式声明enrichmentとTDnet決算factsが無条件ONのまま本番へ入るリスクがあるため、同G8限定R5 `news-improvement-a-pr129-release-safety-env-switches-g8-20261012` をreadyで明示登録。両機能の**独立・初期OFF envスイッチ**とON/OFF回帰のみ。PR129はOPEN/Draft/未マージ、Vercelはビルド回数制限、PR116固定本番（10/13予定）は別。ほかG/H・B/G9・worktreeへ一切触れず、G8→K8返却。今回のrelease gateをK8で再評価。
- recommended_model: Sonnet5（高）
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
