# V3 正式導入の移行仕様（候補・未適用）

Issue #244 の段階1〜3の準備として作った**候補**。現行ルール（`PROJECT_RULES.md`、`.agent/ORCHESTRATION.md`、`.agent_v2/ORCHESTRATION.md`、`AGENTS.md`、`CLAUDE.md`）と稼働中のTASKは変えていない。

- 承認されたら、ルール文書の改訂・最終snapshot・pilotを、それぞれ別TASKで行う。
- 調査の根拠は `PREFLIGHT_20261017.md`。
- V3の仕組み（正本・1commit・CAS・読み戻し）は、PR #229 の `SPEC.md` を前提にする。

PR #229 の `MIGRATION.md` との関係: 段階3の「V3の置き場所＝旧 `.agent/` をarchiveへ移した後の `.agent/`」と `SPEC.md` の1の「`<root>` の候補: 将来の `.agent/`」は、この文書の2で**置き換える**提案とする。旧 `.agent/` のパスは上書きも改名もしない。

## 1. 判定の一覧（2026-10-17 時点）

| ゲート | 判定 | 理由（詳細は `PREFLIGHT_20261017.md`） |
| --- | --- | --- |
| 30枠の整合 | **一括移行はNO_GO** | F2の正本と索引の不一致、F8のL8待ち、継続中のF2/F4〜F7/F10、未archiveのdone 6枠。1枠のpilotは、対象の組（G10/F10）が条件を満たせば妨げない |
| 旧 `.agent/` の履歴ゲート | **NO_GO** | PR #172 のsnapshotは正確だが古い（5ファイルが変化、12 commit）。今のmainとも衝突する。旧G10の今のTASKをバイト一致で持つ写しはmainに無い |
| PR #229 のmain merge | **NO_GO（承認なし）**。技術的な阻害は無い | 今のmainとの合成で衝突なし・45/45 PASS。追加14ファイルだけで既存の運用には影響しない。merge GOの条件は7 |
| 1枠のpilot（G10） | **NO_GO（前提が未充足）** | F10の本TASKが未完了・未archive、最終snapshot未作成、ルール文案未承認、mainへのcommitごとのVercel試行の扱いが未決定 |
| 完全移行（`.agent_v2/` の廃止、旧 `.agent/` の扱いの確定） | **対象外**（別TASK） | — |

## 2. 名前と置き場所

- **V3の正式な置き場所（root）は新しい `.agent_v3_gh/` にする。**
  - 旧 `.agent/` は凍結した履歴として、パスも中身もそのまま残す（上書き・改名・削除・短縮をしない）。
  - `.agent_v3/` は仕様・調査の文書置き場のまま使う。V3ツールのinitは、ファイルが1つでもあるrootを拒否するので、文書と運用データを同じrootに置けない。
  - `.agent_v3_gh` はツールのroot制限（`^\.agent_v3[A-Za-z0-9_-]*$`）を満たす。どのrefにもまだ存在しない。
- 配置は、ツールの `catalog(root, "GH")` のとおり。

| 枠 | TASK（先頭ヘッダーが唯一の正本） | Report | 完了コード |
| --- | --- | --- | --- |
| G1〜G10（Claude） | `.agent_v3_gh/tasks/G1.md`〜`G10.md` | TASK末尾の `## Report` | K1〜K10（1対1） |
| H1〜H5（Codex） | `.agent_v3_gh/tasks/H1.md`〜`H5.md` | `.agent_v3_gh/reports/H1.md`〜`H5.md` | C1〜C5（1対1） |
| 索引 | `.agent_v3_gh/ACTIVE_TASK.md`（ツールが全TASKヘッダーから生成。手で編集しない） | — | — |
| 履歴 | `.agent_v3_gh/HISTORY_INDEX.md`、`.agent_v3_gh/archive/<date>-<slot>-<task_id>/` | — | — |

