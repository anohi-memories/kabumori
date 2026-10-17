# V3 正式導入の移行前調査（read-only、2026-10-17）

Issue #244 の段階1〜3に向けた読み取り専用の調査結果。F10 `orchestration-v3-issue244-integration-preflight-f10-20261017` で作成した。この調査では、どの管理ファイルも書き換えていない（F10自身のTASKと索引のF10行を除く）。移行の手順と判定は `CUTOVER_PLAN.md` にまとめた。

確認済みの事実と、記録だけに頼る事項（独立には確かめていないもの）を分けて書く。

## 0. 固定した対象

| 対象 | 値 |
| --- | --- |
| 30枠の突き合わせに使ったmain | `e858a1b6ef8073cb75a3a8076599f816e8296442`（作業開始時の `691f29ed46e203e4118a9c53c8234e91d70e089d` でも同じ結果。間にF4・F5の新TASKが入っただけ） |
| V3ツールの `verify --legacy-v2` を当てたmain | `50d3ffde4f2d4faaedeb7dae6d5f74fe8b684aaf` |
| PR #229（V3候補） | Draft / OPEN / 未merge、HEAD `2c810122250e885ccbc3ae3a50351b78070ae69c`、14ファイル（すべて追加） |
| PR #172（旧履歴の最終snapshot候補） | Draft / OPEN / 未merge、HEAD `aa4b7210353dde68b76ef0a6414a0aba74091f95` |

方法: TASK先頭の `- key: value` 行（正本）と、索引（`ACTIVE_TASK.md`）の該当ブロックを機械的に比べた。旧系統は `.agent/ACTIVE_TASK.md` の `## Codex Hn` / `## Claude Gn`、v2は `.agent_v2/ACTIVE_TASK.md` の `## Fn` / `## Jn`。比べた項目は task_id / status / next_owner / return_to / completion_code / recommended_model。読み取りは `git show <commit>:<path>` だけで行った。

## 1. 30枠のTASK正本と索引

