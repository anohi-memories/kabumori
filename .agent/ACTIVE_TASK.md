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
- task_id: broad-news-display-and-notification-presets-phase3-20260913
- start_code: H1
- finish_code: C1
- source: `.agent/tasks/CODEX_TASK.md`
- note: アプリmedium+表示・日本語カテゴリ/重要度・通知プリセットを実装。本番変更0件、C1レビュー待ち。

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
- status: in_progress
- task_id: x-multibrand-phase3f-ai-lab-production-like-dry-run-20260913
- start_code: G2
- finish_code: K2
- source: `.agent/tasks/CLAUDE_TASK.md`
- note: Phase 3E (`60dd7e4`, K2承認済み) を土台に、会社員AIラボの共有済みブランド方針をprofile/settingsへ反映し、実OpenAI APIを使う管理者専用dry-run入口を実装する作業に着手。

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