- G/H/K/C の意味（開始条件、1対1の完了確認、`return_to`、推薦モデル、H5は臨時実装専用、G5〜G10は明示割当専用、G7・G8・G9の部屋の専属）は変えない。変わるのはファイルの場所だけ。

## 3. 移行期間の3系統

| 系統 | 枠 | 移行期間中の扱い |
| --- | --- | --- |
| 旧 `.agent/` | G1〜G10 / H1〜H5 | **凍結**。15枠すべて `done`。新しいTASKを置かない。読むのは履歴の確認と、凍結後に変わっていないことの確認だけ |
| v2 `.agent_v2/` | F1〜F10 / J1〜J5 | 稼働中。v2で始めた `task_id` はv2で完結させる |
| V3 `.agent_v3_gh/` | G1〜G10 / H1〜H5 | 切り替えた枠だけ使う |

- **枠ごとの切り替え**: 用途の組（Gn と Fn、Hn と Jn）ごとに、同時に動く系統は1つだけにする。
  - 切り替えの条件:
    - v2側（Fn / Jn）に継続中のtask_idが無い（`idle`、または `done` でarchive済み）。
    - 旧側（Gn / Hn）が凍結済みで、最終snapshotに入っている。
  - 切り替え後、その用途の次の新規TASKは V3 の Gn / Hn に置く。v2のFn / Jnには、以後TASKを置かない（v2側は `idle` のまま「V3 Gnへ移行済み」と記録する。記録は切り替えTASKで行う）。
  - これは、v2の「完全移行で F→G、J→H、L→K、V→C に呼び名を戻す」計画を、枠ごとに少しずつ実現するもの。
- **開始コードの解決**: `Gn` / `Hn` / `Kn` / `Cn` が指すのは、PROJECT_RULES の**切り替え表**に載った枠ならV3、載っていなければ旧 `.agent/`（凍結済みで全枠 `done` なので、開始されない）。表に無い枠へV3のTASKを置かない。
- 1つの `task_id` の正本は、3系統のどれか1つだけ。開始済みのtask_idは、途中で別の系統へ移さない。

## 4. 旧 `.agent/` の凍結と最終snapshot（履歴ゲート）

1. 凍結commitを決める。旧 `.agent/` は 2026-10-14 22:41（`78c9b9115ae5aade57876fc4fc662e4cc35b7797`）以降変わっていない。切り替えTASKを始める時点のmainを凍結commitとし、その時点の旧 `.agent/` 全28ファイルと共有ルール5ファイルを対象にする。
2. 新しいディレクトリに、追記だけで保存する。例: `.agent_v2/archive/<YYYY-MM-DD>-legacy-agent-final-<凍結commitの先頭8桁>/`。保存するのは原本バイトの写し、`MANIFEST.json`（original_path / archive_path / size / SHA256 / git blob / 元commit）、`SHA256SUMS`、`RESTORE.md`。
3. 1commitで書き、GitHubから読み戻す。照合する項目は次のとおり。
   - 全ファイルのサイズ・SHA256・git blob が元commitと一致する。
   - `shasum -a 256 -c SHA256SUMS` が通る。
   - 空のディレクトリへ復元して、バイト一致する。
4. PR #172 は保護対象として触れない（merge・更新・closeをしない）。古いsnapshotとして残る。扱いはChatGPTとユーザーが別に決める。
5. 凍結後に旧 `.agent/` のどれかが変わっていたら、snapshotを取り直す。それまで切り替えない。

## 5. 正本と派生、Kの記録

- V3では、TASK先頭のヘッダーが唯一の正本。索引はツールが毎回作り直す派生物で、食い違えばTASKが正しい。
- **K / C の完了確認の記録はTASKの中に書く**（`## Report` の後ろに `### Kn acceptance` / `### Cn acceptance` の節を足す）。status を `review_required → done` にするのと同じcommitで行う。
  - 理由: 旧 `.agent/CURRENT_STATE.md` は凍結するので、Kの必須項目「会社員AIラボ開発日記の更新判定」（`- AI Lab diary: 候補あり — …` / `- AI Lab diary: 記録不要 — …`）の書き先が無くなる。TASKに書けば、archiveにもそのまま残る。
  - 日記の正本（`supabase/functions/_shared/brand/ai_lab_dev_diary_context.md`）とworkflowの扱いは今のまま変えない。
