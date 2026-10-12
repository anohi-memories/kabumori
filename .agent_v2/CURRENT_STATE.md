# Current State v2（新系統・現在有効な情報だけ）

この文書には、現在有効な情報だけを置く。解決済みの問題、過去の完了解説、K / L / C / V判定の全文は書かない（完了作業は `HISTORY_INDEX.md` と `archive/` へ）。古くなった項目は追記ではなく書き換えて消す。

- 更新: 2026-10-12 JST（PR #155 merge後の状態に更新）

## 移行の状態

- 新系統 `.agent_v2/` はPR #155のmainマージ（`4e80c79dc42c11fbc1ca105665514b0dd32842d3`）により有効。新F/J枠は新規TASKを明示割当した後に使用する。
- 移行期間中の現行正本は旧 `.agent/`（G1〜G10 / H1〜H5）。旧系統で進行中・完了確認待ちのTASKは、すべて旧系統で完結させる。
- 旧 `.agent/` の初回snapshot: `archive/2026-10-12-initial-migration/`（snapshot元 main commit `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7`、33ファイル、SHA256照合・復元テスト済み）。完全移行前に最終snapshotを別TASKで取る。

## POSTONA F4 — Threads個別解除・lease安全化（2026-10-12 JST）
- 旧G4 PR154 のTASKはdone、次の新規TASKを新系統F4へ登録。F4 `postona-f4-threads-disconnect-lease-safe-v1-20261012` ready/claude、Opus5.5（高）、F4→L4、返却先 POSTONA｜マルチSNS化・開発統括（G4）のちゃ。
- 独立F4 Draft branchはG4 PR154 HEAD `98287392327eabfd5092a3ba89dde51a2e8beff6` から。G5 repaired PR152 `ccea1fe8132c6f573a768f0df5a033a05c62ef2c`、H5 source PR159 `163675c62835e84417905f98f97ceedd4dd1bcd9` を参照。PR161 bookkeepingはDraftでmain未反映、旧H5 TASKを書き換えない。
- 実装範囲：Threadsのみ個別解除UI/API/owner-only SQL候補、G5 `signal/stillOwned()` に追従したThreads固有cleanup adapter。G3のX予約/X saga、G5共通ID/T13/T10登録、H5 owner runtimeは保護。G3 in_progressのため変更パス衝突禁止。
- 解除・接続・投稿の本番ゲートOFF、Edge503、実Meta/Auth/DB/Vault/secrets/公開投稿/merge/deploy/EASは一切未承認。G5への本登録、managed権限、独立Sol（高）レビューと本人承認後の限定pilotは別工程。

## プロジェクト別現状

- F2の診断TASK `kabumori-f2-pr143-live-mergeability-diagnosis-20261012` はL2受入済み（done/none、PASS_GO_TO_MERGE_DECISION / PRODUCTION_NO_GO）。F8にニュース改善A J1-a診断TASK `news-improvement-a-jp-official-diagnostics-j1a-f8-20261012` を割当済み（ready/claude、L8返却、Sonnet5高）。その他の新系統枠は割当前の状態を各TASKで確認。
- かぶモリアプリ、X自動投稿アプリ（POSTONA）、共通アカウント、共通AI基盤、MIC、ニュース改善などの現状は、旧 `.agent/CURRENT_STATE.md` と旧各TASKが正本。

## G8 → F8の新規TASK移行

- 旧G8のJ0はK8で受入済み。旧G8の未開始J1-a（task_id `news-improvement-a-jp-official-diagnostics-j1a-g8-20261012`）は明示キャンセル・done/none。F8には**別task_id**でJ1-aを新規登録、旧G8との二重開始禁止。
- F8はjp_official診断の既存JSONBへの記録だけ。PR116の2026-10-13固定production反映、PR129、G9を保護。DB変更/merge/deploy/有料API無し、production NO_GO。F8は独立worktreeとfresh mainの競合を実作業開始時に確認する。

