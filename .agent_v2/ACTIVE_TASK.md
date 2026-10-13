# Active Tasks Index v2（新系統15枠）

新系統（F1〜F10 / J1〜J5）の現在状態だけを置く索引。詳細と正本は各TASK / Report。過去のK / L / C / V判定は書かない。statusだけで空き判定しない。

- 旧系統（G1〜G10 / H1〜H5）の索引は `.agent/ACTIVE_TASK.md`（移行期間中の現行正本）。
- 単独 `F` は、移行期間中この索引と旧索引の両方を見て新旧30枠を統括する（`.agent_v2/ORCHESTRATION.md`）。
- 導入PRのmerge前は新系統を使わない。merge後も、TASKが置かれるまで全枠 `idle`。

## F1
- slot: F1
- status: done
- task_id: kabumori-f1-ai-ask-v1-phase-b0-security-preflight-20261013
- owner: claude
- next_owner: none
- return_to: かぶモリアプリG1のちゃ（新F1担当）
- completion_code: L1
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F1.md
- current_report_path: .agent_v2/tasks/F1.md#report
- dependencies: Phase A Draft PR166; G2 merged PR143/149/158; F5 common Auth; G6 provider; G8 news; G9 cost
- blocker: security architecture preflight and user decisions before live data/API
- slot_use: かぶモリアプリ AIに聞く V1 Phase B0 セキュリティ事前設計（read-only／offline、本番NO_GO）

## F2
- slot: F2
- status: done
- task_id: kabumori-f2-opus-primary-morning-close-handler-20261013
- owner: claude
- next_owner: none
- return_to: かぶモリアプリG2のちゃ（新F2担当）
- completion_code: L2
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F2.md
- current_report_path: .agent_v2/tasks/F2.md#report
- dependencies: PR170→PR173 source candidates; Opus follow-on belongs to F6 task common-ai-f6-opus-primary-both-integration-20261013
- blocker: none for F2 slot. PR173 Draft/unmerged, production NO_GO, F6 integration dependencies unresolved
- l2_verdict: PASS_OFFLINE_SOURCE / TRANSFER_F6 / PRODUCTION_NO_GO
- slot_use: かぶモリアプリ; free after L2, next task must archive current F2 TASK and confirm no conflicts

## F3
- slot: F3
- status: done
- task_id: postona-f3-x-reservation-live-boundary-source-integration-20261012
- owner: claude
- next_owner: none
- return_to: POSTONA G3のちゃ（新F3担当・AI自動投稿／X予約担当チャット）
- completion_code: L3
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F3.md
- current_report_path: .agent_v2/tasks/F3.md#report
- dependencies: 旧G3 K3 accepted done; protected Draft PR145→PR151→PR163, F5/G5 entitlement, G4 X Issue131, F4 Threads separate
- blocker: G4 X verified-account Issue131 and G5/F5 actual production approved entitlement/lifecycle + managed Auth/role/secret proof; integration security review; production NO_GO
- slot_use: POSTONA X予約 Edge/Auth/DB source accepted at L3 PR168 (4b491668); real driver local 9/9, Deno29/29, app330/330, mutation21/21 reported; source gates OFF; no merge/deploy/X post; slot complete/unreserved

## F4
- slot: F4
- status: done
- task_id: postona-f4-threads-t13-authenticated-writer-integration-20261013
- owner: claude
- next_owner: none
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- completion_code: L4
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F4.md
- current_report_path: .agent_v2/tasks/F4.md#report
- dependencies: F4 PR167, F5 PR165 G5 PR121/152, H5 PR159 (all Draft source); old F4 archived in .agent_v2/archive/2026-10-13-F4-postona-f4-threads-disconnect-lease-safe-v1-20261012/
- blocker: F5 contract owner boundary and H5 guarded writer interface must be checked with independent source overlay; live production NO_GO; F4 reported Draft PR169 head fd15430ddcd640c5c7389582f37f1b478fc7204c (base PR167 branch), awaiting L4
- l4_verdict: PASS_SOURCE_IMPLEMENTATION / SECURITY_REVIEW_REQUIRED / PRODUCTION_NO_GO; Draft PR169 HEAD fd15430ddcd640c5c7389582f37f1b478fc7204c, 14 Threads paths, source-only; F4 released after L4. Next new task requires archive.
- slot_use: POSTONA Threads new T13 writer integration; no F3/F5/G5/H5 changes

## F5
- slot: F5
- status: ready
- task_id: common-account-f5-phase6-postona-provider-cleanup-service-deletion-20261013
- owner: claude
- next_owner: claude
- return_to: 共通アカウントG5のちゃ（新F5担当）
- completion_code: L5
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F5.md
- current_report_path: .agent_v2/tasks/F5.md#report
- dependencies: G5 PR121/152, F5 PR165, F4 PR167/169, H5 PR159, F3 X owner coordination
- blocker: all PRs Draft/unmerged; production NO_GO; source-only lease/Threads adapter integration and remote-unverified policy
- slot_use: 共通アカウント基盤 F5 Phase6 POSTONA provider cleanup/service_deletion contract; previous F5 archived

## F6
- slot: F6
- status: ready
- task_id: common-ai-f6-opus-primary-both-integration-20261013
- owner: claude
- next_owner: claude
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- completion_code: L6
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F6.md
- current_report_path: .agent_v2/tasks/F6.md#report
- dependencies: F6 PR170 → F2 PR173 (F2 L2 awaiting), F2-owned handler/test changes protected; new F6-only provider both-cycle PR
- blocker: Pending F2 L2, source/merge gate, Supabase Edge Secret, scoped deployment and live mode; monthly $5 trial cost cap
- slot_use: 共通AI基盤 Opus PRIMARY morning + close, today close priority

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
- status: done
- task_id: news-improvement-a-jp-official-diagnostics-j1a-f8-20261012
- owner: claude
- next_owner: none
- return_to: ニュース改善API最適化のちゃ
- completion_code: L8
- recommended_model: Sonnet5（高）
- current_task_path: .agent_v2/tasks/F8.md
- current_report_path: .agent_v2/tasks/F8.md#report
- dependencies: G8 J0 accepted; old G8 J1-a unstarted/cancelled
- blocker: none for source; PR164 merge/deploy remain on hold pending separate approval and updated integration review
- slot_use: ニュース改善A専任（ユーザー明示割当）

## F9
- slot: F9
- status: review_required
- task_id: api-optimization-b-f9-rights-safe-provider-compare-pr-readiness-20261013
- owner: claude
- next_owner: chatgpt
- return_to: ニュース改善API最適化のちゃ
- completion_code: L9
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F9.md
- current_report_path: .agent_v2/tasks/F9.md#report
- dependencies: old G9 R3 K9 done; clean branch c476ef8a
- blocker: old PR115 unsafe rights/history; no provider calls or release approval
- slot_use: API最適化B専任（ユーザー明示）

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
- task_id: kabumori-j1-ai-ask-b0-independent-security-review-20261013
- owner: codex
- next_owner: chatgpt
- return_to: かぶモリアプリG1のちゃ（新F1担当）
- completion_code: V1
- recommended_model: Sol（高）
- current_task_path: .agent_v2/tasks/J1.md
- current_report_path: .agent_v2/reports/J1.md
- dependencies: F1 Phase B0 PR171; Phase A PR166; G2/G5/F5/G6 read-only dependencies
- blocker: none for source-only pre-review; Phase B1/live remains NO_GO
- slot_use: 独立セキュリティ設計レビュー（AIに聞く Phase B0）

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
