# V3 pilot（1枠）の運用ルールとチェックリスト（候補・未承認）

F10 `orchestration-v3-gh-pilot-rule-integration-f10-20261018` で作った候補。

- 承認されるまで、`.agent_v3_gh/` の作成、G10へのTASK割当、pilotの書き込みはしない。
- ルールの正本は `PROJECT_RULES.md` の「V3（`.agent_v3_gh/`）の段階導入」（このPRでの追加案）。この文書は、その補足（手順・根拠・チェックリスト）。
- PR #248（`CUTOVER_PLAN.md`）・PR #253（`ROLLOUT_READINESS.md`）は2026-10-17時点の記録で、現行の正本としては使わない。必要な内容は、main の `.agent_v3/MIGRATION.md`・`SPEC.md` と、このPRに取り込んだ。

## 1. 今の状態（2026-10-18、main `8bab7f4a0cbce164038346c9d66d9e58b89eae46`）

- **V3のツール**: PR #229 はsquash merge済み（`6b78b6360f5a32bc8be2d4e73f677e4818d1d9ae`）。
  - mainの `scripts/agent_v3/`・`tests/agent_v3/`・`.agent_v3/` のtreeは、確認済みのPRのHEAD `3e757b83bd64c7de9c8ffd87989a2ddfb4d7976a` と同じ。
  - main上で `tests/agent_v3` を7回実行した。6回は 55/55 PASS、1回だけ1件が失敗した（エラー本文は残っていない）。その件は単独で3回PASS（`tasks/F10.md` のReport参照）。
- **旧 `.agent/`**: 凍結（tree SHA `9a8d8e105c7e875d260e8f36db4271727379554d`）。15枠すべて `done / none`、未処理のK / Cは0件。最終snapshotはPR #252（merge `383f82d4039daef26acaf0866750d05bef4bdddc`）で、mainで照合済み（33/33）。
- **v2**:
  - 未処理の完了コードはL8（F8）。
  - 継続中は F2・F7・J2（ready）と F10（このTASK）。
  - `verify --legacy-v2` の指摘は次の3つ（どれも担当へ返す。pilotの対象外）。
    - F2の正本と索引の食い違い。
    - J5の索引に残った値。
    - F5のヘッダーに `start_code` が無い。
- **G10 / F10**:
  - 旧G10は `done / none`。
  - v2のF10は、このTASKのL10受入とarchiveまで使用中。
  - G10は明示割当専用の予備枠で、まだ割り当てていない。

## 2. ChatGPT（GitHubコネクタ）の書き込み手順

根拠: 検証専用リポジトリ `anohi-memories/kabumori-v3-test`（private）の branch `v3-cas-check-20261017`。

- commit `b1b4b85c8d43bcec6767c876f77dfb930fd9d139` が、TASKと索引の2ファイルを1commitで追加している（GitHub APIで確認済み）。
- 「古いexpected_shaでは更新されず、最新なら成功する」はIssue #244 の記録だけ。拒否された更新は跡が残らないので、リポジトリの状態からは確かめられない。
- 競合時のGraphQLのエラーは一般的なエラーで、拒否の分類は未実証。

pilotでは、次のどちらかを使う（最初の登録の前に決める）。

| 方式 | 1commitに入れるもの | 「登録済み」と言える条件 | 注意 |
| --- | --- | --- | --- |
| A | 対象のTASK＋索引 | 5項目の読み戻しが一致し、索引の対象行も一致 | 索引は、派生の形式どおりに作る必要がある（対象行の5項目・owner・推薦モデル・`task_blob`（TASKのgit blob id）を差し替え、`source_digest` を計算し直す）。正確に計算できない時はBにする |
| B | 対象のTASKだけ | 5項目の読み戻しが一致 | 索引は書かない。「TASK登録済み・索引未再生成」と報告する。担当の最初のツール書き込み（開始）が、索引を全体から作り直す（理由 `TASK changed without the index` が結果に残る）。それまでの間、`verify` は索引の古さを示す（正本はTASK） |

どちらの場合も:

1. 書く前に、mainのrefと対象のTASK（Aは索引も）を読み、計画したbaseを記録する。
2. blob → base_treeつきのtree → 親が1つのcommit → mainの更新（expected_sha＝base、force無し）。
3. mainの新しいcommitから5項目を読み戻す。一致した時だけ報告する。
4. 答えが分からない時（GraphQLの一般エラー、時間切れ）は、mainの今の値を読んで判定する。
   - 自分のcommit → 3へ進む。
   - baseのまま → 適用されていない。計画し直してよい。
   - それ以外 → 同じ枠が変わっていれば止める。
   - 拒否の理由を推測しない。成功扱いにしない。
5. Contents API（1ファイルずつ）は使わない。拒否されたら、言い換え・分割・再送をしない。

## 3. 普段の登録の重さ

| 操作 | 読むもの | GitHub APIの回数 |
| --- | --- | --- |
| ツール（Claude / Codex）の1回の書き込み | 対象TASK（とReport）・索引・`tasks/` の一覧 | 15回（手元の偽のGitHubで実測。archiveは25回） |
| ChatGPTの方式B | ref・対象TASK | 約8回（ref・TASKの読み取り2、blob・tree・commit・ref更新4、読み戻し2。手順から数えた値で、実測ではない） |
| ChatGPTの方式A | ref・対象TASK・索引（必要なら一覧） | 約10〜11回（手順から数えた値で、実測ではない） |

