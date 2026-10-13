# 完全移行の専用制御TASK — 2026-10-13

- task_id: agent-full-migration-final-snapshot-cutover-20261013
- owner: chatgpt（全体オーケストレーション）
- slot: unassigned（30枠外の移行制御記録。開始コードではない）
- status: blocked
- next_owner: chatgpt（旧管理差分の整理・現在状態の整合確認）
- return_to: こでくろ連携部屋のちゃ
- completion_code: none（実装slot未割当。Jn→Vn / Hn→Cnを推測しない）
- recommended_model: Opus5.5（高）（正式昇格の実装）
- recommended_review_model: Sol（高）（実装者と独立したレビュー）
- current_task_path: .agent_v2/migrations/FULL_MIGRATION_20261013.md
- current_report_path: .agent_v2/migrations/FULL_MIGRATION_20261013.md#report
- dependencies: PR #10 / #11 / #161 の旧管理差分保護・整理、fresh main・新規TASK・全30枠再確認、最終snapshot、独立レビュー
- blocker: 未マージの旧管理差分3件とCURRENT_STATEの古い割当記述。ユーザー指示「競合時は停止しバックアップだけ進める」を適用

## 目的と今回の範囲

段階移行を完了するため、旧履歴を完全保護した後に軽量基盤を正式 `.agent/` へ昇格する。本記録は専用TASKの制御文書であり、F/Jの空き枠を自動消費せず、既存slotのTASK・Report・完了判定を上書きしない。今回の実行は再確認・追加snapshot・未マージ差分保護・Draft PRまで。正式昇格は競合が残るため未実施。

## 変更可 / 変更不可 / 安全制約

- 今回変更可: 新規 `.agent_v2/archive/2026-10-13-final-migration-preflight-b7ce2c4f/`、HISTORY_INDEX末尾への索引追記、本制御TASK。
- 今回変更不可: 旧 `.agent/` 全ファイル、既存archive、既存F/J TASK・Report・ACTIVE_TASK・CURRENT_STATE、他slotのbranch・worktree・未コミット変更・dev server、既存PRのhead/base/state。
- アプリ・DB/Auth/RLS/migration/RPC/Edge/secrets/Cron・本番deploy・SNS・有料API・EASの操作禁止。force push禁止。独立レビュー完了前のmain merge禁止。

## 競合の証拠と次の判断

1. PR #10 `04f966e2dcb243b86b145c1e141dc8a4244e6d58`: 旧H1 TASK/Report/ACTIVE/CURRENT_STATEとrelease audit文書。移行後の管理表にそのままmergeしない。監査文書を保持した管理差分除外の候補を別途作るか、履歴保護後のclose判断を元担当と確認する。
2. PR #11 `6ef9f327c13f144b0f5525e7064880c98ca24081`: 旧H1 TASK/ACTIVE/CURRENT_STATEのみ。過去のcaller auth blocker記録を現状と照合し、残る課題と履歴を区別して整理する。
3. PR #161 `1ef3aaa43e72540f6f6ac5c2dd97820aaa3259d2`: 旧H5 TASK/Report/ACTIVE/CURRENT_STATE。mainのC5受入は既にdone/noneだが、PRはreview_required/chatgptを再導入する。保存済み履歴とmainの受入を照合後、元担当の整理判断を行う。

3件とも今回変更・closeしていない。全45件のopen PRファイル一覧を確認し、管理基盤を変更するPRはこの3件。CURRENT_STATEには古いready記述が残る。TASK/ACTIVEの最新metadataに基づく現在状態に整合させる工程が必要。製品の未実装・Security review・production HOLDは移行で解消した扱いにしない。

## 正式昇格を再開するときの実行指示（推薦 Opus5.5（高））

