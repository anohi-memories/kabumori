# Active Tasks Index v2（新系統15枠）

新系統（F1〜F10 / J1〜J5）の現在状態だけを置く索引。詳細と正本は各TASK / Report。過去のK / L / C / V判定は書かない。statusだけで空き判定しない。

- 旧系統（G1〜G10 / H1〜H5）の索引は `.agent/ACTIVE_TASK.md`（移行期間中の現行正本）。
- 単独 `F` は、移行期間中この索引と旧索引の両方を見て新旧30枠を統括する（`.agent_v2/ORCHESTRATION.md`）。
- 導入PRのmerge前は新系統を使わない。merge後も、TASKが置かれるまで全枠 `idle`。

## F1
- slot: F1
- status: done
- task_id: kabumori-f1-ai-ask-b0-terminal-finish-auth-fix-20261014
- owner: claude
- next_owner: none
- return_to: かぶモリアプリG1のちゃ（新F1担当）
- completion_code: L1
- recommended_model: Sonnet5（高）
- current_task_path: .agent_v2/tasks/F1.md
- current_report_path: .agent_v2/tasks/F1.md#report
- dependencies: J4 R3-P2 (terminal finish AUTH); PR186 v3; PR177/171/166 protected
- blocker: B1 and production NO_GO until independent focused re-review
- slot_use: AIに聞く B0 終端finish再返却の認可修正（J4残件1件）

## F2
- slot: F2
- status: review_required
- task_id: kabumori-f2-pause-delivery-runtime-candidate-20261015
- owner: claude
- next_owner: chatgpt
- return_to: かぶモリアプリG1のちゃ（運用休止・全体統括）
- completion_code: L2
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F2.md
- current_report_path: .agent_v2/tasks/F2.md#report
- dependencies: F2 design PR #210 merged; F8 news gate runtime; shared POSTONA/AI protected
- blocker: L2 PASS_SOURCE_FIX / SECURITY_FOCUSED_REREVIEW_REQUIRED; Draft #213 head c10f1da593ba3dc365cf340e9569ae1caa9789b1; J2 R2(P1)/R3(P2) corrected in source candidate; production NO_GO; managed preflight pending
- production_mutation_window: FORBIDDEN
- previous_archive: .agent_v2/archive/2026-10-15-f2-pause-offline-design-accepted.md
- slot_use: kabumori X gate/planner/queue/Push source-only candidate after L2 design archived

## F3
- slot: F3
- status: done
- task_id: postona-f3-x-reservation-oauth-entitlement-dispatch-integration-20261016
- owner: claude
- next_owner: none
- return_to: POSTONA G3のちゃ（新F3担当・X投稿／予約担当）
- completion_code: L3
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F3.md
- current_report_path: .agent_v2/tasks/F3.md#report
- dependencies: G3 PR145/151/163, F3 PR204, F5 PR214 and active P2 fix, F4 PR217, G4 Issue131
- blocker: F5/G4 Auth entitlement and OAuth owner guards, F3-L1/R2', production NO_GO
- slot_use: L3 PASS_SOURCE_CANDIDATE / PRODUCTION_NO_GO; PR224 head 2a9d6473, PG17 D3 10 cases reported, 28 mutants, G4/G3/F5 integration outstanding; archive before reuse.
- previous_archive: .agent_v2/archive/2026-10-16-F3-postona-f3-j3-v3-ack-lease-rollback-corrections-20261015/

