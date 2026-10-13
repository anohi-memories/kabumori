# Active Tasks Index v2（新系統15枠）

新系統（F1〜F10 / J1〜J5）の現在状態だけを置く索引。詳細と正本は各TASK / Report。過去のK / L / C / V判定は書かない。statusだけで空き判定しない。

- 旧系統（G1〜G10 / H1〜H5）の索引は `.agent/ACTIVE_TASK.md`（移行期間中の現行正本）。
- 単独 `F` は、移行期間中この索引と旧索引の両方を見て新旧30枠を統括する（`.agent_v2/ORCHESTRATION.md`）。
- 導入PRのmerge前は新系統を使わない。merge後も、TASKが置かれるまで全枠 `idle`。

## F1
- slot: F1
- status: done
- task_id: kabumori-f1-ai-ask-b0-j2-r2-r3-r8-correction-20261013
- owner: claude
- next_owner: none
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
- status: ready
- task_id: postona-f3-j3-v3-r1-r3-security-fixes-20261013
- owner: claude
- next_owner: claude
- return_to: POSTONA G3のちゃ（新F3担当・X投稿／予約担当）
- completion_code: L3
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F3.md
- current_report_path: .agent_v2/tasks/F3.md#report
- dependencies: J3 V3 CHANGES_REQUIRED R1/R2/R3; F3 PR189/182; F5 Phase8 active, F4 PR180/169
- blocker: R1 durable state may need F5-owned contract; no shared file edits; G4 Issue131; production NO_GO
- slot_use: J3 P2 R1 uncertainty-loss, R2 missing action, R3 lease-expiry-after-lock scoped fixes; independent F3 branch, return L3. Previous F3 task archived and indexed.

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
- status: ready
- task_id: common-account-f5-phase8-x-threads-lifecycle-integrated-security-20261013
- owner: claude
- next_owner: claude
- return_to: 共通アカウントG5のちゃ（新F5担当）
- completion_code: L5
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F5.md
- current_report_path: .agent_v2/tasks/F5.md#report
- dependencies: F5 Draft PR121→152→165→178→183; F3 X PR189; F4 Threads PR180; verify fresh heads on start
- blocker: production NO_GO, actual managed GoTrue/PostgREST/Auth/Storage and app deletion wiring not verified
- slot_use: Phase8 common account / X / Threads source-only disposable overlay integration and security regression
- previous_archive: .agent_v2/archive/2026-10-13-F5-common-account-f5-phase7-auth-lifecycle-release-preflight-20261013/

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
- status: ready
- task_id: news-improvement-a-f8-j1b4-performance-security-offline-20261013
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
- task_id: api-optimization-b-f9-clean-replacement-final-rights-gate-20261013
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
- status: done
- task_id: postona-j3-x-service-end-saga-integrated-security-review-20261013
- owner: codex
- next_owner: none
- return_to: POSTONA G3のちゃ（新F3担当・X投稿／予約担当）
- completion_code: V3
- recommended_model: Sol（高）
- current_task_path: .agent_v2/tasks/J3.md
- current_report_path: .agent_v2/reports/J3.md
- dependencies: F3 PR189→182→168→163→151→145; F5 PR183/178→165→152→121; F4 PR180/169; X Issue131
- blocker: full F5 T10 service-delete bridge and managed X/Auth unverified; source security review only; production NO_GO
- slot_use: POSTONA X連携解除/サービス終了の独立セキュリティレビュー（J3→V3）。既存F3/F4/F5 PRはread-only。
- review_result: CHANGES_REQUIRED / PRODUCTION_NO_GO; independently reproduced P2 R1 purge/retry uncertain loss, R2 request action missing, R3 lock-wait expiry. Actual local PG saga/E2E6, parent entitlement, F4 T13+6mutants, F5 owner suite and Deno26/25/231/120 PASS; source edits0. V3 to exact return_to. Full F5 Phase8 integration/managed release pending.

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