| 系統 | slot | status | next_owner | 完了コード | task_id | 索引との差 |
| --- | --- | --- | --- | --- | --- | --- |
| 旧 `.agent/` | H1 | done | none | C1 | `postona-h1-threads-oauth-edge-offline-implementation-20261011` | なし |
| 旧 `.agent/` | H2 | done | none | C2 | `kabumori-pr149-broadcast-fanout-push-security-review-h2-20261012` | なし |
| 旧 `.agent/` | H3 | done | none | C3 | `agent-v2-pr155-dual-slot-migration-review-h3-20261012` | なし |
| 旧 `.agent/` | H4 | done | none | C4 | `common-account-g5-phase4-pr152-pr121-security-review-h4-20261012` | なし |
| 旧 `.agent/` | H5 | done | none | C5 | `common-ai-h5-claude-multimodel-consumer-bridge-m2-20261014` | なし |
| 旧 `.agent/` | G1 | done | none | K1 | `kabumori-g1-ai-ask-v1-phase-a-ui-contract-20261012` | なし |
| 旧 `.agent/` | G2 | done | none | K2 | `kabumori-g2-market-report-yume-column-top-points-20261014` | なし |
| 旧 `.agent/` | G3 | done | none | K3 | `postona-g3-x-reservation-api-client-wiring-offline-v1-20261012` | なし |
| 旧 `.agent/` | G4 | done | none | K4 | `postona-g4-threads-mobile-oauth-and-cleanup-wiring-v1-20261012` | recommended_model: TASK=`Opus5.5（高）` / 索引=`Opus5.5（高） (completed K4)` |
| 旧 `.agent/` | G5 | done | none | K5 | `common-account-g5-phase4-h4-c4-r1-r2-repair-20261012` | なし |
| 旧 `.agent/` | G6 | done | none | K6 | `common-ai-provider-g6-f1-f2-timeout-tests-stability-20261012` | なし |
| 旧 `.agent/` | G7 | done | none | K7 | `mic-stage1-formal-verification-design-finalization-g7-20261011` | なし |
| 旧 `.agent/` | G8 | done | none | K8 | `news-improvement-a-jp-official-diagnostics-j1a-g8-20261012` | なし |
| 旧 `.agent/` | G9 | done | none | K9 | `api-optimization-b-g9-r3-clean-history-provider-compare-replacement-20261011` | なし |
| 旧 `.agent/` | G10 | done | none | K10 | `agent-v2-dual-slot-migration-20261012` | なし |
| v2 `.agent_v2/` | F1 | done | none | L1 | `kabumori-f1-ai-ask-b0-terminal-finish-auth-fix-20261014` | なし |
| v2 `.agent_v2/` | F2 | ready | claude | L2 | `kabumori-f2-pause-delivery-runtime-candidate-20261015` | status: TASK=`ready` / 索引=`review_required`; next_owner: TASK=`claude` / 索引=`chatgpt` |
| v2 `.agent_v2/` | F3 | done | none | L3 | `postona-f3-x-reservation-oauth-entitlement-dispatch-integration-20261016` | なし |
| v2 `.agent_v2/` | F4 | ready | claude | L4 | `postona-f4-threads-oauth-connect-gap-readiness-20261017` | なし |
| v2 `.agent_v2/` | F5 | ready | claude | L5 | `common-account-f5-postona-disposable-supabase-architecture-plan-20261017` | なし |
| v2 `.agent_v2/` | F6 | ready | claude | L6 | `common-ai-f6-postona-consumer-calls-pg-offline-candidate-20261017` | なし |
| v2 `.agent_v2/` | F7 | ready | claude | L7 | `mic-stage1-formal-verification-s1a-source-f7-20261015` | なし |
| v2 `.agent_v2/` | F8 | review_required | chatgpt | L8 | `kabumori-f8-news-discovery-observer-pause-gate-20261016` | なし |
| v2 `.agent_v2/` | F9 | done | none | L9 | `api-optimization-b-f9-clean-pr190-residual-rights-tests-20261014` | なし |
| v2 `.agent_v2/` | F10 | in_progress | claude | L10 | `orchestration-v3-issue244-integration-preflight-f10-20261017` | なし |
| v2 `.agent_v2/` | J1 | done | none | V1 | `common-account-j1-f5-pr226-disposable-guard-focused-review-20261016` | なし |
| v2 `.agent_v2/` | J2 | done | none | V2 | `postona-j2-pr238-auth-cross-user-review-20261017` | なし |
| v2 `.agent_v2/` | J3 | idle | none | V3 | `none` | なし |
| v2 `.agent_v2/` | J4 | done | none | V4 | `postona-j4-pr217-r2c-final-preview-focused-rereview-20261015` | なし |
| v2 `.agent_v2/` | J5 | idle | none | V5 | `none` | return_to: TASK=`none` / 索引=`POSTONA｜マルチSNS化・開発統括（G4）のちゃ` |

- 30枠すべてで、TASKファイルと索引ブロックは存在し、完了コードは自枠のもの（G→K、H→C、F→L、J→V）と1対1で一致した。
- PR #229 のV3ツール（`cli.ts verify --root .agent_v2 --legacy-v2`、main `50d3ffde`）も、v2について同じ3件（F2のstatus・next_owner、J5のreturn_to）だけを返した。別々の方法で同じ結論になった。

## 2. 食い違いと異常枠（担当へ返す。この調査では直していない）

