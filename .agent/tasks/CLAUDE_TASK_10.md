# G10 CURRENT TASK — 新旧30枠・段階移行型タスク基盤 v2 構築

- task_id: agent-v2-dual-slot-migration-20261012
- owner: claude
- slot: claude-10
- status: done
- next_owner: none
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
- reported_at: 2026-10-12 JST
- status: review_required / next_owner: chatgpt（K10待ち）
- result: **PASS_DRAFT_PR** — `.agent_v2/` 新15枠基盤・旧 `.agent/` 完全snapshot・MANIFEST / SHA256・HISTORY_INDEX・新旧移行ルールを [Draft PR #155](https://github.com/anohi-memories/kabumori/pull/155) にまとめた。merge・deployはしていない。旧系統のTASK・Report・ACTIVE_TASK・CURRENT_STATEは、PRでは差分ゼロ。
- draft_pr: https://github.com/anohi-memories/kabumori/pull/155 （Draft / OPEN / 未merge、base `main`、head `8a28a067a20daec5bd96e09656bdfab144c3c458`、68ファイル）
- commit_hash:
  - PR head（`.agent_v2` 本体＋ルール追記）: `8a28a067a20daec5bd96e09656bdfab144c3c458`
  - G10 TASK登録（main、ユーザー承認済み）: `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7`
  - このReport: このReportを含むmainのcommit（`git log -- .agent/tasks/CLAUDE_TASK_10.md` で確認）
- push: PR branch `claude/g10-agent-v2-dual-slot-20261012` をpush（mainへは入れていない）。main へは、TASK登録とこのReport（このファイルと ACTIVE_TASK のG10項目のみ）を通常のfast-forward pushで反映。force push なし。
- deploy: なし。merge: なし。

### changed_files（PR #155）

- 変更: `PROJECT_RULES.md`（「新旧二重系統」節、単独F＝30枠）、`.agent/ORCHESTRATION.md`（新旧二重系統、移行期間中の単独F）、`AGENTS.md`（J1〜J5の1段落）、`CLAUDE.md`（F1〜F10の1行）、`.agent/CHATGPT_HANDOFF.md`（新旧二重系統の3行）。いずれも追記のみで、G / H / K / C の意味は変えていない。
- 追加: `.agent_v2/` 配下63ファイル（下の構造）。

### `.agent_v2/` の構造

- `ORCHESTRATION.md` — 新系統の運用詳細（コード体系、F と F1〜F10 の完全一致での区別、Fn＝Gnの後継枠、J1〜J4レビュー / J5臨時実装の優先枠、移行ルール、TASK / Report方式、次TASK前の履歴保存手順、返却先、単独F＝30枠の二段階確認、完全移行条件）
- `ACTIVE_TASK.md` — 新15枠（全枠 idle）。各枠に slot / status / task_id / owner / next_owner / return_to / completion_code / recommended_model / current_task_path / current_report_path / dependencies / blocker
- `CURRENT_STATE.md` — 現在有効な情報だけ（移行の状態、production安全制約、運用判断、次工程）
- `HISTORY_INDEX.md` — 旧系統の完了・履歴282件（現行15件を含む）の索引
- `tasks/F1.md`〜`F10.md`、`tasks/J1.md`〜`J5.md`、`reports/J1.md`〜`J5.md` — 未割当テンプレート
- `archive/.gitattributes`、`archive/README.md`、`archive/2026-10-12-initial-migration/`（`files/`、`MANIFEST.md`、`MANIFEST.json`、`SHA256SUMS`、`RESTORE.md`）

### snapshot / MANIFEST / SHA256 / restore

- 保存先: `.agent_v2/archive/2026-10-12-initial-migration/`。snapshot元は main `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7`（このTASKの登録直後）。
- 保存ファイル数: 33（旧 `.agent/` 配下の全28ファイル＋ `PROJECT_RULES.md` / `AGENTS.md` / `CLAUDE.md` / `HANDOFF.md` / `HANDOFF_TEMPLATE.md`）、合計 6,017,158 bytes。各ファイルは作業ツリーではなく `git show <commit>:<path>` のバイト列。
- MANIFEST: original_path / archive_path / size / SHA256 / git blob / snapshot元commit を全33件について記録（`MANIFEST.md`・`MANIFEST.json`）。
- SHA256の結果:
  - `shasum -a 256 -c SHA256SUMS` は 33/33件 OK。
  - 別手段でも、`git show <commit>:<path> | shasum -a 256` と `git hash-object` が 33/33件一致。
  - コミットされたarchiveのblobも、原本のblobと 33/33件一致。
- restore test: snapshot元commitの一時worktreeで対象33ファイルを削除（33件の変更）→ archiveの `files/` から復元 → `git status --porcelain` 0件。一時worktreeは確認後に削除した。
- archive配下は原本由来の行末空白を含むため、`archive/.gitattributes`（`** -text -whitespace`）で改行変換と空白チェックの対象外にした。新規に書いた非archiveファイルは引き続きチェック対象。

### HISTORY_INDEX

- 旧系統の各TASK / Report / 旧archive（G4の2件）から機械抽出した。完了・履歴267件と、snapshot時点の各slot現行15件（別表）を収録。旧CURRENT_STATEは参照先（S:）としてだけ使った。
- 列: 完了日 / slot / task_id / 作業名 / result / PR番号 / final commit SHA / archive参照先（T: TASK、R: Report、K/C: 完了確認見出し、S: 旧CURRENT_STATE） / remaining issue参照先。Report本文はコピーしていない。月ごとの見出し（2026-10 / 2026-09 / 日付不明）で、将来 `history/YYYY-MM.md` へ切り出せる。
- 参照の検証: 参照856件すべてについて、archiveの指定行が実在し、task_id（remaining参照は remaining / 残）を含む。生成とは別のスクリプトで確認した。
- 抽出の限界: 282件中、result 65件・PR番号 72件・final SHA 197件は原文から拾えず「—」。日付119件はtask_id由来（「（id）」付き＝割当日の目安）。補完も推測もしていない。

### 新15枠mapping

- F1→L1、F2→L2、F3→L3、F4→L4、F5→L5、F6→L6、F7→L7、F8→L8、F9→L9、F10→L10（`.agent_v2/tasks/Fn.md`、ReportはTASK末尾）
- J1→V1、J2→V2、J3→V3、J4→V4、J5→V5（`.agent_v2/tasks/Jn.md`、最新Reportは `.agent_v2/reports/Jn.md`）
- TASKヘッダーと ACTIVE_TASK v2 の両方で、15件すべて一意。
- 用途の既定: F1/F2=かぶモリアプリ、F3/F4=X自動投稿アプリ（POSTONA）、F5〜F10=明示割当専用（Fn は Gn の後継）。J1〜J4はレビュー・バグ修正・検証。J5はCodex臨時実装の優先枠で、ユーザーが明示した場合だけJ1〜J4も実装に使える。

### 単独F＝30枠の仕様

- 移行期間中の単独 `F`（数字なし、小文字 `f` も同じ）は、旧G1〜G10・旧H1〜H5・新F1〜F10・新J1〜J5の全30枠を統括する。`F1`〜`F10` とは完全一致で区別する（`F1` と `F10` も別）。
- 第一段階: 旧ACTIVE_TASK、旧CURRENT_STATEの先頭の現在の記録だけ、新ACTIVE_TASK、新CURRENT_STATE、30枠のTASK先頭メタデータ。第二段階: 必要なslotだけ個別TASK / Report。過去Report全文は読まない。安全・競合確認は省略しない。
- 完全移行後は、単独Fは全15枠の統括に戻る。
- 記載先: `PROJECT_RULES.md`、`.agent/ORCHESTRATION.md`、`.agent_v2/ORCHESTRATION.md`、`CLAUDE.md`、`.agent/CHATGPT_HANDOFF.md`（いずれもPR #155のmerge後に有効）。

### 旧15枠の差分ゼロ確認

- PR #155 の差分（base `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7`）で、`.agent/tasks/` 全15ファイル、`.agent/CODEX_REPORT*.md` 5件、`.agent/ACTIVE_TASK.md`、`.agent/CURRENT_STATE.md`、`.agent/archive/`、`.agent/room_handoffs/`、`.agent/CLAUDE_REPORT.md` は差分ゼロ。
- `.agent_v2/` 以外で変わったのは、上記のルール・入口文書5ファイルの追記だけ。

### サイズ / 推定token比較

bytes・文字数は実測。tokenは「ASCII文字数÷4＋非ASCII文字数÷1.5」の概算式による推定で、実測ではない。

| 読み込み | bytes（実測） | 文字数（実測） | 推定token |
| --- | ---: | ---: | ---: |
| 旧: 単独F（旧ルールどおり全文） | 5,579,744 | 4,840,143 | 1,364,138 |
| 旧: 1枠の開始（中央値） | 992,061 | 883,362 | 243,491 |
| 旧: 1枠の開始（最大） | 1,936,268 | 1,821,349 | 479,279 |
| 新: 単独F 第一段階（移行期間中・30枠） | 113,977 | 93,500 | 27,638 |
| 新: 単独F 第一段階（完全移行後・15枠） | 18,250 | 13,624 | 4,366 |
| 新: 1枠の開始（現時点のテンプレート） | 89,753 | 48,338 | 20,714 |
| 新: 1枠の開始（TASKが目安上限30KBの場合） | 118,617 | 67,812 | 27,538 |

- 範囲の仮定: 「1枠の開始」は PROJECT_RULES＋HANDOFF＋ORCHESTRATION＋CURRENT_STATE＋自TASK（H枠は＋Report）。「旧CURRENT_STATEの先頭の現在の記録」は先頭10節で計測。旧TASKの先頭メタデータは先頭30行、新は先頭20行。30KB TASKの行は、日本語5,000字＋ASCIIで30KBとした仮定の値（推定）。
- 新系統の1枠開始では、PROJECT_RULES と HANDOFF（約49KB）の共通部分が大半を占める。

### tests / checks

- 新15枠の全ファイル存在（TASK 15、J Report 5、ACTIVE_TASK、CURRENT_STATE、HISTORY_INDEX、ORCHESTRATION の24件）: PASS
- F1〜F10→L1〜L10、J1〜J5→V1〜V5 の一意性: PASS
- 旧15枠の差分ゼロ: PASS
- archive SHA256一致（3つの方法）: PASS
- snapshotからの復元: PASS
- HISTORY_INDEX の参照有効（856件）: PASS
- J1〜J5 の return_to / completion_code 欄の存在と対応: PASS（未割当のため値は none、completion_code は V1〜V5 固定）
- 単独Fと F1〜F10 の区別がルール文書に明記されている: PASS
- `git diff --check`: PASS
- workflow / scripts / supabase/functions に `.agent` を参照するものは無い（archive追加の影響なし）

### remaining_issues

1. HISTORY_INDEX は機械抽出。「—」の欄（result 65 / PR 72 / SHA 197）と、task_id由来の日付119件は原文確認が必要。PR番号欄には、対象PRのほかに保護対象・参照先として書かれたPRも含まれうる。
2. snapshotは `d811b4dc` 時点の写し。旧 `.agent/` はその後も更新されるので、完全移行の直前に別TASKで最終snapshotが必要。
3. リポジトリ全体を検索すると、旧ファイルの写しが `.agent_v2/archive/` で重複して見つかる。検索時は必要に応じて除外する。
4. PR #155 は `PROJECT_RULES.md`・`.agent/ORCHESTRATION.md`・`AGENTS.md`・`CLAUDE.md`・`.agent/CHATGPT_HANDOFF.md` に追記している。merge前にこれらがmainで変わると競合しうるので、merge時にfresh mainで確認が必要。
5. 「Fn＝Gnの後継枠（同じ用途・同じ部屋）」は、完全移行時の呼び名戻しと「G1完了→次からF1」の例に合わせた既定案。予備枠で部屋の用途が決まっているもの（例: G6・G9）をFへ引き継ぐかは、移すときにChatGPTの判断が必要。
6. 推定tokenは概算式による値で、実測ではない。
7. G10 TASK自体は、ChatGPTではなくClaudeがユーザー承認のもとで登録した（登録commit `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7`）。
8. 旧H5（臨時実装専用・H1〜H4は実装しない）と新J5（優先枠・ユーザー明示時はJ1〜J4も実装可）は、TASK指示どおり意図的に異なる。

### safety_checks

- 現行G1〜G10 / H1〜H5 のTASK・Reportの変更なし（G10の登録とこのReportは、ユーザー承認のもとで自分のslotだけ）。進行中TASKの移動なし。旧 `.agent` の軽量化なし。
- force push なし、Git履歴の書き換えなし、既存PRのmergeなし、PR #155 も未merge。
- production deploy、Supabase本番、DB / Auth / RLS / migration、Edge Function、secrets / APIキー、有料APIの呼び出しは、いずれもなし。
- 作業は `kabumori-fresh` の fresh `origin/main` から作った専用worktree `/Users/yuya/Developer/kabumori-g10-agent-v2` で実施した。他のworktreeや他slotのdev serverには触れていない。復元テスト用の一時worktreeは自分で作り、確認後に削除した。

### 完全移行前に必要な次工程

1. K10でPR #155を確認する。Codexレビューを入れる場合は、旧系統のH1〜H4へ置く（docsのみの変更なので、要否はレビュー最適化方針でChatGPTが判断）。
2. ユーザー / ChatGPTの判断でPR #155をmergeし、新旧二重系統を有効化する。
3. 旧系統の各slotが完了した時点で、次の新規TASKを新系統（F / J）へ置くかをChatGPTが判断する。
4. 最初に完了したF / J TASKで、「完了時の履歴保存」（archive＋MANIFEST＋SHA256＋HISTORY_INDEX追記）が回ることを確認する。
5. 完全移行の条件（旧系統の継続TASKと未処理K / Cが無い、新基盤が安定稼働、未解決の依存関係が無い）が揃ったら、別TASKで旧 `.agent/` の最終snapshotを取り、hash照合と復元確認をする。
6. 別TASKで完全移行を行う（F→G、J→H、L→K、V→C、`.agent_v2/` を正式 `.agent/` へ昇格、旧基盤をarchiveへ）。
- next_recommendation: K10でPR #155を確認し、merge可否と最初の新系統TASKの置き場所を判断する。


## K10 FINAL — ChatGPT acceptance / 2026-10-12 JST

- task_id: agent-v2-dual-slot-migration-20261012
- result: **PASS / MERGED / CLOSED**。G10実装PASS、H3 C3独立レビューPASS。
- PR: #155; reviewed HEAD `8a28a067a20daec5bd96e09656bdfab144c3c458`; merge commit `4e80c79dc42c11fbc1ca105665514b0dd32842d3`（GitHub read-back確認）。
- tests/safety: archive 33/33 hash・restore、HISTORY_INDEX参照856件、旧TASK/Report/ACTIVE/CURRENT保護をH3報告とマージ後の確認で受理。production deployなし。新F/J割当なし。
- next_owner: none。G10を解放。旧TASKは旧G/Hで完結し、次の新規TASKから個別にF/Jへ移行する。
- remaining: `.agent_v2/CURRENT_STATE.md` のmerge済み記載を更新。初回新TASK完了時に履歴保存を実証し、完全移行は別TASK。
