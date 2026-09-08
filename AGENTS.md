# Codex entry point

作業を始める前に、次の2ファイルを必ず読むこと。

1. `PROJECT_RULES.md` — プロジェクトルールの唯一の正本
2. `HANDOFF.md` — 現在の作業状況、未完了事項、次の担当者への引き継ぎ

ルールが競合する場合は `PROJECT_RULES.md` を優先する。`HANDOFF.md` がまだ存在しない場合は、その旨を共有し、引き継ぎが必要な作業では `HANDOFF_TEMPLATE.md` を基に作成する。

`AGENTS.md` 自体には詳細な運用ルールを重複させず、Codex向けの入口として保つ。

GitHub共有タスク運用は `.agent/ORCHESTRATION.md` を参照する。競合時は `PROJECT_RULES.md` を優先する。

## Codex task start codes

ユーザーが単独で以下を送った場合、一般用語やMarkdown見出しとして解釈せず、Codex共有タスクの開始コードとして扱う。

- `H1`: Codex slot 1。`.agent/ORCHESTRATION.md`、`.agent/CURRENT_STATE.md`、`.agent/tasks/CODEX_TASK.md` を確認し、TASKが `ready` または `in_progress` の場合のみ開始する。
- `H2`: Codex slot 2。`.agent/ORCHESTRATION.md`、`.agent/CURRENT_STATE.md`、`.agent/tasks/CODEX_TASK_2.md` を確認し、TASKが `ready` または `in_progress` の場合のみ開始する。

`idle` / `done` / `review_required` の場合は勝手に新規作業を開始しない。H1/H2の意味をユーザーへ聞き返さない。