## F4
- slot: F4
- status: ready
- task_id: postona-f4-mobile-auth-entitlement-x-threads-integration-readiness-20261016
- owner: claude
- next_owner: claude
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- completion_code: L4
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F4.md
- current_report_path: .agent_v2/tasks/F4.md#report
- dependencies: J4 V4 CHANGES_REQUIRED P2 R2c, PR211 exact eb1011f2, F5 PR193 handler read-only
- blocker: source-only integration readiness, F3/F5/Threads managed owners, production NO_GO
- slot_use: POSTONA mobile integration readiness for login, entitlement, X reservations, Threads and service lifecycle
- previous_archive: .agent_v2/archive/2026-10-15-F4-postona-f4-pr197-p2-response-warning-preservation-20261015/
- l4_verdict_r2c: PASS_SOURCE_FIX / SECURITY_REREVIEW_REQUIRED / PRODUCTION_NO_GO; PR217 head d4bcd09e Draft, 5 files, Claude reports app313 and F5 seam8 PASS; Codex verification outstanding; F4 released.
- current_assignment: J4 V4 concurrent public-preview monotonic identity fence P2; new F4 TASK, source only, production NO_GO.
- l4_verdict_20261016: PASS_SOURCE_FIX / SECURITY_REREVIEW_REQUIRED / PRODUCTION_NO_GO; PR221 dcae62c6 Draft, 4 mobile files, reported 23/23 focused + 14/14 actual F5 handler seam + app336 PASS; independent Sol focused review needed.
- review_decision: user waived extra Codex rereview for PR221 source; any new security-boundary changes still require risk-based review.

## F5
- slot: F5
- status: ready
- task_id: common-account-f5-phase12-schema-baseline-cron-isolation-offline-20261016
- owner: claude
- next_owner: claude
- return_to: 共通アカウントG5のちゃ（新F5担当）
- completion_code: L5
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F5.md
- current_report_path: .agent_v2/tasks/F5.md#report
- dependencies: F5 PR121→152→165→178→183→193→206→214→220→223; F3 PR204; F4 PR180; G3 T13, POSTONA G4 and full-ID D1
- blocker: BG1 incomplete schema baseline and BG2 unsafe production Cron/network migrations; production and managed disposable operations not authorized
- slot_use: Phase12 source-only baseline provenance/unsafe migration isolation with negative local tests; POSTONA shared Auth focus
- previous_archive: .agent_v2/archive/2026-10-16-F5-common-account-f5-phase11-postona-managed-auth-isolated-test-readiness-20261016/

## F6
- slot: F6
- status: done
- task_id: common-ai-f6-pr219-j1-r1a-a1-correction-20261016
- owner: claude
- next_owner: none
- blocker: L6 PASS_SOURCE_FIX; PR222 R1a/A1 independent focused security delta review required; existing typed errors and NOT_VERIFIED; merge/deploy/production NO_GO
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- completion_code: L6
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F6.md
- current_report_path: .agent_v2/tasks/F6.md#report
- dependencies: J1 V1 CHANGES_REQUIRED P2×2; protected Draft PR187→198→205→219; source-only
- previous_archive: .agent_v2/archive/2026-10-16-f6-j1-r1-r2-source-fix.md
- slot_use: narrow R1a/A1 security correction, POSTONA live wiring excluded

## F7
- slot: F7
- status: ready
- task_id: mic-stage1-formal-verification-s1a-source-f7-20261015
- owner: claude
- next_owner: claude
- return_to: MICのちゃ（Market Intelligence Core専用チャット）
- completion_code: L7
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F7.md
- current_report_path: .agent_v2/tasks/F7.md#report
- dependencies: 旧G7 K7 PASS_DESIGN_ONLY、PR125 Draft design head aa47e40d、2026-10-15 shadow read-only GO_FOR_SOURCE_IMPLEMENTATION（S1-Aのみ）
- blocker: Production/merge/deploy NO_GO。F7開始時にfresh main・独立worktree・他slot競合を再確認。U1 equity no_new_observationはSQL合成テストで証明必須
- slot_use: MIC専属の新規F7 TASK（ユーザー明示指定の段階移行）。S1-A新RPC/migration source＋42 SQL tests/5 mutation plans；S1-B/他境界は別TASK。既存G7完了TASKの移動なし

