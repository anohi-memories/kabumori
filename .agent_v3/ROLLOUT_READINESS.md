# V3 導入直前の準備（候補・未適用）

F10 `orchestration-v3-final-legacy-snapshot-and-pilot-readiness-f10-20261017` で作った**候補**。

- 現行ルール（`PROJECT_RULES.md`、`.agent/ORCHESTRATION.md`、`.agent_v2/ORCHESTRATION.md`、`AGENTS.md`、`CLAUDE.md`）と、稼働中のTASKは変えていない。
- 下の文案は、正式な承認の後に別TASKで反映する。

関係するDraft PR（どれも未merge）:

| PR | 内容 | 追加するパス |
| --- | --- | --- |
| #229 | V3のツール・仕様・テスト（HEAD `2c810122250e885ccbc3ae3a50351b78070ae69c`） | `.agent_v3/{EVIDENCE,MIGRATION,README,SPEC}.md`、`.agent_v3/evidence/`、`scripts/agent_v3/`、`tests/agent_v3/` |
| #248 | 移行前調査と移行仕様の候補（HEAD `ae4861deebf66081db2581cd61b43ae6fb73645a`） | `.agent_v3/CUTOVER_PLAN.md`、`.agent_v3/PREFLIGHT_20261017.md` |
| #252 | 旧 `.agent/` の最終snapshot候補（HEAD `9946c9d59ff90e2c809058a099eca5208f5da519`） | `.agent_v2/archive/2026-10-17-legacy-agent-final-cae7aa4e/` |
| このbranch | この文書 | `.agent_v3/ROLLOUT_READINESS.md` |

4つのPRが追加するパスは重ならない。どれも既存ファイルを変更しない。

## 1. 置き場所の食い違いを直す変更候補

PR #229 の文書は、V3の置き場所を「将来の `.agent/`」としている。PR #248 は、新しい `.agent_v3_gh/` を提案している。PR #248 の案（旧 `.agent/` を上書き・改名しない）に揃える。

**この変更は、PR #229 のbranchには入れていない。** 採用が決まったら、PR #229 のHEADを更新するTASKで反映し、変わった分だけ焦点レビューを行う。

### PR #229 `.agent_v3/SPEC.md`（17行目）

変更前:

> `<root>` は正式適用まで未定（候補: 将来の `.agent/`）。テストでは `.agent_v3_fixture`、GitHub実検証では `.agent_v3_live_fixture` を使い、どちらも専用の場所だけに書く。

変更後:

> `<root>` は、正式適用では `.agent_v3_gh`（G1〜G10 / H1〜H5、`--naming GH`）を使う。旧 `.agent/` は凍結した履歴として残し、上書き・改名・削除しない（`CUTOVER_PLAN.md` の2）。`.agent_v3/` は仕様と調査の文書の置き場で、rootには使わない。テストでは `.agent_v3_fixture`、GitHub実検証では `.agent_v3_live_fixture` を使い、どちらも専用の場所だけに書く。

### PR #229 `.agent_v3/MIGRATION.md`

段階3（25行目）の変更前:

> | 3 | 正式適用TASK: V3の置き場所（候補: 旧 `.agent/` をarchiveへ移した後の `.agent/`）と、G / H / K / C の名前で使うことを決める。PROJECT_RULES / ORCHESTRATION / AGENTS / CLAUDE / CHATGPT_HANDOFF を改訂 | ルール文書（別TASK） |

段階3の変更後:

> | 3 | 正式適用TASK: V3の置き場所を `.agent_v3_gh/` とし、G / H / K / C の名前で使う。旧 `.agent/` は凍結して残し、旧 `ORCHESTRATION.md` / `CHATGPT_HANDOFF.md` は変更しない。PROJECT_RULES・v2 ORCHESTRATION・ChatGPT向けの手順書を改訂し、AGENTS はH枠を切り替える時に改訂する（`CUTOVER_PLAN.md` の10） | ルール文書（別TASK） |

GO条件4（36行目）の変更前:

> 4. 旧 `.agent/` に継続TASKが無く（現時点で満たす）、最終snapshotのhash照合・復元確認が済んでいる（PR #172、または後継）。

GO条件4の変更後:

> 4. 旧 `.agent/` に継続TASKが無く、最終snapshotのhash照合・復元確認が済んでいる。PR #172 は古いので使わない。後継はPR #252（元commit `cae7aa4e8d90dc58b314dec5430187ddbb7fda08`、`.agent` のtree SHA `9a8d8e105c7e875d260e8f36db4271727379554d`）。凍結後に `.agent` のtree SHAが変わっていれば、取り直す。

### PR #248 `CUTOVER_PLAN.md` への追記候補

PR #248 も変更していない。次の3点は、この文書が置き換える。