- 読み取りの実測（2026-10-17、本物のGitHubをGETだけで、`.agent_v2` の15枠の実ファイルで計測）:
  - 差分更新のツールは 4 GET / 21,760 bytes / 1.6秒。これまでのV3は 16 GET / 102,735 bytes / 5.8秒。
  - 単独 `F` の第一段階は、30枠の全文を読むと 35 GET / 4,642,353 bytes。旧系統を凍結してtree SHAだけを確かめると 20 GET / 213,135 bytes。
  - どれも読み取りだけの値で、実際の登録の時間ではない。トークン量は計測していない。
- **全枠を調べるのは例外の時だけ**:
  - 索引のdigestや対象行の不一致。
  - 答えが分からない。
  - `CONFLICT_SAME_SLOT` / `PLAN_REFUSED`。
  - pilotの開始。
  - 単独 `F`。
- それ以外の登録・完了確認では、対象の枠だけを読む。大きな旧TASK / Reportの全文や、過去のReportは読まない。

## 4. Vercel / Netlify の副作用（確認済み）と選択肢

**確認済みの事実**:

- mainへのcommitのたびに、Vercelがadminプロジェクトの**本番（Production）deploy**を行う。管理ファイルだけのcommitでも、`[skip ci]` でも同じ。
  - 例: F10の管理commit `8bab7f4a` で、2026-10-18 09:27 JST にProductionへのdeployが完了した。
  - 1日の上限に達した日は "Deployment rate limited" で失敗する（2026-10-17 の多くのcommit）。
- branchへのpushでは、PRの有無に関係なくVercelが動く。上限内ならPreviewのdeployが完了する（PR #253 は 2026-10-17 20:43 JST、PR #229 は 22:24 JST）。
- Netlify（`shiny-kheer-77a154`）は、PRの付いたbranchでdeploy-previewを始めるが、admin以外の変更では毎回 canceled で終わっている。
- リポジトリに `vercel.json` は無い。Vercelのビルド条件は、Vercelのプロジェクト設定で決まっている。

**pilot（約6commit）での選択肢**（どれも、このTASKでは設定を変えていない）:

| 案 | 内容 | 良い点 | 注意 |
| --- | --- | --- | --- |
| 1. 許容 | 今のまま進める | 準備がいらない | commitのたびにadminの本番が再deployされる（中身はその時のmain）。1日の上限を使う |
| 2. Vercel側で除外 | Vercelのプロジェクト設定（ビルドを省く条件）で、`apps/admin` に変更が無いcommitのdeployを止める | 管理commitが本番に触れなくなる | Vercelの設定変更は本番の設定の変更なので、別TASKと承認が必要。設定の方法と効果は、その時にVercelの画面と文書で確かめる |
| 3. 時間帯を選ぶ | adminに未deployの変更が無いことを確かめてから、pilotのcommitを続けて行う | 設定を変えない | 再deployは起きる。確かめる手間がいる |

推奨は、2を別TASKで先に行うこと。難しければ、3の確認をしてから1にする。

## 5. pilot直前のチェックリスト（GO / NO_GO）

すべて「はい」でGO。ひとつでも「いいえ」ならNO_GO。

1. このPRの `PROJECT_RULES.md` / `.agent_v2/ORCHESTRATION.md` の改訂が承認され、mainに入っている（切り替え表に、pilotの枠だけを載せる）。
2. ユーザーが、pilotの枠（G10案）・用途・`return_to`・完了コード（K10）を明示している。
3. 対応するv2の枠（F10）に、継続中の `task_id` が無い（このTASKがL10で受け入れられ、archive済み）。
4. 旧 `.agent` のtree SHAが `9a8d8e105c7e875d260e8f36db4271727379554d` のまま。
5. 新しい `task_id` が、旧・v2・V3のどこにも無い。
6. ChatGPTの書き込み方式（A / B）が決まり、答えが分からない時の判定方法を共有している。
7. Vercelの扱い（4の案）が決まっている。
8. pilotの対象の組に、食い違い・`review_required`・未archiveの `done` が無い。他の枠の食い違い（F2・J5・F5）は、pilotの対象外なので妨げにならない。

## 6. 手順と中止

- 手順（各段階1commit、読み戻しが一致するまで次へ進まない）:
  1. 切り替え表にG10を載せる（ルールの改訂）。
  2. ツールで `init --root .agent_v3_gh --naming GH --allow-main` を実行する。
  3. ChatGPTがG10を登録する（方式AかB）。
  4. ユーザーが `G10` を送り、Claudeが開始する（ツール）。
  5. Claudeが作業し、Reportを書く（ツール）。
  6. ChatGPTが `K10` で受け入れる（`### K10 acceptance`、AI Lab diaryの判定を含む）。
  7. Claudeがarchiveする（ツール）。
  - 手元の使い捨てリポジトリでの予行は、2026-10-17に一通り通っている（PR #248 の `PREFLIGHT_20261017.md`）。
- 止める条件:
  - ツールの終了コードが0以外。
  - 読み戻しの不一致。
  - 答えが分からない。
  - 索引の作り直しが続く。
  - `.agent` のtree SHAの変化。
  - 表に無い枠への書き込み。
- 中止する時:
  1. 新しいTASKを置くのをやめる。
  2. 実行中の `task_id` はV3のまま完了・archiveする。
  3. 切り替え表からG10を外し、統括用途の次のTASKはv2のF10へ置く。
  4. `.agent_v3_gh/` は消さず、理由を1行残す。
  - 旧 `.agent/` には書かないので、戻す作業は無い。force pushや履歴の書き換えはしない。
