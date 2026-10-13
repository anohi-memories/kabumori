# Active Tasks Index v2（新系統15枠）

新系統（F1〜F10 / J1〜J5）の現在状態だけを置く索引。詳細と正本は各TASK / Report。過去のK / L / C / V判定は書かない。statusだけで空き判定しない。

- 旧系統（G1〜G10 / H1〜H5）の索引は `.agent/ACTIVE_TASK.md`（移行期間中の現行正本）。
- 単独 `F` は、移行期間中この索引と旧索引の両方を見て新旧30枠を統括する（`.agent_v2/ORCHESTRATION.md`）。
- 導入PRのmerge前は新系統を使わない。merge後も、TASKが置かれるまで全枠 `idle`。

## F1
- slot: F1
- status: done
- task_id: kabumori-f1-ai-ask-b0-j1-r1-r8-design-correction-20261013
- owner: claude
- next_owner: none
- return_to: かぶモリアプリG1のちゃ（新F1担当）
- completion_code: L1
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F1.md
- current_report_path: .agent_v2/tasks/F1.md#report
- dependencies: J1 Report R1-R8; Phase B0 PR171; Phase A PR166; F5/G6 protected
- blocker: B1 implementation NO_GO until focused J re-review
- slot_use: AIに聞く B0 security design corrections

## F2
- slot: F2
- status: ready
- task_id: kabumori-f2-shared-market-report-x-app-consumer-cutover-20261013
- owner: claude
- next_owner: claude
- return_to: かぶモリアプリG2のちゃ（新F2担当）
- completion_code: L2
- recommended_model: Sonnet5（高）
- current_task_path: .agent_v2/tasks/F2.md
- current_report_path: .agent_v2/tasks/F2.md#report
- dependencies: F6 Opus main merge; X/app consumer settings both OFF; production provider deployment and old/new routing readback required
- blocker: x-test-post and personalized-reports deployed sources differ from main; consumer gate approval and independent prod mutation window not yet granted
- slot_use: かぶモリ共有朝刊/大引け X・アプリ切り替え preflight (read-only & offline)

## F3
- slot: F3
- status: in_progress
- task_id: postona-f3-x-publish-entitlement-guard-20261013
- owner: claude
- next_owner: claude
- return_to: POSTONA G3のちゃ（新F3担当・AI自動投稿／X予約担当チャット）
- completion_code: L3
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F3.md
- current_report_path: .agent_v2/tasks/F3.md#report
- dependencies: F5 Phase5 Draft PR165 4638891f (<- PR152 <- PR121); F3 Draft PR145 -> PR151 -> PR163 -> PR168 4b491668; F4 Threads separate; F5 orchestrates service end / SNS unlink; G4 X Issue131
- blocker: F5 candidate RPCs unmerged/unapplied and G4 verified account unresolved; production publish authority NOT enabled (PRODUCTION_NO_GO)
- slot_use: POSTONA X投稿・予約実行への共通アカウント利用権統合（ソース＋使い捨てDB、本番OFF、F3→L3）。ChatGPT直接指示を2026-10-13にF3が登録（旧TASKはarchive済み）
## F4
- slot: F4
- status: ready
- task_id: postona-f4-threads-cleanup-live-lease-security-fix-20261013
- owner: claude
- next_owner: claude
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- completion_code: L4
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F4.md
- current_report_path: .agent_v2/tasks/F4.md#report
- dependencies: F4 PR169, F5 PR178 Phase6 cleanup_authorized(uuid), protected PR167/154
- blocker: production NO_GO, integrated Sol（高） review needed after source fix
- slot_use: POSTONA Threads F5-reported service deletion live-lease security defect; F4-owned source only
- previous_task_archive: .agent_v2/archive/2026-10-13-F4-postona-f4-threads-t13-authenticated-writer-integration-20261013/

## F5
- slot: F5
- status: ready
- task_id: common-account-f5-phase7-auth-lifecycle-release-preflight-20261013
- owner: claude
- next_owner: claude
- return_to: 共通アカウントG5のちゃ（新F5担当）
- completion_code: L5
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F5.md
- current_report_path: .agent_v2/tasks/F5.md#report
- dependencies: old G5 K5 done; F5 Phase5/6 L5 accepted and archived; PR121→152→165→178 Draft; F4 live lease guard correction and F3 X runtime separate
- blocker: production NO_GO; managed GoTrue/PostgREST/Auth/Storage unverified, F4 lease fix and F3 integration pending
- slot_use: 共通ID・利用登録・退会のdisposable PG/Auth release preflight / source-only Phase7; other slots protected
- previous_archive: .agent_v2/archive/2026-10-13-F5-common-account-f5-phase6-postona-provider-cleanup-service-deletion-20261013/

## F6
- slot: F6
- status: done
- task_id: common-ai-f6-opus-both-integration-release-gate-20261013
- owner: claude
- next_owner: none
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- completion_code: L6
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F6.md
- current_report_path: .agent_v2/tasks/F6.md#report
- dependencies: stacked PR170→173→175→176, F2 L2 source done; deployment includes 7 unapplied F2 changes; X/app shared consumer gates OFF
- blocker: SOURCE_MERGE_CANDIDATE (4-PR composition PASS: report 324, _shared 613; no conflict; PR170 false = GitHub UNKNOWN while recomputing) / RELEASE_NO_GO pending approvals: 4-PR merge, F2 bundled-deploy of 7 commits, PRIMARY_MODEL secret, deploy byte check, mode ON; consumer gates OFF (x-test-post v144 & personalized-reports v45 behind main); earliest 2026-10-14 07:55
- slot_use: shared AI Opus Primary morning/close source integration release gate

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
- task_id: news-improvement-a-f8-j1b2-visibility-policy-migration-candidate-20261013
- owner: claude
- next_owner: claude
- return_to: ニュース改善API最適化のちゃ
- completion_code: L8
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F8.md
- current_report_path: .agent_v2/tasks/F8.md#report
- dependencies: J1-b L8 accepted, archived, SHA256 verified/indexed
- blocker: DB migration candidate offline only, requires Sol（高）review and separate application approval
- slot_use: 国内ニュース改善A専任。J1-b2: app visibility policy/SQL candidate and synthetic proof. F9 PR174 and other slots protected.

## F9
- slot: F9
- status: done
- task_id: api-optimization-b-f9-pr174-pr115-rights-audit-offline-20261013
- owner: claude
- next_owner: none
- return_to: ニュース改善API最適化のちゃ
- completion_code: L9
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F9.md
- current_report_path: .agent_v2/tasks/F9.md#report
- dependencies: prior L9 accepted, archived SHA256/read-back; F8/F9 distinct boundaries
- blocker: offline audit accepted; PR174 MERGE_HOLD until rights decision for 288 headlines/76 generated texts; legacy PR115 history and 2 main fixtures unresolved
- slot_use: API最適化B専任。PR174/旧PR115権利・履歴リスクと送信gate/価格のoffline監査。F8ニュース関連を変更しない。

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
- status: done
- task_id: kabumori-j1-ai-ask-b0-independent-security-review-20261013
- owner: codex
- next_owner: none
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
- status: ready
- task_id: kabumori-j2-ai-ask-b0-r1-r8-focused-rereview-20261013
- owner: codex
- next_owner: codex
- return_to: かぶモリアプリG1のちゃ（新F1担当）
- completion_code: V2
- recommended_model: Sol（高）
- current_task_path: .agent_v2/tasks/J2.md
- current_report_path: .agent_v2/reports/J2.md
- dependencies: J1 review, PR177
- blocker: none
- slot_use: AIに聞く設計限定再レビュー

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