## F8
- slot: F8
- status: ready
- task_id: kabumori-f8-news-hard-pause-runtime-candidate-20261015
- owner: claude
- next_owner: claude
- return_to: かぶモリアプリG1のちゃ（運用休止・全体統括）
- completion_code: L8
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F8.md
- current_report_path: .agent_v2/tasks/F8.md#report
- dependencies: F8 design PR #209 merged; F2 source candidate; protected PR129/#164 same-handler integration
- blocker: source-only continuation F8 PR164→129→212 integration/fixture & stop preflight plan; no actual merge/deploy/production; observer #43 pending
- production_mutation_window: FORBIDDEN
- previous_archive: .agent_v2/archive/2026-10-15-f8-pause-offline-design-accepted.md
- slot_use: original task_id continuation; integration simulation and read-only preflight plan; L8 return

## F9
- slot: F9
- status: done
- task_id: api-optimization-b-f9-clean-pr190-residual-rights-tests-20261014
- owner: claude
- next_owner: none
- return_to: ニュース改善API最適化のちゃ
- completion_code: L9
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F9.md
- current_report_path: .agent_v2/tasks/F9.md#report
- dependencies: previous L9 accepted and archived; F8 and F9 isolated
- blocker: offline only; production/merge/deploy/paid API prohibited
- slot_use: Redact 288 rights-unconfirmed headlines/76 generated posts in isolated candidate; PR174 and PR115 protected

## F10
- slot: F10
- status: in_progress
- task_id: orchestration-v3-reliable-task-registration-f10-20261016
- owner: claude
- next_owner: claude
- return_to: かぶモリ30枠統括のちゃ（このチャット）
- completion_code: L10
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F10.md
- current_report_path: .agent_v2/tasks/F10.md#report
- dependencies: PROJECT_RULES / old-new ORCHESTRATION / protected Draft PR172 / recent failed registration evidence
- blocker: tool safety rejection root cause unproven; V3 independent source only; no live cutover/merge/production
- slot_use: 新管理基盤V3 登録信頼性の原因調査・独立候補実装（旧G/H・現行F/Jは不変更）

## J1
- slot: J1
- status: review_required
- task_id: common-ai-j1-pr222-r1a-a1-focused-review-20261016
- owner: codex
- next_owner: chatgpt
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- completion_code: V1
- recommended_model: Sol（高）
- current_task_path: .agent_v2/tasks/J1.md
- current_report_path: .agent_v2/reports/J1.md
- dependencies: prior V1 CHANGES_REQUIRED P2x2 archived; F6 L6 source fix Draft PR222 11835df1 based PR219 be35cc93; protected #187→#198→#205→#219→#222
- blocker: CHANGES_REQUIRED P2×1 raw-trivia string-fragment import bypass + P3×1 valid named-import false rejection; A1 five-status accounting/cap fixed. Source merge HOLD / production NO_GO; prior blocked verification remains NOT_VERIFIED and was not retried.
- previous_task_archive: .agent_v2/archive/2026-10-16-j1-pr219-focused-rereview-task.md
- previous_report_archive: .agent_v2/archive/2026-10-16-j1-pr219-focused-rereview-report.md
- slot_use: PR222 focused rereview complete; typed provider+bridge173/market324 PASS, independent acceptance2 FAIL; J1-only completion sync pending; return V1 to 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）.

## J2
- slot: J2
- status: review_required
- task_id: kabumori-j2-f2-f8-pause-three-findings-focused-rereview-20261016
- owner: codex
- next_owner: chatgpt
- return_to: かぶモリアプリG1のちゃ（運用休止・全体統括）
- completion_code: V2
- recommended_model: Sol（高）
- current_task_path: .agent_v2/tasks/J2.md
- current_report_path: .agent_v2/reports/J2.md
- dependencies: F8 Draft #212 d04ff9d2227bbb0e43d7ddbcf8c3b5cc7ad54d3a; F2 Draft #213 c10f1da593ba3dc365cf340e9569ae1caa9789b1; PR129/164 protected
- blocker: CHANGES_REQUIRED P1 R1 residual: concurrent entry OFF does not fence pending egress true, mock X still sent. R2/R3 PASS; production/merge/deploy NO_GO.
- previous_archive: .agent_v2/archive/2026-10-16-J2-f2-f8-pause-integrated-review/
- slot_use: Three-findings focused independent rereview complete; archive SHA256/restore 2/2 PASS; tests 79 PASS / 1 FAIL; return V2 to かぶモリアプリG1のちゃ（運用休止・全体統括）.

