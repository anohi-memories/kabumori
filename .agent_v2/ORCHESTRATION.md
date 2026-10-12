# Agent Orchestration v2（新系統・移行期間中）

## 位置づけと優先順位

- `.agent_v2/` は新しい軽量タスク基盤（shadow / next）。移行期間中の現行正本は旧 `.agent/`（G1〜G10 / H1〜H5）のまま。
- ルールの優先順位は `PROJECT_RULES.md` → `.agent/ORCHESTRATION.md` → この文書。この文書は新系統（F1〜F10 / J1〜J5）の運用詳細だけを定め、上位と矛盾する場合は上位に従う。
- 1つの `task_id` の正本は、旧 `.agent/` か新 `.agent_v2/` のどちらか一方だけ。新旧を同時に正本扱いしない。
- この基盤は、導入PRのmerge後に有効になる。mergeまでは新系統のslotは使わない。merge後も、ChatGPTまたはユーザーが新系統へTASKを置くまで、新15枠はすべて `idle`。

## コード体系（移行期間中）

| 系統 | 開始コード | 完了確認コード | TASK | Report |
| --- | --- | --- | --- | --- |
| 旧 Claude | `G1`〜`G10` | `K1`〜`K10` | `.agent/tasks/CLAUDE_TASK*.md` | 各TASK内 |
| 旧 Codex | `H1`〜`H5` | `C1`〜`C5` | `.agent/tasks/CODEX_TASK*.md` | `.agent/CODEX_REPORT*.md` |
| 新 Claude | `F1`〜`F10` | `L1`〜`L10` | `.agent_v2/tasks/F1.md`〜`F10.md` | 各TASK末尾の `## Report` |
| 新 Codex | `J1`〜`J5` | `V1`〜`V5` | `.agent_v2/tasks/J1.md`〜`J5.md` | `.agent_v2/reports/J1.md`〜`J5.md` |
| 統括 | 単独 `F` | — | 新旧30枠 | — |

- 対応は1対1: F1→L1 … F10→L10、J1→V1 … J5→V5。別枠のコードで完了確認しない。
- **単独 `F` と `F1`〜`F10` は完全一致で区別する。** 数字が付かない `F`（小文字 `f` も同じ）だけが統括コード。`F1`〜`F10` は新Claude枠の開始コードで、`F1` と `F10` も別のコード。`F` の後ろに数字が付いていれば、統括としては扱わない。
- 単独 `L` / 単独 `V` / 単独 `J` は使わない。旧系統の単独 `G` / `K` の扱いは旧ルールのまま（対象は旧G1〜G10だけ）。

## 新15枠の用途

### F1〜F10（Claude）

- `Fn` は旧 `Gn` の後継枠。既定では同じ用途・同じ部屋を引き継ぐ。
  - F1 / F2: かぶモリアプリ
  - F3 / F4: X自動投稿アプリ（POSTONA）
  - F5〜F10: 予備枠。ユーザーまたはChatGPTの明示割当専用。idleだから、F1〜F4が埋まっているから、という理由だけで自動使用しない。
- 旧Gnで明示割当により決まっていた部屋の用途（例: 予備枠の専属担当）は、次の新規TASKをFnへ置くときにChatGPTが引き継ぐかを判断する。

### J1〜J5（Codex）

- **J1〜J4**: 通常のレビュー・バグ修正・検証枠。案件固定なし。空いていて競合しない枠を使う。
- **J5**: Codex臨時実装の優先枠。基本は空けておく。使ってよい場面は旧H5と同じ（Claudeで実装できない／Claudeの安全装置等で止まる／Claudeの利用制限で実装不能／ChatGPTがCodex実装を明示判断／ユーザーが明示希望）。
- ユーザーが明示的に「今回はJ4で実装」などと指示した場合に限り、J1〜J4も臨時実装に使ってよい。ChatGPTが自分の判断でJ1〜J4を実装枠へ転用しない。
- 臨時実装した枠は、その実装の最終レビューを自分でしない。レビューは別のJ枠（臨時実装に使っていないJ1〜J4）へ置く。
- 臨時実装TASKには、臨時実装であること、Codexへ回す理由、対象範囲、変更可 / 不可、安全制約、tests、完了条件、`return_to`、`completion_code`、推薦モデルを必ず書く。

## 移行ルール（最重要）

