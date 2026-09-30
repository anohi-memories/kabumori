# Claude Task 4

- task_id: x-ai-lab-diary-k-check-orchestration-rule-20260930
- owner: claude
- slot: claude-4
- status: in_progress
- next_owner: claude
- priority: medium
- recommended_model: Sonnet5（中）
- source: ユーザーがチャットで直接渡した指示（ChatGPT作成の完成指示）。前TASK `x-ai-salaryman-dev-diary-pr61-merge-prod-rollout-20260930` は status: done / next_owner: none で完了済みのため、G4枠を再利用した。
- purpose: 会社員AIラボの開発日記共有メモ更新判定を、K1 / K2 / K3 / K4 すべてのClaude完了確認時に必ず行う正式なオーケストレーションルールとして実装する。ユーザーが毎回「開発メモを更新して」と指示する必要がない状態にする。

## 作業開始前の確認

- `.agent/ORCHESTRATION.md`
- `.agent/room_handoffs/X_AUTOPOST_CHAT.md`
- `.agent/ACTIVE_TASK.md`
- `.agent/CURRENT_STATE.md`
- `.agent/tasks/CLAUDE_TASK_4.md`（G4の既存Report）
- fresh `origin/main`、Git状態、G4専用の独立worktree / checkoutであること
- 既存TASKが残っている、またはG4が本当に空いていると確認できない場合は上書きせずSTOPする。
- G1/G2のTASK・Report・statusには一切触れない。

## 実装内容

1. `.agent/ORCHESTRATION.md` の K1 / K2 / K3 / K4 のClaude完了確認フローに、次のルールを正式追加する: 各K確認時、ChatGPT（ちゃ）はその作業内容について「会社員AIラボの『今日の個人開発』として外部公開可能な開発内容を、開発日記共有メモへ残す価値があるか」を必ず判定する。記録価値がある場合は、必要な開発日記更新TASKを作成する。ユーザーから毎回「メモ更新して」と指示されることを前提にしない。
2. 記録対象: 新しく作った機能、UI改善、バグ修正、開発中に分かったこと、AIとの開発で試したこと、テストや確認で苦労したこと、個人開発上の工夫、仕様変更や設計改善。外部公開して安全な粒度へ要約する。単なる内部作業ログではなく「非エンジニア会社員がAIと個人開発している日記」の題材になる内容を優先する。
3. 絶対に日記へ入れないもの: branch名、TASK ID、commit hash、PR番号、内部URL、email、token / JWT、password / secret、Authorization header、DB table名、RPC名、Edge Function内部名、Vault情報、production security情報、raw `.agent` 内容、その他攻撃面や内部構造を不必要に公開する情報。既存のdiary sanitizer / safetyルールを弱めない。
4. 共有メモ: 正本は `supabase/functions/_shared/brand/ai_lab_dev_diary_context.md`。必要な更新時のみ、Markdown追記 → snapshot再生成（`generate_ai_lab_dev_diary_snapshot.ts` → `ai_lab_dev_diary_context.snapshot.ts`）→ parity / freshness / sanitizer関連テスト → commit まで行う。
5. deploy: 共有メモの変更を実際の自動投稿へ反映するためにdeployが必要な場合だけ、`x-test-post` 単一Functionを対象にする。不要なdeployはしない。production deployを行う場合は、accepted commit固定、isolated directory、single target、explicit project ref、verify_jwt明示、deploy後read-backの既存ルールを維持する。今回の運用ルール文書変更そのものでは、production deployを行わない。

## 重要

- 今回はGit履歴やTASKを自動収集するcollectorの実装ではない。目的は「K1/K2/K3/K4をちゃが確認した際に、開発日記更新判定を必ず行う」というオーケストレーションルールの正式化。過剰実装しないこと。

## 確認

- K1 / K2 / K3 / K4 すべてが同じ開発日記判定ルールの対象になっていること。
- X専用handoffにも、この運用が必要な範囲で反映されていること。
- 既存のKコード、G1〜G4ルーティング、レビュー運用を壊していないこと。

## 完了報告

G4 TASK末尾Reportに、task_id、result、changed_files、tests / consistency checks、commit_hash、push、deploy、remaining_issues、safety_checks、next_recommendation を記録する。実際に実施していないpush / deployを成功扱いにしない。

Then status -> review_required, next_owner -> chatgpt, STOP for K4.

## Report

- pending
