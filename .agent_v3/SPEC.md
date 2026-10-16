# Agent V3 仕様（候補・未適用）

V3は、v2（`.agent_v2/`）の「軽量TASK・独立Report・append-only archive・HISTORY_INDEX」を引き継ぎ、そのうえでTASK登録の信頼性の問題を直す管理基盤の候補。**現行運用には適用していない。** 正式な適用（パスの昇格、開始コードの切り替え）は別TASKで行う。原因の調査は `EVIDENCE.md`、移行計画は `MIGRATION.md`。

## 1. 置き場所

| パス | 内容 |
| --- | --- |
| `<root>/tasks/<slot>.md` | 各slotの現在のTASK。**先頭ヘッダーがそのslotの唯一の正本** |
| `<root>/reports/<slot>.md` | Codex枠の最新Report（Claude枠はTASK末尾の `## Report`） |
| `<root>/ACTIVE_TASK.md` | 全TASKヘッダーから**自動生成**する索引（手で編集しない） |
| `<root>/HISTORY_INDEX.md` | 完了作業の索引（1件1行、追記のみ） |
| `<root>/archive/<date>-<slot>-<task_id>/` | 完了したTASK / Reportのバイト単位の写し、`MANIFEST.json`、`SHA256SUMS`（追記のみ） |
| `scripts/agent_v3/` | 登録ツール（`cli.ts`、`registry.ts`、`transaction.ts`、`git_backend.ts`、`github_backend.ts`） |
| `tests/agent_v3/` | 隔離テスト |

`<root>` は正式適用まで未定（候補: 将来の `.agent/`）。テストでは `.agent_v3_fixture`、GitHub実検証では `.agent_v3_live_fixture` を使い、どちらも専用の場所だけに書く。

## 2. 正本は1つ、索引は派生物

- slotの状態（`task_id` / `owner` / `slot` / `status` / `next_owner` / `start_code` / `completion_code` / `return_to` / `recommended_model` ほか）は、TASKファイル先頭の `- key: value` 行だけに書く。これが唯一の正本。
- `ACTIVE_TASK.md` は、全TASKヘッダーから機械的に作る派生物。先頭に生成マーカーと、生成元ヘッダーのdigest（`source_digest`、SHA256）を持つ。
- 索引とTASKヘッダーが食い違ったら、**TASKヘッダーが正しく、索引が古い**とみなす。「どちらが正しいか」を人が判断する場面を作らない。
- `verify` は、ヘッダーの形式（必須項目、slotと完了コードの1対1、statusの値、割当中の `return_to` と推薦モデル）、索引との一致、digest、手編集の有無を読み取りだけで確認する。v2の索引にも `--legacy-v2` で同じ検査をかけられる（digestの検査は省く）。

## 3. 1件の登録 = 1つのcommit（トランザクション）

登録・開始・Report・承認・archiveのどれも、関係するファイルすべて（TASK、再生成した索引、必要ならReport、archive一式、HISTORY_INDEXの行）を**1つのcommit**にまとめる。手順は次のとおり。

1. **base を読む**: 対象ref（通常は `refs/heads/main`）の現在のcommit。
2. **計画する**: baseの内容から変更一式を作る。呼び出し側は「自分が見ていた状態」（`expect`: そのslotの `task_id` と `status`）を渡す。baseがそれと違えば、別の書き手が先に変えたので `CONFLICT_SAME_SLOT` で止める。
3. **commitを作る**: baseだけを親にした1つのcommit。作ったcommitを読み直し、計画した全ファイルが入っていなければ `PARTIAL_DETECTED` で止める（公開しない）。
4. **公開する（CAS）**: fast-forwardの場合だけrefを進める。force push、`--force-with-lease`、GitHub APIの `force:true` は使わない。refが動いていたら `stale`。
5. **staleなら再計画**: 新しいheadから手順2をやり直す。最大3回。別slotへの書き込みと重なっただけなら、索引を作り直して通る。同じslotが変わっていれば手順2で止まる。回数を使い切ったら `STALE_BASE_RETRY_EXHAUSTED`。
6. **読み戻す**: 公開後のrefのheadに自分のcommitが含まれていること、対象slotの主要項目（`task_id` / `status` / `next_owner` / `return_to` / `completion_code`）が期待どおりであることを、ref上の内容から確認する。違えば `READBACK_MISMATCH`。
7. **結果**: `refs/heads/main` で手順6まで通った時だけ `REGISTERED_ON_MAIN`（登録成功）。PR branchや他のrefに書いた場合は、内容が正しくても `WRITTEN_TO_BRANCH_NOT_REGISTERED` で、「登録済み」とは報告しない。ローカルに保存しただけの状態も登録ではない。

