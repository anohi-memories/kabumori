# G10 CURRENT TASK — 新旧30枠・段階移行型タスク基盤 v2 構築

- task_id: agent-v2-dual-slot-migration-20261012
- owner: claude
- slot: claude-10
- status: in_progress
- next_owner: claude
- start_code: G10
- finish_code: K10
- recommended_model: **Opus5.5（高）**
- registration: 2026-10-12 JST、ユーザーがチャットで本TASK本文を直接提示し、G10への登録をClaudeが行うことを明示承認した（ChatGPTによる登録がmainに無かったため）。登録で変更したのはこのファイルと `.agent/ACTIVE_TASK.md` のG10項目だけ。
- deliverable: `.agent_v2/` 新基盤の **Draft PR**（merge・deploy禁止）。Reportはこのファイル末尾の `## Report — agent-v2-dual-slot-migration-20261012`。

## TASK本文（2026-10-12 ユーザー提示の原文）

# G10 TASK｜新旧30枠・段階移行型タスク基盤 v2 構築

- task_id: agent-v2-dual-slot-migration-20261012
- owner: claude
- slot: G10
- status: ready
- next_owner: claude
- start_code: G10
- finish_code: K10
- recommended_model: Opus5.5（高）

## 目的

現在稼働中の旧15枠を止めずに、新しい軽量タスク管理基盤を完全に別系統で構築する。

旧基盤は移行期間中も唯一の現行正本として維持し、新規作業から順番に新基盤へ移行する。

既存のG1〜G10/H1〜H5を移行作業中に書き換えない。

---

# 移行期間のコード体系

## 旧基盤

Claude:
- G1〜G10
- 完了確認 K1〜K10

Codex:
- H1〜H5
- 完了確認 C1〜C5

## 新基盤

Claude:
- F1〜F10
- 完了確認 L1〜L10

Codex:
- J1〜J5
- 完了確認 V1〜V5

## 単独 F

単独 `F` は移行期間中、

- 旧G1〜G10
- 旧H1〜H5
- 新F1〜F10
- 新J1〜J5

の全30枠を統括確認する。

`F` と `F1〜F10` は完全一致で区別すること。

---

# 最重要の移行ルール

一度旧G/Hで開始した `task_id` は、そのTASKが完了するまで旧基盤で完結させる。

途中で、

- G → F
- H → J

へ移動しない。

新基盤への移行は「次の新規TASK」から行う。

例：

旧G1のTASK完了
↓
K1確認
↓
次の新規TASKからF1へ移行

移行タイミングはChatGPTが案件ごとに判断できる。

ユーザーが「次からFへ入れて」と指定した場合は新基盤を優先する。

---

# 新基盤の配置

現行 `.agent/` と完全分離すること。

推奨：

`.agent_v2/`

旧 `.agent/` は移行期間中の現行正本。

`.agent_v2/` は新方式のshadow / next基盤。

新旧を同時に正本扱いしない。

---

# 新基盤ファイル

最低限：

.agent_v2/
- ACTIVE_TASK.md
- CURRENT_STATE.md
- HISTORY_INDEX.md
- ORCHESTRATION.md
- tasks/
- reports/
- archive/

Claude TASK：

- F1〜F10用10ファイル

Codex TASK：

- J1〜J5用5ファイル

Codex Report：

- J1〜J5用5ファイル

開始・完了コード：

- F1→L1 ... F10→L10
- J1→V1 ... J5→V5

---

# 新TASK方式

新TASKには現在の作業だけを保存する。

保持：

- task_id
- owner
- slot
- status
- next_owner
- return_to
- completion_code
- recommended_model
- 目的
- 対象範囲
- 変更可
- 変更不可
- 安全制約
- 実装 / レビュー指示
- 依存関係
- 完了条件
- 最新Report

過去の完了TASK全文を連結しない。

目安：

10〜30KB程度。

厳格上限ではない。

---

# Report方式

Codexの新Reportには現在のJ TASKに対応する最新Reportだけを保持する。

ClaudeはF TASK末尾の `## Report` を使ってよい。

次TASKへ進む前に、完了したTASK/Reportの履歴保存を確認する。

過去Report全文を新TASKへ連結しない。

---

# ACTIVE_TASK v2

新15枠の現在状態のみ。

各slot：

- slot
- status
- task_id
- owner
- next_owner
- return_to
- completion_code
- recommended_model
- current_task_path
- current_report_path
- dependencies
- blocker

過去K/L/C/V判定全文を入れない。

---

# CURRENT_STATE v2

現在有効な情報だけを保存。

- プロジェクト別現状
- 未解決問題
- production安全制約
- 未マージPR
- deploy待ち
- slot競合
- 現在有効な運用判断
- 次工程

過去の完了解説・解決済み問題全文を蓄積しない。

---

# HISTORY

