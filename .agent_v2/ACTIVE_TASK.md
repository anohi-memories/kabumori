# Active Tasks Index v2（新系統15枠）

新系統（F1〜F10 / J1〜J5）の現在状態だけを置く索引。詳細と正本は各TASK / Report。過去のK / L / C / V判定は書かない。statusだけで空き判定しない。

- 旧系統（G1〜G10 / H1〜H5）の索引は `.agent/ACTIVE_TASK.md`（移行期間中の現行正本）。
- 単独 `F` は、移行期間中この索引と旧索引の両方を見て新旧30枠を統括する（`.agent_v2/ORCHESTRATION.md`）。
- 導入PRのmerge前は新系統を使わない。merge後も、TASKが置かれるまで全枠 `idle`。

## F1
- slot: F1
- status: done
- task_id: kabumori-f1-ai-ask-v1-phase-a-ui-contract-20261012
- owner: claude
- next_owner: none
- return_to: かぶモリアプリG1のちゃ（新F1担当）
- completion_code: L1
- recommended_model: Opus5.5（中）
- current_task_path: .agent_v2/tasks/F1.md
- current_report_path: .agent_v2/tasks/F1.md#report
- dependencies: G2 reports PR143/149/158, G5 Auth, G6 provider, G8/G9 news. Old G1 task cancelled before start.
- blocker: none for mock/offline Phase A; Phase B production/security separate
- slot_use: かぶモリアプリ AIに聞く V1 Phase A UI/contract

## F2
- slot: F2
- status: done
- task_id: kabumori-f2-pr143-live-mergeability-diagnosis-20261012
- owner: claude
- next_owner: none
- return_to: かぶモリアプリ G2（新F2担当）のちゃ
- completion_code: L2
- recommended_model: Sonnet5（高）
- current_task_path: .agent_v2/tasks/F2.md
- current_report_path: .agent_v2/tasks/F2.md#report
- dependencies: PR143 → PR149 → PR158; old G2 unstarted task cancelled
- blocker: GitHub PR143 currently reports mergeable=false via connected metadata; fresh verification needed at merge execution
- slot_use: かぶモリアプリ

## F3
- slot: F3
- status: in_progress
- task_id: postona-f3-x-reservation-live-boundary-source-integration-20261012
- owner: claude
- next_owner: claude
- return_to: POSTONA G3のちゃ（新F3担当・AI自動投稿／X予約担当チャット）
- completion_code: L3
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F3.md
- current_report_path: .agent_v2/tasks/F3.md#report
- dependencies: 旧G3 K3 accepted done; protected Draft PR145→PR151→PR163, F5/G5 entitlement, G4 X Issue131, F4 Threads separate
- blocker: production auth/entitlement/X ownership real guards not integrated; offline source work ready; no production authorization
- slot_use: POSTONA X予約 Edge/Auth/DB実接続ソース実装（本番OFF、F3→L3）

## F4
- slot: F4
- status: ready
- task_id: postona-f4-threads-disconnect-lease-safe-v1-20261012
- owner: claude
- next_owner: claude
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- completion_code: L4
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F4.md
- current_report_path: .agent_v2/tasks/F4.md#report
- dependencies: G4 PR154, G5 PR152 corrected, H5 PR159; G3 X booking protected
- blocker: real pilot/production NO_GO; G5 adapter registration separate
- slot_use: POSTONA Threads（旧G4の後継）

## F5
- slot: F5
- status: done
- task_id: common-account-f5-phase5-app-auth-entitlement-integration-20261012
- owner: claude
- next_owner: none
- return_to: 共通アカウントG5のちゃ（新F5担当）
- completion_code: L5
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F5.md
- current_report_path: .agent_v2/tasks/F5.md#report
- dependencies: old G5 K5 done; PR152 head ccea1fe8132c6f573a768f0df5a033a05c62ef2c stacked PR121 head 76b50e1e03f82faaa3460bab1603afa8fef3ce44; app owner G1/G2/G3/G4 source protected
- blocker: production/no managed Auth; app-owner wiring separate, must be explicitly coordinated
- slot_use: 共通アカウント基盤 Phase5 本人Auth/サービス登録のG5-owned接続実装（ユーザー明示割当）
- l5_verdict: PASS_SOURCE_CANDIDATE / PRODUCTION_NO_GO; app enrollment existing wiring confirmed; PR165 worker entitlement functions source candidate, G3/G4 publish RPC integration outstanding; no merge/deploy.
- latest_result: IMPLEMENTED_SOURCE_CANDIDATE — Draft PR #165 head 4638891f6c7ff432e08d462019594e1ec3d66f07 stacked on PR152 ccea1fe8132c6f573a768f0df5a033a05c62ef2c (PR121 76b50e1e03f82faaa3460bab1603afa8fef3ce44): real app enrollment modules vs real SQL contract test (13 scenarios) + workspace service-state primitives for service-role workers; local PG17 only, production NO_GO; G3/G4 wiring requested in docs/common-account/phase5-app-integration.md section 4. Report: .agent_v2/tasks/F5.md#report

