# Agent Orchestration

## 位置づけと優先順位

この文書は、ChatGPT（ちゃっぴー）・Codex（こでさん）・Claude Code（くろちゃん）がGitHub上の最新指示と完了報告を共有するための半自動運用ルールです。

- `PROJECT_RULES.md` を最優先とする。
- `AGENTS.md` / `CLAUDE.md` の開始手順にも従う。
- `.agent/` は共有タスク運用専用。`HANDOFF.md` / `HANDOFF_TEMPLATE.md` は置き換えない。
- Codex 1枠、Claude Code 2枠を同時運用できる。
- 並行作業は変更対象が安全に分離されている場合だけ許可する。

## タスク正本

- Codex: `.agent/tasks/CODEX_TASK.md`
- Claude slot 1: `.agent/tasks/CLAUDE_TASK_1.md`
- Claude slot 2: `.agent/tasks/CLAUDE_TASK.md`

`.agent/ACTIVE_TASK.md` は後方互換用インデックス。実装指示の正本は上記3ファイル。

## コード

### G / G1 / G2 — 作業開始

- Codexに `G`: `.agent/tasks/CODEX_TASK.md` を確認して開始。
- Claude Codeに `G1`: `.agent/tasks/CLAUDE_TASK_1.md` を確認して開始。
- Claude Codeに `G2`: `.agent/tasks/CLAUDE_TASK.md` を確認して開始。
- Claude Codeに単独で `G` が来た場合、ready/in_progressのClaudeスロットが1つだけならそのスロットを開始してよい。2つとも対象なら推測せず `G1` / `G2` の指定を求める。

開始時は origin/main をfresh-checkし、ORCHESTRATION/CURRENT_STATE/自分のTASKを確認する。statusがreadyまたはin_progressのときだけ作業する。idle/done/review_requiredでは新規作業を始めない。

### C — Codex完了確認

ChatGPTに `C` とだけ送られた場合、Codex系だけを確認する。

- `.agent/tasks/CODEX_TASK.md`
- `.agent/CODEX_REPORT.md`
- 必要な範囲の `.agent/CURRENT_STATE.md`

Claude側の完了報告・タスクは勝手に処理しない。Codexの完了条件、テスト、commit/push/deploy、残課題、安全確認を評価し、必要ならCodex TASKだけ更新する。

### K1 / K2 — Claude完了確認

ChatGPTに `K1` とだけ送られた場合、Claude slot 1だけを確認する。

- `.agent/tasks/CLAUDE_TASK_1.md` のtaskとinline Report
- 必要な範囲の `.agent/CURRENT_STATE.md`

ChatGPTに `K2` とだけ送られた場合、Claude slot 2だけを確認する。

- `.agent/tasks/CLAUDE_TASK.md` のtaskとinline Report
- 必要な範囲の `.agent/CURRENT_STATE.md`

他スロットやCodex側を勝手に完了処理しない。

### K — Claude簡易完了確認

`K` だけの場合、review_required/doneで未評価のClaudeスロットが1つだけならそのスロットを評価してよい。2つ以上あって曖昧なら勝手に選ばず `K1` / `K2` のどちらかをユーザーへ案内する。

### F — Full status / 全体統括

ChatGPTに `F` とだけ送られた場合は、特定担当の完了コードではなく全体状況確認とする。

確認対象:
- `.agent/ACTIVE_TASK.md`
- `.agent/CURRENT_STATE.md`
- `.agent/tasks/CODEX_TASK.md`
- `.agent/tasks/CLAUDE_TASK_1.md`
- `.agent/tasks/CLAUDE_TASK.md`
- `.agent/CODEX_REPORT.md`

Fでは3スロットの状態・競合・空き状況を整理し、必要なら次の割当方針を決める。別チャットが担当している個別タスクを、文脈なしに勝手に完了判定・次工程へ進めない。

## 完了報告のGitHub同期は必須

G/C/K運用が成立するため、実装コードをpushできない場合でも、完了・停止時の `.agent/` 制御情報だけは必ずGitHub `origin/main` へ反映する。

### Codex

作業を終了・停止するときは必ず以下をGitHubへ同期する。

- `.agent/tasks/CODEX_TASK.md` の `status` を `done` または `review_required` に更新
- `.agent/CODEX_REPORT.md` を最新結果で置き換える

### Claude

作業を終了・停止するときは必ず自分のTASKファイルへ `## Report` を記録し、`status` を `done` または `review_required` に更新してGitHubへ同期する。

### 実装コードをpushできない場合の扱い

ローカルHEADが古い、他workstreamの未コミット変更がある、実装コードを安全にcommit/pushできない、という理由で `.agent/` 完了報告までローカルだけに残してはならない。

その場合は実装コードに触れず、`origin/main` を基点にした一時的なclean worktree等の安全な方法を使い、自分の `.agent/` 制御ファイルだけを最小commitでpushする。

- 他workstreamの変更をstage/commitしない
- 実装コードをその制御用commitへ混ぜない
- push直前に `origin/main` を再fresh-checkする
- non-fast-forwardや同じ制御ファイルの競合が出た場合は上書きせず停止し、同期失敗をユーザーへ明示する
- 「実装コードはlocal only」「commit/pushなし」等の事実はReportへ明記する

`.agent/` のGitHub同期まで終わって初めて、ユーザーへ「C」「K1」「K2」で確認可能と報告する。

## Claude並列スロットの完了報告

Claude slot 1/2は各TASKファイル末尾の `## Report` をそのスロット専用完了報告として使う。これにより同時完了時の上書きを防ぐ。

Report必須項目:
- task_id
- result
- changed_files
- tests
- commit_hash
- push
- deploy
- remaining_issues
- safety_checks
- next_recommendation

Codexは `.agent/CODEX_REPORT.md` を使用する。

## 並行作業と競合防止

- 3スロットは別task_idかつ変更対象が分離される場合のみ同時進行可能。
- 同じファイルを同時編集しない。
- 同じDB migration / RPC / Edge Function / workflow / production settingを複数スロットが同時変更しない。
- 一方のpush後、他スロットはpush前にfresh-checkをやり直す。
- 既存未コミット変更は他workstreamの所有物として扱い、変更・削除・stage・commitしない。
- scopeが曖昧、競合可能性を安全に判定できない場合は作業を開始しない。

## ACTIVE_TASK.md の役割

`.agent/ACTIVE_TASK.md` は古いF/Gルールや別チャットとの互換性を保つため残す。3スロットの状態と正本への参照だけを一覧表示し、詳細指示は各TASKへ置く。

## 共通安全ルール

- 確認済み事実と未確認事項を分ける。
- 未実施を成功扱いにしない。
- secrets、認証情報、個人情報、不要な生データを書かない。
- 自分のスロット以外のTASK/Reportを完了報告として書き換えない。
