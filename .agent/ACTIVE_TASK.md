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
- task_id: common-account-v1-phase2-q1-final-rereview-20261007
- start_code: H1
- finish_code: C1
- next_owner: codex
- source: .agent/tasks/CODEX_TASK.md
- report: .agent/CODEX_REPORT.md
- allocation: Final exact-head rereview of PR #95 head ba35b642d30ce423a8683feffcd26aec325b45ee. Verify Q1 deferred Kabumori auth preparation cannot dispatch after SIGNED_OUT/user-B/same-user-fresh-session supersedes it; current owner path and same-session TOKEN_REFRESHED remain single-flight; bounded S1-T/S2/R1-R5 regressions. No merge/deploy/production migration apply.
- recommended_model: Sol（高）

## Codex H2
- owner: codex
- slot: codex-2
- status: done
- task_id: kabumori-pr101-debug-trace-security-review-20261007
- start_code: H2
- finish_code: C2
- next_owner: none
- source: .agent/tasks/CODEX_TASK_2.md
- report: .agent/CODEX_REPORT_2.md
- allocation: Final C2 accepts CHANGES REQUIRED on PR #101 exact head 2469e8a8. Blockers are F1 effective ACL/owner/default/inheritance drift, F2 free-text secret-shape redaction gaps, F3 silent loss of full candidate/Fact evidence. Clean append-only/non-blocking delivery/prompt hygiene/Hard-call boundaries remain accepted. H2 free until corrected exact-head rereview.
- recommended_model: Sol（中）

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
- task_id: kabumori-pr101-debug-trace-security-corrective-20261007
- start_code: G2
- finish_code: K2
- next_owner: claude
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: PR #101のH2 F1-F3だけを修正。effective ACL/owner/default/inheritanceをfail-closed、free-text内credential redaction/detectorを強化、candidate/local/Fact evidenceのsilent truncationを解消。本文保存方針・append-only・非ブロッキング・Hard/PR99/300字rewrite/call ceilingは維持。OpenAIモデル更新は混ぜず、PR101 merge直後の次G2でGPT-6系へ移行する。
- recommended_model: Opus5.5（高）

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
- status: review_required
- task_id: common-account-v1-phase2-service-enrollment-integration-20261006
- start_code: G5
- finish_code: K5
- next_owner: codex
- source: .agent/tasks/CLAUDE_TASK_5.md
- report: .agent/tasks/CLAUDE_TASK_5.md#report
- allocation: K5 accepts round-4 Q1 fix as PASS_CANDIDATE on PR #95 exact head ba35b642d30ce423a8683feffcd26aec325b45ee. Superseded deferred Kabumori auth preparation is reported fenced before dispatch; S1-T/S1/S2/R1-R5 remain green. Production mutation/deploy/EAS 0. Merge HOLD pending mandatory H1 exact-head rereview.
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