- 旧G/Hで開始した `task_id` は、そのTASKが完了するまで旧系統で完結させる。途中で G→F、H→J へ移さない。
- 新系統への移行は「次の新規TASK」から。例: 旧G1のTASK完了 → K1確認 → 次の新規TASKからF1へ。
- 移行のタイミングはChatGPTが案件ごとに判断する。ユーザーが「次からFへ入れて」等と指定した場合は新系統を優先する。
- 旧Gnと新Fn、旧Hnと新Jnは別slotとして扱う。両方が同時に動く場合も、同じファイル・DB・Auth・Edge・設定・production境界を同時に変更しない（旧ルールの競合防止をそのまま適用）。

## 開始条件

- `ready` または `in_progress` のTASKだけ開始する。`idle` / `done` / `review_required` では開始しない。
- 開始前に `PROJECT_RULES.md`、`HANDOFF.md`、この文書、`.agent_v2/CURRENT_STATE.md`、自分のTASK、fresh `origin/main` を確認する。旧系統のファイルは、依存関係や競合の確認に必要な範囲だけ読む。
- 作業は `/Users/yuya/Developer/kabumori-fresh` の fresh `origin/main` から作るslot専用の独立worktree / checkoutで行う。同一ディレクトリの共有、他slotのbranchのcheckout / reset / rebase、他slotの未コミット変更・dev serverへの操作は禁止。安全な独立環境を作れなければ開始しない。
- 新しいTASKは、statusだけで判断せず、task_id・TASK本文・Report・next_owner・ACTIVE_TASK・CURRENT_STATEから真に未割当と確認できる枠にだけ置く。

## TASK方式（現在の作業だけを持つ）

各TASKファイルには、現在の作業だけを書く。過去の完了TASK全文やReport全文を連結しない。目安は10〜30KB（厳格な上限ではない）。

必須項目:

- メタデータ: `task_id` / `owner` / `slot` / `status` / `next_owner` / `return_to` / `completion_code` / `recommended_model` / `current_task_path` / `current_report_path` / `dependencies` / `blocker`
- 本文: 目的 / 対象範囲 / 変更可 / 変更不可 / 安全制約 / 実装・レビュー指示 / 依存関係 / 完了条件
- 最新Report（Fは同じファイル末尾の `## Report`、Jは `.agent_v2/reports/Jn.md`）

テンプレートは各TASKファイルそのもの（未割当状態）。

## Report方式

- Fの最新Reportは、そのFのTASK末尾の `## Report` に書く。
- Jの最新Reportは `.agent_v2/reports/Jn.md` に、現在のJ TASKに対応するものだけを置く。
- 必須項目: task_id、result、changed_files、tests、commit_hash、push、deploy、remaining_issues、safety_checks、next_recommendation。Jは加えて `return_to` と `completion_code`。
- SHAは `git rev-parse` / `gh pr view` の出力をそのまま書く。短縮SHAを推測で補完しない。

## 完了時の履歴保存（次TASKへ進む前に必須）

L / V の完了確認が済み、そのslotへ次のTASKを置く前に、次TASKを置く担当（通常ChatGPT）が次を行う。

1. 完了したTASKファイル（Jは対応するReportファイルも）を、`.agent_v2/archive/<YYYY-MM-DD>-<slot>-<task_id>/files/` へ元の相対パスのままコピーする。
2. 同じディレクトリに `MANIFEST.md` / `MANIFEST.json` / `SHA256SUMS`（original_path・archive_path・size・SHA256・元commit SHA）を作り、`shasum -a 256 -c SHA256SUMS` で照合する。
3. `.agent_v2/HISTORY_INDEX.md` の「新系統の完了作業」へ1行追記する（Report本文はコピーしない）。
4. 1〜3の確認後に、TASKファイルを次の作業の内容で置き換え、Reportを空にする。

保存を確認できない場合は、TASKを置き換えずに止める。

## 返却先（J1〜J5）

- J1〜J5のTASKには必ず `return_to` と `completion_code`（J1→V1、J2→V2、J3→V3、J4→V4、J5→V5）を書く。`return_to` はG番号やF番号だけにせず、ユーザーが戻るチャットを判別できる名前にする。
- Codexは返却先を推測しない。完了報告の末尾に必ず置く:

```text
返却先
<return_to> へ Vn を送ってください。
```

- `return_to` / `completion_code` が欠落・不明・矛盾・不一致の場合:

```text
返却先
返却先未確定 — ChatGPT確認待ち
```