| 結果コード | 意味 | 報告 |
| --- | --- | --- |
| `REGISTERED_ON_MAIN` | mainに1commitで公開し、読み戻しが一致 | 登録済み |
| `WRITTEN_TO_BRANCH_NOT_REGISTERED` | main以外のrefに書けた | 未登録（main未反映） |
| `CONFLICT_SAME_SLOT` | 同じslotを別の書き手が先に変えた | 未登録。最新を読み直して判断 |
| `PLAN_REFUSED` | 上書き禁止・形式・遷移の規則に反する | 未登録 |
| `STALE_BASE_RETRY_EXHAUSTED` | refが動き続けた | 未登録 |
| `PARTIAL_DETECTED` | 作ったcommitに計画どおりのファイルが無い | 未登録（公開していない） |
| `REFUSED_STOPPED` | プラットフォームや安全装置が、方針・安全を理由に書き込みを拒否したと明示した | 未登録。理由を記録して停止 |
| `TRANSPORT_FAILED_STOPPED` | 公開の要求を送る前に、通信が応答なしで終わった（例: `unexpected EOF`）。拒否か通信障害かは推測しない | 未登録（refは変わっていない）。停止 |
| `ERROR_STOPPED` | 公開の要求を送る前の、その他の失敗 | 未登録（refは変わっていない）。停止 |
| `PUBLISHED_UNVERIFIED` | 公開の要求を送った後で、応答や読み戻しが失われた | **未登録扱い。ただしrefは変わった可能性がある**。次の担当がrefを読み戻して確かめる |
| `PERMISSION_DENIED` / `PUBLISH_FAILED` | 権限・その他の公開失敗（応答あり） | 未登録 |
| `READBACK_MISMATCH` | 公開直後に別の書き込みで内容が変わった、または自分のcommitが履歴に無い | 未登録 |

## 4. 状態遷移と上書き禁止

- 遷移: `idle → ready`、`ready → in_progress`、`in_progress → review_required`、`review_required → done / ready / in_progress`、同じ状態のままの更新。それ以外は `PLAN_REFUSED`。
- 新しい `task_id` を置けるのは `idle` のslotだけ。`done` のslotは、先にarchive（下の5）で `idle` に戻す。完了したTASKが、保存される前に上書きされることはない。
- `ready` / `in_progress` / `review_required` のslotへ、別の `task_id` は書けない。

## 5. archive（1commit）

`done` のslotに対して、次を1commitで行う: 現在のTASK（とCodex枠はReport）のバイト単位の写し、`MANIFEST.json`（original_path / archive_path / size / SHA256 / snapshot元commit）、`SHA256SUMS`、`HISTORY_INDEX.md` への1行の追記、slotのidleテンプレートへのリセット、索引の再生成。途中のどれかが書けなければ、何も書かれない。F9のような「4ファイル中3ファイルだけ」の状態にはならない。archiveディレクトリが既にあれば拒否する（追記のみ）。

## 6. 拒否されたとき

