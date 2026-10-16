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
- ヘッダーの読み取りは、先頭のUTF-8 BOMとCRLF改行を許容する。ヘッダー部分に字下げされた `- key:` 行があると、項目として読まれずに見落とされるため、書き込み時に拒否する。読み取った内容が正しいUTF-8でなければ、整合性エラーとして止める。

## 3. 1件の登録 = 1つのcommit（トランザクション）

登録・開始・Report・承認・archiveのどれも、関係するファイルすべて（TASK、再生成した索引、必要ならReport、archive一式、HISTORY_INDEXの行）を**1つのcommit**にまとめる。手順は次のとおり。

0. **書き込み先を確かめる**: rootは `.agent_v3*` だけ（`.agent` / `.agent_v2` / `.github` などは不可）。変更一式のパスは、すべてそのroot配下の素直な相対パスであること（`..`、絶対パス、空の区切り、空白などの文字は不可）。refは既定で `refs/agent-v3-live-test/*` だけで、`refs/heads/main` は呼び出し側が明示した場合（CLIの `--allow-main`）だけ。GitHubのリポジトリは許可リスト（既定 `anohi-memories/kabumori`）のものだけ。git backendのremoteも、そのリポジトリを指すものだけ（ローカルパスのremoteは `--allow-local-remote` が必要）。外れたら `DESTINATION_REFUSED`。
1. **base を読む**: 対象refの現在のcommit。
2. **計画する**: baseの内容から変更一式を作る。呼び出し側は「自分が見ていた状態」を `expect` で渡す。中身は、そのslotの `task_id` と `status`、**TASKファイル全体のSHA256（`task_sha256`）**、Codex枠でReportも書くときはReportのSHA256（`report_sha256`、無ければ `missing`）。どれかがbaseと違えば、別の書き手が先に変えたので `CONFLICT_SAME_SLOT` で止める。`task_id` と `status` が同じでも、本文が変わっていれば競合になる。`task_sha256` を渡さない呼び出しは `PLAN_REFUSED`（古い呼び出し方は通さない）。現在の値は `show` で読める。
3. **commitを作る**: baseだけを親にした1つのcommit。作ったcommitを読み直す。計画した全ファイルが入っていなければ `PARTIAL_DETECTED`、計画に無い変更が含まれていれば `UNPLANNED_CHANGE_DETECTED` で止める（どちらも公開しない）。
4. **公開する（CAS）**: fast-forwardの場合だけrefを進める。force push、`--force-with-lease`、GitHub APIの `force:true` は使わない。
5. **答えで分ける**（詳しくは「9. 公開の答えの分類」）:
   - `stale`（refが動いた、同時更新に負けた）: 新しいheadから手順2をやり直す（最大3回）。別slotの書き込みと重なっただけなら、索引を作り直して通る。同じslotが変わっていれば手順2で止まる。回数を使い切ったら `STALE_BASE_RETRY_EXHAUSTED`。
   - 明示的な「いいえ」（権限・方針・hookの拒否など）: refは動いていないので停止。
   - 「不明」（5xx、応答の途中切れ、成功に見えるが新しいshaが無いなど）: 要求は**送り直さない**。refを1回読んで、自分のcommitが含まれていれば手順6へ進み、含まれていなければ `PUBLISHED_UNVERIFIED`。
6. **読み戻す**: 3つを分けて確かめる。
   - (a) 自分のcommit自体が計画どおりの主要項目（`task_id` / `status` / `next_owner` / `return_to` / `completion_code`）を持っているか。
   - (b) refの履歴に自分のcommitが含まれているか。
   - (c) refのheadで、そのslotがまだその状態か。
   - (a)か(b)が違えば `READBACK_MISMATCH`。(a)と(b)は正しいが(c)だけ違えば、後から別のcommitがslotを変えたということなので `SUPERSEDED_AFTER_PUBLISH`。読み戻しの途中で読み取りやcompareが失敗したら（5xxを含む）、書き込みは送った後なので `PUBLISHED_UNVERIFIED` とし、`READBACK_MISMATCH` とは言わない。
