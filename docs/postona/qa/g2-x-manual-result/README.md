# G2 第15世代 — X 手入力投稿の未接続ゲートと送信結果の表示（オフラインQA、QA専用）

- Issue #317 TASK `postona-g2-x-manual-publish-result-gate-offline-qa-20261020`
- 対象: G1 PR #366 HEAD `44ab2e6bb812f3484c85f847574de103757e3dfc`（#325 → #346 → #366 の最新。X 手入力投稿の新しい修正版は無い）。この上に積んだ。G1/G4 のソースは読み取りのみ。
- 新規: `apps/social-mobile/tests/g2-x-manual-result-gate.test.mjs`（6件）。本物の画面・モデル・流れ・保存を、**将来つながったときの送信の口の偽物**で動かす。この版自体の送信の口は「未接続」のまま（対照の試験で確認）。実 X・ネットワーク・トークンは使っていない。

## 1. つながり具合（ソースの根拠）

| 部分 | 状態 | 根拠 |
|---|---|---|
| 送信の口 | **未接続**。`getManualPublishPort()` は `UNCONNECTED_MANUAL_PUBLISH_PORT` を返す。送信可否は常に `not_connected`、送ろうとしても `refused / PORT_NOT_CONNECTED`（成功は返さない） | `manual-publish-port.ts` 93–102行 |
| F3 単発投稿への変換部品 | 用意だけ。HTTP は差し込み式で、アプリのどこからも作られていない。送信可否の確認の窓口が無いので `not_connected` | `single-post-port.ts` 1–20行 |
| サーバー側 | F3 #272（単発投稿の契約）、G4 #353（X の再認可、本文に「マージ・配備しないでください」）・#355。どれも未統合 | 各 PR 本文 |
| 投稿ボタンの条件 | ログイン中・記録読み込み済み・データ準備完了・選んだアカウントが今の一覧にある・送信中でない・未解決の試みが無い（同じ番号の再送を除く）・文章が正しい・同意あり・1分以内の「送信できる」確認 | `manual-publish-model.ts` 461–488行 `sendGate` |
| 答えの分類 | 送った番号と違う答え・知らない種類・投稿 ID が無い成功・「テストの結果」の印つき成功は、どれも「不明」か「テスト結果」で、成功にしない | 同 195–217行 `resultOf`、`manual-publish-flow.ts` |

実際の送信経路が無いので、つながった後の動きはすべて**模擬（SOURCE_ONLY）**。実 X での結果は NOT_VERIFIED。

## 2. 既存の試験との対応（重複を作らなかった項目）

| TASK の項目 | 既存の試験（F1/G1、`tests/manual-publish-*.test.mjs`、今回も 213 通過・1 スキップ） |
|---|---|
| ゲート OFF・未接続なら外部送信 0・成功の案内 0 | screen「this build: the confirmation shows the content, the readiness is not_connected, the send is disabled and cannot fire」、marks「this build: the send stays unreachable…」、flow「readiness: the port of this build says not_connected…」 |
| 公開成功 | screen「published is the only road to "sent"…」、marks の simulated / afterFreeze 一式 |
| 拒否（公開されていない・4xx） | screen「rejected: "not posted"… a new attempt gets a new id」「refused (4xx, nothing written)… NEW id」 |
| 応答喪失・つながらない | screen「unconfirmed (nothing known: transport / 503 / unreadable): retry with the same id…」、adapter「a lost answer is retried with the SAME attempt id…」 |
| 処理中（まだ） | screen「pending: "not sent yet"… the retry reuses the SAME attempt id and body」 |
| 不明 | screen「uncertain: warned, no resend…」「uncertain keeps no retry button at all」 |
| 口が例外を投げる | screen「a port that throws mid-send is shown as uncertain…」 |
| タイムアウト（答えが来ない） | screen「leaving the screen mid-send cannot make a second identical send look safe」、restart「restart while a send was in flight… unconfirmed, retryable only with the same id」 |
| 権限の失効・状態の変化 | screen「readiness older than a minute blocks the send…」「a forced press is refused by the handler itself when the gate no longer holds…」 |
| アカウント変更 | screen「account list change: a chosen account that is gone is dropped…」、restart「an account that is gone cannot re-ask the attempt…」 |
| 別の人 | screen「the route re-creates the screen for a different user…」「another signed-in user never inherits an unresolved attempt」 |
| 同じ内容の再確認 | screen「restart: the same text is asked for again; only a matching text… with the stored id」、adapter「different text or another account is a different attempt」 |

