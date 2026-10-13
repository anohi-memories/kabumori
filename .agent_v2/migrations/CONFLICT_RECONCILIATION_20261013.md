# 完全移行準備 — 旧管理差分の扱いと現在状態の突合

- task_id: agent-full-migration-final-snapshot-cutover-20261013（専用制御TASKの今回Report。新たなslot割当ではない）
- source_main: b7ce2c4fd94225542a66aef94042ca528cc47f09
- protected_pr172_head: 8e65a71e3dc7b144ec511fa853ffe08e522dc827
- protected_branch: backup/pr172-pre-conflict-prep-8e65a71-20261013（GitHub ref read-back一致）
- return_to: こでくろ連携部屋のちゃ
- completion_code: none（30枠外の制御作業。Cn/Vnを発行しない）
- recommended_model: Opus5.5（高）
- recommended_review_model: Sol（高）（正式切替前、実装者と独立）
- result: RECONCILIATION_DOCUMENTED / CURRENT_STATE_CORRECTED / CUTOVER_BLOCKED

## 3PRの処置

3件のHEADは前回保存と同一。GitHubの現在のbase/main、PRのmerge-base、変更ファイル、base/head/mainのGit blobと本文を突合した。旧管理11パスすべてがmainと異なる。実ファイルごとの証拠は追加archiveの `PR_MANAGEMENT_DISPOSITION.json`。12件目はPR10の監査文書（mainには存在しない）。PRのbase/head/stateは変更せず、close・merge・force pushは実施していない。

| PR / 固定HEAD | 差分 | 今回確定した扱い | 未実施の外部処置 |
| --- | --- | --- | --- |
| #10 `04f966e2dcb243b86b145c1e141dc8a4244e6d58` | 旧H1 TASK/Report/ACTIVE/CURRENT_STATEの4パス＋`docs/RELEASE_READINESS_AUDIT_2026-09.md` | 旧管理差分は現行へ取り込まない。2026-09監査文書を含め保存済み原文・patchを履歴として参照し、現在のrelease readinessとして取り込まない。 | 元担当によるclose/supersede判断。監査文書を別PRへ救出する場合も旧管理4パスを含めず、日付と歴史的評価であることを維持し現状を再監査する。 |
| #11 `6ef9f327c13f144b0f5525e7064880c98ca24081` | 旧H1 TASK/ACTIVE/CURRENT_STATEのみ3パス | 全差分を履歴扱いにする。H1をreview_required/chatgptへ巻き戻さない。callerのcredential＋storage＋Function gateを調整する課題は、保存されたfindingとして引き継ぐ。 | 元担当のclose/supersede判断。caller認証の現時点の安全性・解決は未検証であり、必要なら別のread-only調査TASK（推薦Sol（高））を正しい枠へ明示割当する。 |
| #161 `1ef3aaa43e72540f6f6ac5c2dd97820aaa3259d2` | 旧H5 TASK/Report/ACTIVE/CURRENT_STATEの4パス | mainのC5受入done/noneを現在状態の正本とする。正式実装Reportの原文は保存済みarchiveから参照する。Report/受入を混同せず、古いreview_required/chatgptや返却指示を再注入しない。 | 元担当のclose/supersede判断。source PR159は保護したまま独立Security review・managed owner/Auth/Meta/DB gateを継続する。 |

これは旧PRのmerge経路を技術的に禁止する仕組みではない。3件がopenで旧管理差分を含む限り、正式昇格は保留する。保存が確認できても、3件を「merge済み」「課題解決済み」「完了確認待ち解消」と新たに宣言しない。

## 30枠・現在状態

- 最新TASK先頭とACTIVEのtask_id/status/owner/next_owner/return_toは30/30整合。slotとcompletion_codeは両方にある場合に照合、コードはG→K/H→C/F→L/J→Vの対応と一致。未割当のreturn_toには説明文差があるが双方none。旧TASKに無い新方針のmetadataを機械的に後付けしない。
- 旧G1–G10/H1–H5はdone/none。新F1–F6/F8はdone/none、F7/F9/F10/J1–J5はidle/task_id:none。現task_idの重複0、最新ヘッダー上の進行中・完了返却待ち0。過去Reportに残る返却時review_requiredや過去TASKのreadyを現在割当と誤読しない。他slotを再割当・完了更新していない。
- F1はPhase Aから現Phase B0へ更新済みだったがCURRENT_STATEが古かった。F3/F5/F6/F8のready記述も古い。F4旧disconnect TASKはarchive済みで現TASKはT13統合。CURRENT_STATEを最新TASKへ合わせ、製品のSecurity review・費用/権限/本人データ・production HOLDを保持した。
- PR143/149/158はGitHubのclosed/merged=trueとmerge SHAを今回再確認。F2の過去mergeability待ちをCURRENT_STATEから除外。F2 TASK/ACTIVEのblocker本文は過去診断時のままなので、次回割当/正式切替時に整理を要する。旧CURRENT_STATEの古いready記述も保持された旧履歴であり、開始の根拠ではない。
- F1の実装Reportにreview_requiredが残るが、現TASK先頭/ACTIVEはdone/none。今回はこれを新規L1待ちへ変更せず、最新ヘッダーを優先する。Report受入の形式整合は正式切替の独立レビューでも確認する。製品Security reviewは別の未完ゲートである。

