# G2-02 第12TASK — G1 #665 + G3 #663 退会後の通知・Worker の実画面統合QA

- task_id: `postona-g2-gen2-12-g1-pr665-g3-pr663-ended-notification-real-simulator-integration-20261113`
- 対象: G1 PR #665 `7787f75a4e794b0bd945a928b89803fc0603f68f`（base `bddbd369f2fe3545d58d6bf52df35909cb64ab42`）に、G3 PR #663 `44f8bc3d3c2ff49766980e0930488647f94d034c` を手元だけで merge した（`c415ed5eca6327189991151d47a944be31496691`、9 paths、競合 0、push なし）
- 環境: G1 の runner（project g1xs、127.0.0.1:56521 だけ）、専用の Simulator `G2-INT12-20261113`（iPhone 17 Pro / iOS 27.0、終了後に削除）、Metro 8081、G3 の TEST ONLY worker twin と偽の X（`g3ls_test`）
- 実タップ: 2026-11-13 08:38〜09:23 JST と 2026-11-14 16:49〜16:51 JST（利用上限で一度止まり、同じ環境のまま再開した）
- 製品ソースは変えていない。flag・接続先・runner の継続は使い捨てツリーだけで変えた（`throwaway.diff`）。このフォルダは G2 の文書と記録だけ
- H1 #306 第46 のレビュー（G3 の新しい definer・trigger）とは独立した QA。製品として採用するか、本番 GO かは判定しない

## 結果

PASS 31 / FAIL 0 / NOT_RUN 2。内訳は実タップ PASS 18、HTTP・PG17・worker の実測 PASS 13。

### 実タップ（R）

| # | 操作 | 結果 | 記録 | 判定 |
|---|---|---|---|---|
| R1 | A でログイン → 設定 → 素材BOX → 戻る | 入口・表示・戻るができる | 01, 02 | PASS |
| R2 | A1 を 2 回修正 + A2 → お知らせ | 4 行が 2 行にまとまり「未読 2件」「以前の承認待ちのお知らせ 2件」 | 03 | PASS |
| R3 | **お知らせを開いたまま、別の session でサービスを終える → 未読を押す**（G2 第11 の FAIL と同じ場面） | 送ったのは list だけで、markRead は 0 件。DB は未読 4 行のまま。アプリは退会済みの gate に切り替わる | 04 | **PASS（第11 は FAIL）** |
| R4 | 閲覧のみを開く → 項目を 3 つ押す | 通信は get 2 回と notifications 1 回だけ。書込みは 0（notes 4:0、resv 0） | 05 | PASS |
| R5 | 閲覧のみから出る | 戻るボタンがない。左端から戻る操作をしても動かない。アプリを開き直して gate に戻った | 06 | PASS（P3 の観察あり） |
| R6 | gate の「利用登録する」を押す | 登録が active に戻る。X は要確認 | 07 | PASS |
| R7 | 再登録後に、まとまった行を開く | markRead 200 が 3 回送られ、その候補の 3 行が既読になる | 08 | PASS |
| R8 | gateway を止めて未読を押す（状態の確認に答えがない） | markRead は 0 件で、行は未読のまま。画面は「読み込めませんでした」 | 09 | PASS |
| R9 | アプリで A3 を承認 → worker（偽の X）→ お知らせ | 承認 200。worker は 1 回送り published。お知らせに「承認した予約の状態が変わりました／投稿済み」が出る | 10, 11 | PASS |
| R10 | B を A の owner に加える → 承認 | 403 `X_ACCOUNT_NOT_VERIFIED`。「接続、またはワークスペースの状態…接続し直すだけでは解決しないことがあります」。書込み 0 | 12 | PASS |
| R11 | A がログアウト → ログイン画面 | 入力欄は空 | — | PASS |
| R12 | B でログイン | B の X（@h_20818892758 = B の puid）だけが出る | 13 | PASS |
| R13 | B のお知らせ | 未読 0 件、お知らせはありません | 14 | PASS |
| R14 | B の承認画面 | 候補はまだありません（A の候補は出ない） | — | PASS |
| R15 | 日本語入力で `2026-12-05 10:00` を打つ | IME が「–」に変え、空白も消えた（`2026–12–0510:00`）。それでも 2026-12-05 10:00 JST で承認待ちになる | 15 | PASS |
| R16 | 日本語入力で 2/30 を打つ | IME が崩した文字列（`026ー0223010：002`）になり、送る前に赤い文で止まる。submit 0 | 16 | PASS |
| R17 | flag OFF（使い捨てのコピーで false にして開き直す）→ 承認・お知らせ | 「まだ使えません。ここからは何も送られません」。アプリの通信 21→21、Edge の関数ログ 189→189 | 17, 18 | PASS |
| R18 | 落ちた記録 | 0（DiagnosticReports に該当なし） | — | PASS |

### HTTP・PG17・worker の実測（H）

