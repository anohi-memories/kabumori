# Active Tasks Index

このファイルは共有オーケストレーションの後方互換用インデックスです。実装指示の正本は各専用TASKです。

- Codex slot 1: `.agent/tasks/CODEX_TASK.md`
- Codex slot 2: `.agent/tasks/CODEX_TASK_2.md`
- Claude slot 1: `.agent/tasks/CLAUDE_TASK_1.md`
- Claude slot 2: `.agent/tasks/CLAUDE_TASK.md`
- 共通ルール: `.agent/ORCHESTRATION.md`
- 現在地: `.agent/CURRENT_STATE.md`

## Current slots

### Codex slot 1
- owner: codex
- slot: codex-1
- status: review_required
- task_id: important-news-hourly-cadence-simplify-20260919
- start_code: H1
- finish_code: C1
- source: `.agent/tasks/CODEX_TASK.md`
- note: `important-news-fetch` Cron 1本のcommand gateをJST基準で簡素化済み。9/19〜9/23は偶数時00分のみ、9/24以降は毎時00分のみ。関連Cron不変。C1確認待ち。

### Codex slot 2
- owner: codex
- slot: codex-2
- status: ready
- task_id: social-mobile-app-phase6-auth-mobile-read-qa-20260918
- start_code: H2
- finish_code: C2
- source: `.agent/tasks/CODEX_TASK_2.md`
- note: Phase5 production membership/RLS C2 PASS後の実Auth/mobile read QA。no-membership stateとtenant RLSを確認し、user↔brandが一意・明示的ならcanary membershipは1件まで。production default data sourceはまだOFF。migration history未記録はrepairしない。

### Claude slot 1
- owner: claude
- slot: claude-1
- status: idle
- task_id: market-report-shared-platform-phase2-consumer-cutover-20260917
- start_code: G1
- finish_code: K1
- source: `.agent/tasks/CLAUDE_TASK_1.md`
- note: shadow analysis redeployはK1 PASS済み。consumer gate OFFのまま、2026-09-24自然shadow観測まで待機。

### Claude slot 2
- owner: claude
- slot: claude-2
- status: review_required
- task_id: social-mobile-app-phase8-completion-followup-claude-20260919
- start_code: G2
- finish_code: K2
- source: `.agent/tasks/CLAUDE_TASK.md`
- note: real non-admin sign-in QAはユーザー自身が実行し成功確認済み（ai_salaryman_lab only / kabumori=0 / mio=0）。fixture cleanupのDELETEはsafety reviewが再度ブロックしたため、Dashboard手動削除手順（Auth user削除→cascade→残り1件Table Editor削除）を提示してSTOP。production mutation 0件。K2待ち。

## Control codes

- `H1`: Codex slot 1開始。
- `H2`: Codex slot 2開始。
- `G`: Claudeではready/in_progressが1枠だけならその枠開始。
- `G1`: Claude slot 1開始。
- `G2`: Claude slot 2開始。
- `C1`: ChatGPTがCodex slot 1完了だけ確認。
- `C2`: ChatGPTがCodex slot 2完了だけ確認。
- `K1`: ChatGPTがClaude slot 1完了だけ確認。
- `K2`: ChatGPTがClaude slot 2完了だけ確認。
- `K`: Claude側の完了対象が1枠だけで明白な場合の簡易コード。
- `F`: 全4スロットの全体状況・競合・空き状況を確認する統括コード。

4スロットの並行実行は、task_idと変更対象が分離され競合しない場合に限る。Codex/Claudeの別を問わず、同じファイル・DB migration/RPC・Edge Function・workflow・production設定を複数slotで同時変更しない。