## F6
- slot: F6
- status: idle
- task_id: none
- owner: claude
- next_owner: none
- return_to: none（未割当）
- completion_code: L6
- recommended_model: none
- current_task_path: .agent_v2/tasks/F6.md
- current_report_path: .agent_v2/tasks/F6.md#report
- dependencies: none
- blocker: none
- slot_use: 予備枠（ユーザーまたはChatGPTの明示割当専用）

## F7
- slot: F7
- status: idle
- task_id: none
- owner: claude
- next_owner: none
- return_to: none（未割当）
- completion_code: L7
- recommended_model: none
- current_task_path: .agent_v2/tasks/F7.md
- current_report_path: .agent_v2/tasks/F7.md#report
- dependencies: none
- blocker: none
- slot_use: 予備枠（ユーザーまたはChatGPTの明示割当専用）

## F8
- slot: F8
- status: ready
- task_id: news-improvement-a-jp-official-diagnostics-j1a-f8-20261012
- owner: claude
- next_owner: claude
- return_to: ニュース改善API最適化のちゃ
- completion_code: L8
- recommended_model: Sonnet5（高）
- current_task_path: .agent_v2/tasks/F8.md
- current_report_path: .agent_v2/tasks/F8.md#report
- dependencies: G8 J0 accepted; old G8 J1-a unstarted/cancelled
- blocker: L8 minor fix required: diagnostics reason key budget may produce 41st key; PR164 remains unmerged, production HOLD
- slot_use: ニュース改善A専任（ユーザー明示割当）

## F9
- slot: F9
- status: idle
- task_id: none
- owner: claude
- next_owner: none
- return_to: none（未割当）
- completion_code: L9
- recommended_model: none
- current_task_path: .agent_v2/tasks/F9.md
- current_report_path: .agent_v2/tasks/F9.md#report
- dependencies: none
- blocker: none
- slot_use: 予備枠（ユーザーまたはChatGPTの明示割当専用）

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
- status: idle
- task_id: none
- owner: codex
- next_owner: none
- return_to: none（未割当）
- completion_code: V1
- recommended_model: none
- current_task_path: .agent_v2/tasks/J1.md
- current_report_path: .agent_v2/reports/J1.md
- dependencies: none
- blocker: none
- slot_use: レビュー・バグ修正・検証（案件固定なし）

## J2
- slot: J2
- status: idle
- task_id: none
- owner: codex
- next_owner: none
- return_to: none（未割当）
- completion_code: V2
- recommended_model: none
- current_task_path: .agent_v2/tasks/J2.md
- current_report_path: .agent_v2/reports/J2.md
- dependencies: none
- blocker: none
- slot_use: レビュー・バグ修正・検証（案件固定なし）

## J3
- slot: J3
- status: idle
- task_id: none
- owner: codex
- next_owner: none
- return_to: none（未割当）
- completion_code: V3
- recommended_model: none
- current_task_path: .agent_v2/tasks/J3.md
- current_report_path: .agent_v2/reports/J3.md
- dependencies: none
- blocker: none
- slot_use: レビュー・バグ修正・検証（案件固定なし）

## J4
- slot: J4
- status: idle
- task_id: none
- owner: codex
- next_owner: none
- return_to: none（未割当）
- completion_code: V4
- recommended_model: none
- current_task_path: .agent_v2/tasks/J4.md
- current_report_path: .agent_v2/reports/J4.md
- dependencies: none
- blocker: none
- slot_use: レビュー・バグ修正・検証（案件固定なし）

## J5
- slot: J5
- status: idle
- task_id: none
- owner: codex
- next_owner: none
- return_to: none（未割当）
- completion_code: V5
- recommended_model: none
- current_task_path: .agent_v2/tasks/J5.md
- current_report_path: .agent_v2/reports/J5.md
- dependencies: none
- blocker: none
- slot_use: Codex臨時実装の優先枠（基本は空けておく）

## コード

- `F1`〜`F10`: 新Claude枠の開始。完了確認は `L1`〜`L10`（1対1）。
- `J1`〜`J5`: 新Codex枠の開始。完了確認は `V1`〜`V5`（1対1）。
- 単独 `F`（数字なし）: 新旧30枠の統括。`F1`〜`F10` とは完全一致で区別する。
