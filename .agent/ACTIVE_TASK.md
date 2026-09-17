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
- task_id: x-multibrand-phase3h-ai-lab-prelive-safeguards-20260913
- start_code: H1
- finish_code: C1
- source: `.agent/tasks/CODEX_TASK.md`
- note: AI Labの280文字制限とfingerprint完了記録をローカル準備。Vault-backed live dispatch統合は安全審査で停止。本番変更0件、C1レビュー待ち。

### Codex slot 2
- owner: codex
- slot: codex-2
- status: ready
- task_id: x-close-report-topix-source-correction-20260911
- start_code: H2
- finish_code: C2
- source: `.agent/tasks/CODEX_TASK_2.md`

### Claude slot 1
- owner: claude
- slot: claude-1
- status: review_required
- task_id: personalized-portfolio-morning-close-reports-phase1-20260911
- start_code: G1
- finish_code: K1
- source: `.agent/tasks/CLAUDE_TASK_1.md`

### Claude slot 2
- owner: claude
- slot: claude-2
- status: review_required
- task_id: morning-greeting-image-disable-cost-gate-20260916
- start_code: G2
- finish_code: K2
- source: `.agent/tasks/CLAUDE_TASK.md`
- note: `scripts/morning-greeting-image.ts`に`checkMorningGreetingEnabled`+`runMorningGreetingImageJob`を追加し、posting_windows(kabumori/morning_greeting).is_active=falseならOpenAI/Storage呼び出し前に正常スキップ、不明時は生成せずexit 1で可視化。既存生成経路は無変更。ブランチ`morning-greeting-image-cost-gate-20260916`(commit afe5d87)へpush済み、mainへは未マージ。本番変更0件。K2待ち。

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
