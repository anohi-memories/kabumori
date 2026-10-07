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
- task_id: kabumori-pr101-f2-f3-final-rereview-20261007
- start_code: H2
- finish_code: C2
- next_owner: none
- source: .agent/tasks/CODEX_TASK_2.md
- report: .agent/CODEX_REPORT_2.md
- allocation: Final C2 accepts H2 PASS on PR #101 exact head 938567c049460ebfe78c4e08c71724d6e77ae71a. PR #101 was squash-merged as e49ecfcc2f6707f64b6282960f9eec61be2973d3. F1/F2/F3 review is closed; no further PR #101 review required. Production migration/deploy remains separate. H2 free.
- recommended_model: Sol（中）

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
- status: ready
- task_id: kabumori-ai-model-registry-gpt61-sol-20261007
- start_code: G2
- finish_code: K2
- next_owner: claude
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: Source-only Kabumori market-report AI model registry + GPT-6.1 Sol migration. Scope is shared morning/closing report generation + Fact and the same Kabumori X report consumer only. Build semantic registry, inventory, raw-literal drift guard, migrate G2 callers after fresh official OpenAI API verification. POSTONA/G3/G4, MIC, important-news and G5/common-account excluded. No production deploy/migration/apply/real OpenAI call.
- recommended_model: Opus5.5（高）

## Claude G3
- owner: claude
- slot: claude-3
- status: done
- task_id: x-social-ai-model-policy-gpt6-upgrade-20261007
- start_code: G3
- finish_code: K3
- next_owner: none
- source: .agent/tasks/CLAUDE_TASK_3.md
- allocation: Final K3 PASS. PR #105 exact head 78a43ae878205f726111dde1002bd28ea8e82b97 was squash-merged as 9e359b3e600196fa0602ccd4162d125d613ebbb9. X/social source now centralizes GPT-6 text model ids/pricing/workloads with drift tests; no Codex review required. Production deploy/model switch is still pending and separately gated; G3 is free.
- recommended_model: Opus5.5（高）

## Claude G4
- owner: claude
- slot: claude-4
- status: ready
- task_id: postona-multisocial-phase2a2-account-schema-candidate-20261007
- start_code: G4
- finish_code: K4
- next_owner: claude
- source: .agent/tasks/CLAUDE_TASK_4.md
- allocation: Phase 2a-1 PASS and exact five provider-domain blobs integrated to main; former PR #103 closed as superseded after stale-base merge race. New Phase 2a-2 is source-only: reconstruct social_accounts contract, create a forward provider/account credential-shape migration candidate only if repository evidence is sufficient, prove it in disposable PostgreSQL, and document next Threads OAuth slice. No production apply/deploy/OAuth/Vault/provider call. Avoid active G2/G5 files and shared migration reservation if occupied.
- recommended_model: Opus5.5（高）
## Claude G5
- owner: claude
- slot: claude-5
- status: in_progress
- task_id: common-account-v1-phase2-production-migration-apply-20261007
- start_code: G5
- finish_code: K5
- next_owner: user
- source: .agent/tasks/CLAUDE_TASK_5.md
- report: .agent/tasks/CLAUDE_TASK_5.md#report
- allocation: User explicitly approved production apply. Production mutation window ACTIVE from 2026-10-07 13:42 JST for G5 only. Scope is exactly migration 20261006230000_common_account_service_start_intent: same-day read-only preflight -> Stage A exact reviewed migration -> Stage B read-back -> Stage C one migration-history row -> final read-back. No other DB/Auth/permission mutation window may open until CLOSED. User operator command is the only pending action; no deploy/EAS/backfill/enforcement/deletion/OAuth/Vault/Cron/X changes.
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