1. fresh origin/main、新旧ACTIVE_TASK・各TASK最新metadata・必要な最新Report・CURRENT_STATE・全open PR・worktree境界を再確認。新規/進行中TASK、未処理K/C/L/V、二重task_id、未解決の管理差分があれば停止。今回のsnapshotを切替承認と解釈しない。
2. 移行の実装slotを明示割当し、実際のreturn_to・completion_code・モデルを設定する。ready/in_progressの独立TASKで実装し、レビューは別slotへ割り当てる。この制御記録は実装slotの代用品ではない。
3. sourceが変わっていたら別の追加snapshotを作る。旧.agent全ファイルと共有ルールをoriginal_path/archive_path/size/SHA256/source commit付きで保存。SHA256照合、空ディレクトリへの実復元、元commitとのバイト比較、検索索引を確認する。完了済みF/J TASK/Reportも切替前の原本を保存する。
4. 保存と競合整理が全て確認できた後、軽量TASK/Report/ACTIVE/CURRENT_STATE/ORCHESTRATIONを正式.agentへ昇格する。F→G、J→H、L→K、V→C、単独F→15枠統括を戻し、15枠のTASK/Report/完了コード/next_owner/return_toを検証する。返却先の実際のチャット名は機械置換で変えない。
5. 既存 `.agent_v2/archive/` の内容・配置・原文は保持し、歴史的参照を壊さない。新しい正式基盤から索引で参照する。旧.agent原本の削除/置換は完全保存確認後だけ許可。現在の入口文書・共通ルール・HISTORY_INDEXの参照先を更新し、過去文書の歴史的コードを現在コードへ一括置換しない。
6. 旧管理方式を持つ既存PRのmerge経路を整理し、切替後に旧TASKファイルや状態が復活しないことを確認する。既存未マージの製品ソースやbranch、serverは保護する。
7. Draft PRを作成。独立Sol（高）によるexact headレビューでarchive不変・復元・15枠mapping・参照先・完了コード・重複正本・fresh-main統合を確認。レビュー完了後もmergeは全体担当の別判断。安全ゲートとproduction操作は別工程のまま。

## テストと完了条件

- 今回: 旧.agent全28＋共有5ファイルの完全性、SHA256、実復元、Git blob、既存archive無変更、未マージ3PRのpatch実復元、30枠metadata一致、二重task_idなし、索引append-only、管理/製品source差分ゼロ。
- 正式昇格: 全15枠mapping・実ファイル参照・return_to/完了コード・旧現行ファイルの再侵入防止・履歴参照・fresh mainと未マージPRの競合・独立レビューが全PASS。未確認のpush/merge/deployは成功扱いしない。
- 全体taskは正式昇格・独立レビュー・全体受入までblocked/未完了。バックアップだけでdoneにしない。

## Report

- executor: Codex（ユーザーが承認した継続作業）
- result: BACKUP_CANDIDATE_VERIFIED / CUTOVER_BLOCKED / INDEPENDENT_REVIEW_PENDING
- source_commit: b7ce2c4fd94225542a66aef94042ca528cc47f09
- changed_files: 新規snapshotディレクトリ、HISTORY_INDEX末尾、本制御TASKのみ
- slot_state_readback: G1–G10/H1–H5全done/none、F1–F6/F8 done/none、F7/F9/F10/J1–J5 idle/none。TASKとACTIVE_TASK一致。現在のtask_id重複なし。slotを再割当・完了更新していない
- tests: snapshot内RESTORE_RESULT.jsonを参照。SHA256・元commit比較・実復元・PR patch復元を確認
- commit_hash / push / PR: この記録を含むPR headをGitHubから確認。記録自身のcommit SHAは自己参照にせず、PR最新headとgit logを正本とする
- merge: NOT_PERFORMED
- deploy / production / paid_calls: 0
- remaining_issues: 3PRの旧管理差分整理、CURRENT_STATE整合、切替時fresh snapshot、実装slot割当、正式昇格、独立Sol（高）レビュー
- safety_checks: 他slot/旧.agent/既存archive/製品source/production無変更。独立checkoutのみ使用
- next_recommendation: 保存候補のDraft PRを確認し、上記競合整理後に専用slotへ正式切替TASKを割当。現在のG/H/F/J開始コードは継続

返却先: こでくろ連携部屋のちゃ。今回は番号slot未割当の移行制御作業であり、Cn/Vnを発行しない。
