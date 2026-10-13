# Active Tasks Index v2（新系統15枠）

新系統（F1〜F10 / J1〜J5）の現在状態だけを置く索引。詳細と正本は各TASK / Report。過去のK / L / C / V判定は書かない。statusだけで空き判定しない。

- 旧系統（G1〜G10 / H1〜H5）の索引は `.agent/ACTIVE_TASK.md`（移行期間中の現行正本）。
- 単独 `F` は、移行期間中この索引と旧索引の両方を見て新旧30枠を統括する（`.agent_v2/ORCHESTRATION.md`）。
- 導入PRのmerge前は新系統を使わない。merge後も、TASKが置かれるまで全枠 `idle`。

## F1
- slot: F1
- status: ready
- task_id: kabumori-f1-ai-ask-b0-j2-r2-r3-r8-correction-20261013
- owner: claude
- next_owner: claude
- return_to: かぶモリアプリG1のちゃ（新F1担当）
- completion_code: L1
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F1.md
- current_report_path: .agent_v2/tasks/F1.md#report
- dependencies: J2 residual R2/R3/R8; PR177; PR166/171 protected
- blocker: B1 and production NO_GO until independent focused review
- slot_use: AIに聞く B0 J2残件3件の設計修正

## F2
- slot: F2
- status: ready
- task_id: kabumori-f2-yume-market-commentator-morning-close-quality-20261013
- owner: claude
- next_owner: claude
- return_to: かぶモリアプリG2のちゃ（新F2担当）
- completion_code: L2
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F2.md
- current_report_path: .agent_v2/tasks/F2.md#report
- dependencies: F6 Opus Primary provider, stored morning report for immutable forecast, X/app consumer contracts
- blocker: forecast history persistence and F6-owned provider changes require separate coordination; production NO_GO
- slot_use: ゆめちゃんAI評論家 朝刊/大引けの独自予想と事後検証の品質改善（source-only）

## F3
- slot: F3
- status: ready
- task_id: postona-f3-x-service-end-saga-wiring-20261013
- owner: claude
- next_owner: claude
- return_to: POSTONA G3のちゃ（新F3担当・X投稿／予約担当）
- completion_code: L3
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F3.md
- current_report_path: .agent_v2/tasks/F3.md#report
- dependencies: archived L3 PR182; F3 PR168/163/151/145, F5 PR178/183 Phase6/7, F4 Threads PR169/180, G4 Issue131
- blocker: F5 cleanup port owner coordination, G4 verified X unresolved, production NO_GO
- slot_use: X固有サービス終了/連携解除sagaをPR182停止関数に接続（source-only・別Draft PR）。前F3 TASK archive+SHA256+HISTORY_INDEX verified。

## F4
- slot: F4
- status: review_required
- task_id: postona-f4-threads-cleanup-live-lease-security-fix-20261013
- owner: claude
- next_owner: chatgpt
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- completion_code: L4
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F4.md
- current_report_path: .agent_v2/tasks/F4.md#report
- dependencies: F4 PR169, F5 PR178 Phase6 cleanup_authorized(uuid), protected PR167/154
- blocker: production NO_GO, integrated Sol（高） review needed after source fix; F4 reported Draft PR180 head 7c4f457834cddb42b72be6b74996e643b213e8c8 (base PR169 branch), awaiting L4
- slot_use: POSTONA Threads F5-reported service deletion live-lease security defect; F4-owned source only
- previous_task_archive: .agent_v2/archive/2026-10-13-F4-postona-f4-threads-t13-authenticated-writer-integration-20261013/

## F5
- slot: F5
- status: done
- task_id: common-account-f5-phase7-auth-lifecycle-release-preflight-20261013
- owner: claude
- next_owner: none
- return_to: 共通アカウントG5のちゃ（新F5担当）
- completion_code: L5
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F5.md
- current_report_path: .agent_v2/tasks/F5.md#report
- dependencies: old G5 K5 done; F5 Phase5/6 L5 accepted and archived; PR121→152→165→178 Draft; F4 live lease guard correction and F3 X runtime separate
- blocker: production NO_GO; managed GoTrue/PostgREST/Auth/Storage unverified, F4 lease fix and F3 integration pending
- slot_use: 共通ID・利用登録・退会のdisposable PG/Auth release preflight / source-only Phase7; other slots protected
- previous_archive: .agent_v2/archive/2026-10-13-F5-common-account-f5-phase6-postona-provider-cleanup-service-deletion-20261013/
- latest_result: IMPLEMENTED_SOURCE_CANDIDATE — Draft PR #183 head f2565cc0412f8127f95f00a728d16bf83af74667 stacked on PR178 83334a091ded5571cf595fd99d7a035627564735 (PR165 4638891f6c7ff432e08d462019594e1ec3d66f07, PR152 ccea1fe8132c6f573a768f0df5a033a05c62ef2c, PR121 76b50e1e03f82faaa3460bab1603afa8fef3ce44): release preflight for the whole common-account chain (order/dependency refusals, read-only managed probe + disposable gate, rollback ladder, provider-state matrix, user notices) and fixes (Phase 6 needed Phase 4/5; Phase 1 rollback left broken Phase 2 functions; resumed POSTONA end could get stuck without consent); local PG17 only, production NO_GO; managed M1-M10 checklist not run. Report: .agent_v2/tasks/F5.md#report

- l5_verdict: PASS_SOURCE_CANDIDATE / SECURITY_REVIEW_REQUIRED / PRODUCTION_NO_GO; Draft PR183 head f2565cc0412f8127f95f00a728d16bf83af74667; local preflight candidate and corrections accepted, managed M1-M10/F4/F3/app deletion wiring still blocked; no merge/deploy.

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
- blocker: LIVE — Opus primary_both active since 2026-10-13 15:45 JST (deploy v32 byte-verified, budget $25/120 month $3/8 day); 10/13 close made by claude-opus-5-5 at 16:21 (2 calls, $0.1875, fact passed); consumer gates still OFF (not delivered)
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
- task_id: news-improvement-a-f8-j1b3-real-schema-proof-review-packet-20261013
- owner: claude
- next_owner: claude
- return_to: ニュース改善API最適化のちゃ
- completion_code: L8
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F8.md
- current_report_path: .agent_v2/tasks/F8.md#report
- dependencies: previous L8 accepted and archived; F8 and F9 isolated
- blocker: offline only; production/merge/deploy/paid API prohibited
- slot_use: DB/RPC real-schema offline proof and Sol review handoff; PR181 source protected

## F9
- slot: F9
- status: review_required
- task_id: api-optimization-b-f9-rights-safe-eval-fixture-redaction-20261013
- owner: claude
- next_owner: chatgpt
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
- status: done
- task_id: kabumori-j2-ai-ask-b0-r1-r8-focused-rereview-20261013
- owner: codex
- next_owner: none
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