旧 `.agent/` の既存巨大履歴を消さない。

初回移行時に完全snapshotを作る。

例：

.agent_v2/archive/2026-10-12-initial-migration/

元のディレクトリ構造を可能な限り維持する。

snapshot対象：

- G1〜G10 TASK
- H1〜H5 TASK
- H1〜H5 Report
- ACTIVE_TASK.md
- CURRENT_STATE.md
- その他移行判断に必要な共有状態ファイル

archiveはappend-only。

新TASKから過去archiveを書き換えない。

---

# MANIFEST

snapshotにはMANIFESTを作る。

各ファイルについて：

- original_path
- archive_path
- size
- SHA256
- snapshot元commit SHA

を記録する。

archive後にhash照合し、復元可能性を確認する。

完全保存確認前に旧ファイルを短縮・削除しない。

---

# HISTORY_INDEX

`.agent_v2/HISTORY_INDEX.md`

検索用軽量索引。

各完了作業：

- 完了日
- slot
- task_id
- 作業名
- result
- PR番号
- final commit SHA
- archive参照先
- remaining issue参照先

Report本文をコピーしない。

通常のF/J/L/V実行時には全履歴を読まない。

必要な過去案件を調査するときだけ検索する。

将来的に、

.agent_v2/history/2026-10.md

等へ年月分割できる構造にする。

---

# 新Codex枠

J1〜J4：

通常のレビュー・バグ修正・検証枠。

案件固定なし。

J5：

Codex臨時実装の優先枠。

基本は空けておく。

ただしユーザーが明示的に、
「今回はJ4で実装」
等と指示した場合はJ1〜J4も臨時実装へ使用可能。

ChatGPTが勝手にJ1〜J4を実装枠へ転用しない。

---

# 返却先

J1〜J5には必ず：

- return_to
- completion_code

を持たせる。

- J1→V1
- J2→V2
- J3→V3
- J4→V4
- J5→V5

Codex報告末尾：

`<return_to> へ Vn を送ってください。`

不明時：

`返却先未確定 — ChatGPT確認待ち`

---

# F全体確認

移行期間中の単独 `F` は新旧30枠を確認する。

ただし過去Report全文を全部読まない。

第一段階：

- 旧ACTIVE_TASK
- 旧CURRENT_STATE
- 新ACTIVE_TASK
- 新CURRENT_STATE
- 各slotの最新metadata

必要なslotだけ個別TASK/Reportを追加確認する。

安全確認・競合確認は省略しない。

---

# GitHub運用ルールへの追加

移行期間中は、

- PROJECT_RULES.md
- `.agent/ORCHESTRATION.md`

に新旧二重系統の運用を明記する。

ただし現行G/H/K/Cの意味を変更しない。

新規：

- F1〜F10
- J1〜J5
- L1〜L10
- V1〜V5

を追加する。

単独Fは30枠統括とする。

---

# 完全移行条件

以下が満たされた時点でChatGPTが完全移行を判断する。

- 旧G1〜G10に継続TASKなし
- 旧H1〜H5に継続TASKなし
- 未処理K1〜K10なし
- 未処理C1〜C5なし
- 旧履歴最終snapshot完了
- archive/hash/restore確認完了
- 新基盤が安定稼働
- 未解決依存関係なし

完全移行時：

- F1〜F10 → G1〜G10
- J1〜J5 → H1〜H5
- L1〜L10 → K1〜K10
- V1〜V5 → C1〜C5

単独Fはそのまま全15枠統括へ戻す。

新基盤を正式 `.agent/` として昇格する。

旧基盤はarchiveとして保存する。

完全移行は別TASKとし、このG10 TASKでは実施しない。

---

# 禁止

- 現行G1〜G10 TASK変更
- 現行H1〜H5 TASK変更
- 現行Report変更
- 進行中TASKの移動
- 旧.agentの軽量化
- force push
- Git履歴書換え
- 既存PR無断merge
- production deploy
- Supabase本番変更
- DB/Auth/RLS/migration変更
- Edge Function本番変更
- Secrets/APIキー操作
- 有料API呼出
- 他worktree変更
- 他slot dev server操作

---

# 今回の実装範囲

このTASKでは：

1. `.agent_v2/` 新15枠基盤構築
2. 新TASK/Reportテンプレート
3. 新ACTIVE_TASK
4. 新CURRENT_STATE
5. HISTORY_INDEX
6. 旧.agent完全snapshot
7. MANIFEST / SHA256検証
8. 新旧移行ルール文書化
9. 単独F=30枠仕様
10. サイズ比較
11. Draft PR作成

まで。

mergeしない。

旧TASK軽量化もまだ行わない。

---

# 検証