- V3側の CURRENT_STATE は、pilotでは作らない。移行期間中のプロジェクト全体の現状は、今までどおり v2 の `CURRENT_STATE.md` に書く。ただし、V3の登録commitには含めない（V3のcommitは `.agent_v3_gh/` の中だけ）。

## 6. 書き手ごとの登録方法と成功の条件

| 書き手 | 方法 | 「登録済み」と言える条件 |
| --- | --- | --- |
| Claude Code / Codex（シェルあり） | PR #229 の `scripts/agent_v3/cli.ts`（git backend、`--naming GH`）を専用worktreeで実行する。先に `show` で `task_sha256` などを読み、`--expect-sha256` を渡す。mainへは `--allow-main` の時だけ書く | 終了コード0（`REGISTERED_ON_MAIN`）。ツールが読み戻しまで行う |
| ChatGPT（GitHubコネクタ、Git Data API） | blob → base_treeつきtree → 親が1つのcommit → main の更新（expected_sha＝計画したbase）。TASKと索引を同じcommitに入れる | mainの新しいcommitから、そのslotのTASKヘッダーの5項目（task_id / status / next_owner / return_to / completion_code）を読み戻して一致した時だけ |

- 索引のdigest（`source_digest`）の計算は、ChatGPTには負担が大きい。そこで、ChatGPTが書いた直後の開始時に、担当（Claude / Codex）が `verify --naming GH` を読み取りで実行する。
  - 索引の食い違いだけなら、担当の最初のツール書き込み（`ready → in_progress`）が索引を作り直す（ツールは毎回、索引も同じcommitで再生成する）。
  - TASK正本そのものがおかしい場合は、開始せずにChatGPTへ返す。
- **答えが分からない時（GraphQLの一般エラー、時間切れ、応答なし）は成功扱いしない。** mainの現在値を読んで判定する。
  - 自分のcommitになっている → 5項目を読み戻して確認する。
  - 計画したbaseのまま → 適用されていない。最新のmainで計画し直してよい。ただし、そのslotが他の人に変えられていれば `CONFLICT_SAME_SLOT` として止める。
  - それ以外 → 別の書き込みが先に入った。最新のmainで計画し直す。
  - 拒否の理由をエラー文から推測しない（ChatGPT経路の拒否の分類は未実証）。
- ツールの `--naming` は全コマンドに効き、既定は `FJ`（PR #229 の `cli.ts` 71行目）。`.agent_v3_gh` を扱うコマンド（init / show / write / archive / verify）には、必ず `--naming GH` を付ける。
  - 付け忘れると、F / J の枠（`tasks/F1.md` など）として扱う。手元の予行では、`verify` は16件の指摘で止まり、`write --slot G10` は `unknown slot G10` で拒否された（`PREFLIGHT_20261017.md` の6）。
  - `FJ` 以外の値は、打ち間違いも含めてすべて GH として扱われる。
- 1ファイルずつしか書けない経路（Contents API）は、V3の登録に使わない。
- 安全チェックや方針による拒否は、言い換え・分割・再送をせずに止めて報告する（PR #229 のSPEC 6）。

## 7. PR #229 のmainへのmerge（事前GO / NO_GO）

PR #229 のmergeは、ツールと文書をmainに置くだけ。V3の採用（開始コードの切り替え）とは別の操作とする。次をすべて満たした時だけGO。

