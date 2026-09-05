# Agent Orchestration

## 位置づけと優先順位

この文書は、ChatGPT（ちゃっぴー）・Codex（こでさん）・Claude Code（くろちゃん）が、ユーザーを中継役としてGitHub上の最新指示と完了報告を共有するための半自動運用ルールです。

- 既存の `PROJECT_RULES.md` を最優先とする。
- `AGENTS.md` / `CLAUDE.md` の開始手順にも従う。
- `.agent/` は共有タスク運用専用であり、既存の `HANDOFF.md` / `HANDOFF_TEMPLATE.md` の用途を置き換えない。
- `HANDOFF.md` はWeb-admin系を含む既存引き継ぎ用途のため、この共有運用だけを理由に変更しない。
- 完全自動化せず、ユーザーが各エージェント間を中継する。
- CodexとClaude Codeは、担当ファイル・DB・deploy対象が競合しない別タスクなら同時進行できる。

## タスク正本

実装担当ごとに1つの専用タスクスロットを持ちます。

- Codex: `.agent/tasks/CODEX_TASK.md`
- Claude Code: `.agent/tasks/CLAUDE_TASK.md`

`.agent/ACTIVE_TASK.md` は後方互換用の一覧・案内ファイルです。実装担当は自分の専用タスクファイルを正本として扱います。

各専用タスクの `status` は `idle / ready / in_progress / review_required / done` を使用します。

## F — ChatGPTへの完了確認・全体調整指示

ユーザーがChatGPT（ちゃっぴー）に `F` とだけ送った場合、次を意味します。

> GitHub上の全共有タスクと各担当の完了報告を確認し、完了判定・競合確認・次の割当を行う。

ChatGPTは原則として次を確認します。

1. `.agent/ACTIVE_TASK.md`
2. `.agent/CURRENT_STATE.md`
3. `.agent/tasks/CODEX_TASK.md`
4. `.agent/tasks/CLAUDE_TASK.md`
5. `.agent/CODEX_REPORT.md`
6. `.agent/CLAUDE_REPORT.md`

各タスクについて、担当者のREPORTと突き合わせて、完了条件、テスト、commit/push/deploy条件、残課題、安全確認を判定します。

- 一方が作業中でも、もう一方に競合しない別タスクを割り当ててよい。
- 同じファイル、同じmigration、同じEdge Function、同じ設定行などに触れる可能性がある場合は同時進行させない。
- 報告不足や不整合があるタスクは完了扱いにしない。
- 次タスクを割り当てる場合は対象エージェントの専用タスクファイルだけを更新する。
- 必要に応じて `.agent/ACTIVE_TASK.md` の一覧も同期する。

## G — Codex / Claude Codeへの作業開始指示

ユーザーがCodexまたはClaude Codeに `G` とだけ送った場合、次を意味します。

> GitHub上の自分専用タスクを読み、担当タスクがあれば開始する。

既存ルールで要求される開始時確認を行ったうえで、必ず次の順序で進めます。

1. `origin/main` をfetchし、ローカルとの差分をfresh-checkする。
2. `.agent/ORCHESTRATION.md` を読む。
3. `.agent/CURRENT_STATE.md` を読む。
4. 自分専用のタスクファイルを読む。
   - Codex: `.agent/tasks/CODEX_TASK.md`
   - Claude Code: `.agent/tasks/CLAUDE_TASK.md`
5. `status` が `ready` または `in_progress` か確認する。
6. `idle` / `done` / `review_required` なら新規作業を開始せず、現在状態だけ報告する。
7. `scope`、`forbidden`、完了条件、commit/push/deploy条件を確認する。
8. 他エージェントのタスクと変更対象が競合する可能性がある場合は、勝手に進めず停止して報告する。
9. 作業開始時は自分の専用タスクだけ `status: in_progress` に更新する。
10. 完了後、自分のREPORT（`CODEX_REPORT.md` または `CLAUDE_REPORT.md`）を最新結果で置き換える。
11. 自分の専用タスクを `done` または `review_required` に更新する。
12. 指示された場合のみ、対象ファイルを限定してcommit / push / deployする。

fresh-checkの結果、`origin/main` が進んでいる、競合がある、または安全に同期できない場合は勝手に上書きせず停止して報告します。

## 並行作業と競合防止

- CodexとClaude Codeは、**別task_idかつ変更対象が分離されている場合のみ**同時進行できる。
- 同じtask_idを両者へ割り当てない。
- 同じファイルを同時編集しない。
- 同じDB migration / RPC / Edge Function / workflow / production settingを双方が同時変更しない。
- 一方のcommitが他方の作業対象へ影響した場合、後からpushする側はfresh-checkをやり直す。
- 既存の未コミット変更は他workstreamの所有物として扱い、上書き・削除・stage・commitしない。
- scopeが曖昧、または競合可能性を安全に判定できない場合は並行作業を開始しない。

## ACTIVE_TASK.md の役割

`.agent/ACTIVE_TASK.md` は、古いF/Gルールや別チャットとの互換性を保つため残します。

- 現在のCodex/Claude両スロットの状態と参照先を一覧表示する。
- 新しい実装指示の正本は各 `.agent/tasks/*_TASK.md` とする。
- 古いクライアントが `ACTIVE_TASK.md` だけを読んでも、どのファイルを見るべきか分かる状態を維持する。

## REPORT更新ルール

- REPORTには `task_id`、`result`、`changed_files`、`tests`、`commit_hash`、`push`、`deploy`、`remaining_issues`、`safety_checks`、`next_recommendation` を必ず含める。
- 確認済みの事実と未確認事項を分け、未実施を成功扱いにしない。
- 秘密情報、認証情報、個人情報、不要な生データを書かない。
- 自分のREPORTだけを更新し、他エージェントのREPORTを完了報告として書き換えない。
