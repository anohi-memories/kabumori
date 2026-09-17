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
- task_id: x-ai-lab-vault-token-refresh-candidate-20260917
- start_code: H1
- finish_code: C1
- source: `.agent/tasks/CODEX_TASK.md`
- note: AI Lab専用refresh/rotation candidate `ed796ba` とmock testsを作成。production deploy/token mutation/OAuth再認可は未実施。C1 review_required。

### Codex slot 2
- owner: codex
- slot: codex-2
- status: done
- task_id: kabumori-news-url-removal-production-deploy-20260917
- start_code: H2
- finish_code: C2
- source: `.agent/tasks/CODEX_TASK_2.md`
- note: important-news-monitor v55へURL除去変更を本番反映済み。自然投稿のread-only観測のみ別件で残る。

### Claude slot 1
- owner: claude
- slot: claude-1
- status: ready
- task_id: market-report-shared-platform-phase2-consumer-cutover-20260917
- start_code: G1
- finish_code: K1
- source: `.agent/tasks/CLAUDE_TASK_1.md`
- note: Phase1 shadow packetは本番稼働済み。Phase2はshared market_report_packetとX/app consumer候補を作る。production consumer switchはK1前に行わない。

### Claude slot 2
- owner: claude
- slot: claude-2
- status: done
- task_id: morning-greeting-image-cost-gate-rollout-20260917
- start_code: G2
- finish_code: K2
- source: `.agent/tasks/CLAUDE_TASK.md`
- note: K2 PASS・main反映済み。翌朝05:30 JSTの自然OFF確認は別read-only観測であり、このslotは空き。

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

4スロットの並行実行は、task_idと変更対象が分離され競合しない場合に限る。Codex/Claudeの別を問わず、同じファイル・DB migration/RPC・Edge Function・workflow・production設定を複数スロットで同時変更しない。
