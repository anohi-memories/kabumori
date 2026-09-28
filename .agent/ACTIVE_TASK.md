# Active Tasks Index

このファイルは共有オーケストレーションの6枠インデックスです。詳細指示と割当の正本は各TASK/Reportです。statusだけで空き判定せず、task_idとTASK本文も確認してください。

## Routing preference

- かぶモリアプリ実装は G1 / G2 を使用する。
- X自動投稿・複数ブランドX実装は G3 / G4 を使用する。
- 各ペア内の割当は空き状況・競合・依存関係を見てChatGPTが決める。
- H1/H2はCodexのレビュー・バグ修正・検証枠。
- ユーザーの個別指定がある場合はその指定を優先する。
- 競合防止ルールは常に優先する。

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
- task_id: x-social-mobile-auth-phase2-final-acceptance-review-20260928
- start_code: H1
- finish_code: C1
- source: `.agent/tasks/CODEX_TASK.md`
- report: `.agent/CODEX_REPORT.md`
- allocation: closed; Final C1 PASS-WITH-FIX; PR #47 accepted at `ed5f8b7` and merged as `fbddef2`

## Codex H2
- owner: codex
- slot: codex-2
- status: idle
- task_id: none
- start_code: H2
- finish_code: C2
- source: `.agent/tasks/CODEX_TASK_2.md`
- report: `.agent/CODEX_REPORT_2.md`
- allocation: unassigned; previous deferred PR #32 review closed as stale/obsolete after the target PR was already merged; historical report preserved

## Claude G1
- owner: claude
- slot: claude-1
- status: review_required
- task_id: kabumori-daily-topic-level-settings-20260928
- start_code: G1
- finish_code: K1
- source: `.agent/tasks/CLAUDE_TASK_1.md`
- allocation: K1 source PASS at PR #48 `98732bf`; migration/RPC independent review still mandatory before merge/apply. H1 currently occupied by X Auth review; H2 deferred task protected, so no review slot overwritten. Preferred next H1 with Sol（高） when genuinely free.

## Claude G2
- owner: claude
- slot: claude-2
- status: ready
- task_id: kabumori-shared-analysis-prod-deploy-observe-20260928
- start_code: G2
- finish_code: K2
- source: `.agent/tasks/CLAUDE_TASK.md`
- allocation: in progress; shared-checkout config incident recovered; continue ONLY from `/Users/yuya/Developer/kabumori-g2-market-report-reliability` on fresh main `fc0afd32`; old PR #45 branch/worktree and shared checkout are forbidden for deploy; deploy only market-report-analysis with app/x gates OFF; recommended Sonnet5（高）

## Claude G3
- owner: claude
- slot: claude-3
- status: ready
- task_id: x-social-mobile-auth-release-readiness-phase3-20260928
- start_code: G3
- finish_code: K3
- source: `.agent/tasks/CLAUDE_TASK_3.md`
- allocation: assigned; Auth Phase 2 is accepted/merged. Proceed with release-readiness/account settings/config validation only; no production provider/config mutation. Independent G3 worktree required. Recommended Opus5.5（高）.

## Claude G4
- owner: claude
- slot: claude-4
- status: ready
- task_id: x-social-mobile-posting-interaction-phase2-20260928
- start_code: G4
- finish_code: K4
- source: `.agent/tasks/CLAUDE_TASK_4.md`
- allocation: assigned; implement truthful preview/edit/regenerate/approve/retry/reconnect UX only where backend contracts exist. No real X post or production mutation. Independent G4 worktree required. Recommended Sonnet5（高）.

## Deferred

- PR #15 is closed with Final K4 PASS. PR #33 remains unmerged; its Auth/security review/merge decision can now be scheduled separately after fresh slot review.
- Kabumori Expo Web Netlify Preview task is also deferred because it is not currently needed for the native app workflow.

## Control codes

- `H1` / `H2`: Codex H1/H2開始。
- `G1`〜`G4`: Claude G1〜G4開始。
- `C1` / `C2`: ChatGPTが対応Codex枠だけ完了確認。
- `K1`〜`K4`: ChatGPTが対応Claude枠だけ完了確認。
- `F`: 全6枠の状態・競合・実際の空き状況を確認する統括コード。

並行実行はtask_idと変更対象が分離され競合しない場合に限る。同じファイル・DB migration/RPC・Edge Function・workflow・production設定等を複数枠で同時変更しない。