| slot | 内容 | 原因（確認済み） | 返却先 | 移行への影響 |
| --- | --- | --- | --- | --- |
| F2 | TASKは `ready / claude`、索引は `review_required / chatgpt`。TASKのReportは `NOT_STARTED` のまま | commit `22e725fa225a2cea2ad97065cdf24b88c6ea6504`（2026-10-16 08:12、「accept L2 L8 scoped fixes for focused security rereview」）が**索引だけ**を更新した。TASKの最後の変更は `ba7709dcaabfc4ff30054a522d8fd90d20384f61`（同 07:45、ready の再割当）。F2の修正作業のReportはTASKに書かれていない | かぶモリアプリG1のちゃ（運用休止・全体統括）。F2のTASK正本を、L2の判定どおりに直すかの判断 | 移行禁止（正本と索引の不一致） |
| J5 | idleのTASKに対し、索引に前TASKの `return_to` / `dependencies` / `blocker` が残る。Reportは前TASKの取り消し記録（`cancelled_before_start`） | 前TASKは開始前に取り消され、`.agent_v2/archive/2026-10-15-J5-cancelled-postona-p2-task-before-start/` とHISTORY_INDEXに保存済み（`699470fc4b6396beb8f4f27f03aa292f02687d10` ほか）。索引の掃除だけが残った | ChatGPT（次にJ5へ置く人）。V5待ちは無い | 低。J5は臨時実装の優先枠で、移行の対象にもしない |
| G4 | 推薦モデルの欄に、索引だけ `(completed K4)` の注記 | 完了時の注記 | 不要（表記だけ） | なし |
| 旧CURRENT_STATE | 先頭の記録が「G2 K2 待ち（2026-10-14）」のまま | K2は `37276b210ece156dffa52146acdf7ef1cdc552c8`（2026-10-14 11:48）で受入済み。CURRENT_STATEの先頭だけ更新されていない | 記録のみ（旧系統は凍結予定） | なし（正本はTASK） |
| v2 CURRENT_STATE | 最新の記録（F5の割当）が、F5のTASK正本より古い | TASKのほうが後から進んだ | 記録のみ | なし（正本はTASK） |

## 3. 完了確認待ち・継続中・未archive

- **未処理の完了コード**
  - L8（F8 `review_required / chatgpt`）。
  - F2は上の不一致のため、L2の状態が確定できない。索引は「L2受入、焦点再レビュー待ち」、TASKは「ready」。
  - 旧K1〜K10・C1〜C5は0件。旧15枠すべて `done / none`。
- **継続中のtask_id（途中移管禁止）**
  - ready: F2（不一致）、F4、F5、F6、F7。F7は2026-10-15から ready のまま。
  - in_progress: F10（このTASK）。
- **done だが未archive**（v2では、次のTASKを置く前にarchiveする決まり）: F1、F3、F9、J1、J2、J4。
- **旧系統の done に残る後続作業**（TASKとしては完了。続ける場合は新しいtask_idが必要）
  - G2: 本番フォローアップ（x-test-post v145 の並び未deploy、iPhone画面の読み戻し、SECURITY DEFINERの事後レビュー、10/14大引けの実出力）。
  - H5: `SOURCE_MERGE_HOLD`（PR198、F6側の修正が必要）。
- 旧 `.agent/` の最後の変更は `78c9b9115ae5aade57876fc4fc662e4cc35b7797`（2026-10-14 22:41、H5のC5締め）。それ以降、旧系統のファイルは変わっていない。

## 4. 作業競合・名前空間

- 526個のref（ローカルbranchと `origin/*`）のうち、`.agent_v3*` のパスを含むのはPR #229 のbranchだけ。V3の名前空間を使う他の作業は無い。
- GitHub上に専用ref `refs/agent-v3-live-test/f10-20261016-a`〜`g` の7本が残っている。branchではなく、中身は `.agent_v3_live_fixture/` の検証データだけ。削除は承認待ちのまま。
- 新しい置き場所の候補 `.agent_v3_gh` は、どのrefにも存在しない。

## 5. 履歴ゲート（旧 `.agent/` の保存）

### PR #172（`aa4b7210`、snapshot `.agent_v2/archive/2026-10-13-final-migration-preflight-b7ce2c4f/`）

| 確認 | 結果 |
| --- | --- |
| MANIFEST.json の33件（旧 `.agent/` 28件＋共有ルール5件）。サイズ・SHA256・git blob が、PRのblobと一致するか | 33/33 一致 |
| 同じ33件が、元commit `b7ce2c4fd94225542a66aef94042ca528cc47f09` の原本とバイト一致するか | 33/33 一致 |
| `SHA256SUMS` の全64行が、PRのblobと一致するか | 64/64 一致 |
| 元commitがmainの祖先か | はい |
| snapshot後に旧 `.agent/` が変わったか | **変わった**。`.agent/` に触れたcommitが12個。5ファイル（`ACTIVE_TASK.md`、`CURRENT_STATE.md`、`CODEX_REPORT_5.md`、`tasks/CLAUDE_TASK.md`（G2）、`tasks/CODEX_TASK_5.md`（H5））が別の内容になっている。追加・削除されたファイルは無い |
| 今のmainへ重ねられるか（`git merge-tree`、どのbranchも変更せず） | **衝突**: `.agent_v2/CURRENT_STATE.md`、`.agent_v2/HISTORY_INDEX.md`。分岐点 `7adbd97d9981fddfb6d542e0ca7f776ad645e53c` からmainは899 commit進んでいる。PRは稼働中の `CURRENT_STATE.md` を +39 −110 で書き換える |

