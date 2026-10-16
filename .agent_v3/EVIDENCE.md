# V3 調査：TASK登録が不整合になる原因（2026-10-16）

F10 `orchestration-v3-reliable-task-registration-f10-20261016` の調査結果。原因を「確認済み」「仮説」「未検証」に分けて記録する。プラットフォームの安全チェックは無効化も迂回もしていない。

## 調べたもの

- mainのfirst-parent履歴を1commitずつ再生した。各commitで、15枠のTASK先頭ヘッダー（`task_id` / `status` / `next_owner`）とACTIVE索引の値を比べ、食い違いが出てから消えるまでを1つの「食い違い区間」として数えた（読み取りのみ。再現用スクリプトは `evidence/mismatch_scan.py`）。
  - 新系統 v2: PR #155 のmerge `4e80c79d`（10/12 23:12）から `017583cc4040706bc9d3249a9e6ba9476f827723`（10/16 09:51）まで。
  - 旧系統 G/H: G5追加 `619a7526`（10/01）から `4e80c79d` まで。旧索引は書式の揺れが大きく、件数は概数として扱う。
- 現在の食い違いは、`017583cc` 時点の全15枠について、`task_id` / `status` / `next_owner` / `return_to` / `completion_code` を、項目の並び順に依存しない方法で比べた。
- F9のSHA256SUMSの件は、記録したcommitの本文と、archiveディレクトリのcommit履歴を照合した。
- 保護対象のDraft PR #172（Codexの最終移行前snapshot）は、本文とファイル一覧だけを読んだ。変更はしていない。

## 確認済み（証拠あり）

### 1. 登録の書き込みは1ファイルずつ別commitになっている

| 期間 | first-parent commit | 1ファイルだけのcommit | 複数ファイルのcommit |
| --- | ---: | ---: | ---: |
| v2（10/12〜10/16） | 754 | 671（89%） | 68 |
| 旧G/H（10/01〜10/12） | 1511 | 1302（86%） | 179 |

- 割当では「TASKで1commit → 索引で1commit」が数秒〜十数秒おきに並ぶ。
  - F10割当: `9771057b`（TASK、09:22:35）→ `12689f48`（索引、09:22:49）
  - F8: `eda46c7c`（TASK、09:21:31）→ `c96ec4e3`（索引、09:21:38）
- 同じcommitメッセージが3回続く例もある（`7468f7e2` / `980c57e9` / `098101f3`「K2 accept Phase2c source…」、いずれも10/12 15:15）。
- 一方、Claude側のReportは、TASKとReportを1commitで書いている（例: `045696e8`、`b90d9a56` はいずれも2ファイル）。
- この構造では、1件の登録が2〜4回の別々の書き込みになる。途中で止まれば、片方だけが更新された状態がmainに残る。

### 2. 「片方だけ更新」は毎日起きており、ときに長時間残る

| | 食い違い区間 | 2分以内に解消 | 2〜10分 | 10〜60分 | 60分超 | 未解消 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| v2 | 143 | 129 | 5 | 1 | 7 | 1 |
| 旧G/H（概数） | 384 | 230 | 46 | 38 | 69 | 1 |

- 2分以内に消える区間の大半は、上の「TASK → 索引」の2回書きの間にできるもの。
- v2で長く残った例:

| slot | 開始commit（変わったファイル） | 解消commit | 時間 | 内容 |
| --- | --- | --- | ---: | --- |
| F6 | `9cfdbec8`（TASKのみ） | `c062e806`（索引） | 約1419分 | 索引のtask_idが前のTASKのまま |
| F1 | `ec59fcd0`（TASKのみ） | `018a54e5`「sync F1 active metadata」 | 約689分 | 索引が前のTASKを done のまま表示 |
| F8 | `e4b2831c`（TASKのみ） | `9e5da10a`「Reconcile F8 F9 L8 L9」 | 約339分 | TASKは done、索引は ready |
| F8 | `8829568b` | `f4d5e13b`「reconcile completed F8 F9」 | 約142分 | 同上 |
| F8 | `b7d4f754` | `e870fe4e` | 約108分 | 同上 |
| F8 | `b830e7bc` | `f215b4c3` | 約102分 | 同上 |
| F8 | `22e725fa`（索引のみ） | `c96ec4e3`（索引） | 約69分 | 索引だけが review_required に変わった |
| J2 | `d459ffba`（TASKのみ） | `670a2c7a`「align ACTIVE_TASK with already registered…」 | 約14分 | 索引のtask_idが前のTASKのまま |

- 解消commitの多くは、後から気づいて直した「sync / align / reconcile」commit。登録した時点で、両方そろったことを確かめる手順が無かった。
- 旧G/Hでも同じ型がある（例: `9c1518e0` からのG4 約3287分、`1d30eaab` からのH2 約2098分、`0e907cfc` からのG1 約1419分）。

