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
- task_id: kabumori-fact-v2-pr132-final-integrated-review-20261011
- start_code: H2
- finish_code: C2
- completion_code: C2
- next_owner: none
- return_to: かぶモリアプリG2のちゃ
- source: .agent/tasks/CODEX_TASK_2.md
- report: .agent/CODEX_REPORT_2.md
- allocation: C2 COMPLETE CHANGES_REQUIRED — Fact V2 PR132 exact bd424616a135e7bf71592c2ac41acb3e03f8568d on protected PR110 319a442edcd61c07274e3409d8864234f9d77cd4; R1 same-day same-sentence negation exonerates second false affirmation, R2 TOPIX 算出値/ウエート 437円 masquerades as 1306, R3 wrong US postposed date 10/7 stripped. ALL P2 objective-fact guard regressions reproducible X+app mocked delivery; 55/55 baseline focus PASS, independent 14 probes 10 PASS 4 FAIL. Opus grounded inference ALLOW policy CONFIRMED valid; do NOT reverse. Vercel rate limit, not code failure. H2 source edits0; no prod/merge/deploy/paid API. H2 Report saved with historical suffix intact, H2 current TASK done/none, released but not pre-reserved. G2 one bounded correction registered, H2 prior G5 C2 history preserved.
- recommended_model: Sol（高） (completed)
## Codex H3
- owner: codex
- slot: codex-3
- status: review_required
- task_id: kabumori-pr143-ondemand-queue-auth-security-review-20261011
- start_code: H3
- finish_code: C3
- completion_code: C3
- next_owner: chatgpt
- return_to: かぶモリアプリG2のちゃ
- source: .agent/tasks/CODEX_TASK_3.md
- report: .agent/CODEX_REPORT_3.md
- allocation: C3 H3 completed independent read-only review of PR143 exact head 1d0529bb68b0e60b32ce0a2cb0002872b1671177. Result CHANGES_REQUIRED / PRODUCTION_NO_GO due P2 expired-lease failure RPC missing expiry fence; 58 targeted offline tests PASS with --no-check, standard type resolution and disposable PG unavailable. No product source edits or production operations. Common all-users broadcast remains blocker. Return to G2 chat for narrow fix.
- recommended_model: Sol（高）
## Codex H4
- owner: codex
- slot: codex-4
- status: idle
- task_id: none
- start_code: H4
- finish_code: C4
- completion_code: C4
- next_owner: none
- return_to: none（未割当）
- source: .agent/tasks/CODEX_TASK_4.md
- report: .agent/CODEX_REPORT_4.md
- allocation: 未割当（2026-10-11追加）。固定プロジェクト専用にしないCodex枠。割当時に return_to / completion_code C4 / 推薦モデルを必ず記入する。
- recommended_model: none
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
- status: done
- task_id: kabumori-portfolio-holdings-stale-valuation-guard-20261011
- start_code: G1
- finish_code: K1
- next_owner: none
- return_to: かぶモリアプリG1のちゃ
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: K1 PR142 final PASS_SOURCE_IMPLEMENTATION after focused reload safety correction on exact PR head cfaf5dcf8d24b942988c10acf7a3959c05dba20a; PR OPEN/UNMERGED, explicit user permission still required for merge. G1 source-only: saved vs current five-field match guards holdings row P/L, impact top3 and aggregate. On focus/pull reload, valuation eligibility closes immediately and reopens only after current generation finishes; latest-wins fetch fence prevents older responses resetting the view. Claude reported focused 26/26 PASS and full app 521/521 PASS; tsc 2 existing CSS/typing diagnostics (no new), 375pt fixture pass, no native real-account edit. CI Vercel rate limited, NOT green; latest main files no PR overlap. No native five-tab, DB/Auth/API/Edge/EAS/production changes. G1 done/free subject to fresh slot/worktree review. Old report Oct7–9 gap explicitly no fix; G2 cutover untouched.
- recommended_model: Sonnet5（中）
## Claude G2
- owner: claude
- slot: claude-2
- status: done
- task_id: kabumori-personalized-ondemand-background-push-v1-20261011
- start_code: G2
- finish_code: K2
- next_owner: none
- return_to: かぶモリアプリG2のちゃ
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: K2 2026-10-11 accepted [Draft PR143] exact 1d0529bb68b0e60b32ce0a2cb0002872b1671177 as PASS_SOURCE_CANDIDATE_WITH_BROADCAST_BLOCKER / PRODUCTION_NO_GO. G2 reported 1,616/1,616 offline Deno/app plus disposable PG17 ACL/RLS/concurrency/13 mutations PASS; ChatGPT source-inspected but did not rerun. 30 files: authenticated request, DB persisted queue, fenced worker, private results, completion push, common market reader, OFF by default. Missing shared morning/close everyone-broadcast push is blocker; real Edge/Cron/DB/Expo/provider/native NOT_RUN. Separate H3 Sol（高） independent security review allocated; do not merge/apply PR143 before C3. Prior Draft PR141 superseded/protected; other slots untouched. G2 source task finished and released.
- recommended_model: Opus5.5（高） (completed)
## Claude G3
- owner: claude
- slot: claude-3
- status: ready
- task_id: postona-x-reservation-store-offline-v1-g3-20261011
- start_code: G3
- finish_code: K3
- next_owner: claude
- return_to: POSTONA G3のちゃ（AI自動投稿・X予約担当チャット）
- source: .agent/tasks/CLAUDE_TASK_3.md
- allocation: User accepted next POSTONA milestone after PR138 local planner was squash-merged. G3 owns isolated **X-only AI/manual reservation durable backend candidate**: new offline SQL candidate/store/RPC or trustworthy port, new reservation claim/lease/finish boundary, save/read/edit/cancel client adapter with explicit disabled-by-default gate, disposable PG17/18 safety tests + app regressions and docs. Source-only Draft PR, never apply SQL/create live posts/X provider calls/migrate/Edge/Cron/EAS/merge. Manual per-post explicit consent vs unattended AI auto_post_preference; G5 active x_autopost entitlement and lifecycle guard, G4 verified X OAuth Issue131 and signed owner permission are hard blocked dependencies, never fake authorize. Stage3B PR127 docs and main 2026100616 migrations are read-only reference, not live. G4 current Threads integration PR140/PR124/PR135/PR139 and G5 local OSS/Auth/T13 PR121 protected; no G4/G5/H5 code overlap. Live activation only after Sol（高） independent integrated Auth/RLS/DB/API review and separate user authorization. At K3 return to this G3 chat.
- recommended_model: Opus5.5（高）
## Claude G4
- owner: claude
- slot: claude-4
- status: ready
- task_id: postona-threads-connect-publish-integrated-offline-v1-g4-20261011
- start_code: G4
- finish_code: K4
- next_owner: claude
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- source: .agent/tasks/CLAUDE_TASK_4.md
- report: .agent/tasks/CLAUDE_TASK_4.md#report
- allocation: User 2026-10-11 explicitly requested proceed to POSTONA Threads authenticated connection + manual TEXT publisher integration. New G4 TASK after K4 accepted PR140 source-only. Opus5.5（高） owns isolated NEW stacked Draft PR (base protected PR140 2e75a6a842e70f3de78558681803b60935fb4251), G4-only glue/tests and P1 server permission/entitlement revocation TOCTOU remediation candidate. Locally combine protected read-only PR124 c30f246409a77080cbc03aef6c4cb72b5481e125, PR135 e38788d6677082138f0990453c7d2f00549666d0, H5 PR139 b4fa672f97592e87682671454e868a92098cbd56, PR140 and mock G5 T13 for end-to-end offline proof, WITHOUT editing original branches/worktrees/H5/G5/G3 files. Resolve / precisely block absent account-credential expiry reader, provider-aware T10 and H5 owner route, and cover revoke-after-claim-before-redeem/HTTP; never bypass true actor/T13. All real Auth/Meta/X/Supabase calls, permissions changes, DB apply, feature flags, Edge deploy, merge, external Threads post forbidden. Keep static connect/publish/app gates false. No H5 allocation, H1-H4 review only at joined Auth/DB/publish release boundary; stop if dirty worktree/overlap. K4 returns here.
- recommended_model: Opus5.5（高）
## Claude G5
- owner: claude
- slot: claude-5
- status: in_progress
- task_id: common-account-phase3h-local-oss-keycloak-safe-pilot-20261011
- start_code: G5
- finish_code: K5
- next_owner: claude
- return_to: 共通アカウントG5のちゃ
- source: .agent/tasks/CLAUDE_TASK_5.md
- report: .agent/tasks/CLAUDE_TASK_5.md#report
- allocation: K5 accepted Phase3g source-only feasibility and freed G5. User 2026-10-11 「すすめて」 expressly chooses next no-photo-downtime local OSS pilot. G5 Phase3h on isolated dedicated worktree/Podman resources, local Supabase OSS + Keycloak with 2-3 fake users and limited E2/E3/E5/E8/E9 evidence; new docs/test fixtures only, new Draft PR. No production or managed Supabase, no Auth0/real credentials/users, no family photo stop, no SQL direct delete E11, no paid actions, no app/DB/Auth/RPC/Edge deploy/merge. Preserve PR121/122/128/130/134/137 and other slots. LOCAL evidence not managed proof; IDP_PREPAUSE_BLOCKED persists. Return K5 for evaluation.
- recommended_model: Sonnet5（高）
## Claude G6
- owner: claude
- slot: claude-6
- status: ready
- task_id: common-ai-provider-g6-phase1g-one-paid-call-ledger-smoke-20261011
- start_code: G6
- finish_code: K6
- next_owner: claude
- latest_result: KEY_COMPAT_VERIFIED_NO_SOURCE_CHANGE / WAIT_HOLD_RELEASE_AND_USER_SETUP — production market-report-analysis has used sb_secret in apikey+Bearer for service_role-only RPCs since 9/17 (claims passed on 10/2 and 10/5 in prod); the smoke refuses before any paid call if the ledger RPC is rejected. No live call, no ledger RPC, paid calls 0. Report: .agent/tasks/CLAUDE_TASK_6.md
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- source: .agent/tasks/CLAUDE_TASK_6.md
- report: .agent/tasks/CLAUDE_TASK_6.md#report
- live_smoke_gate: K6_CONDITIONAL_RELEASE — user Anthropic workspace $10 cap and scoped 0600 key saved; obtain temporary user-owned sb_secret, plan, one fail-closed live smoke only. If ledger probe rejects new secret, 0 paid calls, STOP. No retry. Previous HOLD_SB_SECRET_COMPAT — NEW sb_secret key with Authorization Bearer in ledger_guard.ts may fail JWT verification; user key creation and live smoke WAIT pending G6 offline compatibility check / narrow fix. User can complete Claude Console workspace setup. See G6 TASK safety hold.
- production_mutation_window: RESERVED_NOT_ACTIVE (one paid Claude smoke with only ai_ledger RPC reserve/mark_sent/settle. G5-first and other-writer ACTIVE windows block; CAS open immediately prior, CLOSED immediately after)
- user_authorization: 2026-10-11 「じゃあ進めて」 — approved ONE real Anthropic Opus 5.5 paid test with fixed synthetic payload and live Supabase budget ledger verification; not a broader production provider/cutover authorization.
- allocation: prior Phase1f source/DB PASS, K6 accepted, now G6 Phase1g. Verify dedicated Claude Console workspace $10/month cap + scoped key, ephemeral user-managed Supabase secret test key, no secrets logged; plan=PASS then strictly ONE `--mode=live --ledger=supabase --confirm=ONE_PAID_CALL`, allowed hosts only and <$0.05 upper-bound, no retry or fallback. Independently read-back usage/cost delta and revoke ephemeral key; unexpected provider/safety/auth/conflict => STOP, no workaround. No Supabase Edge Secret/Edge/Cron/other migration/G2 release/PR merge. Past G6 TASK + Report preserved in own TASK. Return K6 only to this common-AI chat.
- recommended_model: Opus5.5（高）
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
- task_id: news-improvement-a-pr129-k8-f7-rotation-and-f9-boundary-g8-20261011
- start_code: G8
- finish_code: K8
- next_owner: claude
- return_to: ニュース改善API最適化のちゃ
- source: .agent/tasks/CLAUDE_TASK_8.md
- report: .agent/tasks/CLAUDE_TASK_8.md#report
- allocation: USER EXPLICIT G8はニュース改善A専任。前TASK `news-improvement-a-pr129-f1-f9-remediation-g8-20261011` K8はCHANGES_REQUIRED：PR129修正984eeb41を確認、F1〜F6/F8の修正あり。F7の10分単位rotationは毎時起動3候補では同じ2候補に固定されるため、G8へ狭いR2是正を再割当。F9 guarded PATCHのstatus/content_hash/判定競合と残留no_post等の方針を確認。PR129 Draft、PR116固定本番と他slotを保護。K8で本チャットへ返却。G9/API-Bは不干渉。
- recommended_model: Opus5.5（高）
## Claude G9
- owner: claude
- slot: claude-9
- status: ready
- task_id: api-optimization-b-g9-r3-clean-history-provider-compare-replacement-20261011
- start_code: G9
- finish_code: K9
- next_owner: claude
- return_to: ニュース改善API最適化のちゃ
- source: .agent/tasks/CLAUDE_TASK_9.md
- report: .agent/tasks/CLAUDE_TASK_9.md#report
- allocation: USER EXPLICIT G9=API最適化B専任。他のG/H・別案件へ引継禁止。R2外部送信権利ゲートはK9でPASS_OFFLINE、ブランチ65c95589。次のB工程は既存PR115に第三者本文18件を含む問題の改善として、fresh main起点の**履歴の綺麗な新規Draft PR候補**の再構築（PR115/旧ブランチの変更・close・force-push・merge/本番使用なし）。G9はB専任維持、R3完了時K9返却。
- recommended_model: Opus5.5（高）
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