- 4（最終snapshot）: PR #252 で作成済み。merge時に HISTORY_INDEX へ1行を別commitで足す。凍結の確認は、`.agent` のtree SHA（上記）が同じかどうかで行う。
- 6（書き手ごとの登録方法）: 普段の登録は、この文書の2の軽量手順を使う。
- 8（pilot）: G10はユーザーがまだ割り当てていない予備枠。ユーザーまたは統括の明示承認があるまで、G10へTASKを置かない（pilotは提案にとどめる）。

## 2. 普段の登録・完了確認を軽くする

### 方針

- 普段の操作は、**対象slotのTASK正本と索引だけ**を読み書きする。全30枠の走査、archiveの読み込み、Report全文の繰り返し取得はしない。
- 例外の時だけ広く調べる（下の「例外」）。

### 手順（1件＝1commit）

| 操作 | 誰が | 読むもの | 書くもの（1commit） | 「済んだ」と言える条件 |
| --- | --- | --- | --- | --- |
| 新しいTASKの登録（`idle → ready`） | ChatGPT | mainのref、対象slotのTASK、索引 | 対象TASK＋索引 | mainの新しいcommitで、5項目（task_id / status / next_owner / return_to / completion_code）を読み戻して一致 |
| 開始（`ready → in_progress`） | Claude / Codex（ツール） | 同上 | 同上 | `REGISTERED_ON_MAIN` |
| Report提出（`→ review_required`） | Claude / Codex（ツール） | 同上（CodexはReportも） | 対象TASK（ClaudeはReportを含む）＋索引（CodexはReportファイルも同じcommit） | `REGISTERED_ON_MAIN` |
| 完了確認（K / C、`→ done`） | ChatGPT | 同上 | 対象TASK（`### Kn acceptance` / `### Cn acceptance`。KはAI Lab diaryの判定を含む）＋索引 | 5項目の読み戻しが一致 |
| archive（`done → idle`） | Claude / Codex（ツール） | 対象slotのTASK（とReport）、archive先が空であること | archive一式＋idleテンプレート＋HISTORY_INDEX＋索引 | `REGISTERED_ON_MAIN` |

- 対象slotの競合の確認は、次の2つだけで行う。
  - 読んだTASKの task_id / status / SHA256 が、自分の計画したbaseと同じか。
  - 索引の対象slotの行が、TASKと一致しているか。
- **例外**（この時だけ全枠・archiveを調べる）:
  - 索引のdigestが合わない。
  - 対象slotの索引の行がTASKと食い違う。
  - 公開の答えが分からない（`PUBLISHED_UNVERIFIED`、GraphQLの一般エラー、時間切れ）。
  - `CONFLICT_SAME_SLOT` / `PLAN_REFUSED` が出た。
  - pilotの開始。
  - 単独 `F`。

### 索引を差分だけ更新する（ツールの変更候補。別TASK・要レビュー）

今のPR #229 のツールは、索引を作るたびに全15枠のTASKを読む（`deriveIndex`）。軽量手順にするには、次の変更が必要。

1. 索引の各slotの行（task_id / status / next_owner / return_to / completion_code、owner、recommended_model、パス）から、`source_digest` を計算し直す。
   - 今の `source_digest` と一致すれば、索引は手で直されていない。
   - 一致しなければ、例外として全枠から作り直す。
2. 対象slotの行だけを、新しいTASKのヘッダーで置き換える。digestを計算し直して書く。
3. テストで、「索引が正本と一致している時、差分更新の結果は全枠からの再生成と1バイトも違わない」ことを確かめる。

注意: 別の書き手がTASKだけを書いて索引が古い場合、差分更新はその古さを引き継ぐ（悪化はしない）。それを見つけるのは、例外時の全枠の検査と、単独 `F` の `verify`。

### 計測（2026-10-17）

本物のGitHubを、GETだけで3回ずつ計測した。

- 計測に使ったmain: `109f6403b15a7a7ea6a2c7d5b6d77408ce566f51`。凍結後の単独 `F` の行だけ `07776c44b04ad129597f25b27a184ec5c50f5f64`。どちらも `.agent` のtree SHAは `9a8d8e105c7e875d260e8f36db4271727379554d`。
- 計測用の通信路は、GET以外を送ろうとすると例外で止まる。
- 時間には、`gh` コマンドの起動時間が含まれる。
- GETの回数と取得量は、3回とも同じだった。時間は中央値（括弧内は3回の値）。

