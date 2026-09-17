# Claude Task 2

- task_id: morning-greeting-image-cost-gate-rollout-20260917
- owner: claude
- slot: claude-2
- status: review_required
- next_owner: chatgpt
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

## Report

- commit/push hash: 承認済み`afe5d87`を`git cherry-pick`し、最新origin/main上でリベース後`e8bd8cc`としてpush済み。
- source_base / final_head: 作業開始時点の`origin/main`は`1d45b36`だったが、cherry-pick完了後・push直前の再fetchで`ea3cd82`（別スロットによる`.agent/tasks/CODEX_TASK.md`のみの更新）へ進んでいるのを検知。対象2ファイルへの競合はないことを確認した上で`git rebase origin/main`を実行し、そのまま`ea3cd82`の直後としてfast-forward pushした（final_head: `e8bd8cc`）。push直前に再度`origin/main`をfetchし、追加の変更が無いことを確認してから実行。
- tests: `node --experimental-strip-types --test scripts/morning-greeting-image.test.ts`で26/26 pass（cherry-pick後・rebase後の両方で実行し確認）。`git diff --check`で空白エラーなし。**訂正**: 前タスクのReportで「28/28 PASS」と報告していたが、実際のテスト数は26件（`grep -c "^test("`で確認）。全件PASSという結論自体は変わらないが、件数の記載が誤っていたため本Reportで訂正する。
- changed files: `scripts/morning-greeting-image.ts`, `scripts/morning-greeting-image.test.ts`の2件のみ（承認済み差分と完全一致、他ファイルは一切混ざっていない）。
- main read-back: `origin/main`から`scripts/morning-greeting-image.ts`をread-backし、`checkMorningGreetingEnabled`/`runMorningGreetingImageJob`が実装されていることを確認。`scripts/morning-greeting-image.test.ts`のテスト数も26件であることを確認。
- production setting changes: 0件。`posting_windows`の値、admin toggle、Supabase schema/RPC/migration、Cron/workflow scheduleのいずれも変更していない。
- manual OpenAI/workflow dispatch: 0件。`workflow_dispatch`の手動実行、OpenAI API呼び出し、Storage書き込み検証は一切行っていない。
- user next action: 管理画面で「朝の挨拶」をOFFにする。
- tomorrow observation requirement: 翌朝05:30 JSTの自然な定時実行後、以下を別確認タスクで検証すること: (1) workflow logに`morning greeting disabled; image generation skipped`が出力される、(2) OpenAI画像生成が実行されていない、(3) 新規Storage画像が作成されていない、(4) workflowがOFFを正常skip（exit 0）として終了している。人工実行では確認しないこと。
