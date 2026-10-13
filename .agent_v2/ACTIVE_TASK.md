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
- status: in_progress
- task_id: kabumori-f2-emergency-market-report-app-feed-broadcast-20261013
- owner: claude
- next_owner: claude
- return_to: かぶモリアプリG2のちゃ（新F2担当）
- completion_code: L2
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F2.md
- current_report_path: .agent_v2/tasks/F2.md#report
- dependencies: main PR143/149/158, F6 generator; current X/app consumer ON, old individualized scheduled Cron OFF
- blocker: アプリの「きょうの市況」は本番で公開・実機で確認済み。一斉通知は migration・worker v1（main と一致）・Cron jobid 44・送信 ON（pilot 1人）まで完了。最初の送信は 10/14 朝刊の直後で、その読み戻しと実機の確認が残る
- slot_use: EMERGENCY 共通市況アプリ配信・一斉通知を最短で整備（1時間目標）

## F3
- slot: F3
- status: done
- task_id: postona-f3-j3-v3-r1-r3-security-fixes-20261013
- owner: claude
- next_owner: none
- return_to: POSTONA G3のちゃ（新F3担当・X投稿／予約担当）
- completion_code: L3
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F3.md
- current_report_path: .agent_v2/tasks/F3.md#report
- dependencies: J3 V3 CHANGES_REQUIRED R1/R2/R3; F3 PR189/182; F5 Phase8 active, F4 PR180/169
- blocker: R1/R3 mandatory Codex Sol（高） focused rereview; F5 Phase8 durable count/T10 wiring; G4 Issue131; production NO_GO
- slot_use: L3 PASS_SOURCE_FIX / SECURITY_REREVIEW_REQUIRED / PRODUCTION_NO_GO; F3 Draft PR192 HEAD 9384818e, nine owned files, reported PG fail-before/pass-after. F3 done/unreserved, archive before reuse.

## F4
- slot: F4
- status: done
- task_id: postona-f4-threads-cleanup-live-lease-security-fix-20261013
- owner: claude
- next_owner: none
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- completion_code: L4
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F4.md
- current_report_path: .agent_v2/tasks/F4.md#report
- dependencies: F4 PR169, F5 PR178 Phase6 cleanup_authorized(uuid), protected PR167/154
- blocker: production NO_GO, integrated Sol（高） review needed after source fix; F4 reported Draft PR180 head 7c4f457834cddb42b72be6b74996e643b213e8c8 (base PR169 branch), awaiting L4
- slot_use: POSTONA Threads F5-reported service deletion live-lease security defect; F4-owned source only
- previous_task_archive: .agent_v2/archive/2026-10-13-F4-postona-f4-threads-t13-authenticated-writer-integration-20261013/
- l4_verdict: PASS_SOURCE_FIX / SECURITY_REVIEW_REQUIRED / PRODUCTION_NO_GO; PR180 head 7c4f457834cddb42b72be6b74996e643b213e8c8 Draft unmerged, 10 F4-scoped changes, reported fail-before/pass-after, F4 available after archive.

## F5
- slot: F5
- status: done
- task_id: common-account-f5-phase8-x-threads-lifecycle-integrated-security-20261013
- owner: claude
- next_owner: none
- return_to: 共通アカウントG5のちゃ（新F5担当）
- completion_code: L5
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F5.md
- current_report_path: .agent_v2/tasks/F5.md#report
- dependencies: F5 Draft PR121→152→165→178→183; F3 X PR189; F4 Threads PR180; verify fresh heads on start
- blocker: production NO_GO; managed GoTrue/PostgREST/Auth/Storage and app deletion wiring not verified; F3 L1 lock order / R2 scope and G3 T13 wiring open
- slot_use: Phase8 common account / X / Threads source-only disposable overlay integration and security regression
- previous_archive: .agent_v2/archive/2026-10-13-F5-common-account-f5-phase7-auth-lifecycle-release-preflight-20261013/
- latest_result: IMPLEMENTED_SOURCE_CANDIDATE — Draft PR #193 head 314aeac47a02ce80aea3d94426a563dfbe57ad7c stacked on PR183 f2565cc0412f8127f95f00a728d16bf83af74667 (PR178 83334a09, PR165 4638891f, PR152 ccea1fe8, PR121 76b50e1e unchanged): real F3 PR189 + F4 PR180 + G4 PR124 sources assembled unmodified in a disposable PG17/Edge overlay (e2e 29, F3/F4 own suites unchanged, apply order/refusals/commutation, cross-stack rollback ladder + read-backs, privilege inventory, seeded lock-order stress); F5 fixes: typed X result bridge equal to F3 mapper, durable x_posts_unconfirmed (migration 20261013140000, unapplied) recorded before X done + ack of F3 PR192 checkpoint, unreadable end record fails closed; F3-owned finding L1 (3-way lock cycle on the legacy saga path, reproduced + verified one-statement repair), F3 R2' POSTONA-only scope, G3 T13 wiring, G4 legacy login-deleting path; local PG17 only, production NO_GO; managed M1-M10 not run. Report: .agent_v2/tasks/F5.md#report