## 共通アカウント G5→F5 新規TASK
- 旧G5 `common-account-g5-phase4-h4-c4-r1-r2-repair-20261012` はK5受入済み・done/none、旧系統のまま完結（PR152修正head `ccea1fe8132c6f573a768f0df5a033a05c62ef2c`、依存PR121 `76b50e1e03f82faaa3460bab1603afa8fef3ce44`）。旧TASK/ReportをF5へ複写しない。
- F5の新規task_id `common-account-f5-phase5-app-auth-entitlement-integration-20261012` を明示割当、`ready/claude`、推薦 `Opus5.5（高）`、開始F5・完了L5、返却先 `共通アカウントG5のちゃ（新F5担当）`。
- 既存Phase1/2開始・再登録のRPCを再利用し、本人共通ID＋サービスentitlementのG5-owned backend接続部分だけ実装。G1/G2アプリUI/Auth、G3/G4 POSTONA/Threads、H5 transport等は所有者保護し、別slotへの正確な接続依頼に分離。全てsource/offline、PR121/152未merge、本番 Auth/DB/deploy/実SNSはNO_GO。

## 未解決問題

- F2: PR143 の GitHub の表示（GraphQL は UNKNOWN、REST は clean）は、試しのマージが古い main `50a2e079` の上のまま再計算されていないため。今の main `3c590d40` に対して、手元で PR143→149→158 を順に当てて衝突0件。マージは L2 の確認のあと、通常のマージで、間で後ろの PR の base を main に付け替えて進める（`delete_branch_on_merge: false`）。本番は NO_GO。
- 旧系統の未解決問題は旧 `.agent/CURRENT_STATE.md` と旧各TASK / Reportを参照する。

## production安全制約（現在有効）

- production の DB / Auth / RLS / migration / Edge Function / secrets / Cron / workflow / 実投稿 / 有料API は、各TASKの明示承認と安全ゲートが無い限り操作しない。
- 共通アカウント（旧G5）の優先は「競合したときに優先」であり全体停止ではない。同じDB object・RPC・Auth / RLS・Edge・settings・workflow・API境界に重なる場合だけ待つ。同一Supabase DBのDDL / write区間は直列化する。
- production mutation window は実writeの直前に開き、read-back後すぐ閉じる。各TASKヘッダーの `production_mutation_window: ACTIVE` と、その境界を確認してからproductionへ書く（新旧両系統のTASKを確認する）。
- 秘密情報（`.env`、APIキー、token、Cookie、秘密鍵）は表示・commit・ログ出力しない。

## 未マージPR

- F2は診断TASKのみで新規PRなし。対象の旧G2 PR143/149/158は未マージ、Draft。
- 新系統導入PR #155はマージ済み。旧系統の未マージPRは旧CURRENT_STATEとGitHubを参照する。

## deploy待ち

- 新系統としては無い。

## slot競合

- F2は診断中に旧G2/G1/G5/G6など既存slotとの同一ファイル操作を禁止。旧G2の診断TASKは未開始終了済み。
- 移行期間中は、旧Gn / Hn と新Fn / Jn が同じ境界を同時に変更しないよう、TASKを置くときに新旧両方の索引を確認する。

## 現在有効な運用判断

- 旧系統: G1/G2=かぶモリアプリ、G3/G4=X自動投稿アプリ（POSTONA）、G5〜G10=明示割当専用。H1〜H4=レビュー枠、H5=Codex臨時実装専用。単独 `F` は新旧30枠の統括。
- 新系統: F1〜F10は旧G1〜G10の後継枠、J1〜J4はレビュー枠、J5は臨時実装の優先枠（ユーザーの明示指示があればJ1〜J4も実装可）。
- 旧系統で開始したtask_idは旧系統で完結させ、新系統へは次の新規TASKから移す。
- Codexレビューの要否と時期は「レビュー最適化方針（2026-09-25〜）」に従う。レビュー省略時も実証確認は減らさない。

## 次工程

- F8で国内ニュースJ1-aを実装、L8で本チャットへ報告（Sonnet5高、production NO_GO）。
- F2のPR143マージ可否の診断はL2で受入済み。GitHub PR143 mergeable=falseが接続経由では継続するため、実マージ前の最新確認は必須。本番 NO_GO。

1. 旧系統の各slotが完了した時点で、ChatGPTが次の新規TASKを新系統へ置くかを判断する。
2. 初回の新系統TASK完了時にarchive / MANIFEST / SHA256 / HISTORY_INDEXの保存運用を確認する。
3. 完全移行の条件が揃ったら、最終snapshotと完全移行を別TASKで行う。
