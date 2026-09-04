# Agent Orchestration

## 位置づけと優先順位

この文書は、ChatGPT（ちゃっぴー）・Codex（こでさん）・Claude Code（くろちゃん）が、ユーザーを中継役としてGitHub上の最新指示と完了報告を共有するための半自動運用ルールです。

- 既存の `PROJECT_RULES.md` を最優先とする。
- `AGENTS.md` / `CLAUDE.md` の開始手順にも従う。
- `.agent/` は共有タスク運用専用であり、既存の `HANDOFF.md` / `HANDOFF_TEMPLATE.md` の用途を置き換えない。
- `HANDOFF.md` はWeb-admin系を含む既存引き継ぎ用途のため、この共有運用だけを理由に変更しない。
- 今回は完全自動化せず、ユーザーが各エージェント間を中継する。

## F — ChatGPTへの完了確認指示

ユーザーがChatGPT（ちゃっぴー）に `F` とだけ送った場合、次を意味します。

> 担当エージェントの作業が終わったようなので、GitHub上の最新共有状態と完了報告を確認し、結果を評価して次の指示を作る。

ChatGPTはGitHub上の最新状態を取得し、次の4ファイルを確認します。

1. `.agent/ACTIVE_TASK.md`
2. `.agent/CURRENT_STATE.md`
3. `.agent/CODEX_REPORT.md`
4. `.agent/CLAUDE_REPORT.md`

その後、`ACTIVE_TASK.md` の `owner` と `task_id` に対応する担当者の最新REPORTを評価します。完了条件、テスト、commit/push/deploy条件、残課題、安全確認を判定し、必要なら次の `ACTIVE_TASK.md` を作る方針に進みます。報告不足や不整合がある場合は、完了扱いにせず確認事項を明示します。

## G — Codex / Claude Codeへの作業開始指示

ユーザーがCodexまたはClaude Codeに `G` とだけ送った場合、次を意味します。

> GitHub上の最新指示を読み、自分が担当なら作業を開始する。

既存ルールで要求される開始時確認を行ったうえで、必ず次の順序で進めます。

1. `origin/main` をfetchし、ローカルとの差分をfresh-checkする。
2. `.agent/ACTIVE_TASK.md` を読む。
3. `.agent/CURRENT_STATE.md` を読む。
4. `owner` が自分（`codex` または `claude`）か確認する。
5. `scope`、`forbidden`、完了条件、commit/push/deploy条件を確認する。
6. ownerでなければ作業せず、「現在の担当は○○」とだけ報告する。
7. ownerなら、開始を共有する必要がある場合は `status: in_progress` に更新してから作業する。
8. 完了後、自分のREPORT（`CODEX_REPORT.md` または `CLAUDE_REPORT.md`）を最新結果で置き換える。
9. `ACTIVE_TASK.md` のstatusを `done` または `review_required` に更新する。
10. 指示された場合のみ、対象ファイルを限定してcommit / push / deployする。

fresh-checkの結果、`origin/main` が進んでいる、競合がある、または安全に同期できない場合は勝手に上書きせず停止して報告します。

## Ownerと競合防止

- `ACTIVE_TASK.md` の `owner` を、そのtaskの唯一の実装担当として扱う。
- CodexとClaude Codeが同じ `task_id` を同時に実装してはならない。
- owner以外が `G` を受けても、ファイル変更・commit・push・deployを行わない。
- 並行作業は、別taskとしてscopeと変更対象が完全に分離され、`ACTIVE_TASK.md` に明記されている場合だけ許可する。
- ownerやscopeが曖昧な場合は作業を開始せず、ユーザーまたはChatGPTに確認する。
- 既存の未コミット変更は他workstreamの所有物として扱い、上書き・削除・stage・commitしない。

## REPORT更新ルール

- REPORTには `task_id`、`result`、`changed_files`、`tests`、`commit_hash`、`push`、`deploy`、`remaining_issues`、`safety_checks`、`next_recommendation` を必ず含める。
- 確認済みの事実と未確認事項を分け、未実施を成功扱いにしない。
- 秘密情報、認証情報、個人情報、不要な生データを書かない。
- 自分のREPORTだけを更新し、他エージェントのREPORTを完了報告として書き換えない。
