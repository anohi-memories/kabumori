# Active Task

このファイルは、ChatGPT（ちゃっぴー）が作成する最新指示の正本です。実装担当は作業開始前に `.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認してください。

## Task

- task_id: none
- owner: none
- status: idle
- purpose: 次指示待ち
- scope: なし
- forbidden:
  - 未指定のファイル・機能を変更しない
  - 他workstreamの未コミット変更を変更・stage・commitしない
- completion_criteria: なし
- commit: 指示がある場合のみ
- push: 指示がある場合のみ
- deploy: 指示がある場合のみ
- next_owner: chatgpt

## Status values

- `idle`: 有効な指示なし（初期状態・次指示待ち）
- `ready`: ownerが開始できる
- `in_progress`: ownerが作業中
- `review_required`: 実装済みで確認・判断待ち
- `done`: 完了

`owner` は `codex` または `claude` のどちらか一方だけを指定します。`status: idle` のときだけ `owner: none` を使用できます。