- 新15枠全ファイル存在
- F1〜F10→L1〜L10一意
- J1〜J5→V1〜V5一意
- 旧15枠に差分なし
- archiveのSHA256一致
- snapshotから復元可能
- HISTORY_INDEX参照有効
- return_to/completion_code対応
- 単独Fで新旧30枠を区別可能
- git diff --check PASS

移行前後の通常読み込み量も推定比較する。

実測tokenと推定tokenを混同しない。

---

# 完了報告

K10へ以下を報告：

- result
- changed_files
- added_files
- `.agent_v2/` 構造
- snapshot保存先
- MANIFEST
- 保存ファイル数
- HISTORY_INDEX
- SHA256結果
- restore test
- 新15枠mapping
- 単独F=30枠仕様
- 旧15枠差分ゼロ確認
- サイズ/推定token比較
- commit SHA
- Draft PR URL
- merge/deploy
- remaining_issues
- safety_checks
- 完全移行前に必要な次工程

完了時点ではDraft PR止まり。
merge/deploy禁止。

## Preserved original unused G10 template (not an active task)

以下は2026-10-11追加時の未割当テンプレート（作業割当ではない履歴）。本文はそのまま、見出しを二段下げ、メタデータとReport欄は1行にまとめて保存した。改行も含めた完全な原文はgit履歴（このファイルを追加したcommit `d1046319af21eb956640bb7a73ca721fa973b3b8`）にある。

### Claude Task 10 — UNASSIGNED TEMPLATE（原文）

- task_id: none（当時）
- slot: claude-10 / status: idle（当時） / next_owner: none（当時） / start_code: G10 / finish_code: K10 / recommended_model: none（当時）

#### Purpose / allocation

未割当の予備Claude実装スロット（2026-10-11追加）。用途は固定しない。ユーザーまたはChatGPTが明示割当した場合のみ使用する。既存のG1/G2=かぶモリアプリ、G3/G4=X自動投稿アプリの基本ルーティングを維持する。idleだからという理由や、G1〜G4に空きがないという理由だけで自動使用しない。MIC・その他案件にも自動消費しない。

このテンプレートの追加自体は作業割当ではない。現時点のScope・完了条件・実行権限は未設定。

#### Before assignment（ChatGPT）

- statusだけで空き判定せず、task_id・TASK本文・Report・next_owner・ACTIVE_TASK・CURRENT_STATE・fresh `origin/main`を確認する。
- 既存TASK/Reportと他workstreamの変更を保護し、変更対象の非競合と専用の独立worktree/checkoutを確認する。
- 明示割当時にtask_id、目的、対象範囲、変更禁止対象、テスト、安全制約、完了条件を記入する。既存G枠と同様に、`K10` を確認するちゃの部屋を `return_to` に書いておくとよい。
- 明示割当時に推薦モデルを必ず設定する。候補：Sonnet5（中）/ Sonnet5（高）/ Sonnet5（極高）/ Opus5.5（中）/ Opus5.5（高）/ Opus5.5（極高）。未割当の間はnone。

#### Start / G10

`PROJECT_RULES.md`、`HANDOFF.md`、`.agent/ORCHESTRATION.md`、`.agent/CURRENT_STATE.md`、このTASK、必要なReport、Git状態とfresh `origin/main`を確認する。

明示割当済みでstatusが `ready` / `in_progress` の場合のみ `G10` で開始する。`idle` / `done` / `review_required` では開始しない。単独 `G` でも開始可能なClaude枠が1つだけと明白な場合のみ対象にできる。

G10専用の独立Git worktree/checkoutを `/Users/yuya/Developer/kabumori-fresh` の fresh `origin/main` から作成して使用する。安全な独立環境を用意できない場合は開始せず停止する。他slotのbranchをcheckout/reset/rebaseしない。他workstreamの未コミット変更を変更・削除・stage・commitしない。他slotの作業ファイルやdev serverを停止・再起動しない。

#### Scope / tests / completion criteria

未設定。明示割当時に具体化する。割当がない間は変更・テスト・push・deploy等を開始しない。

#### Completion / K10

完了・停止時の実績はこのTASK末尾の `## Report` に記録する。`K10` はG10専用のClaude完了確認コード。ChatGPTは完了条件、実装内容、changed_files、tests、commit/push/deploy、残課題、安全確認、競合、Codexレビュー要否を評価し、ORCHESTRATIONの開発日記更新判定も適用する。未実施を成功扱いにしない。

#### Report（テンプレート当時）

- task_id: none / result: not_started（未割当） / changed_files: none / tests: not_run / commit_hash: none / push: not_performed / deploy: not_performed / remaining_issues: none（作業未割当） / safety_checks: not_started / next_recommendation: 明示割当までidleを維持する。

## Report — agent-v2-dual-slot-migration-20261012

- task_id: agent-v2-dual-slot-migration-20261012
- result: in_progress（作業中。完了時にここへ記録する）
