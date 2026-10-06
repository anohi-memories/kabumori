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
- status: ready
- task_id: common-account-v1-phase2-service-enrollment-corrective-rereview-20261006
- start_code: H1
- finish_code: C1
- next_owner: codex
- source: .agent/tasks/CODEX_TASK.md
- report: .agent/CODEX_REPORT.md
- allocation: Mandatory focused re-review of corrected PR #95 exact head dd065e16. Verify prior R1-R5 closures, new service-start-intent migration/RPC atomic semantics, immutable session-bound transport, one-use re-enrollment intent, positive-ready push/notification gating, strict response validation, and PR #94/current-main compatibility. No merge/deploy/production mutation.
- recommended_model: Sol（高）

## Codex H2
- owner: codex
- slot: codex-2
- status: ready
- task_id: x-social-mobile-pr41-live-generation-security-review-20261007
- start_code: H2
- finish_code: C2
- next_owner: codex
- source: .agent/tasks/CODEX_TASK_2.md
- report: .agent/CODEX_REPORT_2.md
- allocation: One focused independent review of PR #41 exact head 280aa0f83d4f039ba3e43f32da202a91fd2333f2. Review the new service_role-only SECURITY DEFINER settings reader, exact/effective ACL including adverse default/inheritance cases, consent completeness, renumbered 3-migration chain, live scheduled-user X path, PR76/PR82/Kabumori regressions, and G5 dormant/enforcement handoff. No merge/deploy/production mutation. If PASS, no routine rereview. Recommended Sol（高）.

## Claude G1
- owner: claude
- slot: claude-1
- next_owner: none
- status: done
- task_id: kabumori-topic-learning-access-progress-and-swipe-20261006
- start_code: G1
- finish_code: K1
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: Final K1 PASS and merged after C1 coordination. PR #94 exact head 97d374b48886ad33b61cd2288188d4b690e27a5c squash-merged as d30a518731e976ab1c0e4e19e26f461a174a3c1c. Native swipe parity, topic list 3-level switch, local 未読/学習済み, 375/402 verification complete. G1 free.
- recommended_model: Sonnet5（中）

## Claude G2
- owner: claude
- slot: claude-2
- status: ready
- task_id: kabumori-editorial-points-specificity-corrective-20261006
- start_code: G2
- finish_code: K2
- next_owner: claude
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: 10/6大引けの自然観測でfactual safetyはPASSしたが、3ポイントが「主要指数上昇／国際情勢を確認／米国株と為替を見る」と抽象化しすぎてeditorial未達。具体例文のprompt除去、generic見出し抑制、節目数値の例外、WARN-only specificity telemetry、不要rewrite/call増の見直しをsource/test onlyで実施。Hard境界・call ceilingは維持。production mutation禁止。
- recommended_model: Sonnet5（高）

## Claude G3
- owner: claude
- slot: claude-3
- status: review_required
- task_id: x-social-mobile-pr41-live-generation-fresh-integration-20261006
- start_code: G3
- finish_code: K3
- next_owner: codex
- source: .agent/tasks/CLAUDE_TASK_3.md
- allocation: K3 accepts PASS_CANDIDATE only on PR #41 exact head 280aa0f83d4f039ba3e43f32da202a91fd2333f2. Source integration/tests/CI are green, but the candidate introduces a SECURITY DEFINER/service_role/live-publish boundary, so merge remains HOLD pending the single focused H2 security review. Production/deploy/real X/OpenAI remain 0. Recommended reviewer Sol（高）.
- recommended_model: Opus5.5（高）

## Claude G4
- owner: claude
- slot: claude-4
- status: done
- task_id: postona-multisocial-phase1-architecture-inventory-20261006
- start_code: G4
- finish_code: K4
- next_owner: none
- source: .agent/tasks/CLAUDE_TASK_4.md
- allocation: Final K4 PASS. POSTONA multi-social Phase 1 docs-only architecture accepted. Exact one-file design document from former PR #96 was integrated unchanged directly to fresh main as 25fd6aeec85528a06f78995f4306aaeba98f9d75 after the PR merge raced a moving base; PR #96 closed as superseded. Runtime/DB/Edge/OAuth/Vault/production/provider calls 0. No Codex review. G4 free, but Phase 2a waits for G3 PR #41 and G5 PR #95 acceptance/merge.
- recommended_model: Opus5.5（高）
## Claude G5
- owner: claude
- slot: claude-5
- status: review_required
- task_id: common-account-v1-phase2-service-enrollment-integration-20261006
- start_code: G5
- finish_code: K5
- next_owner: codex
- source: .agent/tasks/CLAUDE_TASK_5.md
- report: .agent/tasks/CLAUDE_TASK_5.md#report
- allocation: K5 accepts corrected PR #95 head dd065e16 as PASS_CANDIDATE only. G5 reports H1 R1-R5 reproduced and fixed with forward service-start-intent migration, immutable session-bound RPC transport, one-use user/session reactivation intent, positive-ready side-effect gate, and strict payload validation. Production/deploy/EAS remain 0. Merge and migration apply HOLD pending mandatory H1 re-review.
- recommended_model: Opus5.5（極高）

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
