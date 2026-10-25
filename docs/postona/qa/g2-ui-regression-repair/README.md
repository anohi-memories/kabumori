# G2 第46世代 — 個人向けの手動投稿の画面の G2 の古い確認5本を、G1 #497 の上でまとめて直した回帰の一式（QA専用）

- Issue #317 TASK `postona-g2-existing-ui-regression-suite-consolidated-repair-20261025`
- 対象（この PR の base）: G1 PR #497 HEAD `446a9c3960262a078aa7784503673e87edbae331`（base = #468 `45ee9ac3296fdc6f5e53942faa93a1e73e61c1c9`。G1 第18・19TASK は ACCEPT 済み、#497 は開始時から変化なし）
- 新しいファイル（この PR）:
  - `apps/social-mobile/tests/g2-reg-394-x-manual-result-gate.test.mjs` ← G2 #394 `7384aa5a` `tests/g2-x-manual-result-gate.test.mjs`
  - `apps/social-mobile/tests/g2-reg-403-pr398-regression.test.mjs` ← G2 #403 `ffed4d87` `tests/g2-pr398-regression.test.mjs`
  - `apps/social-mobile/tests/g2-reg-411-postfix-baseline.test.mjs` ← G2 #411 `38501193` `tests/g2-postfix-baseline.test.mjs`
  - `apps/social-mobile/tests/g2-reg-414-pr410-transitions.test.mjs` ← G2 #414 `7b150a89` `tests/g2-pr410-transitions.test.mjs`
  - `apps/social-mobile/tests/g2-reg-448-pr435-retry-kind.test.mjs` ← G2 #448 `d44713bc` `tests/g2-pr435-retry-kind.test.mjs`
  - `apps/social-mobile/tests/g2-reg-copy-contract.mjs`（共通の判定。試験ファイルではない）
  - この README、`before-repair.log`・`run.log`・`controls.log`、計測の手順 `reg_isolated.py.txt`・`reg_controls.py.txt`
- **古い PR と元のファイルは変えていない**（各 PR の HEAD に送っていない）。新しい名前の写しを直したので、元の名前と衝突しない。直した箇所には `G2-46 repair` と書いた。
- 製品のコード・G1 の画面と試験・model／flow／送信の口・他の担当の物は変えていない。この PASS はアプリの完成や実際の SNS の安全の証拠ではない（実機・実 Auth・実 X・サーバーの同じ送信IDの扱いは NOT_VERIFIED）。

## 1. 直す前（`before-repair.log`）: #497 の上で 16 件が失敗。原因は4種類

| 原因 | 試験 | 件数 | 直し方 |
|---|---|---|---|
| **A. 古い文の固定**（#497 の文の修正で意図どおり失敗） | #403 G2-R2、#411 NC-3、#448 観察 G2-RK3 | 3 | 完全一致をやめ、`sameIdShown`（意味の判定: 言い切りが無い・X での確認を促す・同じ送信IDの説明があるか）に置き換えた |
| **B. G1 が直した不具合の再現の試験**（「不具合があれば通る」作りなので、直った版では失敗する） | #394 G2-X1、#403 G2-SM3R-S、#411 SM3R-S、#414 G2-410-3、#448 の H1 P2 の入口・#448 の関門（同じ送信IDの3回目） | 6 | 「直ったことを守る」試験（FIXED）に反転した。どれも「出ない」側だけでなく「出る」側も同じ試験で確かめる |
| **C. 試験の場の作りの古さ** | #394 G2-X2・X3・X4（送信中の記録の共有）、#394・#403・#414・#448 の負例（画面・流れの目印のずれ） | 7 | 送信中の記録をアプリ1つごとに分けた。負例の目印を #468 の作りに付け直した（入口の鍵 `${userId}:${sessionMark}`、引き継ぎの分岐 `if (out !== null) return createSendingState(..)`、返事の適用 `takenOver.answer.then`、送信の登録の塊、確認し直しの再同期の条件 `code === UNRESOLVED_REFUSAL_CODE`） |
| **D. 試験の順番への依存**（失敗ではなく、見かけの PASS） | #403 FINDING G2-SM3R、G2-SM3R-C（#497 では FAIL→PASS） | （2） | 下の §2 |

- #394・#414 の「前からの失敗」（#468 でも同じ数）は B と C だった（G1 の連絡の区分と一致）。

