# Active Task

このファイルは、ChatGPT（ちゃっぴー）が作成する最新指示の正本です。実装担当は作業開始前に `.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認してください。

## Task

- task_id: morning-greeting-enable-2026-09-06
- owner: claude
- status: done
- purpose: 2026-09-06朝の挨拶を、fresh-dateテストではなく本番自動投稿として安全に1回動かせる状態へする。
- result:
  - 自動投稿経路を実装・有効化済み
  - `posting_windows`: 06:30-07:00 JST / daily_probability=1 / is_active=true
  - x-test-post v86 ACTIVE
  - 画像生成workflowは05:30 JSTに自動実行予定
  - x-test-post全回帰 293/293 pass
  - commit `c4427ea` をorigin/mainへpush済み
- pending_followup:
  - 2026-09-06 00:00 JST以降に `scheduled_posts` をread-only確認し、確定した朝の挨拶投稿予定時刻を確認する
  - 2026-09-06朝、投稿結果（scheduled_posts / publish_claims / x_post_id）をread-only確認する
- forbidden:
  - 2026-09-05のfailed claimを削除・変更・再利用しない
  - 他workstreamの未コミット変更を変更・stage・commitしない
  - secretsを表示・変更しない
- commit: 完了済み `c4427ea`
- push: 完了
- deploy: x-test-post v86 ACTIVE
- next_owner: chatgpt

## Status values

- `idle`: 有効な指示なし（初期状態・次指示待ち）
- `ready`: ownerが開始できる
- `in_progress`: ownerが作業中
- `review_required`: 実装済みで確認・判断待ち
- `done`: 完了

`owner` は `codex` または `claude` のどちらか一方だけを指定します。`status: idle` のときだけ `owner: none` を使用できます。