1. ユーザーまたはChatGPTが、merge自体を明示的に承認している（2026-10-17 時点で無い → NO_GO）。
2. mergeする直前のmainとの合成で、衝突が無く、`tests/agent_v3` が全件PASSし、変更が14ファイルの追加だけである。PR HEADが `2c810122250e885ccbc3ae3a50351b78070ae69c` から変わっていれば、変わった分の焦点レビューを先に行う。
3. この文書の2（置き場所を `.agent_v3_gh/` にする）を採るなら、PR #229 の `SPEC.md` 1と `MIGRATION.md` の段階3は古い案になる。merge前に直すか、「この文書で置き換え済み」と承認時に明記する。
4. mergeのcommitでもVercelがdeployを試みることを承知している（7の調査）。

## 8. 1枠のpilot（候補: V3 の G10）

### 候補の選び方と結論

- 条件:
  - 旧側が `done` で、K / C 待ちと後続作業が無い。
  - v2側に継続中のtask_idが無い（または、終わり次第archiveできる）。
  - 用途が管理・文書だけで、製品コードや本番に触れない。
  - 返却先の部屋がはっきりしている。
- **第一候補: G10（このチャットの統括用途）。**
  - 旧G10は `done / none`、K10待ちは無い。
  - v2のF10は、このTASKが完了・archiveされれば空く。
  - 用途は管理・文書だけ。返却先は「かぶモリ30枠統括のちゃ（このチャット）」。
  - pilotの最初のTASKは、V3自身の読み取り検査など、製品・本番に触れないものにする。
- 予備候補: H3（v2のJ3が `idle`、旧H3は `done / none`）。Codexの別Reportファイルの経路を試せる。ただし、ふだんの用途（製品のレビュー）に触れるので、G10の後にする。
- 今は移せない枠:
  - F2（不一致）、F8（L8待ち）。
  - F4〜F7・F10（継続中）。
  - F1・F3・F9・J1・J2・J4（未archive）。
  - G2・H5（旧側に後続作業が残る。続ける場合は新しいtask_idにして、どの系統に置くか決める）。
  - J5（臨時実装の優先枠。移行の対象にしない）。

### 前提（すべて満たしてから始める）

| # | 前提 | 今の状態 |
| --- | --- | --- |
| P1 | v2のF10の今のTASKがL10で受け入れられ、`done` → archive（SHA256・復元・HISTORY_INDEX）まで済んでいる。pilotの間、F10にはTASKを置かない | 未（このTASKの完了後） |
| P2 | 旧G10が `done`、K10待ちが無い | 済（2026-10-17） |
| P3 | 4の最終snapshotが、mainで読み戻し・照合済み | 未 |
| P4 | ルール文案（10）のうち、G10だけを切り替える分が承認されている | 未 |
| P5 | 使うツールのcommitが決まっている（PR #229 の `2c810122`、またはmerge後のmain） | 未決定 |
| P6 | mainへのcommitごとにVercelのdeploy試行が起きる（pilotで約6回）ことを承知している。または、別TASKでVercel側の除外設定をしてある | 未決定 |
| P7 | 11のチェックリストを、ChatGPTとユーザーが確認した | 未 |

### 手順（各段階は1commit。どれも読み戻しが一致するまで次へ進まない）

| 段階 | 誰が | 何をするか | 成功の条件 |
| --- | --- | --- | --- |
| S1 | Claude（ツール） | `init --root .agent_v3_gh --naming GH --allow-main`。15枠のidleテンプレート＋索引＋HISTORY_INDEXを1commitで作る | `REGISTERED_ON_MAIN`、続けて `verify --root .agent_v3_gh --naming GH` が0件 |
| S2 | ChatGPT（コネクタ） | G10へ新しいtask_idを登録（`idle → ready`）。TASKと索引を1commit | 6の5項目の読み戻しが一致 |
| S3 | ユーザー → Claude | ユーザーが `G10` を送る。Claudeは `verify` を読み取りで実行し、`ready → in_progress` をツールで書く | `REGISTERED_ON_MAIN` |
| S4 | Claude（ツール） | 作業後、Reportと `in_progress → review_required` を1commit | `REGISTERED_ON_MAIN`。ユーザーに `K10` を案内 |
| S5 | ChatGPT（コネクタ） | `K10` の受入（`### K10 acceptance`、AI Lab diaryの判定を含む）と `review_required → done` を1commit | 5項目の読み戻しが一致 |
| S6 | Claude（ツール） | `archive`（done → idle、archive一式、HISTORY_INDEXの1行）を1commit | `REGISTERED_ON_MAIN`、archiveの照合が一致 |