## 3. 今回足したもの（結果）

| ID | 内容 | 結果 |
|---|---|---|
| 対照 | この版（未接続の口）: 同意しても「Xに投稿する」は押せず、無理に押しても送信 0、成功の文言 0 | PASS |
| **G2-X1** | **初めての送信**の最中に、確認画面に「前回と同じ内容・同じ送信IDで確認します。…」と出る（前の試みは無い） | **FINDING（P3、担当 G1）** |
| G2-X2 | A の送信の答えを待っている間に B がログイン → B には新しい画面で A の文章も試みも出ない。A の「公開済み」が後から返っても B には出ない。A の試みは A の側で終わる | PASS |
| G2-X3 | 答えを待っている間に、選んだアカウントが一覧から消え、「まだ」「つながらない」が返る → 送り直しのボタンは出て確認画面に戻るが、送信ボタンは押せず、無理に押しても送らない。別のアカウントに向け直さない | PASS（安全側）。観察: 成功できない送り直しを案内する（理由は確認画面の中で初めて分かる） |
| G2-X4 | 「不明」の後で「Xで確認しました」を押すと、入力欄は**空**（古い文章が残らない）。同じ文章を打ち直して送ると新しい番号 | PASS（Threads の G2-T1 のような「古い文章が残って二重投稿を招く」形にはならない） |

### 負例コントロール
- 画面の作り直しを「人ごと」にしない書き換え → B に A の送信中の文章が見える（G2-X2 の前提が崩れる。同じ場面で検出）
- 「前回と同じ…」の行を、本当の送り直し（未解決の試みが in_flight 以外）のときだけ出す修正案 → G2-X1 が反転する（初回では出ない）

## 4. 新しく見つかったこと（G1 へ一度だけ）
**G2-X1（P3、担当 G1）初回の送信中に「前回と同じ内容・同じ送信IDで確認します」と出る。**
- 根拠: `src/app/manual-publish.tsx` 404–406行。表示の条件が `state.unresolved !== null` で、初回の送信でも送信の開始時点で試みが「送信中（in_flight）」として未解決に入るため、成り立つ。
- 再現: 送信の口が「送信できる」を返す状態で、文章を入れて確認 → 同意 →「Xに投稿する」→ 答えを待っている間の画面。
- 影響: 初めての送信なのに「前回」と言うので、同じ番号の再送と新しい送信の区別が表示の上で崩れる（TASK の「同じ送信番号と新規送信の違いを表示」）。送信の動き自体は正しい。
- 期待: 本当に前の試みを同じ番号で送り直すとき（「まだ」「つながらない」からの送り直し、再起動後の再確認）だけ出す。
- 経緯: 第9世代の Simulator 確認で「範囲外・未分類の観察」として記録したもの。今回、TASK の範囲に入ったので試験で固定した。

## 5. 保護したまま（重ねて報告しない）
G2-T1（P2、Threads 二重公開、#391）、G2-T2（P3、#393）、G2-T1-X（#381 の照合試験）、SM1〜SM4・SM4-D（#380・#385）、iOS 27 の標準ビルドが起動しない（#348）。どれも修正版は出ていない。

## 6. 実行
```bash
cd apps/social-mobile && node --test tests/g2-x-manual-result-gate.test.mjs
```
`run.log`（6件）、`suite.log`（全体 497 件中 496 通過・1 スキップ・失敗 0。既存の手入力投稿の試験 214 件中 213 通過・1 スキップ）。