## J3
- slot: J3
- status: review_required
- task_id: kabumori-j3-f2-f8-pause-three-findings-focused-rereview-20261016
- owner: codex
- next_owner: chatgpt
- return_to: かぶモリアプリG1のちゃ（運用休止・全体統括）
- completion_code: V3
- recommended_model: Sol（高）
- current_task_path: .agent_v2/tasks/J3.md
- current_report_path: .agent_v2/reports/J3.md
- dependencies: F8 PR212 d04ff9d2, F2 PR213 c10f1da5, prior J2 review; J2 protected/possibly already running
- blocker: USER_STOPPED_DUPLICATE_REVIEW; not completed or archived; outstanding worktree/Report NOT_VERIFIED; do not restart; production NO_GO
- previous_archive: .agent_v2/archive/2026-10-16-J3-common-account-pr214-review/
- slot_use: paused/cancelled by user after J2 duplication; G1 reconcile before reallocation

## J4
- slot: J4
- status: done
- task_id: postona-j4-pr217-r2c-final-preview-focused-rereview-20261015
- owner: codex
- next_owner: none
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- completion_code: V4
- recommended_model: Sol（高）
- current_task_path: .agent_v2/tasks/J4.md
- current_report_path: .agent_v2/reports/J4.md
- dependencies: PR217 d4bcd09e stacked PR211 eb1011f2 / PR197 2171ee4c; actual F5 PR193 handler; F5 PR214 integration separate
- blocker: CHANGES_REQUIRED P2: concurrent public preview B/null observations bypass active end sticky fence; stale A settle can return completion/facts. Original serial R2c fixed, screen guarded; production NO_GO
- slot_use: PR217 focused independent concurrency rereview with actual F5 synthetic seam; no product changes
- previous_archive: .agent_v2/archive/2026-10-15-J4-postona-j4-pr211-p2-client-fixes-focused-security-rereview-20261015/
- v4_verdict: CHANGES_REQUIRED P2 x1; original R2c 2 FAIL→2 PASS, focused19/seam8/app313 PASS, new concurrency 4 FAIL/2 controls PASS. Await coordinator V4.
- latest_assignment: PR217 focused review completed 2026-10-16; return to POSTONA G4 coordinator, V4.

## J5
- slot: J5
- status: idle
- task_id: none
- owner: codex
- next_owner: none
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- completion_code: V5
- recommended_model: none
- current_task_path: .agent_v2/tasks/J5.md
- current_report_path: .agent_v2/reports/J5.md
- dependencies: J4 V4 CHANGES_REQUIRED P2 R1/R2, PR197 HEAD 2171ee4c, F5 PR193 typed response; no F3/F5/F4 backend changes
- blocker: PRODUCTION_NO_GO, owner server/Auth/SNS and independent review remain
- slot_use: user-directed Codex emergency POSTONA client fix, outcome mandatory evidence and warning preservation, original J5 archived
- cancellation: prior unstarted task archived; new F4 task owns correction.

## コード

- `F1`〜`F10`: 新Claude枠の開始。完了確認は `L1`〜`L10`（1対1）。
- `J1`〜`J5`: 新Codex枠の開始。完了確認は `V1`〜`V5`（1対1）。
- 単独 `F`（数字なし）: 新旧30枠の統括。`F1`〜`F10` とは完全一致で区別する。
