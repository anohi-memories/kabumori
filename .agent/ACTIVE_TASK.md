# Active Tasks Index

このファイルは共有オーケストレーションの7枠インデックスです。詳細指示と割当の正本は各TASK/Reportです。statusだけで空き判定せず、task_idとTASK本文も確認してください。

## Routing preference

- かぶモリアプリ実装は G1 / G2 を使用する。
- X自動投稿・複数ブランドX実装は G3 / G4 を使用する。
- `G5`: 予備のClaude実装スロット。用途は固定せず、ユーザーまたはChatGPTが明示割当した場合のみ使用する。既存の基本ルーティングの自動fallbackにはしない。
- 各ペア内の割当は空き状況・競合・依存関係を見てChatGPTが決める。
- H1/H2はCodexのレビュー・バグ修正・検証枠。
- ユーザーの個別指定がある場合はその指定を優先する。
- 競合防止ルールは常に優先する。

## Project Critical Path — Common Account

- priority: **CRITICAL / project-wide**
- user decision: 共通アカウント完成を、かぶモリ・X自動投稿の次工程より最優先とする。
- G5 owns the shared common-account critical path.
- Existing G1-G4 tasks are preserved. Non-conflicting UI/source/read-only work may continue, but **no unrelated production DB/Auth/permission mutation may overtake an active/approved G5 production window**.
- G3 PR81 production apply remains HOLD whenever G5 has an approved/active production write.
- next shared milestone: production legacy backfill dry-run -> explicit backfill approval -> exact backfill -> Phase 2 integrations -> Phase 3 deletion/enforcement.

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
- task_id: common-account-v1-phase2-q1-final-rereview-20261007
- start_code: H1
- finish_code: C1
- next_owner: none
- source: .agent/tasks/CODEX_TASK.md
- report: .agent/CODEX_REPORT.md
- allocation: Final C1 accepts H1 PASS on PR #95 exact head ba35b642d30ce423a8683feffcd26aec325b45ee. Q1 is closed; prior S1-T/S2/session_id/R1-R5 remain PASS. PR #95 source was squash-merged as d5bea735937b53095b110b4bed1f20442e56b089. H1 free. No production migration apply/deploy/EAS.
- recommended_model: Sol（高）

## Codex H2
- owner: codex
- slot: codex-2
- status: done
- task_id: kabumori-trace-gpt61-rollout-runbook-review-20261007
- start_code: H2
- finish_code: C2
- next_owner: none
- source: .agent/tasks/CODEX_TASK_2.md
- report: .agent/CODEX_REPORT_2.md
- allocation: User explicitly waived the focused PR #108 review to prioritize today's natural close-cycle rollout. No Codex PASS is claimed. PR #108 is merged and the production rollout completed with direct bounded read-backs. H2 free.
- recommended_model: Sol（高）

## Claude G1
- owner: claude
- slot: claude-1
- next_owner: none
- status: done
- task_id: kabumori-portfolio-canonical-ui-v1-20261006
- start_code: G1
- finish_code: K1
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: Final K1 PASS. PR #100 exact head 3fd7c569efb6598202e71151dd2393f661f93b81 squash-merged as fe8090bab89824fc8c00147fb5fc92bb1afab82c. Canonical portfolio UI, real saved-close data, Search, interim Watchlist, fallback avatars and contextual report navigation are complete. Portfolio-origin report Back/swipe returns Portfolio; Reports-list origin returns Reports list. 426/426 app tests; no backend/DB/Auth/EAS changes. G1 free.
- recommended_model: Sonnet5（中）

## Claude G2
- owner: claude
- slot: claude-2
- status: done
- task_id: kabumori-market-report-gpt61-production-preflight-20261007
- start_code: G2
- finish_code: K2
- next_owner: none
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: Final production rollout APPLIED_PASS at 16:11 JST after explicit user approval. Trace migration 20261007120000 applied and verified with one exact history row; market-report-analysis alone deployed as v28 ACTIVE from accepted GPT-6.1 Sol source; app/x consumer gates remain OFF; no manual report/replay; natural close cron remains active for 16:20 JST. G2 free pending observation.
- recommended_model: Opus5.5（高）

## Claude G3
- owner: claude
- slot: claude-3
- status: review_required
- task_id: ai-lab-topic-continuity-fix-20261007
- start_code: G3
- finish_code: K3
- next_owner: chatgpt
- source: .agent/tasks/CLAUDE_TASK_3.md
- allocation: Urgent AI Lab continuity bugfix. Production evidence shows 10/day schedule is healthy but 7 evergreen seeds + 72h seed / 48h theme cooldown exhausted the topic pool, causing all 2026-10-07 executed slots to fail before OpenAI/X. Expand to a sufficiently large diverse safe topic reservoir with explicit continuity fallback, preserve claim/fencing/cooldowns/duplicate guards, and prove >=14 days x 10/day cannot exhaust. Source/migration candidate only; no production mutation/deploy/merge.
- recommended_model: Opus5.5（高）

## Claude G4
- owner: claude
- slot: claude-4
- status: ready
- task_id: postona-multisocial-phase2a2-security-corrective-20261007
- start_code: G4
- finish_code: K4
- next_owner: claude
- source: .agent/tasks/CLAUDE_TASK_4.md
- allocation: Direct independent review of PR #106 head dac01220 returned CHANGES REQUIRED. G4 must update the existing PR only and close B1-B6: provider-identity unique-index precondition, provider immutability, PG16+ SET ROLE graph, explicit starting schema/ACL baseline, connected-Meta access-ref invariant, and provider-aware service_role Meta-write boundary. Also harden policy/trigger/index/check postconditions. No production/apply/deploy/OAuth/Vault/provider calls. After corrected K4, use a free H1/H2 for one Sol（高） exact-head rereview if available.
- recommended_model: Opus5.5（高）
## Claude G5
- owner: claude
- slot: claude-5
- status: ready
- task_id: common-account-v1-phase2-native-client-validation-20261007
- start_code: G5
- finish_code: K5
- next_owner: claude
- source: .agent/tasks/CLAUDE_TASK_5.md
- report: .agent/tasks/CLAUDE_TASK_5.md#report
- allocation: Phase 2 server migration is APPLIED_PASS. Next validate the merged client on iOS Simulator/local app before any EAS/TestFlight or real self-service mutation. Re-run exact Auth/service-enrollment regressions, verify deployed response contract compatibility, and exercise signed-out/login/session-refresh/sign-out/serviceSession gating on native Simulator. Production service-state mutation, deploy and EAS forbidden.
- recommended_model: Opus5.5（高）

## Deferred

- PR #15 is closed with Final K4 PASS. PR #33 remains unmerged; its Auth/security review/merge decision can now be scheduled separately after fresh slot review.
- Kabumori Expo Web Netlify Preview task is also deferred because it is not currently needed for the native app workflow.

## Control codes

- `H1` / `H2`: Codex H1/H2開始。
- `G1`〜`G5`: Claude G1〜G5開始。ready / in_progressのTASKのみ。
- `C1` / `C2`: ChatGPTが対応Codex枠だけ完了確認。
- `K1`〜`K5`: ChatGPTが対応Claude枠だけ完了確認。
- 単独 `G` / `K`: G5も候補に含め、対象が1枠だけと明白な場合のみ使用。
- `F`: H1/H2 + G1〜G5の全7枠の状態・競合・実際の空き状況を確認する統括コード。

並行実行はtask_idと変更対象が分離され競合しない場合に限る。同じファイル・DB migration/RPC・Edge Function・workflow・production設定等を複数枠で同時変更しない。
