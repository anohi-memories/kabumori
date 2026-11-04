# G10-02｜Phase 2 読み取り専用の試験調査（readonly_trial）
- task_id: g10-phase2-readonly-trial-20261022
- slot: G10
- owner: claude
- status: ready
- next_owner: claude
- return_to: G10担当ちゃ（開発運用統括）
- completion_code: K10
- recommended_model: Claude Sonnet5（中）
- generation_limit: 50
- production_permission: NO_GO
- safety_gate: NO_GO for production, SNS, merge, deploy, GitHub write. readonly_trial only.
- automation_enabled: true
- automation_mode: local_cli
- automation_approval: approved
- phase2_run: approved
- phase2_approval_id: g10-p2-trial-20261022-a01
- phase2_norm: NORM-1
- phase2_policy_version: policy-v1
- phase2_policy_sha256: 1111111111111111111111111111111111111111111111111111111111111111
- phase2_task_sha256: 0000000000000000000000000000000000000000000000000000000000000000
- base_ref: refs/heads/main
- base_sha: 0c42933ca5030ab31a56267529430d0473d9b155
- model: sonnet
- phase2_model_id: claude-sonnet-5-5
- effort: medium
- max_minutes: 10
- max_budget_usd: 0.50
- phase2_scope: readonly_trial
- phase2_report_mode: local_only

## 目的
指定コミット（base_sha）のリポジトリを読み取り、PROJECT_RULES.md の固定Issue方式の記述と、.agent/ORCHESTRATION.md の記述の食い違いを、文章で報告する。実装・変更は行わない。

## preflight
- 関連PR: なし（読み取り専用の初回調査。基点HEADのみ: 上の base_ref と base_sha）
- 使う情報は、実行係が検証して渡すこのTASK本文と、作業フォルダ内の指定コミットのファイルだけ。
- 他slotの変更ファイル、DB/RPC/Auth/Edgeへの影響はない（読み取りのみ）。依存するTASKはない。
- 本文の記述と食い違いがあれば、推測せず、質問として返す。

## 実行
1. 作業フォルダの PROJECT_RULES.md と .agent/ORCHESTRATION.md を、Read／Glob／Grep だけで読む。
2. 固定Issue方式（1枠1現役Issue・本文は現在のTASKのみ・REPORT→HISTORY→ACCEPT→次TASK）に関する記述を比べ、食い違い・不足を、根拠のファイルパスと行付きで挙げる。
3. 結果を最終回答として文章で返す（ファイルは作らない）。

## 安全
読み取り専用。変更可能な範囲はなし。ファイルの作成・編集、コマンド実行、Web・GitHubへの書き込み、SNS実投稿、DB/Auth/Edge/外部APIのwriteは禁止。production_permissionはNO_GO。

## tests・完了条件
tests: なし（読み取り専用）。実行係が、作業フォルダに変更がないこと、実使用モデルが指定IDの1件であることを機械的に確認する。完了条件: ローカルREPORTの第2部に、GitHubへ投稿できる形のREPORT（type: REPORT を1件、task_id、next_task_allowed:false、tests、changed_files、PR/HEAD、remaining_issues、safety_checks、return_to、completion_code）が含まれること。GitHubへの投稿とread-backはG10担当ちゃが行う。本文の編集は禁止。