この S1〜S6 は、手元だけの使い捨てリポジトリで一通り予行した（すべて `REGISTERED_ON_MAIN`、各 `verify` 0件。`PREFLIGHT_20261017.md` の6）。ただし、S2・S5 もCLIで代わりに実行したので、ChatGPTのコネクタ経由の書き込みと、GitHubのbranch上でのCASは、pilot本番が最初の実地確認になる。

pilotの合格条件:

- S1〜S6のすべてで登録が確認できた。
- 各段階の後の `verify` が0件だった。
- 旧 `.agent/` と、承認したF10の記録以外の `.agent_v2/` が変わっていない。
- 同じtask_idが他の系統に無い。

合格後の他枠への拡大は、別TASKで1枠ずつ行う。

## 9. 失敗時の復旧とロールバック

- **ツールが止まった時**（`REFUSED_STOPPED` / `TRANSPORT_FAILED_STOPPED` / `INTEGRITY_FAILED_STOPPED` / `PARTIAL_DETECTED` / `UNPLANNED_CHANGE_DETECTED` など）
  - ツールは再試行しない。結果をそのまま記録して止め、ChatGPT / ユーザーが判断する。
  - 1commitなので、公開前に止まればmainには何も残らない。
- **`PUBLISHED_UNVERIFIED`**: 同じcommitを送り直さない。mainを読み、6の「答えが分からない時」と同じ方法で判定する。
- **ChatGPTの書き込みで索引だけが古い**: 正本はTASK。次のツール書き込みで索引を作り直す。単独 `F` は「索引は古い（正本はTASK）」と表示する。
- **後から別の正しい変更が入った**（`SUPERSEDED_AFTER_PUBLISH`）: 壊れた書き込みとは区別する。最新の状態から続ける。
- **pilotを中止する時**（ChatGPT / ユーザーが判断）
  1. V3のG10へ新しいTASKを置くのをやめる。
  2. 実行中のtask_idがあれば、V3のまま完了させる（途中で他の系統へ移さない）。完了後はV3でarchiveする。
  3. ルール文書のG10の切り替えを戻す（別TASK）。統括用途の次のTASKは、v2のF10へ置く。
  4. `.agent_v3_gh/` のファイルは消さない。中止の理由をV3のHISTORY_INDEXと、v2のCURRENT_STATEに1行ずつ残す。
  5. 旧 `.agent/` には一度も書かないので、旧側に戻す作業は無い。
- **V3のファイルが壊れた時**: force pushや履歴の書き換えはしない。書き込みを止め、正しい内容を新しいcommitで戻す（`git revert` 相当）。archiveは消さない。

## 10. 必要なルール修正（文案。適用は承認後の別TASK）

