# G10-02｜Phase 2 実行係の実装（偽Claudeのみ・TASK 1/50）
- task_id: g10-phase2-runner-fake-claude-impl-20261021
- slot: G10
- owner: claude
- status: ready
- next_owner: claude
- return_to: G10担当ちゃ（開発運用統括・Issue #323担当チャット）
- completion_code: K10
- recommended_model: Claude Opus5.5（高）
- generation_task_no: 1
- completed_tasks_in_generation: 0
- generation_limit: 50
- review_required: true（実装後、Codex Sol（高）によるセキュリティ・並行性・停止制御レビュー必須）
- next_task_allowed: false
- production_permission: NO_GO
- safety_gate: FAKE_CLAUDE_ONLY; NO_GO for real Claude auto-start, dedicated macOS user, ACL, sudoers, launchd, F0, long-lived token, production, SNS, external real writes, paid API, main push, merge, deploy.
- related_pr: none（新規Draft PRを作成。旧V3 Draft PR #281は保護・非採用）
- pinned_head: none（PR作成後、REPORTに実HEADを記載）
- predecessor_disposition: CANCELED_FOR_MIGRATION_NOT_ACCEPTED（旧V3 TASK/REPORT/PR #281は保護。受入済み扱いしない）

## 目的
Phase 2仕様 v5本体＋v5.1〜v5.4差分を暫定実装基準として、実Claudeを呼ばずに実行係のsource実装と偽Claude試験を完成させる。今回の合格は「source実装候補・偽Claude検証」のみであり、実CLI試験・F0・無人稼働・productionのGOを意味しない。

## preflight
- 関連PR: なし（新規。成果物はDraft PR。旧V3 #281を変更しない）。
- 仕様原本: Mac上の ~/Library/Application Support/kabumori-agent-watch/phase2-spec/ にあるv5、v5.1〜v5.4、F0草案のSHA256SUMSを照合。ファイル不存在・不一致・矛盾時は推測せずREPORTに記載しSTOP。添付仕様を勝手に書き換えない。
- 最新PROJECT_RULES.md、G10 #323のTASK、旧V3中止記録・PR #281、fresh origin/main、他G/H枠の作業・変更path・関連PR/HEADをread-onlyで照合。task_id重複や同一path競合があればSTOP。古いV3 TASKを引き継いだり完了扱いしない。
- G10専用の独立clean worktree/branchをfresh origin/mainから準備し、他slotのcheckout/reset/rebase/stash、dev serverや未コミット変更を触らない。
- 変更対象は原則、新設の tools/phase2_g10/ 配下のソース・テスト・設計補足のみ。既存 tools/ 配下の他slot所有ファイルを上書きしない。追加変更が必要なら事前に担当ちゃへ返す。

## 実行
1. TASK解析、正式メタデータ領域、NORM-1ハッシュ計算・照合を実装し、V1〜V10と異常系を独立再計算・試験する。仕様中の正式承認メタデータと、現在の非自動実装TASKを混同しない。
2. 日次04:00 JST失効のENVELOPE、承認・停止イベント台帳（seq／prev_hash／署名を検証する境界）、at-most-once（CLAIMとused_requests、fsync、巻戻りfail-closed）を偽データで実装・検証する。日次の実行回数・合計時間の上限は設けず、個別上限・頻度・ブレーカーを維持。
3. STOP・HALT・UNHALT・起動トランザクションの状態機械を作る。HALT／STOP／取消イベントの確定と起動の最終判定は、共通halt.lockの排他／共有規約で直列化し、検証から偽プロセスの起動確定までロックを保持。競合・クラッシュ・拒否・再送で二重起動しないことを必須テストにする。
4. プロセス登録簿、S1/S2監督・期限・停止、クラッシュ復旧、独立不在確認、HALT不解除条件を偽Claudeで検証。macOS別UID停止権限・ACL・Seatbelt・launchd・Max認証・F0はインターフェースとモックまでとし、実環境に触れない。
5. ローカルREPORT／監査証拠／通知を実装。Claudeの自己申告と検証済み実行事実を分離し、REPORTに不明・未検証・未実装を明記する。
6. 実行アダプタは**偽Claudeだけを実行可能**に固定。実Claude CLIの起動パス、一般任意コマンドの実行、OS設定変更、GitHubへの実write、秘密値や認証情報の取得・使用を実装・試用しない。単なる設定フラグ変更で実Claudeに切替えられない設計とテストを付ける。
7. source+testsをG10専用branchにコミットしてDraft PRを作る。mainへpushしない、mergeしない。PR URL・HEAD・changed filesをREPORTに記載しread-backする。

## 安全
- Phase 1の既存監視スクリプト・状態・launchdを変更・停止・初期化しない。
- 実Claudeの起動（手動試験も本TASKでは対象外）、Max認証、F0、長期トークン、専用macOSユーザー作成、ACL・sudoers・launchd・Keychain・HOME権限の変更は禁止。
- production DB/Auth/RLS/RPC/Edge/Cron/secrets、SNS実投稿、外部API実write・有料API、main push、merge/deployは禁止。旧PR #281、旧TASK/REPORT/archiveは原文保護。
- 独立worktree必須。必要のない既存ファイル変更・他slot作業領域への操作禁止。予期せぬ権限・競合・安全拒否はSTOP→fresh read-back→報告。正規再試行は最新PROJECT_RULESの規定内のみ。
- 未実装または未検証のmacOS権限・認証・時間保証をPASSと偽らない。ユーザーによる日次ENVELOPE承認方式は設計として維持し、今回稼働させない。

## tests・完了条件
- 偽Claudeで、起動・停止、並行CLAIM、二重受理、04:00 JST境界、イベント追記と最終判定の競合、STOP/HALT・UNHALT、S1/S2障害、全クラッシュ位置、復旧、期限切れ、記録巻戻り、署名不正、報告・通知、ミューテーションの正負テストを実測。省略項目は NOT_VERIFIED としてREPORTする。
- 仕様v5＋差分のテストベクトルV1〜V10、読み取り専用アダプタ固定、実Claude非起動を確認。テスト結果・失敗・未確認の理由、git diff --check、変更ファイル、依存関係・競合、PR/HEADを記録。
- GitHub Issue #323へ **type: REPORT** を1件投稿してread-back（task_id、next_task_allowed:false、tests、changed_files、PR/HEAD、remaining_issues、safety_checks、return_to、completion_code を必ず含む）。Issue本文はClaudeが編集しない。
- 推薦レビュー: Codex Sol（高）。本TASKはレビュー結果と担当ちゃのHISTORY・ACCEPT照合まで受入未確定。実Claude自動起動・実機環境変更・無人運用は継続NO_GO。終了時はG10担当ちゃに **K10** を返す。