- プラットフォームの安全チェックや方針による拒否は、`REFUSED_STOPPED` として理由を記録し（認証情報らしい文字列は伏せる）、その場で止める。拒否と明示されていない「応答なし」は `TRANSPORT_FAILED_STOPPED` とし、安全ブロックだと決めつけない。
- **同じ内容の言い換え、分割、再エンコード、別経路での再送はしない。** 安全チェックを避ける工夫は一切しない。拒否・通信失敗のどちらも、ツール自身は再試行しない。
- 1commitにまとめているので、公開の要求を送る前に止まれば、mainに何も残らない。送った後で止まった場合だけ `PUBLISHED_UNVERIFIED` とし、「書けた」とも「書けていない」とも言わない。原因の判断と再実行は、記録を見た人（ChatGPT / ユーザー）が行う。

## 7. 書き手の種類ごとの使い方

| 書き手 | 使う方法 | 登録成功の条件 |
| --- | --- | --- |
| シェルが使える担当（Claude Code / Codex） | `scripts/agent_v3/cli.ts`（git backend）。専用worktreeで実行 | CLIの終了コード0（`REGISTERED_ON_MAIN`） |
| GitHub APIで複数ファイルを1commitにできる担当 | Git Data API（blob → base_treeつきtree → 親1つのcommit → `PATCH git/refs/heads/main`、`force:false`）。CLIの github backend と同じ手順 | 手順6の読み戻し一致 |
| 1回に1ファイルしか書けない担当（Contents APIなど） | **TASKファイル（正本）1つだけ**を書く。索引は書かない（次の書き手が作り直す） | TASKの読み戻しが一致した時だけ「TASK登録済み・索引未再生成」と報告。索引の一致は主張しない |

- 3段目の書き手は、archive（複数ファイル）を行わない。archiveはツールを使える担当に依頼する。
- 単独 `F` などの確認では、索引ではなく各TASKヘッダーを読み、索引のdigestが古ければ「索引は古い（正本はTASK）」と表示する。

## 8. GitHub側で確認した事実（2026-10-16）

- `refs/heads/` 以外の専用ref（`refs/agent-v3-live-test/f10-20261016-a`）では、`PATCH git/refs`（`force:false`）がfast-forwardでない更新を受け付けた（先に入れたcommitが上書きされた）。サーバー側のfast-forward検査はbranch以外では当てにできない。
- そのため github backend は、更新の直前にrefの現在値がbaseと一致するかを確かめ、違えば書かずに `stale` を返す。branch（`refs/heads/`）では、GitHubのfast-forward検査が、この確認と更新の間の残りの隙間を閉じる（GitHubの仕様。**branch上での実機確認はしていない**。理由は `MIGRATION.md`）。
- 専用refへの書き込みでは、Vercel / Netlify のcommit状態は付かなかった（deployは起きていない）。
- 専用ref `refs/agent-v3-live-test/f10-20261016-c` の実行では、blob作成の要求が応答なしで終わった（`unexpected EOF`）。ツールは公開せずに止まり、refは作成元のmain commitのまま変わらなかった。この結果は当初、誤って「拒否」に分類していた。そこで、拒否と通信失敗を分ける `TRANSPORT_FAILED_STOPPED` を追加した。
- 専用ref `refs/agent-v3-live-test/f10-20261016-d` の実行でも、登録の計画中の読み取り（GET）が応答なしで終わった。`TRANSPORT_FAILED_STOPPED` で止まり、refは初期化commitから進んでいない。1回の登録でGitHub APIを数十回呼ぶため、github backendは次のようにした。
  - 読み取り専用のGETだけは、応答が無いときに最大3回まで送り直す。
  - 書き込み（POST / PATCH）は送り直さない。
  - 同じcommit・同じパスの読み取りは記憶して使い回す（commitの中身は変わらないため）。

## 9. 実行方法

```bash
deno test --no-config --allow-run --allow-read --allow-write --allow-env tests/agent_v3/agent_v3.test.ts
```

```bash
deno run --no-config --allow-run --allow-read --allow-env scripts/agent_v3/cli.ts verify --repo . --root .agent_v2 --legacy-v2
```
