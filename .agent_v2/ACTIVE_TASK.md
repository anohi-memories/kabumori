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
- task_id: kabumori-f2-topix-pr201-203-premerge-safety-corrections-20261015
- owner: claude
- next_owner: claude
- return_to: かぶモリアプリG2のちゃ（新F2担当）
- completion_code: L2
- recommended_model: Sonnet5（高）
- current_task_path: .agent_v2/tasks/F2.md
- current_report_path: .agent_v2/tasks/F2.md#report
- dependencies: stacked Draft PR201 exact 6977ca3c / PR203 exact 46cd29be; previous F2 archive 2026-10-15 confirmed. TOPIX actual Yahoo symbol and JPX/Yahoo/Nikkei rights unverified.
- blocker: L2 CHANGES_REQUIRED_SOURCE_PREMERGE / PRODUCTION_NO_GO. (1) TOPIX date guard when Nikkei missing/unusable, (2) dry-run topix_source bypasses default OFF to permit an external fetch. Fix both offline on new stacked Draft, do not modify PR201/203 originals.
- slot_use: Source-only guard correction of PR201/203. No API/network/merge/deploy/Secret/Cron/X/post/notification/EAS permission.

## F3
- slot: F3
- status: review_required
- task_id: postona-f3-j3-v3-ack-lease-rollback-corrections-20261015
- owner: claude
- next_owner: chatgpt
- return_to: POSTONA G3のちゃ（新F3担当・X投稿／予約担当）
- completion_code: L3
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F3.md
- current_report_path: .agent_v2/tasks/F3.md#report
- dependencies: J3 V3 P2 R1a/R3a/R1b; F3 PR192→189, F5 PR193 Phase8, F4 PR180, G4 Issue131
- blocker: F5 ACK snapshot consumer coordination; inherited hold() time check; production NO_GO
- slot_use: Fix count-only ACK ABA, row-lock lease expiration and rollback race; F3-only source candidate; previous F3 archive restored/verified.
- previous_archive: .agent_v2/archive/2026-10-15-F3-postona-f3-j3-v3-r1-r3-security-fixes-20261013/

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
- task_id: common-account-f5-phase9-postona-shared-login-enrollment-20261015
- owner: claude
- next_owner: none
- return_to: 共通アカウントG5のちゃ（新F5担当）
- completion_code: L5
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F5.md
- current_report_path: .agent_v2/tasks/F5.md#report
- dependencies: F5 PR121→152→165→178→183→193; F3/J3 security corrections; F4 PR180; POSTONA app PR197 / J4 client review
- blocker: source-only; managed Auth/RLS/GoTrue and app UI not proven, pending F3 ACK and J4 fixes, production NO_GO
- slot_use: Phase9 POSTONA-first shared sign-in / registration / entitlement integrated candidate; future apps supported
- previous_archive: .agent_v2/archive/2026-10-15-F5-common-account-f5-phase8-x-threads-lifecycle-integrated-security-20261013/
- latest_result: IMPLEMENTED_SOURCE_CANDIDATE — Draft PR #206 head a84a9b6abb8c8d4706bba5f8a12e5c1aef3d3b8c stacked on PR193 314aeac47a02ce80aea3d94426a563dfbe57ad7c (PR183 f2565cc0, PR178 83334a09, PR165 4638891f, PR152 ccea1fe8, PR121 76b50e1e unchanged): POSTONA-first shared sign-in/enrollment proven offline with the apps' real enrollment modules over fake GoTrue/PostgREST seams and the repository SQL (16 tests; no Kabumori profile/entitlement/RPC needed; idempotency, duplicate/concurrent sign-up, refresh, stale/forged/expired tokens, isolation, lifecycle, independence, races); F5 fixes (migration 20261015090000, unapplied): signed-out device's unexpired token could restart an ended service, guest session was enrolled; mutations 14/14, preflight chain of nine; handoffs: G3 T13 wiring of X onboarding RPCs (server does not enforce x_autopost entitlement), F3 PR204 ACK-snapshot consumer pending in F5; local PG17 only, production NO_GO; managed M1-M12 not run. Report: .agent_v2/tasks/F5.md#report

- l5_verdict: PASS_SOURCE_CANDIDATE / SECURITY_REVIEW_REQUIRED / PRODUCTION_NO_GO (2026-10-15); Draft PR206 head a84a9b6abb8c8d4706bba5f8a12e5c1aef3d3b8c. Managed M1-M12 not executed; G3 T13, G4 old deletion path, F3 PR204 ACK consumer and J4 mobile fixes remain. No merge/deploy.

