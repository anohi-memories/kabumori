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
- task_id: ai-lab-daily-content-plan-writer-postgres-proof-20260918
- start_code: H1
- finish_code: C1
- source: `.agent/tasks/CODEX_TASK.md`
- note: C1 blockerだった実PostgreSQL disposable proofを完了。Phase1+Phase2 migration apply、RPC/grant/security、state/idempotency、並列activation、consumer query、rollback dry-runを確認。production mutation 0。C1確認待ち。

### Codex slot 2
- owner: codex
- slot: codex-2
- status: ready
- task_id: social-mobile-app-phase5-production-membership-rls-rollout-20260918
- start_code: H2
- finish_code: C2
- source: `.agent/tasks/CODEX_TASK_2.md`
- note: Phase4 disposable proof C2 PASS後のproduction rollout。exact `brand_memberships` + tenant RLS candidateのみをpreflight→apply→postflight→admin compatibility→rollback readinessで反映する。blind db push禁止。canary membershipはuser/brandを一意確認できる場合のみ1件まで。data sourceはまだONにしない。

### Claude slot 1
- owner: claude
- slot: claude-1
- status: review_required
- task_id: market-report-shared-platform-phase2-consumer-cutover-20260917
- start_code: G1
- finish_code: K1
- source: `.agent/tasks/CLAUDE_TASK_1.md`
- note: shared market_report_packet候補とX/app consumer gate実装のK1 review待ち。`x-test-post`を含むためH1 writer Phase2は同ファイルを変更しない。

### Claude slot 2
- owner: claude
- slot: claude-2
- status: done
- task_id: morning-greeting-image-cost-gate-rollout-20260917
- start_code: G2
- finish_code: K2
- source: `.agent/tasks/CLAUDE_TASK.md`
- note: K2 PASS・main反映済み。自然OFF確認は別read-only観測。

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
