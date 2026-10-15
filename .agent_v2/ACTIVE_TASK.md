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
- status: ready
- task_id: kabumori-f2-pause-delivery-runtime-candidate-20261015
- owner: claude
- next_owner: claude
- return_to: かぶモリアプリG1のちゃ（運用休止・全体統括）
- completion_code: L2
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F2.md
- current_report_path: .agent_v2/tasks/F2.md#report
- dependencies: F2 design PR #210 merged; F8 news gate runtime; shared POSTONA/AI protected
- blocker: offline implementation only; production NO_GO; live Cron #1/claim/schema and pending queues unverified
- production_mutation_window: FORBIDDEN
- previous_archive: .agent_v2/archive/2026-10-15-f2-pause-offline-design-accepted.md
- slot_use: kabumori X gate/planner/queue/Push source-only candidate after L2 design archived

## F3
- slot: F3
- status: done
- task_id: postona-f3-j3-v3-ack-lease-rollback-corrections-20261015
- owner: claude
- next_owner: none
- return_to: POSTONA G3のちゃ（新F3担当・X投稿／予約担当）
- completion_code: L3
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F3.md
- current_report_path: .agent_v2/tasks/F3.md#report
- dependencies: J3 V3 P2 R1a/R3a/R1b; F3 PR192→189, F5 PR193 Phase8, F4 PR180, G4 Issue131
- blocker: Codex Sol（高） focused R1a/R3a/R1b review; F5 snapshot ACK integration, inherited hold() now(), F3-L1 lock cycle; production NO_GO
- slot_use: L3 PASS_SOURCE_FIX / SECURITY_REREVIEW_REQUIRED / PRODUCTION_NO_GO; PR204 Draft HEAD 45b08a87, 9 F3-owned files, local E2E10/48 mutants reported; F3 done, archive before reuse.
- previous_archive: .agent_v2/archive/2026-10-15-F3-postona-f3-j3-v3-r1-r3-security-fixes-20261013/

## F4
- slot: F4
- status: ready
- task_id: postona-f4-pr211-r2c-final-preview-identity-fix-20261015
- owner: claude
- next_owner: claude
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- completion_code: L4
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F4.md
- current_report_path: .agent_v2/tasks/F4.md#report
- dependencies: J4 V4 CHANGES_REQUIRED P2 R2c, PR211 exact eb1011f2, F5 PR193 handler read-only
- blocker: independent Sol（高） rereview and managed POSTONA integration; production NO_GO
- slot_use: one bounded POSTONA client fix for late final-preview A→B/null user cross-warning return
- previous_archive: .agent_v2/archive/2026-10-15-F4-postona-f4-pr197-p2-response-warning-preservation-20261015/

## F5
- slot: F5
- status: done
- task_id: common-account-f5-phase10-postona-x-ack-snapshot-reconciliation-20261015
- owner: claude
- next_owner: none
- return_to: 共通アカウントG5のちゃ（新F5担当）
- completion_code: L5
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F5.md
- current_report_path: .agent_v2/tasks/F5.md#report
- dependencies: F5 PR121→152→165→178→183→193→206; F3 PR204 L3 pending; F4 PR180; POSTONA PR197/J4
- blocker: F3 ACK snapshot contract L3 pending; managed Auth/RLS/GoTrue unverified; production NO_GO
- slot_use: Phase10 POSTONA common lifecycle ACK snapshot integration; かぶモリ休止は別担当
- previous_archive: .agent_v2/archive/2026-10-15-F5-common-account-f5-phase9-postona-shared-login-enrollment-20261015/
- latest_result: IMPLEMENTED_SOURCE_CANDIDATE — Draft PR #214 head bc290ab618508a8fbaba1abfad308c52d86e4689 stacked on PR206 a84a9b6abb8c8d4706bba5f8a12e5c1aef3d3b8c (PR193 314aeac4, PR183 f2565cc0, PR178 83334a09, PR165 4638891f, PR152 ccea1fe8, PR121 76b50e1e, F3 PR204 45b08a87, F4 PR180 7c4f4578, POSTONA PR197 2171ee4c unchanged): F3 PR204 snapshot-bound ACK consumed in the F5 POSTONA end — (count, snapshot) pair recorded durably BEFORE acknowledging that exact snapshot, a changed set is recorded first then acknowledged (bounded), a pair that cannot be recorded never lets X be done and never lets the saga forget; one new unapplied migration 20261015120000 (shape CHECK widened by x_unconfirmed_snapshots, service_role-only recorder, rollback keeps data); F5-owned fix: another service's entitlement no longer makes single-service flows unreadable; proofs on local PG17 only: migration runner + 25/25 mutants, Edge 140 tests + 36/36, assembled F3 PR204+F4+F5 e2e 39 (X1-X8 ABA/cross-person/crash/takeover/stale lease/rollback/common-ID block/other-app entitlement preserved), release preflight ten-member chain; handoffs: F3 inherited hold()/F3-L1/R2' (POSTONA-only person cannot end POSTONA alone), G3 T13, G4 PR197/PR211, F4 Threads no app-side revoke; open D1 (whole-account deletion reports the unconfirmed count in the response only); production NO_GO. Report: .agent_v2/tasks/F5.md#report

- l5_verdict: PASS_SOURCE_CANDIDATE / SECURITY_REVIEW_REQUIRED / PRODUCTION_NO_GO (2026-10-15); Draft PR214 bc290ab618508a8fbaba1abfad308c52d86e4689, reported PG17 integrated e2e39 + Edge140 and mutation suites. Full-ID deletion D1 consent, F3 legacy issues, G3 T13, POSTONA route, managed Auth and independent security review pending. No merge/deploy.

