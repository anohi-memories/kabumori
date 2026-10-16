# J3 — かぶモリ休止 F2/F8 修正3件 限定独立再レビュー
- task_id: kabumori-j3-f2-f8-pause-three-findings-focused-rereview-20261016
- slot: J3
- owner: codex
- status: review_required
- next_owner: chatgpt
- return_to: かぶモリアプリG1のちゃ（運用休止・全体統括）
- start_code: J3
- completion_code: V3
- recommended_model: Sol（高）
- current_task_path: .agent_v2/tasks/J3.md
- current_report_path: .agent_v2/reports/J3.md
- previous_archive: .agent_v2/archive/2026-10-16-J3-common-account-pr214-review/
- dependencies: PR #212 HEAD d04ff9d2227bbb0e43d7ddbcf8c3b5cc7ad54d3a; PR #213 HEAD c10f1da593ba3dc365cf340e9569ae1caa9789b1; prior J2 CHANGES_REQUIRED Report; PR #129/#164 protected
- blocker: USER_STOPPED_DUPLICATE_REVIEW; no further execution; report/worktree evidence NOT_VERIFIED; production NO_GO

## 目的
F8/F2のJ2指摘3件（R1 P1、R2 P1、R3 P2）に対する修正を差分限定で独立検証。全体再監査不要。他枠の作業と干渉せず、J2を使わない。製品コード修正しない。

## 開始ゲート
fresh origin/main、J1/J2/J3/J4、旧H、F2/F8 ACTIVE_TASK最新metadataと各TASK/Reportを部分確認。J2は別のレビューが進行中の可能性があり、実行枠・worktree・branch・PRを絶対に触らない。PR #212/#213のHEAD、他PRの変更対象、独立clean worktree/checkout、archive MANIFEST/SHA256SUMS/restoreを確認。競合があれば実行せずG1へ報告。

## 3点のみ検証
1. J2-R1 P1 F8: concurrent stale trueの復活防止、読み取り開始順フェンス、後発OFF/timeout/unreadable、TTL既定0、3秒timeout、複数warm-request、X/AI/DB claim/write/Push直前・実handlerの合成検証。OFF即時完了や送信済HTTP取消と誤認しない。
2. J2-R2 P1 F2: generation/test/dry-run全7mode、無認証・invalid token・非admin・missing key・auth exception→事前401かつAI/DB write/X0。認可admin×disabled→423、live/dry_run→mockのみ。scheduledとPOSTONA不変。
3. J2-R3 P2 F2: planner復元のstable ID/キー/brand/NULL legacy所有権とstate CAS、重複/欠落/付替/other brand drift→全体abort、既存OFF保持。resumeReadinessでpending/running/unknown X/Pushを精査、古い予約無条件再送不可。

## 安全制約
完全offline合成・deny-net/deny-env、負の対照を独立検証。既存PRのHEAD、F2/F8/J2、他slot、managed DB/Auth/RLS/Cron/Edge/Secrets、X/Push/実AI/課金、main製品コード、merge/deploy変更禁止。レビュー成果はJ3 Report/同TASK/ACTIVE J3節のみ。必要な修正は元F2/F8担当へ戻す。PR129/164統合および本番preflightは独立の後工程。

## 完了条件
確認したHEAD、テスト、再現反例、P1/P2残件、POSTONAへの影響、変更ファイル/commit/push/read-backと判断を記録。完了時はJ3 review_required / next_owner chatgpt、かぶモリアプリG1のちゃ（運用休止・全体統括）へ V3 を送ってください。PASSでも本番NO_GO。

## Report
- result: NOT_STARTED / FOCUSED_REVIEW_ONLY
- tests: not_run
- merge: not_performed
- deploy: not_performed
- production: NO_GO

## G1停止記録（2026-10-16）
- user confirmed: J3 was started, then stopped on G1 instruction because J2 completed the same scope.
- result: STOP_REQUEST_ACCEPTED / NOT_A_COMPLETED_REVIEW; J3 worktree, uncommitted work and independent tests NOT_VERIFIED.
- Do not restart J3 or delete local changes. Preserve any existing independent findings for G1. F8 correction assigned to F8, not J3.