判定: snapshotの中身は正確だが、**最終snapshotとしては古い**。そのままmergeすると、稼働中の `CURRENT_STATE.md` を古い内容で置き換える。**NO_GO（最終保存済みとみなさない）**。PR #172 は保護対象のまま触れず、凍結時点で新しい最終snapshotを別に取る（`CUTOVER_PLAN.md` の4）。

### main上の初回snapshot（`.agent_v2/archive/2026-10-12-initial-migration/`、元commit `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7`）

- MANIFEST 33件・SHA256SUMS 33行は、すべて一致した。
- その後113個のcommitで、旧 `.agent/` 28件のうち18件が変わっている。今の旧G10のTASK（`tasks/CLAUDE_TASK_10.md`）も変わった側に入る。今の内容とバイト一致する写しは、未mergeのPR #172 にしか無い。

## 6. PR #229（V3候補）の固定と検証

- HEAD `2c810122250e885ccbc3ae3a50351b78070ae69c`、14ファイル、+3046 −0。対象は `.agent_v3/`、`scripts/agent_v3/`、`tests/agent_v3/` だけ。既存ファイルの変更は0件。
- 今のmainとの合成（`git merge-tree` で作ったローカルだけのcommit `b4708aa9da80517fb5ce97501a94a3388b8be5ec`、main `872516cd885e70e36c8714e7e972c75cd0229a79` との合成、pushしていない）で確認した。
  - 衝突なし。
  - `tests/agent_v3` 45/45 PASS。
  - `deno check` 終了コード0、`deno lint` 指摘なし（9ファイル）。
- この確認は実装者（同じF10）が行ったもので、独立レビューではない。
- 独立レビューと外部試験の記録の所在:

| 項目 | リポジトリ内の記録 | 独立に確かめたこと |
| --- | --- | --- |
| N1/N2 再レビュー PASS | Issue #244 本文、`.agent_v2/HISTORY_INDEX.md` のF10の行（"rereview PASS"）。レビュー本文・ログはリポジトリに無い | なし（記録だけ） |
| ChatGPT の Git Data API でのTASK＋ACTIVE同一commit | 検証専用リポジトリ `anohi-memories/kabumori-v3-test`（private）の branch `v3-cas-check-20261017` | commit `b1b4b85c8d43bcec6767c876f77dfb930fd9d139` が `v3-cas-fixture/TASK.md` と `v3-cas-fixture/ACTIVE_TASK.md` を1commitで追加している（GitHub APIで読んで確認） |
| 古いexpected_shaでは更新されない／最新なら成功 | Issue #244 本文。検証用branchの先頭 `b5f2f0a4d50b4277d0340ddb3581868ac4d0297d` の `lease-check.txt` は "descendant commit with intentionally stale expected_sha" | 成功した更新しかrefに残らないため、拒否されたことはリポジトリの状態からは確かめられない（記録だけ） |
| 競合時のGraphQLエラー | Issue #244 本文: 一般的なエラーで、拒否の分類は未実証 | なし。V3の分類では「不明」として扱い、読み戻しで判定する（`CUTOVER_PLAN.md` の6） |

### G / H の名前でのpilotの予行（手元だけ）

PR #229 のテストは F / J の名前だけを使っていて、`--naming GH` は試されていなかった。そこで、手元だけの使い捨てリポジトリで、`CUTOVER_PLAN.md` の8の S1〜S6 を一通り実行した。