## 2. #403 の順番への依存: 再現と直し（`controls.log`）
- **原因**: 古い #394・#403 の試験の場は、アプリの流れの部品の「送信中の記録」を、モジュールに1つだけある共有の物のまま使っていた（#410 で増えた物）。前の試験が返事待ちの送信を残すと、次の試験のアプリが「送信中の引き継ぎ」をして、画面が編集欄を出さなくなる。#403 では G2-R2 が最後まで進むと（#468）、「次の投稿」の送信が返事待ちのまま残り、後の SM3R の試験が失敗していた。G2-R2 が途中で止まると（#497）、送信が残らないので「通って」しまっていた。
- **再現**: 直した #403 の写しに、共有の記録だけを戻すと、ファイル全体では4件が FAIL、1件ずつ単独では全部 PASS になる。
- **直し**: アプリ（＝処理1つ）ごとに新しい送信中の記録を作る（`realFlow.createInFlightSends()`）。新しいアプリは新しい処理なので、本物の再起動と同じになる。製品のコードの問題ではない（製品は処理ごとに1つの記録を持つ）。
- **確認**: 直した40件を1件ずつ単独で流しても、ファイル全体で流しても、全部 PASS（不一致 0）。

## 3. 空振りの否定の直し
- 古い「その文が出ない」の固定（#394 X2・負例、#403 G2-R2 の最後、#411 FIXED-X1、#414 G2-410-3）は、文が変わると何も確かめなくなっていた。`sameIdShown` は「同じ送信IDの説明の文があるか」を意味で見るので、どんな言い方の説明でも見つける。また、言い切りの文が1つでもあれば、その場で失敗する。
- 反転した FIXED の試験は、同じ試験の中で「出る」側（本当の確認し直し）も確かめる。
- **計測**（`controls.log`、使い捨ての作業場所で画面の文をわざと壊した）:
  - 古い2文に戻す → 40件中 **7件**が失敗
  - 同じ約束を別の言い方で書く（「サーバーが二重に投稿することはありません」）→ **6件**が失敗（564 行は変えていないので、RK3 は通る）
  - X での確認を抜く → **7件**が失敗

## 4. 直した後（`run.log`）

| ファイル | 件数 | 結果 |
|---|---|---|
| g2-reg-394 | 6 | 6 PASS |
| g2-reg-403 | 6 | 6 PASS |
| g2-reg-411 | 14 | 14 PASS |
| g2-reg-414 | 6 | 6 PASS |
| g2-reg-448 | 8 | 8 PASS |
| 合計 | 40 | **40 PASS / 0 FAIL**。ネットワークを使えない状態でも 40/40 |
| 全体（#497 ＋ この5本） | 652 | 651 PASS / 0 FAIL / 1 skip（F3 の照合ファイルが無いときの既知の skip） |

- まだ「不具合があれば通る」作りのまま残したもの（**既知の OPEN で、直っていない**。通るのは不具合がまだあるから）: #411 FINDING-SM2・SM3R-T・SM4・SM4-D、#403 FINDING G2-SM3R、#448 観察 G2-RK3。修正済みとは書かない。
- TS の型検査・lint: 対象外（試験は .mjs、製品のコードは変えていない）。`git diff --check` OK。

## 5. 統合の順番の提案（提案だけ。統合はしない）
1. G1 #468 → G1 #497 → この PR（G2 の回帰の一式）。G2 #504（#497 の焦点の確認）も #497 の上で、この PR と同時に並べられる（ファイルは重ならない）。
2. 古い G2 の PR #394／#403／#411／#414／#448 は、古い版の上の記録として残す（統合しない）。閉じるかどうかは G2 担当ちゃが決める。
3. 製品のコードの変更は無いので、この PR だけで本番の判断には使えない（本番 NO_GO）。
- 既知のまま: G2-UC1・SN5・RK3（文言）、SM2・SM3R-T・SM4・SM4-D、Threads の G2-T1・T2・T1-X、iOS 27 の標準ビルド、識別名 G2-ID1・ID5、Android 実機、G4 #426 の安全レビュー。退会・ログアウトの保持、旧共有の作業場所は未決。

```bash
cd apps/social-mobile && node --test tests/g2-reg-*.test.mjs
```