## F6
- slot: F6
- status: ready
- task_id: common-ai-f6-openai-anthropic-migration-inventory-20261015
- owner: claude
- next_owner: claude
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- completion_code: L6
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F6.md
- current_report_path: .agent_v2/tasks/F6.md#report
- dependencies: F6 PR187 → H5 PR198 → F6 PR205 Draft, J1 independent Sol security review ready
- blocker: review and offline inventory required before production; no merge/deploy or API switching
- slot_use: POSTONA-first full OpenAI API inventory and Anthropic migration plan

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
- blocker: offline implementation only; production NO_GO; PR129/164 index.ts integration and deployed version unverified
- production_mutation_window: FORBIDDEN
- previous_archive: .agent_v2/archive/2026-10-15-f8-pause-offline-design-accepted.md
- slot_use: important-news-monitor all-mode hard pause source-only candidate after L8 design archived

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
- status: idle
- task_id: none
- owner: claude
- next_owner: none
- return_to: none（未割当）
- completion_code: L10
- recommended_model: none
- current_task_path: .agent_v2/tasks/F10.md
- current_report_path: .agent_v2/tasks/F10.md#report
- dependencies: none
- blocker: none
- slot_use: 予備枠（ユーザーまたはChatGPTの明示割当専用）

## J1
- slot: J1
- status: review_required
- task_id: common-ai-j1-f6-h5-pr187-198-205-security-review-20261015
- owner: codex
- next_owner: chatgpt
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- completion_code: V1
- recommended_model: Sol（高）
- current_task_path: .agent_v2/tasks/J1.md
- current_report_path: .agent_v2/reports/J1.md
- dependencies: Draft #187 a7e1d3f3 → Draft #198 4223d5c0 → Draft #205 4cd2cbdd, F6 L6 accepted, H5 C5 accepted
- blocker: source-only independent security audit; no merge/deploy/production/paid calls; all provider and bridge source protected
- slot_use: Independent Claude API header/env, tenant/entitlement, ledger, import boundary review

## J2
- slot: J2
- status: ready
- task_id: kabumori-j2-f2-f8-pause-runtime-integrated-security-review-20261015
- owner: codex
- next_owner: codex
- return_to: かぶモリアプリG1のちゃ（運用休止・全体統括）
- completion_code: V2
- recommended_model: Sol（高）
- current_task_path: .agent_v2/tasks/J2.md
- current_report_path: .agent_v2/reports/J2.md
- dependencies: F8 Draft #212 b80d5235, F2 Draft #213 cb34ab7d, PR129/164; J1 common-AI reserved
- blocker: source-only independent security review; production NO_GO; no merge/deploy
- previous_archive: .agent_v2/archive/2026-10-15-J2-ai-ask-b0-r1-r8-focused-rereview-20261013/
- slot_use: F2/F8 pause runtime combined independent review; Sol(高); J2→V2

## J3
- slot: J3
- status: done
- task_id: postona-j3-pr204-p2x3-security-rereview-20261015
- owner: codex
- next_owner: none
- return_to: POSTONA G3のちゃ（新F3担当・X投稿／予約担当）
- completion_code: V3
- recommended_model: Sol（高）
- current_task_path: .agent_v2/tasks/J3.md
- current_report_path: .agent_v2/reports/J3.md
- dependencies: F3 L3 PR204 45b08a87 stacked PR192; F5 Phase10 PR206/193 ACK integration; F4 PR180, G4 Issue131
- blocker: PR204 focused source PASS; F5 Phase10 snapshot ACK integration, inherited lease/lock concerns and managed gate pending; production NO_GO
- slot_use: V3 ACCEPTED PASS_SOURCE_REVIEW / PRODUCTION_NO_GO; Codex Sol（高） original P2 R1a/R3a/R1b closed for exact PR204 45b08a87. F5 Phase10 integration pending. Archive J3 before reuse.
- previous_archive: .agent_v2/archive/2026-10-15-J3-postona-j3-x-saga-r1-r3-focused-rereview-20261014/

## J4
- slot: J4
- status: done
- task_id: postona-j4-pr211-p2-client-fixes-focused-security-rereview-20261015
- owner: codex
- next_owner: none
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- completion_code: V4
- recommended_model: Sol（高）
- current_task_path: .agent_v2/tasks/J4.md
- current_report_path: .agent_v2/reports/J4.md
- dependencies: F4 PR211 eb1011f2 stacked PR197 2171ee4c; J4 V4 previous P2x2; F5 PR193 exact handler contract
- blocker: CHANGES_REQUIRED P2 R2c: late final-preview auth switch retains prior-user warnings in helper return; current screen hides them. Original R1/R2 repros fixed. Separate F5/managed/legacy gates; production NO_GO
- slot_use: independent P2 R1/R2 POSTONA mobile rerun with actual F5 handler synthetic tests
- previous_archive: .agent_v2/archive/2026-10-15-J4-postona-j4-pr197-postona-deletion-client-security-review-20261014/
- v4_verdict: CHANGES_REQUIRED P2 R2c; original R1/R2 repaired, late final-preview cross-account helper warning not sanitized, screen remains guarded. Reviewed PR211, app294 and Deno120 independently PASS, no source modification; J4 released and archive needed before reuse.

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
