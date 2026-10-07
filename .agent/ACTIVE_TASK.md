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
- task_id: common-account-v1-phase2-session-identity-final-rereview-20261007
- start_code: H1
- finish_code: C1
- next_owner: none
- source: .agent/tasks/CODEX_TASK.md
- report: .agent/CODEX_REPORT.md
- allocation: Final C1 accepts H1 CHANGES REQUIRED on PR #95 exact head 1e8119e1. S2 queued-X cancellation is PASS; stable session_id cache/context design and same-session refresh are PASS. One remaining P2 S1-T exists only in Kabumori: after Supabase reports a superseding login/sign-out, AuthProvider defers owner/generation invalidation until setTimeout(0), allowing old A1 readiness to transiently reappear before deferred work runs. H1 free; exact corrected head requires focused Sol（高） rereview.
- recommended_model: Sol（高）

## Codex H2
- owner: codex
- slot: codex-2
- status: done
- task_id: x-social-mobile-pr41-acl-focused-rereview-20261007
- start_code: H2
- finish_code: C2
- next_owner: none
- source: .agent/tasks/CODEX_TASK_2.md
- report: .agent/CODEX_REPORT_2.md
- allocation: Final C2 PASS on corrected PR #41 exact head c509117f8addf5a8687d60d9c18ae271b2c1777c. R1 effective column privilege and R2 default/inherited EXECUTE blockers closed. PR #41 squash-merged as b90ee326600b075e3d0b23209b4eefc1b4cd9c16. No further routine review. Production rollout remains separate. H2 free.
- recommended_model: Sol（高）

## Claude G1
- owner: claude
- slot: claude-1
- next_owner: chatgpt
- status: review_required
- task_id: kabumori-portfolio-canonical-ui-v1-20261006
- start_code: G1
- finish_code: K1
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: K1 PASS on portfolio implementation / merge HOLD only for contextual report-detail navigation. PR #100 head 5a9735c80e3dbc01b25911a0aabc83fce3d56bc9; canonical 402/375 UI, real saved-close data, top3 impact, search, interim Watchlist, fallback avatar, 404/404 tests accepted. Remaining: Portfolio -> report detail must Back/swipe to Portfolio, while Reports-list origin returns Reports list. Preferred root-level report-detail structural fix, but active G5/H1 owns src/app/_layout.tsx; do not overlap. Wait for C1/root boundary clear, then bounded G1 correction. No merge yet.
- recommended_model: Sonnet5（中）

## Claude G2
- owner: claude
- slot: claude-2
- status: ready
- task_id: kabumori-pr99-morning-natural-observation-20261007
- start_code: G2
- finish_code: K2
- next_owner: claude
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: PR #99 correctiveをmarket-report-analysis v25へexact deploy済み。10/7朝刊07:55/08:05の最初の自然サイクルをread-only観測し、3ポイントの具体性、generic/metric telemetry、rewrite/calls、rejection_reasons、Hard Fact安全性を確認。08:10 JSTより前は待機せず停止。production mutation禁止。
- recommended_model: Sonnet5（中）

## Claude G3
- owner: claude
- slot: claude-3
- status: done
- task_id: x-social-mobile-pr41-acl-corrective-20261007
- start_code: G3
- finish_code: K3
- next_owner: none
- source: .agent/tasks/CLAUDE_TASK_3.md
- allocation: Final C2 PASS and PR #41 merged. Live generic social-mobile scheduled-post source plus remembered AI settings/persona and hardened Stage3B ACL boundaries are now on main via squash b90ee326600b075e3d0b23209b4eefc1b4cd9c16. Production migrations/deploy/authority activation remain 0 and must wait for G5/common-account and separate rollout gates. G3 free.
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
- allocation: C1 corrective round 3 on existing PR #95. Fix only S1-T in Kabumori AuthProvider: synchronously record/fence the SDK-notified current auth owner/login and invalidate/cancel obsolete enrollment/readiness immediately on changed login/user/sign-out before any deferred task can run. Defer network preparation only. Add render-before-deferred-task regressions for same-user fresh login, different user, and sign-out; every serviceSession must remain null. Preserve same-session refresh single-flight, S2 PASS, session_id cache design, R1-R5, PR94 navigation, and X behavior. No production migration apply/deploy/EAS/Phase3. Mandatory exact-head H1 rereview after correction.
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