## open PR・ローカル境界

- open PR46件（本PR172含む）をGitHub APIで列挙し、各PRの全変更ファイルを確認。各一覧は100件未満でページ省略なし。#172以外で旧/新管理基盤・共通入口/引継ぎを変更するのは#10/#11/#161のみ。証拠は `OPEN_PR_FILE_AUDIT.json`。他の製品PRにはこの準備の変更パスとの重複がない。
- 新旧親checkoutとこのプロジェクト配下のGit checkoutから134登録worktreeをread-onlyで確認。旧 `/Users/yuya/Developer/kabumori`に旧管理7ファイルの未コミット変更あり（ACTIVE、H1/H2 Report、CURRENT_STATE、G2/H1/H2 TASK）。共有HANDOFF.mdにも未コミット変更があり、root HANDOFFへの今回追記は競合防止のため行わず本Reportを引継ぎ先とした。内容を上書き・stage・commit・resetしていない。
- 登録だけ残る不在worktree1件は旧G3 scratchpad `g3-status`。pruneせず保全状態を担当者確認とする。既存登録worktreeの稼働セッション全体はこの確認だけでは断定できない。TASK/PRへの反映前の将来変更を排除したという意味でもない。
- 今回worktree: `kabumori-migration-conflict-prep-20261013`、local branch `codex/migration-conflict-prep-20261013`。元移行checkoutや他slotのbranch/未コミット変更/serverには触れていない。PR172には元HEADを親とする追記commitだけを積み、push前にfresh main/PR headsの変動を再確認する。

## 保存・検証

- 前回最終snapshotのSHA256 64/64を再照合。既存archiveの全trackedファイルを元PR172 HEADのバイト列と比較し、不変を確認する。
- 今回変更前のCURRENT_STATEと専用移行TASKを追加archive `2026-10-13-conflict-reconciliation-8e65a71e/`へ保存。original_path/archive_path/size/SHA256/source commit/Git blobを記録し、空ディレクトリへ2/2実復元して元commitのバイト列と一致。
- 30枠metadata、全open PRの変更一覧、3PR disposition、worktree境界、RESTORE_RESULTを追加保存。HISTORY_INDEXは末尾追記のみ。既存snapshot/MANIFEST/RESTORE/索引の先行部分、旧.agent、各slotのTASK/Report/ACTIVE、製品sourceは変更しない。
- 管理文書のみの変更。製品テスト/Deno/PostgreSQL/managed caller認証/Meta/有料APIは未実行。既存製品Reportのテストを独立再実行したとは扱わない。git diff --checkと参照先・変更範囲・hash/read-backで検証する。

## 正式切替の未解決条件

1. #10/#11/#161の旧管理差分を含むmerge経路の除外、close/supersedeの担当判断が未実施。#11の認証課題の解決確認は別。
2. 旧checkout未コミット変更の保存/扱いと不在登録worktreeの確認、他slotの継続作業・新規TASKを切替直前に再確認。
3. 最新main/新旧CURRENT_STATE/全30枠/Report受入/新規PRを再照合し、古いblocker記述と現状を区別する。
4. 切替時に旧基盤・共有文書・現F/J TASK/Reportを追加snapshotしSHA256/実復元/検索索引を検証する。今回の保存候補は切替承認ではない。
5. 実装slotと実際のreturn_to/completion_codeを明示割当し、正式昇格・名称復帰・15枠mappingを実装後、実装者とは独立したSol（高）レビューを行う。推薦実装Opus5.5（高）。main merge・本番操作はさらに別判断。

返却先: こでくろ連携部屋のちゃ。今回Cn/Vnの発行なし。
