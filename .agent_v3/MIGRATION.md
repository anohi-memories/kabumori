# V3 への段階移行（提案・正式ルール未承認）

この文書は提案。現行ルールの変更、`.agent/` / `.agent_v2/` の切り替え・削除・改名、開始コードの意味の変更は、どれも行っていない。正式に適用するときは、承認の後に別TASKで行う。

2026-10-17（F10 `orchestration-v3-pr229-namespace-gate-f10-20261017`）に、PR #248（`CUTOVER_PLAN.md`）と PR #253（`ROLLOUT_READINESS.md`）の方針に揃えた。方針は「旧 `.agent/` を保存したまま、新しい `.agent_v3_gh/` へ、切り替え表で1枠ずつ移す」。

## 前提（2026-10-17 の確認時点）

- 旧 `.agent/` のG1〜G10 / H1〜H5は、15枠すべて `done / none`。未処理のK / Cは0件。
  - 2026-10-14 22:41 以降、変わっていない（`.agent` のtree SHA `9a8d8e105c7e875d260e8f36db4271727379554d`）。
- 旧 `.agent/` の最終snapshotは保存済み。
  - PR #252（merge `383f82d4039daef26acaf0866750d05bef4bdddc`）の `.agent_v2/archive/2026-10-17-legacy-agent-final-cae7aa4e/`。33ファイル、SHA256SUMS 33/33、復元確認済み。HISTORY_INDEXに登録済み。
  - PR #172（2026-10-13時点のsnapshot候補）は古く、今のmainと衝突するので使わない。保護対象として触れない。
- 新系統 `.agent_v2/` のF1〜F10 / J1〜J5は稼働中。

## 置き場所と名前

| 系統 | 枠と完了コード | 置き場所 | 移行期間中の扱い |
| --- | --- | --- | --- |
| 旧 | G1〜G10→K1〜K10、H1〜H5→C1〜C5 | `.agent/` | 凍結。新しいTASKを置かない。変更しない |
| v2 | F1〜F10→L1〜L10、J1〜J5→V1〜V5 | `.agent_v2/` | 稼働中。v2で始めたtask_idはv2で完結させる |
| V3 | G1〜G10→K1〜K10、H1〜H5→C1〜C5 | `.agent_v3_gh/`（`--naming GH`） | 切り替え表に載った枠だけ使う |

- G / H / K / C の意味（開始条件、1対1の完了確認、`return_to`、推薦モデル、H5は臨時実装専用、G5〜G10は明示割当専用、G7・G8・G9の部屋の専属）は変えない。変わるのはファイルの場所だけ。
- 旧 `.agent/ORCHESTRATION.md` と `.agent/CHATGPT_HANDOFF.md` には旧パスが固定で書かれている。これらは変更せず、PROJECT_RULES の切り替え表を優先する。

## 運用の決まり（提案）

1. **単独 `F`**
   - 移行期間中も30枠を見る。組（Gn と Fn、Hn と Jn）ごとに、Gn / Hn が旧（凍結）かV3かを切り替え表で決める。
   - 第一段階で、次を読み取りだけで実行する。
     - `verify --root .agent_v2 --legacy-v2`
     - `verify --root .agent_v3_gh --naming GH`
     - 旧 `.agent` のtree SHAが凍結時と同じことの確認
   - 食い違いは各担当へ返し、`F` 自身は直さない。
2. **完了コードの対応**: Gn→Kn、Hn→Cn（V3）、Fn→Ln、Jn→Vn（v2）の1対1。別の枠のコードで完了確認しない。V3のK / Cの受入は、TASKの中の `### Kn acceptance` / `### Cn acceptance` に書く。Kの「会社員AIラボ開発日記の更新判定」もそこに書く。
3. **途中移管の禁止**: 旧・v2で始めたtask_idを、途中でV3へ移さない。V3へ移すのは、その用途の次の新規TASKから。
4. **同じ名前の二重割当を避ける**:
   - 用途の組で、同時にTASKを持つのは一方だけ。
   - 切り替え表に無い枠へ、V3のTASKを置かない。
   - Gn / Hn を切り替えた後は、対応するFn / Jnに新しいTASKを置かない（v2側は `idle` のまま「V3 Gnへ移行済み」と記録する）。
   - 新しいtask_idは、旧・v2・V3のどこにも無いことを確かめてから置く。1つのtask_idの正本は、1つの系統だけ。
5. **return_to**: 割当の時に、ユーザーが戻る部屋の名前（slot番号だけにしない）と、自枠の完了コードを確定する。分からなければ割り当てない（「返却先未確定 — ChatGPT確認待ち」）。
6. **archive（追記のみ）**:
   - 完了したslotは、`done` → archive → `idle` の順にする。archiveしていない `done` のslotには、新しいtask_idを置けない。
   - 既存のarchiveは書き換えない。足りないファイルは、新しいファイルとして足す。
7. **CASと読み戻し**:
   - 1件（登録・開始・Report・完了・archive）＝1commit。fast-forwardだけで、force push・`force:true` は使わない。
   - 「登録済み」と言えるのは、ツールの `REGISTERED_ON_MAIN`、またはmainからの5項目（task_id / status / next_owner / return_to / completion_code）の読み戻し一致の時だけ。
   - 答えが分からない時（GraphQLの一般エラー、時間切れ、応答なし）は成功扱いしない。mainの今の値を読んで判定する（`SPEC.md` の3と9）。
