# Active Tasks Index

このファイルは共有オーケストレーションの後方互換用インデックスです。実装指示の正本は各専用TASKです。

- Codex slot 1
- owner: codex
- slot: codex-1
- status: review_required
- task_id: kabumori-important-news-caller-auth-merge-only-20260924
- start_code: H1
- finish_code: C1
- source: `.agent/tasks/CODEX_TASK.md`
- note: PR #12 reviewed head `9dffce9` merged normally as `844c77d`; all seven files read back identical. Vercel passed. Production migration remains unapplied, Vault entry absent, monitor ACTIVE v64 / `verify_jwt=false`, and Cron fingerprints unchanged. No production mutation. PR #11 remains open/draft/unmerged and untouched. Stop for C1.


### Codex slot 2
- owner: codex
- slot: codex-2
- status: ready
- task_id: x-autopost-phase0c-production-brand-scope-rollout-20260923
- start_code: H2
- finish_code: C2
- source: `.agent/tasks/CODEX_TASK_2.md`
- note: compatible x-test-postを先に本番deployし、runtime確認後にexact migrationを適用するPhase0c。production mutation直前に明示同意必須。GPT-6 Sol Medium推奨。

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
- status: in_progress
- task_id: x-admin-netlify-thin-control-plane-phase1-20260924
- start_code: G2
- finish_code: K2
- source: `.agent/tasks/CLAUDE_TASK.md`
- note: apps/admin限定でNetlify Free向けthin management UI化の設計・source candidateに着手。H2(x-test-post本番rollout)/H1(important-news caller-auth)/G1(consumer mobile)とは非競合。production変更0件。

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