- 環境:
  - scratchの bare リポジトリ（中身は上の合成commit `b4708aa9` を main にしたもの）と、そのclone。
  - GitHub・origin・他のworktreeには一切書いていない。
  - ChatGPTの段階（S2・S5）も、ここではCLIで代わりに実行した。コネクタ経由の書き込みは試していない。

| 段階 | 結果 | commit（手元のみ） | 変わったファイル |
| --- | --- | --- | --- |
| S1 `init --root .agent_v3_gh --naming GH` | `REGISTERED_ON_MAIN`、`verify` 0件 | `0f6ef002dfd05b3d7ecf02c8dfefc9d17b350cd4` | 22（`tasks/G1〜G10.md`・`tasks/H1〜H5.md`・`reports/H1〜H5.md`・索引・HISTORY_INDEX） |
| S2 G10 `idle → ready` | `REGISTERED_ON_MAIN` | `b9f63c1bb889d359cdeee53437139685d74e0e3b` | `tasks/G10.md`、索引 |
| S3 `ready → in_progress` | `REGISTERED_ON_MAIN`、`verify` 0件 | `bed1d31cf3b336e4c882e76a9da17a52a628843f` | `tasks/G10.md`、索引 |
| S4 Report と `review_required` | `REGISTERED_ON_MAIN` | `44124c996d11d6c3d58cb096d6eb5cef6747caaf` | `tasks/G10.md`、索引 |
| S5 `### K10 acceptance`（AI Lab diaryの判定を含む）と `done` | `REGISTERED_ON_MAIN` | `2c6ec14faef2e6f1831652011ed4dcf377389cc9` | `tasks/G10.md`、索引 |
| S6 `archive` | `REGISTERED_ON_MAIN`、`verify` 0件、G10は `idle` に戻った | `da220da200075c167d5597481841e972d3f42aa5` | 6（archiveの写し・MANIFEST.json・SHA256SUMS、HISTORY_INDEXの1行、G10のidleテンプレート、索引） |

- archiveの写しのSHA256（`1a923cb7…`）は、done時点のTASKのSHA256と一致した。`### K10 acceptance` の節も含めてそのまま残った。
- `--naming` を付け忘れた場合も確かめた。
  - `verify --root .agent_v3_gh`（GH指定なし）は、16件の指摘（15枠の `TASK_MISSING` と `INDEX_STALE`）で止まった。
  - `write --slot G10`（GH指定なし）は `unknown slot G10` で拒否され、mainは変わらなかった。
  - どちらも、黙って通ることは無かった。

## 7. 書き込みとdeployの関係（確認済み）

- mainへのcommitには、内容に関係なくVercelの状態が付く。今回の管理ファイルのcommit（`691f29ed46e203e4118a9c53c8234e91d70e089d`、`c57c2a2ed795a89d377f04fe7a7c2e9c32325548`）にも付いていた。
  - どちらも "Deployment rate limited — retry in 24 hours" の failure。Vercelがdeployを試み、1日の上限で止まった。
- `[skip ci]` を付けたcommit（`a8abe86785f4cb2265daa4a8862650eaddcecc22` ほか）にも、VercelとNetlify deploy-previewの状態が付いていた。`[skip ci]` では止まらない。
- PR #229 のbranchへのpush（2026-10-17 13:27 JST、`2c810122`）では、Vercelがadminプロジェクトの**Preview**を作った（Ready）。本番ではない。
- 専用ref（`refs/agent-v3-live-test/*`）への書き込みでは、状態は付かなかった（PR #229 のSPEC 8）。
- 推測（未確認）: 管理ファイルのcommitが、Vercelの1日の上限（無料枠100回）を消費している可能性がある。V3の「1件1commit」はcommit数を減らすが、0にはしない。

## 8. この調査でしていないこと

- 他slotのTASK / Report / 索引 / CURRENT_STATE、旧 `.agent/`、既存archive、PR #172 / #229 の変更。
- GitHub（mainや他のref）での `.agent_v3_gh` の作成とV3による登録。予行は手元の使い捨てリポジトリだけで行った。
- mainへのPR merge、deploy、本番操作。
- 専用refの削除。