- l5_verdict: PASS_SOURCE_CANDIDATE / SECURITY_REVIEW_REQUIRED / PRODUCTION_NO_GO (2026-10-14); Draft PR193 head 314aeac47a02ce80aea3d94426a563dfbe57ad7c. F3-L1/R2', G3 onboarding T13, G4 old deletion path are safety blockers. No merge/deploy.

## F6
- slot: F6
- status: review_required
- task_id: common-ai-f6-anthropic-multimodel-shared-adapter-m1-20261013
- owner: claude
- next_owner: chatgpt
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- completion_code: L6
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F6.md
- current_report_path: .agent_v2/tasks/F6.md#report
- dependencies: deployed Opus primary_both stable contract, existing ai_provider/model catalog/ai ledger; F2 owns commentator quality, F8 news, F9 API optimization
- blocker: PASS_OFFLINE_SOURCE Draft PR #187 (a7e1d3f3): per-role Claude model policies (Sonnet/Haiku/Opus, versioned aliases, narrow-only overrides, refusals before send, ledger/idempotency unchanged, no auto fallback); 11 tests + 6/6 mutants, provider 121 / report 324 / _shared 624; live primary_both untouched; NOTE consumer gates x/app turned ON 2026-10-13 20:49 JST (not by F6) while x-test-post (10/08) / personalized-reports (09/25) code is behind main
- slot_use: Claude multimodel API common adapter (Sonnet/Haiku/Opus) Phase M1

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
- task_id: news-improvement-a-f8-j1b5-security-review-readiness-20261014
- owner: claude
- next_owner: none
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
- status: ready
- task_id: postona-j3-x-saga-r1-r3-focused-rereview-20261014
- owner: codex
- next_owner: codex
- return_to: POSTONA G3のちゃ（新F3担当・X投稿／予約担当）
- completion_code: V3
- recommended_model: Sol（高）
- current_task_path: .agent_v2/tasks/J3.md
- current_report_path: .agent_v2/reports/J3.md
- dependencies: F3 PR192 9384818e stacked on PR189 4fd7084d, J3 V3 archived findings; F5 Phase8, F4 PR180, G4 Issue131
- blocker: local focused security re-review only; full integrated F3/F5/F4 gate and managed Auth/X still pending; production NO_GO
- slot_use: Re-review F3 R1 durable uncertainty + ACK and R3 lock wait wall-clock lease, plus R2 HTTP action. Previous J3 TASK+Report archived with SHA256 and HISTORY_INDEX.

## J4
- slot: J4
- status: done
- task_id: kabumori-j4-ai-ask-b0-v3-review-20261013
- owner: codex
- next_owner: none
- return_to: かぶモリアプリG1のちゃ（新F1担当）
- completion_code: V4
- recommended_model: Sol（高）
- current_task_path: .agent_v2/tasks/J4.md
- current_report_path: .agent_v2/reports/J4.md
- dependencies: PR186 and J2 review
- blocker: none
- slot_use: AI Ask B0 v3 R2/R3/R8 review

## J5
- slot: J5
- status: ready
- task_id: postona-j5-account-deletion-legacy-bypass-ui-bridge-20261014
- owner: codex
- next_owner: codex
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- completion_code: V5
- recommended_model: Sol（高）
- current_task_path: .agent_v2/tasks/J5.md
- current_report_path: .agent_v2/reports/J5.md
- dependencies: F5 PR193 Phase8 old deletion route G4-1; F4 PR180/169, F3 PR192 and J3 independent review; no mutation outside POSTONA mobile
- blocker: backend shared account deletion permission/contract and managed environment unverified, production NO_GO
- slot_use: user-approved Codex emergency implementation of POSTONA mobile shared-ID deletion-bypass closure, not review

## コード

- `F1`〜`F10`: 新Claude枠の開始。完了確認は `L1`〜`L10`（1対1）。
- `J1`〜`J5`: 新Codex枠の開始。完了確認は `V1`〜`V5`（1対1）。
- 単独 `F`（数字なし）: 新旧30枠の統括。`F1`〜`F10` とは完全一致で区別する。
