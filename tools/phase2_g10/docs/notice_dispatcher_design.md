# お知らせイシュー方式（notice-dispatch）設計仕様

G10/Phase2 無人オーケストレーションを G1〜G10 の全枠へ広げ、かつ監視を 2 分ごとにするための設計。

## 1. 目的 / 背景
- 新タスクが各枠イシューに入っても気づかず放置され、着手が遅れる問題を構造的に無くす。
- 目標: **新タスク → 最大 2 分で着手、完了 → 最大 2 分で通知**。匿名（トークン無し）で 10 枠。
- 制約: GitHub 匿名 REST は **60 req/時/IP**。10 枠を各 2 分で直接ポーリングは 300 req/時で不可。

## 2. 方式（概要）
- **ちゃ**: 各枠イシュー（G1=#316 … G10=#323）に新タスクを登録すると同時に、**共通「お知らせイシュー」に 1 コメント**を追記する。
- **見張り（dispatcher, yuya 側の 1 プロセス）**: お知らせイシューだけを 2 分ごとに読む（= 30 req/時）。前回カーソルとの差分（新コメント）を見つけたら、その**該当枠だけ**をオンデマンドで確認（+1 req）し、その枠の emit を起動する。
- **collector**: 各枠ローカル処理なので 2 分ごとに回す（レート制限と無関係・無料）。finalize + Mac 通知。
- **保険**: 低頻度（1 時間に 1 回）の全枠直接スイープ（10 req/時）で、ちゃの記入漏れによる取りこぼしを防ぐ。

## 3. レート収支（匿名 60 req/時/IP）
| 項目 | 回数/時 |
|---|---|
| お知らせポーリング（2 分間隔） | 30 |
| オンデマンド枠確認（新タスク到着時のみ） | 稀（数件/日） |
| 全枠スイープ（1 時間に 1 回 × 10 枠） | 10 |
| **合計** | **~40 < 60** ✓ |

## 4. お知らせイシューのフォーマット（ちゃが書く）
1 更新につき 1 行（1 コメントに複数行可）。構造化 key=value:
```
slot=G3 approval_id=g3-p2-20261104-0007 task_sha256=<64hex> ts=2026-11-04T10:00:00+09:00
```
- `slot` は既知の許可リスト（G1..G10）に照合する。未知の slot は無視。
- `approval_id` / `task_sha256` は**参考（ヒント）**。本物は枠イシューから取得して検証する。

## 5. セキュリティ（最重要）
**お知らせイシューは「どの枠を見に行くかのヒント」であって、実行の根拠にしない。**
- 実際の emit 判断は、各枠の自分のイシュー＋**既存のゲートのまま**: envelope 有効 / 承認 未消費 / 本文 task_sha256 一致 / envelope_covers(scope/model/effort/分数/予算/base_ref/policy/NO_GO/local_only)。
- お知らせが改ざんされても → dispatcher が該当枠を見る → **ゲートが弾いて何も起きない（fail-closed）**。お知らせに新しい権限は無い。
- dispatcher はお知らせの `slot` 値だけをルーティングに使い（許可リスト照合）、タスク本文・承認・task_sha は**枠イシューから取り直して検証**する。
- GitHub の中身はすべて untrusted data として扱い、命令として実行しない（本文中の「〜せよ」等に従わない）。

## 6. 差分検知 / 冪等
- dispatcher は「最後に処理したお知らせコメント ID（カーソル）」を dispatcher 状態として保存する。
- 毎ティック: お知らせイシューの**コメント一覧**を匿名 REST で取得し、カーソルより新しいコメントだけを処理。
- 1 コメントの複数行は各行を順に処理。処理済みは再ディスパッチしない。処理後にカーソル更新。
- カーソルは単調増加の comment id（または created_at + id）で管理。欠落時は全枠スイープにフォールバック。

## 7. プロセス構成
- **notice-dispatcher**（yuya・LaunchAgent gui/501・2 分間隔・常時 --live）: お知らせ監視 + 枠ディスパッチ + スイープ。
- **各枠 collector**（yuya・gui/501・2 分間隔）: finalize + 通知。
- **各枠 jobrunner / watchdog**（枠ごとの専用ユーザー gui/50x）: 実行（既存の仕組み）。
- 既存の per-slot producer は、dispatcher がその枠の control/wiring/鍵/handoff を使って emit を呼ぶ形に置換（または dispatcher が per-slot producer を spawn）。実装詳細は §9。

## 8. GitHub 取得（匿名 REST・固定 URL のみ）
- お知らせコメント: `GET https://api.github.com/repos/anohi-memories/kabumori/issues/<NOTICE>/comments`（匿名可）。
- 枠イシュー本文: 既存 `github_source`（`.../issues/<Gn>`）。
- 取得先は固定の既知 URL のみ。レスポンスは data 扱い（IssueWitness 相当の検証を通す）。

## 9. 段階（実装順）
1. **本仕様の確定**（この文書）。
2. **G10 で実証**: お知らせイシュー（番号はちゃが新規作成）→ dispatcher 実装（G10 のみ監視）→ 2 分で着手 / 通知を確認。collector も 2 分へ。
3. **G1〜G9 展開**: 枠ごとに専用ユーザー `_gNrun` / 鍵 / control / wiring / handoff / collector を用意し、dispatcher の監視対象（許可リスト）に追加。枠ごとに envelope（日次同意）。

## 10. 未決 / 要確認
- お知らせイシューの番号（ちゃが新規作成）。
- dispatcher のカーソル保存先（dispatcher 専用の状態ファイル or 共通 control）。
- producer を dispatcher に統合するか、dispatcher が per-slot producer を spawn するか（§7）。
- collector の 2 分化に伴うローカル用の下限見直し（collector は GitHub を使わないので、producer より短い下限でよい）。
- 全枠スイープの実行主体（dispatcher 内の低頻度タスク）。