## 単独 F（移行期間中は新旧30枠）

`F` は完了コードではない。整理と提案だけを行い、別チャット担当のTASKを完了・再割当しない。過去Report全文は読まない。

第一段階（必ず行う）:

1. 旧 `.agent/ACTIVE_TASK.md`
2. 旧 `.agent/CURRENT_STATE.md` の先頭にある現在の記録だけ（全文は読まない）
3. `.agent_v2/ACTIVE_TASK.md`
4. `.agent_v2/CURRENT_STATE.md`
5. 各slotの最新メタデータ（旧15枠・新15枠のTASK先頭のヘッダーだけ）

第二段階（必要なslotだけ）: 状態の食い違い、`review_required`、blocker、競合、production作業の可能性があるslotについて、個別のTASK / Reportを追加で読む。

整理する項目（新旧30枠すべて、系統を明記する）: slot / 系統（旧・新）/ status / task_id / owner / next_owner / return_to / completion_code / 実際の空き / 作業中 / 完了確認待ち / deploy待ち / blocker / 競合（新旧間の同一境界を含む）/ worktree分離 / 次工程。旧H5・新J5は、臨時実装中か・空いているか・レビュー用途で誤使用されていないかも確認する。

安全確認と競合確認は省略しない。完全移行後は、単独 `F` は全15枠の統括に戻る。

## 各ファイルの役割

| ファイル | 内容 | 入れないもの |
| --- | --- | --- |
| `ACTIVE_TASK.md` | 新15枠の現在状態だけ | 過去のK / L / C / V判定の全文 |
| `CURRENT_STATE.md` | 現在有効な情報だけ（プロジェクト別現状、未解決問題、production安全制約、未マージPR、deploy待ち、slot競合、現在有効な運用判断、次工程） | 過去の完了解説、解決済み問題の全文 |
| `HISTORY_INDEX.md` | 完了作業の検索用索引（参照先つき） | Report本文 |
| `tasks/` | F1〜F10、J1〜J5の現在のTASK | 過去TASKの全文 |
| `reports/` | J1〜J5の最新Report | 過去Reportの全文 |
| `archive/` | 旧系統のsnapshotと、新系統の完了TASK / Report（append-only） | — |

通常のF / F1〜F10 / J1〜J5 / L / V の実行時には `HISTORY_INDEX.md` と `archive/` を読まない。過去案件を調べるときだけ検索する。

## archive（append-only）

- `archive/` 配下は追加だけ。既存のsnapshotや保存済みファイルを書き換え・削除・短縮しない。新TASKから過去archiveを編集しない。
- 初回snapshot: `archive/2026-10-12-initial-migration/`（旧 `.agent/` 全28ファイル＋共有ルール・引き継ぎ5ファイル。詳細は同ディレクトリの `MANIFEST.md` と `RESTORE.md`）。
- snapshot後も旧 `.agent/` は変化し続ける。完全移行の直前に、別TASKで最終snapshotを取る。
- 旧ファイルの短縮・削除は、保存とhash照合・復元確認が済むまで行わない（このPRでは行わない）。

## 完全移行

次がすべて満たされた時点で、ChatGPTが完全移行を判断する。

- 旧G1〜G10に継続TASKが無い
- 旧H1〜H5に継続TASKが無い
- 未処理のK1〜K10が無い
- 未処理のC1〜C5が無い
- 旧履歴の最終snapshotが完了している
- archive / hash / restore の確認が完了している
- 新基盤が安定稼働している
- 未解決の依存関係が無い

完全移行時（別TASKで実施）:

- F1〜F10 → G1〜G10、J1〜J5 → H1〜H5、L1〜L10 → K1〜K10、V1〜V5 → C1〜C5 に呼び名を戻す。
- 単独 `F` は全15枠の統括に戻る。
- 新基盤を正式な `.agent/` へ昇格し、旧基盤はarchiveとして保存する。

## モデル運用・レビュー・production

- 割当時の推薦モデルは必須（Claude: Sonnet5 / Opus5.5、Codex: Luna / Sol、各 中 / 高 / 極高）。未割当は `none`。
- レビュー要否と時期は `.agent/ORCHESTRATION.md` の「レビュー最適化方針（2026-09-25〜）」に従う。新系統でCodexレビューを置く先はJ1〜J4。
- production並行運用、G5（共通アカウント）優先の競合判定、production mutation windowの扱いは旧ルールのまま新系統にも適用する。
