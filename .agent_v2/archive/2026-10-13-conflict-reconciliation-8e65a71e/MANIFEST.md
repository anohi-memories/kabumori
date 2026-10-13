# 2026-10-13 — 移行準備の競合整理証拠

source: PR172 `8e65a71e3dc7b144ec511fa853ffe08e522dc827`、比較main `b7ce2c4fd94225542a66aef94042ca528cc47f09`。

- `MANIFEST.json`: 変更前CURRENT_STATE v2・移行専用TASKの原本2ファイル。original_path/archive_path/size/SHA256/source commit/Git blob。
- `before/`: 原本をそのまま保存。元commitのバイト列と実復元一致。
- `SLOT_METADATA.json`: 現TASK先頭とACTIVEの30枠照合。未割当return_toの説明差はnoneとして比較。
- `OPEN_PR_FILE_AUDIT.json`: 46open PRと全変更ファイル。既存製品PRは未変更。
- `PR_MANAGEMENT_DISPOSITION.json`: 3PR/12パスと最新mainのGit blob/内容比較、履歴扱い。
- `WORKTREE_AUDIT.json`: 134登録worktreeのHEADと管理ファイル未コミット境界。不在登録を勝手にpruneしない。
- `RESTORE_RESULT.json`: 2/2実復元、前回64/64 hash再確認、30枠照合。
- `FINAL_VALIDATION.json`: 旧.agent/製品source/既存archive不変と文書変更範囲の最終検証。
- `EVIDENCE_MANIFEST.json`と`SHA256SUMS`: 保存物のpath/size/SHA256。hash manifest自身を自分のentryへ入れない。

このarchiveはappend-only。正式切替承認ではない。main反映状態はPR172のmerge状態を別途確認する。
