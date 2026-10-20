# G2 第13世代 — Threads 手動投稿の二重公開（G2-T1、P2）の層をまたいだ限定QA（QA専用）

- Issue #317 TASK `postona-g2-threads-manual-duplicate-publish-crosslayer-qa-20261020`
- 対象: G4 の最新 PR #381 HEAD `8eefb3b63f4efba0727e99de980e0d56733d1d8e`（この上に積んだ）。手動投稿の画面部品・処理部品は 2026-10-13 以降変更なし（G2 PR #342 の版 `02fd1989` と同じ中身）。**T1 の修正版は無い**。
- 新規: `apps/social-mobile/tests/g2-threads-t1-crosslayer.test.mjs`（9件）。本物の画面部品と処理部品を、データベース候補 `begin_threads_manual_publish` の規則どおりに動く偽のサーバーにつないで動かす。実 Threads・Supabase には接続しない。
- PR #342 の16件（T1 の基本形、処理中は入力欄を隠す、別の人・別アカウントの答えを無視、二度押しは同じキー、など）は作り直していない。

## 1. 手動投稿の流れ（ソースで確認した到達経路）

| 段階 | どこ | 何が起きるか | 区分 |
|---|---|---|---|
| 公開の可否 | `src/domain/threads-manual-publish.ts` 8行 | `THREADS_MANUAL_PUBLISH_UI_ENABLED = false`。OFF の間は入力欄も出ない | ゲート OFF |
| 入力 → 確認 | `threads-publish-card.tsx` 43–47行 | 「投稿内容を確認する」ごとに `pin()` が**新しい冪等キー**を作る | SOURCE_ONLY |
| 送信 | 同 48–52行 | 「投稿する」で確認中の状態をすぐ捨て（`setPinned(null)`）、返事が来て受け付けられたときだけ入力欄を空にする | SOURCE_ONLY |
| サーバー呼び出し | `use-threads-manual-publish.ts` 57–70行 | Edge 関数 `social-mobile-threads-publish` を呼ぶ。返事が失われたら一般的な文言だけ | SOURCE_ONLY |
| 読み直し | 同 103行 | どの結果でも、そのあと口座の状態を読み直す。処理中の記録があれば入力欄を隠す | SOURCE_ONLY |
| 表示 | `threads-manual-publish.ts` 122–146行 | published / published_unidentified / failed は「新しい投稿を書ける」。uncertain は「確認する」だけ | SOURCE_ONLY |
| 確認する | card 97行・hook 127–138行 | `reconcile` は同じ記録 ID の答えだけを受け取る | SOURCE_ONLY |
| サーバーの判定 | `supabase/candidates/postona_threads_publish/threads_manual_publish_candidate.sql` 155–158・327–380行 | 同じキー＝同じ記録を返す。処理中の記録があれば `PUBLISH_IN_PROGRESS`。終わった後の新しいキーは**新しい記録**。**文章が同じかどうかは見ない** | 候補（未適用） |
| 実際の Threads | — | 接続していない | NOT_VERIFIED |

処理部品の説明には「同じ確認を送り直すときはキーを使い回す（サーバーは同じ記録を返す）」とあるが、画面には、返事が失われた後で同じキーを使い直す道が無い（確認中の状態は送信の時点で捨てる）。

## 2. 結果（公開要求の数・キー・公開された数）

