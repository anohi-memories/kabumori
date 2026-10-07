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
- status: ready
- task_id: kabumori-pr101-f1-f3-final-rereview-20261007
- start_code: H2
- finish_code: C2
- next_owner: codex
- source: .agent/tasks/CODEX_TASK_2.md
- report: .agent/CODEX_REPORT_2.md
- allocation: corrected PR #101 exact head fddd274863b08aefed60795d678a298a1160d599 のF1-F3だけを最終再レビュー。effective ACL/owner/inheritance、free-text secret redaction/backstop、full candidate/local/Fact retentionを独立再現。Hard/PR99/300字rewrite/call/fallback不変も確認。production access/apply/deploy禁止。
- recommended_model: Sol（中）

## Claude G1
- owner: claude
- slot: claude-1
- next_owner: claude
- status: ready
- task_id: kabumori-portfolio-canonical-ui-v1-20261006
- start_code: G1
- finish_code: K1
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: K1 corrective only on existing PR #100. PR #95/common-account source is merged, so root navigation is unblocked. Integrate fresh main, then make Portfolio-origin report detail a root Stack route so visible Back/native swipe return Portfolio; keep Reports-list-origin on nested /reports/[id] so it returns Reports list. Preserve PR95 Auth/serviceSession, root news-detail, all accepted portfolio UI/data/search/watch behavior. No internal router interception, no backend/DB/Auth/EAS changes.
- recommended_model: Sonnet5（中）

## Claude G2
- owner: claude
- slot: claude-2
- status: review_required
- task_id: kabumori-pr101-debug-trace-security-corrective-20261007
- start_code: G2
- finish_code: K2
- next_owner: codex
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: K2 PASS_CANDIDATE。PR #101 corrected head fddd274863b08aefed60795d678a298a1160d599。H2 F1-F3再現ケースを閉鎖し、full failed-output retention方針維持。migration/deploy/production mutation 0。最終H2 exact-head rereviewへ。
- recommended_model: Opus5.5（高）

## Claude G3
- owner: claude
- slot: claude-3
- status: ready
- task_id: x-social-ai-model-policy-gpt6-upgrade-20261007
- start_code: G3
- finish_code: K3
- next_owner: claude
- source: .agent/tasks/CLAUDE_TASK_3.md
- allocation: Source-only GPT-6 model migration for X/social auto-post AI only: POSTONA, AI Lab, and Kabumori X. Centralize social text model ids/pricing/workload mapping in one shared policy; routine 5.6 Luna -> gpt-6-luna, existing 5.6 Sol escalations -> gpt-6.1-sol; preserve gpt-image-2. Add invariant preventing future raw model-id drift outside policy. Do not touch G2 app/report/news/MIC model ownership. No production/deploy/merge. Recommended Opus5.5（高）.
- recommended_model: Opus5.5（高）

## Claude G4
- owner: claude
- slot: claude-4
- status: ready
- task_id: postona-multisocial-phase2a1-provider-domain-foundation-20261007
- start_code: G4
- finish_code: K4
- next_owner: claude
- source: .agent/tasks/CLAUDE_TASK_4.md
- allocation: POSTONA Phase 2a-1. Provider-neutral domain foundation only while G5 common-account review finishes. Add canonical provider ids/capabilities and pure publication target/outcome/adapter contracts. Current X behavior unchanged; no overlap with PR #95 and no database, auth, external-provider, production, or deployment changes.
- recommended_model: Sonnet5（高）
## Claude G5
- owner: claude
- slot: claude-5
- status: ready
- task_id: common-account-v1-phase2-production-migration-preflight-20261007
- start_code: G5
- finish_code: K5
- next_owner: claude
- source: .agent/tasks/CLAUDE_TASK_5.md
- report: .agent/tasks/CLAUDE_TASK_5.md#report
- allocation: PR #95 source is merged as d5bea735937b53095b110b4bed1f20442e56b089. Next step is read-only production preflight for migration 20261006230000_common_account_service_start_intent.sql only: verify migration history/current RPC/ACL/state, ordering with already-merged PR41 candidates, old-binary/client compatibility, and exact apply/read-back plan. Production writes/migration apply/deploy/EAS are forbidden until explicit user approval after K5.
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