## F6
- slot: F6
- status: done
- task_id: common-ai-f6-h5-consumer-bridge-import-boundary-repair-20261014
- owner: claude
- next_owner: none
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- completion_code: L6
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F6.md
- current_report_path: .agent_v2/tasks/F6.md#report
- dependencies: F6 PR187 (a7e1d3f3), H5 PR198 (4223d5c0), H5 C5 done/merge hold; H5 PR199 bookkeeping unmerged
- blocker: L6 PASS_OFFLINE_SOURCE; independent Codex Sol(高) header/auth/tenant/budget security review required before merge/deploy.  PASS_OFFLINE_SOURCE Draft PR #205 (4cd2cbdd) on #198: 3 isolation failures fixed by exact allowlist + new name-level least privilege and entry-point checks (nothing relaxed); SDK env containment (webhookKey null, header-contained fetch pins x-api-key/version); isolation 9, containment 4, H5 27+2, provider 126, report 324, _shared 658, mutants 8/8; order #187→#198→#205; Codex Sol review recommended
- slot_use: F6 safety boundary repair for H5 Claude consumer bridge M2

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
- status: ready
- task_id: common-ai-j1-f6-h5-pr187-198-205-security-review-20261015
- owner: codex
- next_owner: codex
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
- task_id: postona-j3-x-saga-r1-r3-focused-rereview-20261014
- owner: codex
- next_owner: none
- return_to: POSTONA G3のちゃ（新F3担当・X投稿／予約担当）
- completion_code: V3
- recommended_model: Sol（高）
- current_task_path: .agent_v2/tasks/J3.md
- current_report_path: .agent_v2/reports/J3.md
- dependencies: F3 PR192 9384818e stacked on PR189 4fd7084d, J3 V3 archived findings; F5 Phase8, F4 PR180, G4 Issue131
- blocker: CHANGES_REQUIRED P2 x3 (ACK ABA / later row-lock lease expiry / rollback checkpoint race); integrated F3/F5/F4 gate and managed Auth/X pending; production NO_GO
- slot_use: Focused PR192 review complete; Report records independently reproduced defects and passing original fixes. Return V3 to POSTONA G3のちゃ（新F3担当・X投稿／予約担当）. No product changes.

## J4
- slot: J4
- status: done
- task_id: postona-j4-pr197-postona-deletion-client-security-review-20261014
- owner: codex
- next_owner: none
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- completion_code: V4
- recommended_model: Sol（高）
- current_task_path: .agent_v2/tasks/J4.md
- current_report_path: .agent_v2/reports/J4.md
- dependencies: J5 PR197, F5 PR193, F4 PR180, F3 PR192 with J3 V3 P2x3; old POSTONA Edge account-delete endpoint
- blocker: J4 CHANGES_REQUIRED P2x2 (incomplete success response / post-response warning loss); F3/J3 P2x3, legacy server containment and managed F5/F4 gates remain; production NO_GO
- slot_use: J4 independent review of POSTONA J5 legacy delete-client boundary; previous J4 TASK/Report archived
- v4_verdict: CHANGES_REQUIRED P2x2 (PR197 incomplete provider summary accepted; known warnings lost after read-back errors); review complete J4 released. Source fix new G4/F4 or explicitly Codex J5 task; archive before reuse, production NO_GO.

## J5
- slot: J5
- status: done
- task_id: postona-j5-account-deletion-legacy-bypass-ui-bridge-20261014
- owner: codex
- next_owner: none
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- completion_code: V5
- recommended_model: Sol（高）
- current_task_path: .agent_v2/tasks/J5.md
- current_report_path: .agent_v2/reports/J5.md
- dependencies: F5 PR193 Phase8 old deletion route G4-1; F4 PR180/169, F3 PR192 and J3 independent review; no mutation outside POSTONA mobile
- blocker: backend shared account deletion permission/contract and managed environment unverified, production NO_GO
- slot_use: IMPLEMENTED_SOURCE_CANDIDATE Draft PR197 head 2171ee4c; 18 client files, app281/tsc/lint/web-export PASS; source gate OFF; V5 pending, separate Sol（高） review and owner server/managed blockers

- v5_verdict: PASS_SOURCE_IMPLEMENTATION / SECURITY_REVIEW_REQUIRED / PRODUCTION_NO_GO; PR197 exact 2171ee4c02ea2eec46562d81595f5460e5507d9d Draft/unmerged, 18 app files, Codex tests app281 pass reported; J5 released; archive before reuse.

## コード

- `F1`〜`F10`: 新Claude枠の開始。完了確認は `L1`〜`L10`（1対1）。
- `J1`〜`J5`: 新Codex枠の開始。完了確認は `V1`〜`V5`（1対1）。
- 単独 `F`（数字なし）: 新旧30枠の統括。`F1`〜`F10` とは完全一致で区別する。
