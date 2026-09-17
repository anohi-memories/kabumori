# Claude Task 2

- task_id: morning-greeting-image-cost-gate-rollout-20260917
- owner: claude
- slot: claude-2
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Sonnet
- purpose: K2承認済みの朝の挨拶画像生成コストゲート実装 `afe5d87` を最新 `origin/main` に安全に取り込み、翌朝05:30 JSTの自然実行でOFF時に画像生成コストが発生しないことを確認できる状態へ進める。

## K2 approval / source of truth

前タスク `morning-greeting-image-disable-cost-gate-20260916` はK2 PASS済み。

承認済み実装:
- branch: `morning-greeting-image-cost-gate-20260916`
- commit: `afe5d87`
- changed files:
  - `scripts/morning-greeting-image.ts`
  - `scripts/morning-greeting-image.test.ts`
- tests: 28/28 PASS
- OFF path: OpenAI image call 0 / Storage image write 0
- ON path: existing behavior preserved
- production changes before K2: 0

K2時点でbranchはmainに対して1 behind / 1 aheadだったため、古いmainへ直接pushしないこと。

## Parallel safety

開始前に必ず読む:
1. `.agent/ORCHESTRATION.md`
2. `.agent/CURRENT_STATE.md`
3. this TASK
4. `.agent/tasks/CODEX_TASK.md`
5. `.agent/tasks/CODEX_TASK_2.md`
6. `.agent/tasks/CLAUDE_TASK_1.md`
7. fresh `origin/main`

現状:
- Codex slot1 hotfixはdone。`x-test-post`/Admin側を触らない。
- Codex slot2 URL除去はdone。`important-news-monitor`を触らない。
- Claude slot1はmarket report Phase1を進行中で、`scripts/morning-greeting-image*`を触らない指示済み。

このG2が触れてよい実装対象は承認済みの以下のみ:
- `scripts/morning-greeting-image.ts`
- `scripts/morning-greeting-image.test.ts`
- 自分の `.agent/tasks/CLAUDE_TASK.md`

`.github/workflows/morning-greeting-image.yml` は承認済み実装で変更不要。新規変更しない。

## Goal

最新 `origin/main` を基点に、`afe5d87` の承認済み変更だけを安全に統合し、mainへpushする。

## Required procedure

1. isolated clean worktree/cloneで最新 `origin/main` を取得。
2. `afe5d87` の2ファイル差分を最新mainへ適用する。
   - cherry-pickでもよいが、競合が出た場合は内容を勝手に解決せずSTOPして報告。
   - 承認済み差分以外を混ぜない。
3. main側で承認後に入った関連差分があるか確認。`scripts/morning-greeting-image*` に新しい競合/仕様変更があればSTOP。
4. テスト:
   - `node --experimental-strip-types --test scripts/morning-greeting-image.test.ts`
   - expected 28/28以上（main側追加テストがあれば全件PASS）
   - `git diff --check`
5. 承認済み差分だけであることを確認。
6. push直前に再度 `origin/main` fresh-check。
7. fast-forward可能な安全な形でmainへpush。
8. origin/main read-backで2ファイルにゲート実装が入ったことを確認。

## Production boundary

このタスクで許可:
- GitHub mainへの承認済みコード統合
- read-onlyなGitHub確認

このタスクではまだ行わない:
- `posting_windows` の本番値変更
- 管理画面toggleの代理操作
- manual `workflow_dispatch`
- OpenAI API呼び出し
- Storage書き込み検証
- X投稿/Push/API手動実行
- Cron/workflow schedule変更
- Supabase schema/RPC/migration変更

main反映後、ユーザーが管理画面で「朝の挨拶」をOFFにする。その状態で翌朝05:30 JSTの**自然な定時実行**を待つ。

## Tomorrow verification target

翌朝の自然実行後に別確認タスクで最低限確認する:
- workflow log: `morning greeting disabled; image generation skipped`
- OpenAI画像生成が実行されていない
- 新規Storage画像が作成されていない
- workflowはOFFを正常skipとして終了

人工実行で確認しない。

## Completion

main反映まで完了したら:
- this TASKを `status: review_required`
- `next_owner: chatgpt`
- `## Report` を追記
- commit/push hash
- source_base / final_head
- tests
- changed files
- main read-back
- production setting changes = 0
- manual OpenAI/workflow dispatch = 0
- user next action = 管理画面で朝の挨拶をOFF
- tomorrow observation requirement

を記録してorigin/mainへ同期し、K2待ちでSTOP。
