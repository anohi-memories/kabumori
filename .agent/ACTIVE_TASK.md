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
- task_id: kabumori-pr99-editorial-specificity-focused-review-20261007
- start_code: H1
- finish_code: C1
- next_owner: codex
- source: .agent/tasks/CODEX_TASK.md
- report: .agent/CODEX_REPORT.md
- allocation: PR #99 focused review。10/6大引けのeditorial regression修正について、prompt specificity、WARN-only generic telemetry、X短文rewrite閾値430→300のruntime semantics、bounded rejection_reasons、Hard境界不変を確認。source fix/merge/deploy/production mutation禁止。
- recommended_model: Luna（高）

## Codex H2
- owner: codex
- slot: codex-2
- status: done
- task_id: x-social-mobile-pr41-live-generation-security-review-20261007
- start_code: H2
- finish_code: C2
- next_owner: none
- source: .agent/tasks/CODEX_TASK_2.md
- report: .agent/CODEX_REPORT_2.md
- allocation: Final C2 accepted CHANGES REQUIRED on PR #41 exact head 280aa0f83d4f039ba3e43f32da202a91fd2333f2. Two blockers only: R1 effective column-level service_role privilege drift; R2 unexpected default/inherited EXECUTE on completion/authority RPCs. H2 closed; no merge/deploy/production mutation. Focused rereview only after bounded G3 corrective.
- recommended_model: Sol（高）

## Claude G1
- owner: claude
- slot: claude-1
- next_owner: claude
- status: ready
- task_id: kabumori-portfolio-canonical-ui-v1-20261006
- start_code: G1
- finish_code: K1
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: ユーザー承認済みポートフォリオ正本を実装。銘柄タブdefaultを資産評価額→保存済みFact-passedポート総括→資産への影響top3→保有銘柄→AI CTAへ再構築。最新大引け/ tracked_stocks実データのみ、stale basis明示、企業ロゴは未実装でfallback avatar。検索を独立実画面化、Watchlistはタグ未確定のため既存監視銘柄を安全なinterim subviewへ。src/app/_layout.tsx/Auth/migration/RPC/G5境界禁止。375/402 Simulator、EAS 0、backend/production mutation 0。
- recommended_model: Sonnet5（高）

## Claude G2
- owner: claude
- slot: claude-2
- status: review_required
- task_id: kabumori-editorial-points-specificity-corrective-20261006
- start_code: G2
- finish_code: K2
- next_owner: codex
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: K2 PASS_CANDIDATE。PR #99 head cd33b1f22f532be9273d63f0f42f0a0d9c1de156。完成例文除去、具体性条件、節目数値例外、WARN-only generic telemetry、bounded rejection diagnosticsを実装。Hard/call ceiling不変。ただしX短文rewrite閾値を430→300へ変更したため、focused H1 reviewを1回実施。production mutation 0。
- recommended_model: Sonnet5（高）

## Claude G3
- owner: claude
- slot: claude-3
- status: in_progress
- task_id: x-social-mobile-pr41-acl-corrective-20261007
- start_code: G3
- finish_code: K3
- next_owner: claude
- source: .agent/tasks/CLAUDE_TASK_3.md
- allocation: Bounded corrective for H2/C2 PR #41 findings only. R1: fail closed on any effective service_role column privilege drift, including inherited/PUBLIC column grants, with atomic rollback. R2: exact/effective EXECUTE hardening for completion + publish-authority privileged RPCs against unknown default ACL, inheritance, grant option, overload/owner drift; no global ACL/role repair. Preserve already-passed live-generation/runtime behavior and G5 boundaries. Source-only; no production/merge/deploy. Recommended Opus5.5（高）.
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
- status: ready
- task_id: common-account-v1-phase2-service-enrollment-integration-20261006
- start_code: G5
- finish_code: K5
- next_owner: claude
- source: .agent/tasks/CLAUDE_TASK_5.md
- report: .agent/tasks/CLAUDE_TASK_5.md#report
- allocation: C1 corrective round 2 on existing PR #95. Fix only H1 S1/S2: bind cache/view/consent/positive-ready to stable login-session identity (e.g. validated JWT session_id) so same-user fresh login invalidates old explicit request/result while ordinary same-session token refresh preserves single-flight; and prevent queued X automatic enrollment from dispatching after cleanup/sign-out/unmount by checking cancellation/current generation before ensure/transport dispatch. Preserve already-passed R1-R5 corrections and PR94 navigation. No production migration apply/deploy/EAS/Phase3. Mandatory exact-head H1 re-review after correction.
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
