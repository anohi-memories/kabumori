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
- blocker: 3PRの旧管理merge経路、旧checkout未コミット管理変更、切替時snapshot/slot明示割当/正式昇格/独立レビューが未完。CURRENT_STATEの古い新枠割当記述は今回整理済み

## 目的と今回の範囲

段階移行を完了するため、旧履歴を完全保護した後に軽量基盤を正式 `.agent/` へ昇格する。本記録は専用TASKの制御文書であり、F/Jの空き枠を自動消費せず、既存slotのTASK・Report・完了判定を上書きしない。今回の継続実行はユーザー明示承認に基づくPR172保全・3PR差分突合・CURRENT_STATE整理・30枠/PR/worktree監査・追加保存まで。正式昇格は未実施。

## 変更可 / 変更不可 / 安全制約

- 今回変更可: 新規 `.agent_v2/archive/2026-10-13-conflict-reconciliation-8e65a71e/`、HISTORY_INDEX末尾、CURRENT_STATE、本制御TASKとCONFLICT_RECONCILIATION_20261013.md、保全branchとPR172へのfast-forward/説明更新。
- 今回変更不可: 旧 `.agent/` 全ファイル、既存archive、既存F/J slot TASK・Report・ACTIVE_TASK、他slotのbranch・worktree・未コミット変更・dev server、既存PRのhead/base/state。
- アプリ・DB/Auth/RLS/migration/RPC/Edge/secrets/Cron・本番deploy・SNS・有料API・EASの操作禁止。force push禁止。独立レビュー完了前のmain merge禁止。

## 競合の証拠と次の判断

詳細な突合・今回の扱い・未実施事項は `CONFLICT_RECONCILIATION_20261013.md` を参照。3PRの旧管理11パスは現行管理へ取り込まない。PR10の監査文書も保存済み歴史資料として参照する。PR11の認証課題は解決判定していない。PR161はmainのC5受入done/noneと正式実装Reportを区別し、古い返却状態を再注入しない。

全46open PR（172含む）のファイル確認で、他の管理差分PRなし。3PRのHEADは前回保存時と同一だが、close/supersedeや旧差分除外は未実施のため切替保留を維持する。30枠の現在割当は整合・未処理完了コードを示す最新next_ownerなし。旧checkoutの未コミット管理7ファイルと不在登録worktree1件を保護。CURRENT_STATEを最新TASKへ整理したが、旧CURRENT_STATE/F2 blockerの歴史的記述・Report形式整合は正式切替前に再確認する。

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

- executor: Codex（ユーザーが承認した移行準備継続）
- result: RECONCILIATION_DOCUMENTED / CURRENT_STATE_CORRECTED / CUTOVER_BLOCKED / INDEPENDENT_REVIEW_PENDING
- source_commit: b7ce2c4fd94225542a66aef94042ca528cc47f09
- protected_pr172_head: 8e65a71e3dc7b144ec511fa853ffe08e522dc827（backup/pr172-pre-conflict-prep-8e65a71-20261013、GitHub read-back一致）
- changed_files: CURRENT_STATE、本制御TASK、CONFLICT_RECONCILIATION、追加archive、HISTORY_INDEX末尾
- slot_state_readback: G1–G10/H1–H5 done/none、F1–F6/F8 done/none、F7/F9/F10/J1–J5 idle/none。TASK先頭/ACTIVEの現在割当30/30整合、task_id重複0。slotを再割当・完了更新していない
- tests: 前回snapshot SHA256 64/64再照合、変更前2ファイル実復元・元commit一致、archive既存バイト不変、索引append-only、変更範囲/参照先/diff check、GitHub read-back。追加archiveのRESTORE_RESULT.json/SHA256SUMSを参照
- commit_hash / push / PR: 本文自身のcommit SHAは自己参照にせずPR172の最新HEADとgit logで確認。lease付き非force ref更新とGitHubファイルread-backを行う
- merge: NOT_PERFORMED
- deploy / production / paid_calls: 0
- remaining_issues: 3PRのmerge経路除外判断、旧checkout未コミット管理変更/共有HANDOFFと不在worktree確認、正式切替前再照合/追加snapshot/slot割当/正式昇格/独立Sol（高）レビュー
- safety_checks: 旧.agent/既存archive/slot TASK・Report・ACTIVE/製品source/他checkout/production無変更。独立worktree。旧方式削除・正式昇格・main mergeなし
- next_recommendation: CONFLICT_RECONCILIATIONの未解決条件を満たしてから正式切替TASKを明示割当。現行G/H/F/JとK/C/L/Vの意味は継続

返却先: こでくろ連携部屋のちゃ。今回は番号slot未割当の移行制御作業であり、Cn/Vnを発行しない。