7. **結果**: `refs/heads/main` で手順6まで通った時だけ `REGISTERED_ON_MAIN`（登録成功）。PR branchや他のrefに書いた場合は、内容が正しくても `WRITTEN_TO_BRANCH_NOT_REGISTERED` で、「登録済み」とは報告しない。ローカルに保存しただけの状態も登録ではない。

| 結果コード | 意味 | 報告 |
| --- | --- | --- |
| `REGISTERED_ON_MAIN` | mainに1commitで公開し、読み戻しが一致 | 登録済み |
| `WRITTEN_TO_BRANCH_NOT_REGISTERED` | main以外のrefに書けた | 未登録（main未反映） |
| `CONFLICT_SAME_SLOT` | 同じslotを別の書き手が先に変えた（本文・Reportの変更を含む） | 未登録。最新を読み直して判断 |
| `PLAN_REFUSED` | 上書き禁止・形式・遷移の規則に反する、`expect` のSHA256が無い、Reportが合わない | 未登録 |
| `DESTINATION_REFUSED` | root・パス・ref・リポジトリが許可の外 | 未登録（何も読み書きしていない） |
| `STALE_BASE_RETRY_EXHAUSTED` | refが動き続けた | 未登録 |
| `PARTIAL_DETECTED` | 作ったcommitに計画どおりのファイルが無い | 未登録（公開していない） |
| `UNPLANNED_CHANGE_DETECTED` | 作ったcommitに計画に無い変更が含まれる | 未登録（公開していない） |
| `REFUSED_STOPPED` | プラットフォームや安全装置が、方針・安全を理由に書き込みを拒否したと明示した | 未登録。理由を記録して停止 |
| `TRANSPORT_FAILED_STOPPED` | 公開の要求を送る前に、通信が応答なしで終わった（例: `unexpected EOF`）。拒否か通信障害かは推測しない | 未登録（refは変わっていない）。停止 |
| `INTEGRITY_FAILED_STOPPED` | 公開の要求を送る前に、受け取った内容が信用できなかった（本文の途中切れ、blob SHAやサイズの不一致、不正なUTF-8、gh の終了コードの食い違い） | 未登録（refは変わっていない）。archiveもidleへの戻しもしない |
| `ERROR_STOPPED` | 公開の要求を送る前の、その他の失敗 | 未登録（refは変わっていない）。停止 |
| `PERMISSION_DENIED` / `PUBLISH_REJECTED` | 公開を明示的に断られた（権限、hook、保護branchなど） | 未登録（refは変わっていない） |
| `PUBLISHED_UNVERIFIED` | 公開の答えが不明で、refを読んでも自分のcommitを確認できなかった。または送った後で読み取りが失敗した | **未登録扱い。ただしrefは変わった可能性がある**。次の担当がrefを読み戻して確かめる |
| `SUPERSEDED_AFTER_PUBLISH` | 自分のcommitは正しく入ったが、その後の別のcommitがslotを変えた | 未登録扱い（slotは今その状態ではない）。現在の状態を読み直す |
| `READBACK_MISMATCH` | 自分のcommitが計画どおりの内容でない、または履歴に無い | 未登録 |

## 4. 状態遷移と上書き禁止

- 遷移: `idle → ready`、`ready → in_progress`、`in_progress → review_required`、`review_required → done / ready / in_progress`、同じ状態のままの更新。それ以外は `PLAN_REFUSED`。
- 新しい `task_id` を置けるのは `idle` のslotだけ。`done` のslotは、先にarchive（下の5）で `idle` に戻す。完了したTASKが、保存される前に上書きされることはない。
- `ready` / `in_progress` / `review_required` のslotへ、別の `task_id` は書けない。

## 5. archive（1commit）

`done` のslotに対して、次を1commitで行う。

- 現在のTASK（とCodex枠はReport）のバイト単位の写し
- `MANIFEST.json`（original_path / archive_path / size / SHA256 / snapshot元commit）と `SHA256SUMS`
- `HISTORY_INDEX.md` への1行の追記
- slotのidleテンプレートへのリセットと、索引の再生成

途中のどれかが書けなければ、何も書かれない。F9のような「4ファイル中3ファイルだけ」の状態にはならない。次の場合は、archiveもidleへの戻しもしない。