### 3. `017583cc` 時点で残っている食い違い

- **F2**: TASKは `ready / claude`、索引は `review_required / chatgpt`。`22e725fa`「state(G1): accept L2 L8 scoped fixes…」で索引だけが変わってから続いている。どちらが意図した状態かは、この調査からは判断できない（F2・索引の担当側の確認待ち）。
- **J5**: TASKの `return_to` は none、索引には前の割当の `return_to` が残っている。

どちらも、このTASKでは直していない（他slotの状態を変更しないため）。

### 4. ルールにも原因がある

- 旧・新どちらのORCHESTRATIONも、「slotは自分のTASK / Reportだけを更新し、索引はChatGPTが更新する」という分担になっている。TASKと索引を同時に更新する仕組みも、登録後に両方を読み戻して確かめる手順も無い。
- そのため、slotのReport commit（F8の例）は意図どおり索引を変えず、L判定のあと索引が直されるまで食い違いが続く。

### 5. F9のSHA256SUMSが書き込めなかった件

- `afde6dea`（10/13 16:07:05）に、ChatGPTが次の記録を残している: 「SHA256SUMS write hit OpenAI safety block; archive process incomplete and F9 reallocation is withheld」。
- 該当archiveは、写し `1229dc4f`（16:05:06）、MANIFEST.json `8aa38a3f`（16:05:10）、MANIFEST.md `41bdfdd5`（16:05:14）の3ファイルだけが先に入った。SHA256SUMSは `1ba468ec`（18:07:32）で後から追加されている。約2時間、4ファイル中3ファイルだけの状態だった。
- 同じ日の他のF9 archiveのSHA256SUMSは通っている（`46ad37b6`、`de1d48a8`、`57bd0ac9`）。2時間後の再試行も成功している（`7b6ebaa1` に「Prior F9 SHA256SUMS blockage retried successfully」）。
- ChatGPTは、保存が終わるまでF9の再割当を保留した（fail-closedに動いた）。

## 仮説（証拠が足りない）

- **H1（書き込み経路）**: ChatGPTのGitHub連携が、ファイル単位のContents API（1ファイル＝1commit）で書いている。1ファイル1commitとメッセージの使い回しはこれと合うが、要求ログが無く、両経路のcommitがどちらも署名なし（unsigned）のため確定できない。
- **H2（2回目が抜ける理由）**: 会話の中断、ツール呼び出し回数の上限、ユーザーによる停止、単純な書き忘れのいずれか。commit履歴からは区別できない。
- **H3（競合）**: mainには1〜2分おきに書き込みが入る。Contents APIの古いsha（409）や他の書き込みとの競合で、2回目が失敗した可能性。409等の記録は無い。
- **H4（安全ブロック）**: SHA256SUMSの中身（64桁の16進数とパスの並び）が、秘密情報に似たものと判定された可能性。ただし同種のファイルは他では通っており、内容だけで説明はつかない。原因は未確定。

## 未検証

- 失敗時の実際のエラー文・HTTPコード（409 / 422 / 403）と、使われたAPI。リポジトリに記録が無い。
- ChatGPTのGitHub連携が、Git Data API（blob → tree → commit → ref更新）で複数ファイルを1commitにできるか。
- Claude側の安全装置による拒否の有無。この期間のClaude slotのcommitに拒否の記録は見当たらないが、拒否は記録されない可能性もあり、「無かった」とは断定しない。

## 方式の比較

| 項目 | 旧G方式（`.agent/`） | v2（`.agent_v2/`） | V3候補（`.agent_v3/`） |
| --- | --- | --- | --- |
| TASKの中身 | 過去の全TASKを連結（数百KB） | 現在の作業だけ | 現在の作業だけ（v2を継承） |
| 状態の正本 | TASKヘッダーと索引の両方を手で更新 | 同左 | **TASKヘッダーだけ**。索引は自動生成した派生物 |
| 1件の登録 | 2〜4回の別commit | 同左 | **1commit**（TASK・索引・Report・archive・HISTORYをまとめる） |
| 競合の扱い | 無し（後勝ち） | 無し | base SHAとのCAS（fast-forwardのみ）、同一slotの競合は拒否 |
| 成功の判定 | 書いた側の自己申告 | 同左 | **mainから読み戻して一致した時だけ** `REGISTERED_ON_MAIN` |
| 索引の古さ | 気づいた人が手で直す | 同左 | 生成元のdigestで検出し、次の書き込みで自動的に作り直す |
| archive | 1ファイルずつ（3/4で止まりうる） | 同左 | 1commit。止まれば何も書かれない |
| 拒否されたとき | 記録はまちまち | 記録して保留（F9） | `REFUSED_STOPPED` で停止・記録。言い換え・分割・再エンコードはしない |