| # | 内容 | 結果 | 記録 | 判定 |
|---|---|---|---|---|
| H1 | 有効なときに、本人の JWT で直接 markRead | 200、read_at が書かれる | http-markread | PASS |
| H2 | 終了後に、直接 markRead | **403 `SERVICE_NOT_ACTIVE`、read_at は変わらない**（G3 #663 のサーバー側の守り） | http-markread | PASS |
| H3 | 終了後の notifications / get / submit | 200 / 200 / 403 | http-markread | PASS |
| H4 | 再開した後の markRead | 200 | http-markread | PASS |
| H5 | 終了の transaction を 3 秒持っている間に markRead | 2577 ms 待ってから 403、read_at は null のまま | http-markread | PASS |
| H6 | 同じ clientRequestId を 3 回（2 回は同時）、同じ承認を 3 回 | 候補 1・予約 1 | http-markread | PASS |
| H7 | worker: 期限が来た承認済みの予約 → 偽の X に 1 回 → published | `reservation_changed:published` と outbox が、list を呼ばなくても +1。もう一度動かしても claimed 0、X 呼出しは増えない | http-worker | PASS |
| H8 | X の答えが分からない | uncertain が 1 回だけ記録される。再実行・X を戻しても再送 0 | http-worker | PASS |
| H9 | 終了中に期限が来た予約 | claimed 0、お知らせも 0 | http-worker | PASS |
| H10 | 再開 + 再接続 | 前の接続の予約は送らずに `failed/SERVICE_GENERATION_CHANGED`。お知らせ・outbox は +1 | http-worker | PASS |
| H11 | B から C の候補・お知らせ | list 0、get・approve・reject・revise は 404、お知らせ 0 | http-cross-user | PASS |
| H12 | token なし、壊れた JWT、署名の壊れた JWT、ログアウト済みの JWT | すべて 401 | http-jwt, http-cross-user | PASS |
| H13 | server-final | 同じお知らせへの outbox の重複 0、同じ予約を指す候補の重複 0、偽の X 呼出しは合計 3（published 2、uncertain 1） | server-final | PASS |

### 第11 の FAIL の前 → 後、片方だけの状態

- 前（G2 第11、#659 + #653）: 開いたままの画面で markRead 200、read_at が書かれた
- 後（#665 + #663）: 画面は送らない（R3）。直接送っても 403（H2）
- UI だけの場合（#665 + #653）: G1 の第47 REPORT が「アプリの送信は 0、直接送ると 200」と実測している。**UI の修正だけでは、サーバーの認可が通ったことにはならない**
- サーバーだけの場合（#659 + #663）: G3 の第20 REPORT の AP21 が「直接送ると 403」と実測している。画面の切り替えは #665 が必要
- G2 はこの 2 つの片方だけの状態を作り直していない。上の 2 行は各担当の REPORT に書かれた値

### G1 の runner（実装者の試験。G2 の結果には数えない）

- 1 回目（`g1-runner-run1.txt`。Mac の負荷が 300 を超えていた）: T46 grouping「one call per row 1 !== 3」と T47「403 !== 200」が落ちた
- 2 回目（`g1-runner-run2.txt`）: 末尾 15 pass / 1 skip、承認の e2e 12/13
  - **T47 が「G3 still accepts it … 403 !== 200」で落ちる**。T47 は「G3 はまだ受け付ける（200）」ことを前提にしているが、#663 と合わせると 403 になるため、毎回落ちる
  - 製品の不具合ではない。G1 の試験の前提を、#663 の契約（403）に合わせて直す必要がある
  - 使い捨ての runner は、この失敗の後も止まらないように変えた（`throwaway.diff`）

## NOT_RUN

- 実 Push の配信（outbox に行ができるだけで、送る処理はない）
- 状態確認の RPC が「別の人」を返す場合の fail-close。実画面では作れなかった。G1 #665 の単体テストと e2e の範囲
- 実 iPhone、実 OAuth、実 X・SNS への投稿は範囲外で、PASS としていない

## 課題（P0〜P3）

- P0 / P1 / P2: なし。セキュリティ上の高リスクなし
- P3 G1（試験）: T47 e2e の前提「G3 は終了後も markRead 200」が #663 と合わない。最小の再現は、#665 + #663 で `approvals.e2e.mjs` を動かすと 432 行目で 403 !== 200
- P3 G1（画面）: 閲覧のみの画面に戻る・出る手段がない（R5、写真 06）。開き直すしかない
- 観察 G1: T46 grouping は負荷が非常に高いとき（load 300 超）に 1 回だけ 1 !== 3 で落ちた。2 回目は通った。待ち時間の扱いかどうかは調べていない
- 観察: 日本語入力では、IME が「-」を「–」に変えたり、空白を消したり、文字の順番を崩したりした。正しい入力は NFKC とダッシュの変換で読み取られ、崩れた入力は送る前に止まる。今回 2/30 そのものは崩れて打てなかったので、2/30 の拒否は G2 第11（実タップ）と parse-alt の結果を参照する（#665 は日時のコードを変えていない）
- 環境: Mac の負荷が 300 を超えた時間がある。入力が抜けたときは打ち直し、送る前に画面で確かめた

## 安全

- production/managed/hosted、実 X/Threads/Meta/OAuth/Push、有料 API、EAS・署名、merge・deploy・main への push はしていない
- G1/G3/G4/G5 の原本、H1 のレビュー用の worktree・container（h1pr663）、他の担当の端末には触れていない
  - 最後に panel を切り離したとき、他の端末（iPhone 17、G1-T49、G8）の表示 panel も閉じた。端末そのものは操作していない
- 偽の X の token は TEST ONLY の値。試験の人のメールアドレス・パスワード・JWT・worker secret は、文書・写真に入れていない（文字で検索して 0 件）