| 読み取りの組 | GET | 取得したファイルの合計 | 時間 |
| --- | --- | --- | --- |
| 旧方式の登録に必要な読み取り（G2: 旧TASK・旧索引・旧CURRENT_STATE） | 4 | 1,706,620 bytes | 2.8秒（2.8 / 2.5 / 2.8） |
| v2の決まりでの登録（F10: TASK・索引・CURRENT_STATE） | 4 | 96,857 bytes | 1.6秒（1.6 / 1.5 / 1.7） |
| 今のV3ツールの計画段階（15枠のTASKをすべて読む） | 16 | 121,133 bytes | 6.4秒（6.4 / 6.1 / 6.5） |
| 軽量手順（対象TASKと索引だけ） | 3 | 18,520 bytes | 1.2秒（1.1 / 1.2 / 1.2） |
| 単独 `F` の第一段階（旧・v2の索引とCURRENT_STATE、30枠のTASK全文） | 35 | 4,642,353 bytes | 16.2秒（16.2 / 16.2 / 16.1） |
| 凍結後の単独 `F`（v2の索引・CURRENT_STATE・15枠のTASK＋旧 `.agent` のtree SHAの確認だけ） | 20 | 213,135 bytes | 8.0秒（8.0 / 8.1 / 7.8） |

- 今のV3ツールの1回の状態更新では、APIの呼び出しが合計26回だった。
  - 内訳: contents GET 16、ref GET 3、commit GET 1、compare GET 1、blob POST 2、tree POST 1、commit POST 1、ref PATCH 1。
  - archiveは36回（contents GET 22、blob POST 6 ほか）。
  - これは、手元の偽のGitHub（G / Hの15枠のroot）で数えた値。
- 軽量手順の書き込みは、blob POST 2・tree POST 1・commit POST 1・ref更新 1、読み戻しは ref GET 1・contents GET 1〜2。これは手順の定義から数えた回数で、まだ実装していないので実測ではない。
- **計測していないもの**:
  - ChatGPTのコネクタ経由の呼び出し回数と時間。
  - 本物のGitHubへの書き込みにかかる時間。
  - V3の `.agent_v3_gh/` 上での単独 `F`（まだ存在しないため）。
  - これらの比較は書かない。

読み取れること（計測値だけから）:

- 旧方式の重さは、旧TASKと旧CURRENT_STATEが大きいことによる。旧TASKは過去の作業を連結していて、最大はG2の `tasks/CLAUDE_TASK.md` の860,308 bytes（PR #252 のMANIFEST）。
- 今のV3ツールは、v2の決まりより取得量が約1.25倍、GETの回数が4倍、時間が約3.9倍。原因は、索引を作るために全15枠を読むこと。
- 軽量手順は、v2の決まりと比べてGETが1回少なく、取得量は約5分の1。
- 単独 `F` は、旧系統を凍結してtree SHAだけを確かめれば、GETが35回から20回、取得量が約22分の1になる。

## 3. ルール文書の文案（未適用）

### `PROJECT_RULES.md` に足す節（文案）

```markdown
## V3（`.agent_v3_gh/`）の段階導入（承認後に有効）

- V3の置き場所は `.agent_v3_gh/`。G1〜G10（完了確認 K1〜K10）、H1〜H5（完了確認 C1〜C5）の意味・開始条件・1対1の完了確認・return_to・推薦モデル・H5とG5〜G10の使い方は変えない。
- 切り替え表に載った枠だけ、開始・完了コードがV3のTASKを指す。載っていない枠は旧 `.agent/`（凍結済み）を指す。

| 枠 | 切り替えcommit | v2側の扱い |
| --- | --- | --- |
| （承認されるまで空） | — | — |

- 旧 `.agent/` は凍結commit（`.agent` のtree SHA `<凍結時の値>`）から変更しない。最終snapshotは `.agent_v2/archive/<最終snapshotのディレクトリ>/`。旧 `ORCHESTRATION.md` / `CHATGPT_HANDOFF.md` のパスより、この表を優先する。
- 用途の組（Gn と Fn、Hn と Jn）で、同時にTASKを持つのは一方だけ。v2で始めたtask_idはv2で完結させる。1つのtask_idの正本は1つの系統だけ。
- 1件の登録・開始・Report・完了確認・archiveは、それぞれ1commit。「登録済み」と言えるのは、ツールの `REGISTERED_ON_MAIN`、またはmainからの5項目の読み戻し一致だけ。答えが分からない時は成功扱いしない。
- K / C の受入はTASKの中（`### Kn acceptance` / `### Cn acceptance`）に書く。Kの「会社員AIラボ開発日記の更新判定」もそこに残す。
- 単独 `F` は、移行期間中も30枠を組で見る。`verify --root .agent_v2 --legacy-v2` と `verify --root .agent_v3_gh --naming GH` を読み取りで実行し、旧 `.agent/` はtree SHAが凍結時と同じことだけを確かめる。
- 詳細は `.agent_v3/CUTOVER_PLAN.md` と `.agent_v3/ROLLOUT_READINESS.md`。
```

### `.agent_v2/ORCHESTRATION.md` の改訂（文案）

- 「完全移行」の節の後に足す: 「V3の切り替え表に載ったGn / Hnに対応するFn / Jnには、新しいTASKを置かない。v2側の索引の行は `idle` のまま、`slot_use: V3 Gnへ移行済み（<切り替えcommit>）` と書く。」
- 「単独 F」の第一段階に足す: 「`verify --root .agent_v2 --legacy-v2` を読み取りで実行し、食い違いを一覧に入れる。直すのは各担当。」

### ChatGPT向けの手順書（新規、例: `.agent_v3/CHATGPT_V3.md`。文案の項目）

1. 登録・完了確認は、2の表の手順だけで行う。対象slotのTASKと索引を読み、計画したbaseを記録する。
2. Git Data APIで、TASKと索引を1つのcommitにする（blob → base_treeつきtree → 親1つのcommit → mainの更新、expected_sha＝base）。
3. mainの新しいcommitから5項目を読み戻す。一致した時だけ「登録済み」と報告する。
4. 答えが分からない時は、mainの今の値を読んで判定する。
   - 自分のcommit → 読み戻しへ進む。
   - base のまま → 計画し直してよい。
   - それ以外 → 同じslotが変わっていれば止める。
   - 拒否の理由を推測しない。
5. 1ファイルずつ書くAPI（Contents API）は使わない。安全チェックや方針による拒否は、言い換え・分割・再送をしない。
6. Kの受入では、AI Lab diaryの判定行をTASKの `### Kn acceptance` に書く。