| 文書 | 修正の内容 |
| --- | --- |
| `PROJECT_RULES.md` | 新しい節「V3（`.agent_v3_gh/`）の段階導入」。<br>・切り替え表（枠・切り替えcommit・v2側の扱い）<br>・開始コード・完了コードの解決規則（3）<br>・旧 `.agent/` の凍結commitと最終snapshot（4）<br>・単独 `F` の範囲（下記）<br>・K / Cの記録先（5）<br>・1件1commitと「登録済み」の条件（6）<br>「新旧二重系統」節の完全移行の項を、この節への参照に置き換える |
| `.agent_v2/ORCHESTRATION.md` | 「完全移行」の節を、枠ごとのV3切り替えに合わせて改める（Fn / Jn は、対応するGn / Hn の切り替え後にTASKを置かない）。単独Fの手順に `verify --legacy-v2` と `verify --naming GH` を足す |
| `.agent/ORCHESTRATION.md`、`.agent/CHATGPT_HANDOFF.md` | **変更しない**（凍結。最終snapshotの対象）。どちらにも旧パスが固定で書かれている（例: G1 → `.agent/tasks/CLAUDE_TASK_1.md`）。そのため、PROJECT_RULES に「切り替え表の枠では、旧ORCHESTRATION・旧CHATGPT_HANDOFFのパスより、この表を優先する」と明記する |
| ChatGPT向けの新しい手順書 | 例: `.agent_v3/CHATGPT_V3.md`。Git Data APIでの1commit・expected_sha・5項目の読み戻し・答えが分からない時の判定・Kの記録を書く。ChatGPTのProject指示も同時に改める |
| `AGENTS.md`（Codexの入口） | H1〜H5の固定パス（`.agent/tasks/CODEX_TASK*.md`）を書いている。H枠を切り替える時に、切り替え表への参照へ改める。G10のpilotだけなら変更不要 |
| `CLAUDE.md` | 固定パスが無いので変更不要（PROJECT_RULES に従う） |
| PR #229 の `SPEC.md` 1・`MIGRATION.md` 段階3 | 置き場所の候補を `.agent_v3_gh/` に改める（7の3） |

単独 `F` の範囲（文案）:

- 移行期間中は、各nについて「Gn（旧の凍結 または V3）」と「Fn（v2）」、「Hn（旧の凍結 または V3）」と「Jn（v2）」の組を見る。同じ組で両方が動いていればエラーとして示す。
- 第一段階で、ツールの `verify --root .agent_v2 --legacy-v2` と `verify --root .agent_v3_gh --naming GH` を読み取りで実行する。
- 旧 `.agent/` は、凍結commitから変わっていないことだけを確かめる。
- 完全移行後は、V3の15枠だけを統括する。

ツールの追加候補（別TASK、レビュー対象）:

- (a) 切り替え表に無いG / H枠への書き込みを拒否する。
- (b) initで切り替えた枠だけを作る。
- (c) Vercelで `.agent*` だけのcommitをbuild対象から外す。これはVercelの設定変更なので、別の承認が必要。
- (d) `--naming` の値を `FJ` / `GH` だけに限る。rootが `.agent_v3_gh` ならGHを必須にする（付け忘れ・打ち間違いを拒否する）。

## 11. pilot前のチェックリスト（ChatGPT・ユーザー確認用）

- [ ] pilotの枠は **G10**。用途は統括。`return_to` は「かぶモリ30枠統括のちゃ（このチャット）」。`completion_code` は **K10**。`recommended_model` を記入する。
- [ ] 主体と担当を確認した:
  - TASKの登録は ChatGPT、実行は Claude（G10）、K10 の受入は ChatGPT、archive は Claude（ツール）。
  - ユーザーが送るコードは `G10`（開始）と `K10`（受入）。
- [ ] v2のF10に、継続中のtask_idが無い（このTASKがL10で受入れ・archive済み）。pilotの間、F10にTASKを置かない。
- [ ] 旧G10は `done / none`。K10待ちが無い。最終snapshotの凍結commitと照合結果を確認した。
- [ ] pilotの新しいtask_idが、旧・v2・V3のどこにも存在しない。
- [ ] 切り替えの後、`G10` / `K10` はV3の `.agent_v3_gh/tasks/G10.md` を指す。その他のG / H / K / C は、今までどおり旧（凍結）を指す。
- [ ] 使うツールのcommitが決まっている（`2c810122` またはmerge後のmain）。
- [ ] mainへの各commitでVercelのdeploy試行が起きることを承知した。
- [ ] 中止の条件と判断者（ChatGPT / ユーザー）、中止の手順（9）を確認した。
- [ ] PR #172、旧 `.agent/`、v2の他slotには触れない。