- 呼び出し側の `expect`（`task_id`、`done`、TASKのSHA256。Codex枠はReportのSHA256も）がbaseと違う。
- Codex枠のReportが無い、またはReportの `task_id` が別のTASKのもの（`PLAN_REFUSED`）。
- archiveディレクトリに、既にファイルが1つでもある（追記のみ）。
- 読み取った内容が信用できない（github backendでは、受け取ったbase64のサイズとgit blob SHAを、GitHubが示す値と照合する）。

init（rootの初期化）も、root配下に1つでもファイルがあれば拒否する。

## 6. 拒否されたとき

- プラットフォームの安全チェックや方針による拒否は、`REFUSED_STOPPED` として理由を記録し（認証情報らしい文字列は伏せる）、その場で止める。拒否と明示されていない「応答なし」は `TRANSPORT_FAILED_STOPPED` とし、安全ブロックだと決めつけない。
- **同じ内容の言い換え、分割、再エンコード、別経路での再送はしない。** 安全チェックを避ける工夫は一切しない。拒否・通信失敗のどちらも、ツール自身は再試行しない。
- 1commitにまとめているので、公開の要求を送る前に止まれば、mainに何も残らない。送った後で止まった場合だけ `PUBLISHED_UNVERIFIED` とし、「書けた」とも「書けていない」とも言わない。原因の判断と再実行は、記録を見た人（ChatGPT / ユーザー）が行う。

## 7. 書き手の種類ごとの使い方

| 書き手 | 使う方法 | 登録成功の条件 |
| --- | --- | --- |
| シェルが使える担当（Claude Code / Codex） | `scripts/agent_v3/cli.ts`（git backend）。専用worktreeで実行。先に `show` で `task_sha256` などを読み、`write` / `archive` に `--expect-sha256` を渡す。mainへは `--allow-main` を付けた時だけ書く | CLIの終了コード0（`REGISTERED_ON_MAIN`） |
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

## 9. 公開の答えの分類

| 経路 | 答え | 分類 |
| --- | --- | --- |
| git push | 成功（終了コード0） | ok |
| git push | `!` 行の `non-fast-forward` / `fetch first` / `stale info` / `incorrect old value` / `cannot lock ref` / `failed to update ref` | stale（再計画） |
| git push | `!` 行の hook declined / protected branch / permission など、その他の明示的な拒否 | rejected（停止） |
| git push | `Permission to … denied` / HTTP 401・403 / authentication failed | permission（停止） |
| git push | 「denied / blocked / refused by policy・safety」「safety block / filter」「content policy」と明示 | refused（停止） |
| git push | 上記以外（`the remote end hung up unexpectedly`、`RPC failed; HTTP 502`、`Permission denied (publickey)` など、状態行の無い失敗） | unknown（refを読むだけ） |
| GitHub `PATCH git/refs` | 200で `object.sha` が新しいcommit | ok |
| GitHub | 422「not a fast forward」「Reference update failed」 | stale（再計画） |
| GitHub | 403 / 404 | permission（停止） |
| GitHub | その他の422 | rejected（停止） |
| GitHub | 5xx、409、応答の途中切れ、200なのに新しいshaが無い | unknown（refを読むだけ） |

- 「denied」「blocked」だけの単語では拒否と判定しない（認証・通信のエラー文にも出るため）。
- GitHubの読み取り（GET）は、応答が無い場合に限り最大3回まで送り直す。書き込み（POST / PATCH）は送り直さない。gh の終了コードがHTTPの答えと食い違う場合（2xxなのに非0）は、応答が途中で切れたものとして扱う。
- エラー文は記録前にマスクする。対象は、`gh*_` / `github_pat_` のtoken、URLに埋め込まれた認証情報、`x-access-token` / `token=`、Authorizationヘッダー（2語の形式を含む）、Bearer。

## 10. 実行方法

```bash
deno test --no-config --allow-run --allow-read --allow-write --allow-env tests/agent_v3/
```

```bash
deno run --no-config --allow-run --allow-read --allow-env scripts/agent_v3/cli.ts show --repo . --root .agent_v2 --slot F3
```

```bash
deno run --no-config --allow-run --allow-read --allow-env scripts/agent_v3/cli.ts verify --repo . --root .agent_v2 --legacy-v2
```