8. **索引の差分更新**: 普段の書き込みでは、対象slotのTASK・索引・`tasks/` の一覧1回だけを読む（`SPEC.md` の2）。
   - 読み取りの実測（2026-10-17、本物のGitHubをGETだけで、`.agent_v2` の15枠の実ファイルで計測）: 4 GET / 21,760 bytes / 1.6秒。これまでのV3は 16 GET / 102,735 bytes / 5.8秒だった。
   - これは読み取りだけの時間で、実際の登録（書き込みと読み戻しを含む）にかかる時間ではない。
9. **deploy・Previewの副作用（確認済み）**:
   - mainへのcommitには、内容に関係なくVercelの状態が付く（`[skip ci]` でも付く）。
   - branchへのpushでは、PRの有無に関係なくVercelが動く。Preview環境へのdeployが完了した例がある（PR #253 は 2026-10-17 20:43 JST、PR #229 は同 22:24 JST、どちらもadminプロジェクトのPreview）。
   - PRの付いたbranchでは、Netlifyのdeploy-previewも動く。
   - pilotの前に、許容するか、Vercelの除外設定を別TASKにするかを決める。

## 段階

| 段階 | 内容 | 状態（2026-10-17） |
| --- | --- | --- |
| 0 | V3の仕様・ツール・隔離テスト・調査を独立パスに置く（このPR） | 済（Draft、未merge） |
| 1 | 確認とレビュー（transaction・CAS・読み戻し・github backend、N1/N2、索引の差分更新） | N1/N2は独立再レビューPASS（Issue #244・HISTORY_INDEXの記録）。差分更新はL10済み。独立レビューを足すかはChatGPTが判断 |
| 2 | 影運用: 単独 `F` の時に `verify --legacy-v2` を読み取りだけで実行し、食い違いを担当へ知らせる | 提案 |
| 3 | 正式適用TASK: `.agent_v3_gh/` を作り、G / H / K / C の名前で使う。PROJECT_RULES・v2 ORCHESTRATION・ChatGPT向けの手順書を改訂する（AGENTS はH枠を切り替える時に改訂） | 未承認 |
| 4 | 枠ごとの移行: 承認された1枠（候補G10。まだ割り当てていない予備枠なので明示承認が必要）でpilotを行う。合格後に1枠ずつ広げる | 未承認 |
| 5 | v2の全slotが完了・archive済みになったら、v2の最終snapshotを取ってarchiveへ移す。単独 `F` は15枠の統括に戻る | 別TASK |

## GO 条件

### PR #229 のmainへのmerge（ツールと文書を置くだけ。V3の採用ではない）

1. ユーザーまたはChatGPTが、merge自体を明示的に承認している。
2. merge直前のmainとの合成で、衝突が無く、`tests/agent_v3` が全件PASSし、変更がこのPRの追加ファイルだけである。HEADが固定した値から変わっていれば、変わった分の焦点レビューを先に行う。
3. この文書と `SPEC.md` の置き場所の記述が、`.agent_v3_gh/` の案に揃っている。
4. mergeのcommitでもVercelがdeployを試みることを承知している。

### pilot（段階4）の前

1. ルール文書の改訂（pilotの枠の分だけ）が承認され、反映されている。
2. pilotの枠と用途を、ユーザーまたは統括が明示的に指定している。`return_to` と完了コードが確定している。
3. その組のv2側（例: F10）に継続中のtask_idが無い（`idle`、または `done` でarchive済み）。
4. 旧 `.agent` のtree SHAが凍結時と同じ。最終snapshotはmainで照合済み（PR #252）。
5. ChatGPTの書き込み経路（Git Data APIでTASKと索引を1commitにし、5項目を読み戻す）を、最初の登録で確かめる。答えが分からない時の判定方法を、事前に共有している。
6. Vercel / Netlify の副作用の扱いが決まっている。

## NO_GO 条件（ひとつでも当てはまれば移さない）

- 移す対象の組に、未解消の食い違い、`review_required`、未archiveの `done`、継続中のtask_idがある。
- 開始コードや `return_to` が曖昧、または同じtask_idを2つの系統で書く必要がある。
- 移行経路の書き込みで、原因不明の拒否（`REFUSED_STOPPED`）が出ていて、まだ説明できていない。
- 旧 `.agent` のtree SHAが変わっている（最終snapshotが古くなった）。

## 未確認の理由（branch上のCAS）

専用ref（`refs/agent-v3-live-test/...`）では、サーバー側のfast-forward検査が効かず、CASの実機確認にならなかった（`SPEC.md` の8）。branchで確かめると、pushのたびにVercelが動く（PRの無いbranchでも動くことを確認済み）。次のどれかで、承認を得てから確かめる。

- 連携の無い使い捨てのリポジトリで確かめる（ChatGPTの検証用リポジトリ `kabumori-v3-test` の試験は、その一例）。
- Vercelの動作を許容したうえで、専用branchを1本だけ作って確かめる（push 2回程度）。
- pilotの最初の登録（main）を、最初の実地確認として扱う（答えが分からない時の判定を必ず行う）。

## V3導入までの暫定策（v2への提案。適用は別TASK）

- 割当・完了のたびに、書いた側がTASKと索引の両方をmainから読み戻す。一致しなければ「登録未完了」と報告する（「登録済み」と言わない）。
- slotのReport commitでは、自分のslotの索引行も同じcommitで更新する（今の分担ルールの変更が必要）。
- 単独 `F` の第一段階で `verify --legacy-v2` を実行し、食い違いを一覧に入れる。
