# G2-02 第13TASK — G1 #675 退会後の閲覧画面・403・お知らせの実 Simulator 再QA

- task_id: `postona-g2-gen2-13-g1-pr675-ended-readonly-exit-native-simulator-qa-20261114`
- 対象: G1 PR #675 `db8556d26008f433198ed52604a4cbef077ad3bf`（base #670 `add1dfcdd239c65e45adc06291633937fc97d296`）に、G3 PR #663 `44f8bc3d3c2ff49766980e0930488647f94d034c` を手元だけで merge した（`40cfd96c8fdd9dbcc58dcf708b427bba9400d6d9`、9 paths、競合 0、push なし）
- 環境: G1 の runner（project g1xs、127.0.0.1:56521 だけ）、専用の Simulator `G2-INT13-20261114`（iPhone 17 Pro / iOS 27.0、終了後に削除）、Metro 8081
- 実タップ: 2026-11-14 21:56〜22:07 JST。端末の操作の許可は 1 回目で通った
- 製品ソースは変えていない。flag・接続先・runner の継続は使い捨てツリーだけで変えた（`throwaway.diff`）。このフォルダは G2 の文書と記録だけ
- G1 第50 の単体 1083 PASS とは別の、G2 独自の結果。G3 第23（PR #673）の Edge の新機能はこの木に入っておらず、検証していない

## 結果

PASS 22 / FAIL 0 / NOT_RUN 2。内訳は実タップ PASS 17、HTTP・DB の実測 PASS 5。

### 実タップ（R）

| # | 操作 | 結果 | 記録 | 判定 |
|---|---|---|---|---|
| R1 | A でログイン → お知らせ（同じ候補を 2 回修正 + 別候補） | 4 行が 2 行にまとまり「未読 2件」「以前の承認待ちのお知らせ 2件」 | 01 | PASS |
| R2 | 画面を開いたまま、別の session でサービスを終える → 未読を押す | 送ったのは list だけで、markRead 0。DB は未読 4 行のまま。退会済みの gate に切り替わる | 02 | PASS |
| R3 | 「これまでの承認とお知らせを見る（閲覧のみ）」を開く | 上端の「‹ 戻る」が、ステータスバー・Dynamic Island の下に重ならず見える（第12 の P3 が直った） | 03 | PASS |
| R4 | 閲覧のみで候補・お知らせを押す | 通信は list・get・notifications だけ。書込み 0（notes 4:0、resv 0） | 03 | PASS |
| R5 | 出口 1: 上の「‹ 戻る」 | gate に戻る | 04 | PASS |
| R6 | 一番下までスクロール | 「最新の状態を読み込む」「戻る」「利用登録する」「ログアウト」が、ホームインジケーターに重ならずに並ぶ | 05 | PASS |
| R7 | 出口 2: 下の「戻る」 | gate に戻る | 06 | PASS |
| R8 | 出口 3: 下の「利用登録する」 | 登録が active に戻り、閲覧画面が閉じてホームに入る | 07 | PASS |
| R9 | 再登録後に、まとまった行を開く | markRead 200 が 3 回（その候補の 3 行が既読） | 08 | PASS |
| R10 | もう一度終える → 閲覧のみ → 出口 4: 下の「ログアウト」 | ログイン画面に戻る。A の session は 0 | 09 | PASS |
| R11 | B でログイン | B の X（@h_597889279937 = B の puid）だけ。A の閲覧画面や退会表示は引き継がれない | 10 | PASS |
| R12 | B のお知らせ | 未読 0、お知らせはありません（A のものは出ない） | 11 | PASS |
| R13 | A を B の owner に加える → B が承認 | 403 `X_ACCOUNT_NOT_VERIFIED`、書込み 0（owner loss） | 12 | PASS |
| R14 | flag OFF（使い捨てのコピーで false にして開き直す）→ B の承認・お知らせ | 「まだ使えません。ここからは何も送られません」。アプリの通信 22→22、Edge の関数ログ 117→117 | 13, 14 | PASS |
| R15 | flag OFF のまま、終了している A でログイン | gate に「利用登録する」と「ログアウト」だけ。閲覧のみへの入口は出ない。通信 0 | 15 | PASS |
| R16 | 画面の上端と下端（safe area） | 03・05・07・15 のどれも、ステータスバー・Dynamic Island・ホームインジケーターと文字やボタンが重ならない | — | PASS |
| R17 | 落ちた記録 | 0（DiagnosticReports に該当なし） | — | PASS |

### HTTP・DB の実測（H）

| # | 内容 | 結果 | 記録 | 判定 |
|---|---|---|---|---|
| H1 | 終了中に、A の JWT で直接 markRead（2 回） | 403 `SERVICE_NOT_ACTIVE`、read_at は null のまま。notifications・get は 200 | http.txt | PASS |
| H2 | B から A の候補・お知らせ | list 0、get・approve・reject・revise は 404。B のお知らせは B 自身の 1 件だけ | http.txt | PASS |
| H3 | token なし、壊れた JWT、署名の壊れた JWT、ログアウト済みの JWT | すべて 401 | http.txt | PASS |
| H4 | server-final | outbox の重複 0。A は notes 4:3（再登録後の既読 3 行だけ）、B は 1:0 | server-final.txt | PASS |
| H5 | T46 のレース（負荷 200 前後） | G1 の runner を負荷 200〜240 のときに動かし、承認の e2e 13/13、T46 PASS（g1-runner.txt）。負荷 300 以上は再現できなかった | g1-runner.txt | PASS（G1 の試験。参考） |

## NOT_RUN

- 負荷 300 以上での T46 の観測（今回の負荷は最大 587 だったが、それは build の最中で、runner の実行中は 200〜240 だった）
- 実 Push の配信。実 iPhone・実 OAuth・実 SNS 投稿は範囲外で、PASS としていない

## 課題（P0〜P3）

- P0 / P1 / P2: なし。G2 第12 の P3 2 件（閲覧画面の出口、T47 の期待値）は直っていた
- 観察: 閲覧のみの一覧の「承認待ち」の札は、終了前の状態をそのまま見せている。閲覧のみの見出しで「承認・修正・新しい投稿候補の作成はできません」と書いてあるので、誤解のおそれは小さい
- 観察（環境）: 古い Draft PR #197・#235・#238・#240（2026-10-13〜10-17、F4/F5 時代）が `service-enrollment-gate.tsx` を変えている。#675 の祖先ではないが、どれも 1 か月近く動いていない古い候補で、現在の作業とは重ならないと判断した。中央で閉じるか確認してほしい
- 環境: build の最中に Mac の負荷が 587 まで上がった。ログイン欄の入力で文字が抜けたときは打ち直し、送る前に画面で確かめた

## 安全

- production/managed/hosted、実 X/Threads/Meta/OAuth/Push、有料 API、EAS・署名、merge・deploy・main への push はしていない
- G1/G3/G4/G5 の原本と他の担当の worktree・container・端末には触れていない
  - 最後に自分の端末だけを指定して panel を切り離したが、他の端末（iPhone 17、G8）の表示 panel も一緒に閉じた。端末そのものは操作していない
- 試験の人のメールアドレス・パスワード・JWT は文書・写真に入れていない（文字で検索して 0 件）。ログイン画面の写真は残していない