## 4. pilot直前のチェックリスト（ChatGPT・ユーザー確認用）

pilotの対象・時期は、ユーザーまたは統括が明示的に決める。下の項目がすべて確認できるまで、`.agent_v3_gh/` をmainに作らない。

| # | 確認すること | 確かめ方 | 2026-10-17 の状態 |
| --- | --- | --- | --- |
| 1 | 旧G1〜G10 / H1〜H5に、未処理のK / Cが無い（全枠 `done / none`） | 旧TASKのヘッダー15件（索引ではなくTASK） | 0件（PR #248 の `PREFLIGHT_20261017.md`） |
| 2 | 旧 `.agent/` が凍結後に変わっていない | mainの `.agent` のtree SHAが `9a8d8e105c7e875d260e8f36db4271727379554d` と同じ | 同じ（main `cae7aa4e`・`109f6403`・`07776c44` で確認） |
| 3 | 最終snapshotが検証済みでmainにある | PR #252 のmerge、HISTORY_INDEXの1行、mainで `shasum -a 256 -c SHA256SUMS` と復元 | PR #252 はDraftで未merge（検証はPR上でPASS） |
| 4 | v2のF / Jで継続中のtask_idを、V3へ移さない | 対象の組（例: F10）のv2 TASKが `idle`、または `done` でarchive済み | F10はこのTASKの完了・archive待ち |
| 5 | 対象の枠と用途を、ユーザーが明示的に指定している | ユーザー・統括の明示の割当（G10はまだ割り当てていない予備枠） | 未指定（G10は提案だけ） |
| 6 | return_to と完了コード | 対象枠の `return_to` が戻る部屋の名前、完了コードが自枠（G10→K10） | 未設定（割当時に決める） |
| 7 | PRの依存と競合 | PR #229・#248・#252・この文書のPRは、追加するパスが重ならない。mergeの順番とHEADを固定する。各PRの直前のmainとの合成を確認する | 重なり無し。どれも未merge |
| 8 | deploy・Previewの副作用 | mainへの各commitでVercelがdeployを試みる。branchへのpushでも、PRの有無に関係なくVercelが動く。PRの付いたbranchではNetlifyのdeploy-previewも動く | 今はVercelの1日の上限で失敗している。扱い（許容するか、除外設定を別TASKにするか）は未決定 |
| 9 | 止める条件 | ツールの終了コードが0以外、読み戻しの不一致、答えが分からない、索引のdigestの不一致、`.agent` のtree SHAの変化、対象外の枠への書き込み | 決定済み（`CUTOVER_PLAN.md` の9） |
| 10 | 失敗した時の戻し方 | 実行中のtask_idはV3のまま完了・archiveする。ルールの切り替えを戻し、次の統括TASKはv2のF10へ置く。`.agent_v3_gh/` は消さず、理由を1行残す。旧 `.agent/` には書かないので、戻す作業は無い | 決定済み（`CUTOVER_PLAN.md` の9） |
| 11 | 対象外の枠に触らない | F2・J5の食い違い、F8のL8待ちなどは、それぞれの担当が直す | 未解消のまま（この準備では直していない） |
