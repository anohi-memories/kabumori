# Claude Task 5 — UNASSIGNED TEMPLATE

- task_id: none
- owner: claude
- slot: claude-5
- status: idle
- next_owner: none
- start_code: G5
- finish_code: K5
- recommended_model: none

## Purpose / allocation

未割当の予備Claude実装スロット。用途は固定しない。ユーザーまたはChatGPTが明示割当した場合のみ使用する。既存のG1/G2=かぶモリアプリ、G3/G4=X自動投稿アプリの基本ルーティングを維持し、MIC用に自動消費しない。

このテンプレートの追加自体は作業割当ではない。現時点のScope・完了条件・実行権限は未設定。

## Before assignment

- statusだけで空き判定せず、task_id・TASK本文・Report・next_owner・ACTIVE_TASK・CURRENT_STATE・fresh `origin/main`を確認する。
- 既存TASK/Reportと他workstreamの変更を保護し、変更対象の非競合と専用の独立worktree/checkoutを確認する。
- 明示割当時にtask_id、目的、対象範囲、変更禁止対象、テスト、安全制約、完了条件、推薦モデルを記入する。
- 推薦モデルは割当内容で選ぶ。軽微な運用文書作業の目安：推薦モデル：Sonnet5（中）。現時点では未割当のためrecommended_modelもnone。

## Start / G5

`PROJECT_RULES.md`、`HANDOFF.md`、`.agent/ORCHESTRATION.md`、`.agent/CURRENT_STATE.md`、このTASK、必要なReport、Git状態とfresh `origin/main`を確認する。

明示割当済みでstatusが `ready` / `in_progress` の場合のみ `G5` で開始する。`idle` / `done` / `review_required` では開始しない。単独 `G` でも開始可能なClaude枠が1つだけと明白な場合のみ対象にできる。

G5専用の独立Git worktree/checkoutを使用する。安全な独立環境を用意できない場合は開始せず停止する。他slotのbranchをcheckout/reset/rebaseしない。他workstreamの未コミット変更を変更・削除・stage・commitしない。他slotの作業ファイルやdev serverを操作しない。

## Scope / tests / completion criteria

未設定。明示割当時に具体化する。割当がない間は変更・テスト・push・deploy等を開始しない。

## Completion / K5

完了・停止時の実績はこのTASK末尾の `## Report` に記録する。`K5` はG5専用のClaude完了確認コード。ChatGPTは完了条件、実装内容、changed_files、tests、commit/push/deploy、残課題、安全確認、競合、Codexレビュー要否を評価し、ORCHESTRATIONの開発日記更新判定も適用する。未実施を成功扱いにしない。

## Report

- task_id: none
- result: not_started（未割当）
- changed_files: none
- tests: not_run
- commit_hash: none
- push: not_performed
- deploy: not_performed
- remaining_issues: none（作業未割当）
- safety_checks: not_started
- next_recommendation: 明示割当までidleを維持する。
