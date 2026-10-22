# G2 第29世代 — Threads 解除の照合試験の失敗（G2-T1-X）の切り分け（QA専用）

- Issue #317 TASK `postona-g2-threads-t1x-qa-harness-import-parity-20261022`
- 対象（この PR の base）: G4 PR #381 HEAD `8eefb3b63f4efba0727e99de980e0d56733d1d8e`。#381 以後、解除の処理・試験・`social_account_id.ts` を変えた PR は無い（修正候補なし）。
- 新規: `apps/social-mobile/tests/g2-threads-t1x-import-parity.test.mjs`（7件）。G4 の試験と同じ読み込み方で本物の解除の処理（`threads_disconnect.ts`）を読み、G4 の試験の照合データ（7行）は**G4 の試験ファイルから直接読み取る**（写していないので、G4 が変えれば自動で追従する）。G4 の試験・製品のファイルは変更していない。ネットワークなし。

## 1. 原因（ソース）
- `threads_disconnect.ts` は #381 で `import { SOCIAL_ACCOUNT_ID } from "./social_account_id.ts";` が増え、読み込み先が 2 つ（`../../social-mobile-threads-publish/logic.ts` と `./social_account_id.ts`）になった。
- G4 のアプリ側の試験 `threads-disconnect.test.mjs` の照合（94–96行）は、厳密な読み込み一覧（一覧に無いものは止める）に `logic.ts` だけを入れている。
- `social_account_id.ts` 自体は何も読み込まない純粋な規則（`^[a-z][a-z0-9_]{1,80}$`）。
- → 失敗は**試験の準備（読み込み一覧）の不足**で、読み込みの時点で止まり、データベースの答えの照合は 1 行も試されていない。

## 2. 同じ版での比較

| 条件 | 結果 |
|---|---|
| G4 の試験そのまま（`g4-threads-disconnect-same-head.log`） | 17 件中 16 通過・1 失敗（`unexpected import ./social_account_id.ts`） |
| G2-T1X-2: G4 と同じ一覧で読む（前） | 同じ理由で読み込みの時点で止まる（再現） |
| G2-T1X-3: 一覧に本物の `social_account_id.ts` を足す（後） | **G4 の 7 行すべて、G4 の期待どおりにアプリで読める** → 解除の約束は壊れていない |
| 参考: #381 の一つ前 #373 `61e94a10` | 17 件すべて通過（G2 #391 の記録 `threads-disconnect-parity-on-pr373.log`、今回は流し直していない） |

## 3. 追加の確認

| ID | 確認 | 結果 |
|---|---|---|
| G2-T1X-1 | 原因をソースで確かめる（読み込み先 2 つ、G4 の一覧は 1 つ、`social_account_id.ts` は読み込みなし） | PASS |
| G2-T1X-4（新しい照合） | サーバーが断る口座の番号（大文字・先頭が数字や下線・ハイフン・空白・最後の改行・長すぎ・UUID の形）は、アプリでも「失敗」と読まれ、「解除しました」にならない。データベースにも聞かない | PASS |
| 準備の確認 | 「後」の実行が本当に番号の規則を通っていることを確認: #381 より前の UUID だけの規則を差し込むと、本物の形の口座が断られて照合が失敗する。何でも通す規則では照合の 7 行は通ってしまう（7 行は番号の規則を試していない）が、断るべき番号が「解除しました」に見えてしまう → それを捕まえるのは G2-T1X-4 だけ | 期待どおり |
| 負例（構文木、メモリの中だけ） | 解除の処理から番号の確認を外す → 断るべき番号が「解除しました」になる（G2-T1X-4 が検出） | 検出（当たる数ちょうど 1） |
| G2-T1X-5（関門） | アプリの試験のうち、厳密な一覧でサーバーのファイルを読む箇所すべてで、読み込み先が一覧に入っているか | 足りないのは `threads-disconnect.test.mjs` の 1 箇所だけ（`threads-connect.test.mjs` の接続の照合は足りている。投稿の試験の読み込み先は読み込みなし） |

記録: `run.log`（7/7）。#381 + 本試験の全体: 302 件中 301 通過・1 失敗（G4 の試験の T1-X、変化なし）。

## 4. 分類と申し送り
- G2-T1-X は **G4 所有の試験の準備の不足**（製品の約束の後退ではない）。直す場所は G4 の `apps/social-mobile/tests/threads-disconnect.test.mjs` の照合の読み込み一覧で、例えば `'./social_account_id.ts': <本物の social_account_id.ts>` を足せば、G2-T1X-3 と同じく 7 行が通る見込み。G2 は G4 の試験を書き換えない。**既報の G2-T1-X と同じ指摘なので、新しい引き継ぎはしない**（今回の切り分けの根拠を REPORT に付けるだけ）。
- 照合の 7 行は口座の番号の規則を試していない（準備の確認）。番号の規則がアプリ側でも「失敗」になることは G2-T1X-4 で新しく確かめた。
- Threads 解除の G2-T2（P3、早すぎる成功表示）とその条件は、照合とは別の部分（カードと処理部品）なので、この結果で解消扱いにしない（G4 の他の 16 件は通過、T2 の FINDING は G2 #393 のまま）。
- G2-T1（P2、二重公開）も OPEN のまま。

## 5. そのまま残るもの
G2-T1（P2）とその経路、G2-T2（P3）とその条件、G2-T1-X（G4 の試験の修正待ち）、G1/H1 の P2・G2-SN5、G4 #426 の安全レビュー、iOS 27 の標準ビルド、識別名 G2-ID1・ID5、SM 系、Android 端末、実 Threads／SNS。

## 6. 実行
```bash
cd apps/social-mobile && node --test tests/g2-threads-t1x-import-parity.test.mjs
```
