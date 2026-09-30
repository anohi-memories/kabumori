# Claude Task 4

- task_id: x-ai-lab-diary-k-check-orchestration-rule-20260930
- owner: claude
- slot: claude-4
- status: review_required
- next_owner: chatgpt
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

- task_id: x-ai-lab-diary-k-check-orchestration-rule-20260930
- result: **PASS**。K1 / K2 / K3 / K4 すべての完了確認で、会社員AIラボ開発日記の更新判定を必ず行うルールを `.agent/ORCHESTRATION.md` に正式追加した。X専用handoffにも、この部屋での運用範囲を反映した。
- model_used: Opus 5.5（TASK推奨はSonnet5（中）。セッションのモデルは利用者の選択のまま）
- worktree: G4専用 `/Users/yuya/Developer/kabumori/.claude/worktrees/g4-x-admin-pr15`（fresh `origin/main` から作業。前TASKが status: done / next_owner: none であることを確認してから、TASK本文を上書きした）

### changed_files

- `.agent/ORCHESTRATION.md`: 「K1 / K2 / K3 / K4 — Claude」節の直後に、小節「会社員AIラボ開発日記の更新判定（K1 / K2 / K3 / K4 共通・必須）」を追加（18行追加・削除0）。
  - 各K確認で必ず判定する。ユーザーの「メモ更新して」の指示は前提にしない。
  - 題材の優先順位と、外部公開して安全な粒度への要約。
  - 判定結果を Final K 項目に1行で残す（`AI Lab diary: 候補あり — …` / `記録不要 — …`）。記録不要の場合も残す。
  - 禁止事項の一覧。既存のsanitizer / safetyルールは弱めない。
  - 記録価値ありの場合は、明確に未割当のG3 / G4に開発日記更新TASKを置く。空きがない、または確認している部屋がG3 / G4を割り当てない部屋のときは、候補行だけを残し、次の割当時にまとめてTASK化する。
  - 更新TASKの範囲は、Markdown追記 → snapshot再生成 → parity / freshness / sanitizer関連テスト → commit。deployは必要な場合だけ、`x-test-post`単一Functionに既存のdeployルールで行う。
  - 実施日を偽らない。レビュー要否の判断とは独立して毎回行う。
- `.agent/room_handoffs/X_AUTOPOST_CHAT.md`（room-local）: 小節「会社員AIラボ開発日記の更新判定（この部屋での運用）」を追加し、`updated_at` を 2026-09-30 に更新（9行追加・1行変更）。
  - この部屋では、K3 / K4 の判定を自分で行う。
  - K1 / K2 のコードには、従来どおり「私の担当ではありません」とだけ返す。K1 / K2 の判定はその担当の部屋が行う。
  - 開発日記更新TASKを作るときに限り、Final K1 / K2 項目の「候補あり」の1行だけを読んでよい。G1 / G2 のTASK本体・Report・statusには触れない。
- `.agent/tasks/CLAUDE_TASK_4.md`: 本TASKの記録とこのReport。

コード、日記Markdown、snapshot、テスト、Edge Functionの変更なし。collectorは実装していない（TASKの指示どおり）。G1 / G2 のTASK・Report・status、`ACTIVE_TASK.md`、`CURRENT_STATE.md`、`PROJECT_RULES.md` には触れていない。

### tests / consistency checks

- K1 / K2 / K3 / K4 の対象範囲: 新しい小節の見出しと本文で、4つすべてを同じ判定ルールの対象と明記した。X handoffは共有ルールを参照し、この部屋の担当（K3 / K4）と、担当外（K1 / K2）での扱いを分けて記述した。
- 既存ルールの保全: 差分の行数集計で、`ORCHESTRATION.md` は追加のみ（18行追加・0行削除）。handoffは追加9行と `updated_at` 1行の変更のみ。
  - G1〜G4のルーティング行、`K1: G1`〜`K4: G4`の対応、「私の担当ではありません」の規定、レビュー運用の本文が、変更後もそのまま残っていることを確認した。
  - 新しい小節は、K節と「F — 全体統括」節の間に収まっている。
- 差分の空白チェック（diff --check）: PASS。
- 参考: 日記コンテキストのテスト（`ai_lab_dev_diary_context_test.ts`）29/29 pass（コード変更がないため影響がないことの確認のみ）。

### commit_hash

- `3ab466e`（TASK割当・in_progress）
- `f1c462a`（ORCHESTRATION.md・X handoffの変更）
- このReportのcommit（本コミット）

### push

`main` へpush済み（`62288e4..3ab466e`、`3ab466e..f1c462a`。いずれもfast-forward、他workstreamの変更との衝突なし）。このReportのcommitも同じ手順でpushする。

### deploy

**なし**。運用ルール文書の変更のみで、production deployは行っていない（TASKの指示どおり）。

### remaining_issues

1. 日記エントリの最新は2026-09-29。**2026-10-02以降は鮮度の範囲を外れ、自動投稿はエバーグリーンな題材に戻る**。今回のルール運用が始まり、最初の開発日記更新TASKが実行されるまで、この状態は変わらない。
2. 日記を本番に反映するには、`x-test-post` のdeployが必要。Claude Codeのauto modeでは本番deployが拒否されるため、これまでどおり操作者の実行と、Claudeによるread-backの分担になる見込み。
3. コード側のsanitizerが機械的に弾くのは一部の識別子（URL・メール・鍵形・ブランチ名・PR番号・タスクID形・一部のテーブル/RPC名など）だけ。ルールの禁止一覧（Edge Function内部名、Authorization header等）の多くは、候補を書く時点の人/ChatGPTの判断で守る必要がある。今回はsanitizerの範囲を変更していない（弱めてもいない）。
4. `.agent/ORCHESTRATION.md` の「## 作業開始コード」見出しの直前に、以前からある `NaN` という文字化けが残っている。今回のTASKの範囲外のため修正していない。

### safety_checks

- 変更は運用文書2ファイルと自分のTASKファイルのみ。秘密値・識別子・内部URLは追加していない。
- 既存のKコード、G1〜G4のルーティング、レビュー運用、部屋ごとの担当分離（X部屋はK1 / K2を扱わない）は維持した。
- production mutation = 0（deploy・DB・Auth・Vault・Cron・settings・X投稿はいずれも無し）。

### next_recommendation

1. 次のK確認（K3 / K4 に限らず、K1 / K2 を含む）から、この判定を実運用で開始する。直近の完了分（例: 管理画面・アプリ側の改善や、今回の開発日記化そのもの）について「候補あり」の行を残せば、最初の開発日記更新TASKの題材になる。
2. 鮮度切れ（10/2以降）の前に、最初の開発日記更新TASKを一度実行するのが望ましい（Markdown追記 → snapshot再生成 → テスト → commit → `x-test-post`のdeployとread-back）。
3. K1 / K2 を担当する部屋の引き継ぎ文書がある場合は、同じ共有ルールを参照する旨を、その部屋の担当者側で追記するとよい（この部屋からは変更していない）。

## Completion

- status -> review_required
- next_owner -> chatgpt