| ID | 組み合わせ | 公開要求 | キー | 公開数 | 判定 |
|---|---|---|---|---|---|
| T1-U | 返事が失われる → サーバーは「確認できない」（入力欄は隠れる＝安全）→「確認する」で公開済みと分かる → **古い文章が入力欄に戻る** → 確認し直す | 2 | 別 | **2** | **FINDING（新しい経路、P2）** |
| T1-PU | 返事が失われる → サーバーは「公開済み（リンク不明）」→ 古い文章が残る → 確認し直す | 2 | 別 | **2** | **FINDING（新しい経路、P2）** |
| T1-F | 返事が失われる → サーバーは「失敗」（公開されていない）→ 同じ文章で送り直す | 2 | 別 | 1 | PASS（正当な再試行。**修正後も残すべき**） |
| T1-W | 返事が失われ、状態の読み直しが遅れている間に確認し直す → 最初の記録が公開済みになった後でもう一度 | 3（2回目はサーバーが拒否） | すべて別 | 2回目の時点で 0、3回目の後で 2 | PASS（サーバーの拒否は**処理中の間だけ**守る、と確認） |
| T1-A | 同じ画面部品が別のアカウントを表示すると、入力中（公開済みでも）の文章がそのアカウントに残る | 2 | 別 | 2（A と B に同じ文章） | FINDING（P3） |
| T1-P | ログイン中の人が変わっても、画面部品が残っていれば入力中の文章が残る | 0 | — | 0 | FINDING（P3） |
| T1-R | 「確認する」の答えが別の記録 ID | 1 | — | — | PASS（答えとして扱わない） |
| 照合 | 偽のサーバーの規則を SQL 候補の文面と照合、画面の「確認中を先に捨てる」「受け付け時だけ空にする」を照合 | — | — | — | PASS |

T1-A・T1-P は画面部品の範囲の確認。実際の画面遷移で同じ部品が使い回されるかは NOT_VERIFIED（アカウント詳細は通常アカウントごとに別の画面になる）。

### 負例コントロール（素朴な修正案で確かめる）
「返事が失われた直後の確認と同じ文章なら、前のキーを使い回す」という素朴な修正案を画面部品に入れて動かした。
- T1-U と T1-PU は、2回目が同じキーになって公開数 1 になる（FINDING が反転する）。
- その一方で、T1-F（失敗の後の正当な再試行）は、失敗した記録が返され続けて**二度と送れなくなる**（公開数 0）。

つまり、この確認一式は「止めすぎる修正」も見つけられる。

## 3. 修正後の受入条件（G4 向けの提案）
1. 返事が失われた後は、サーバーで記録が終わる（published / published_unidentified / failed）まで、同じ文章の新しいキーでの送信をさせない。T1-W のとおり、今のサーバーの拒否は処理中の間だけしか守らない。
2. 記録が published または published_unidentified で終わったら、その文章を入力欄から消すか、「すでに投稿済み」と明示して再送を止める（T1-U・T1-PU が反転すること）。
3. failed で終わったら、同じ文章の再送をできるようにする（T1-F が通り続けること）。
4. 案内文の「確認する」と実際のボタンをそろえる（既知の T1 の一部）。
5. 入力中の文章をアカウントとログイン中の人に結び付ける（T1-A・T1-P が反転すること）。
6. 確認: #342 の T1 FINDING と本ファイルの FINDING 4件の反転、T1-F・T1-W・T1-R の通過、全体の試験。実 Threads は別承認。

## 4. 新しく見つかった独立の問題（G4 へ一度だけ）
**G2-T1-X（P3、担当 G4）G4-12（PR #381）でアプリ側の既存試験が1件失敗する。**
- 内容: `tests/threads-disconnect.test.mjs` の「parity: the database's exact answers through the REAL server handler parse in the app as intended」が `unexpected import ./social_account_id.ts` で失敗する。#381 で `supabase/functions/_shared/social/threads_disconnect.ts` に `import { SOCIAL_ACCOUNT_ID } from "./social_account_id.ts";` が追加されたが、この試験の読み込み一覧に入っていない。
- 再現: #381 の版で `cd apps/social-mobile && node --test tests/threads-disconnect.test.mjs` → 17 件中 16 通過・1 失敗（`threads-disconnect-parity-on-pr381.log`）。1つ前の #373 `61e94a10026df2eb6aa5f3acdc4f4512c4cb96fd` では 17/17 通過（`threads-disconnect-parity-on-pr373.log`）。
- 影響: 解除処理の「データベースの答えがアプリで正しく読めるか」の照合が動いていない。#381 の報告はサーバー側の試験（310 件）だけで、アプリ側の試験には触れていない。
- 期待: 試験の読み込み一覧に `./social_account_id.ts` を加え、全体の試験が通ること。

## 5. 実行
```bash
cd apps/social-mobile && node --test tests/g2-threads-t1-crosslayer.test.mjs
```
`run.log`（9件）、`suite.log`（全体 304 件中 303 通過・1 失敗＝上の G2-T1-X。G4 の手動投稿試験 18/18）。
