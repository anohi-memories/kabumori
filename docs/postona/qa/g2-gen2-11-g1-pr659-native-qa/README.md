# G2-02 第11TASK — G1 #659 承認・通知UXの実タップ統合QA

- task_id: `postona-g2-gen2-11-g1-pr659-approval-notification-native-four-not-run-and-regression-qa-20261112`
- 対象: G1 PR #659 `bddbd369f2fe3545d58d6bf52df35909cb64ab42`（base `fedddba4dec6ec2765ba92fdb5a674becf697f43`）に G3 PR #653 `7794538644fe54f5248e250195be4545706898c1` を手元だけで merge（`03b2e5de704d0ef880583b2b34f6b82275659b4e`、競合 0、push なし）
- 環境: G1 runner（project g1xs、127.0.0.1:56521 だけ）、専用 Simulator `G2-INT11-20261112`（iPhone 17 Pro / iOS 27.0、終了後に削除）、Metro 8081
- 実タップ: 2026-11-12 21:35〜22:19 JST
- 製品ソースは変更なし。flag・接続先は使い捨てツリーだけで変更（`throwaway.diff`）。このフォルダは G2 の文書と記録だけ

## 結果

PASS 25 / FAIL 1 / NOT_RUN 1。内訳は実タップ 21 PASS + 1 FAIL、HTTP・代わりの計測 4 PASS。

| # | 操作（実タップ） | 結果 | 記録 | 判定 |
|---|---|---|---|---|
| R1 | Aでログイン → 設定 | 素材BOX・投稿の承認・お知らせが並ぶ | 01, 02 | PASS |
| R2 | 素材BOX を開く → 戻る | 開いて表示、戻れる | 03 | PASS |
| R3 | 日本語キーボードで日時。変換候補から全角の年・長音「ー」・全角「：」を選んで送る | 承認待ちになり、DB は `2026-11-21 09:30` JST | 04, 05 | PASS |
| R4 | 日本語キーボードで `2026-02-30` | 送る前に止まる。submit 0、行 0 | 06 | PASS |
| R5 | 日本語キーボードで今日の 09:30（過去） | 送る前に止まる。submit 0 | 07 | PASS |
| R6 | 半角で `2026-11-22 09:30` | submit 200、候補 1 | — | PASS |
| R7 | 別 session で A1 を 2 回修正 → お知らせ | A1 は 1 行にまとまり「以前の承認待ちのお知らせ 2件」。DB は未読 4 行、画面は未読 2件（重複しない） | 08 | PASS |
| R8 | gateway を止めてお知らせを押す | markRead が成功しないので、画面も DB も未読のまま | 09, 10 | PASS |
| R9 | gateway を戻して押す | markRead 200 が 3 回（同じ候補の 3 行）。開いた候補が出る。古い行は削除されず read_at が付くだけ | 11, server-final | PASS |
| R10 | A1（版 4）を承認 → 予約の管理 | 予約 1、予約済み | 12, 13 | PASS |
| R11 | 予約の管理で時刻を `2026-11-23 10:00` に変更 | DB `planned` 2026-11-23 10:00（予約画面と日時欄が両立） | 14 | PASS |
| R12 | B を A の workspace の owner に追加 → A2 を承認 | 403 `X_ACCOUNT_NOT_VERIFIED`。画面は「接続、またはワークスペースの状態を確認できなかった…接続し直すだけでは解決しないことがあります」で、再接続を言い切らない。書込み 0。B を外すと承認 200 | 15, 16, 17 | PASS |
| R13 | 別 session で A3 を修正 → 古い画面で承認 | 409 STALE、版 2 を読み直し、書込み 0 | 19 | PASS |
| R14 | gateway を止めて承認 → 戻して押し直す | 黄色の「結果を確認できず…二重には作られません」、行 0。戻すと 1 回だけ承認（予約 3） | 20, 21 | PASS |
| R15 | X を再接続（アプリの外）→ A4 を承認 | 409 GENERATION_CHANGED、「修正して承認に回し直す」 | 23 | PASS |
| R16 | 複数候補・世代のお知らせ | 候補ごとにまとまり、画面の未読 7件 = DB の未読 7 行 | 22 | PASS |
| R17 | サービスを終了 → 修正して回し直す | 403 SERVICE_NOT_ACTIVE、表示を閉じる。読み直しても書込み 0 | 24, 25 | PASS |
| R18 | 終了後、開いたままのお知らせで未読を押す | **markRead 200 が送られ、read_at が 1 行書かれた**（DB の既読 5→6 行） | 26, 27 | **FAIL（P3）** |
| R19 | A ログアウト → B | 入力欄は空。B には B の X（@h_444848627790 = B の puid）だけ。お知らせ 0、承認 0 | 28, 29, 30 | PASS |
| R20 | B ログアウト → A | 「退会済み」と「これまでの承認とお知らせを見る（閲覧のみ）」 | 31 | PASS |
| R21 | 閲覧のみを開く・項目を押す | A の候補 4 件とお知らせだけ。通信は get 4 回と notifications 1 回だけ、書込み 0 | 32, 33 | PASS |
| R22 | 使い捨てコピーで承認 flag を false に戻して再起動（B） | 退会画面に閲覧ボタンなし。承認・お知らせは「まだ使えません…何も送られません」。アプリの通信行 36→36、Edge の関数ログ 115→115（外部呼出 0） | 34, 37, 38 | PASS |

HTTP・代わりの計測:

- H1 `parse-alt.txt`: G1 の parseJstInput に 21 種類の入力。全角・U+30FC・各ダッシュ・U+2212・U+FF0D・U+2011・全角空白・全角コロン・空白なし・末尾全角空白・U+FF70 を受け付け、`/`・`T`・他の文字の数字・2/30・過去・24:00 を拒否 — PASS
- H2 `http-probe.txt`: B は A の list が 0 件。get・approve・reject・revise は 404。B のお知らせ 0。token なし 401、壊れた JWT 401 — PASS
- H3 `dup-probe.txt`: 同じ clientRequestId で 3 回（2 回は同時）→ 候補 1・お知らせ 1・outbox 1。同じ承認 3 回 → 予約 1（本文ラベルは前回の script のまま `G2T10-dup`） — PASS
- H4 `after-end-outside.txt`: 終了後、list・notifications 200、submit 403 — PASS
- server-final: outbox の同じ通知への重複 0、同じ予約を指す候補の重複 0、B の行 0
- 落ちた記録: 0（DiagnosticReports に該当なし）

NOT_RUN: 実 Push の配信（outbox に行ができるだけ）。実 iPhone・実 OAuth・実 SNS 投稿はこの試験の範囲外で、PASS としていない。

## 課題（P0〜P3）

- P0/P1/P2: なし
- P3 G1/G3（R18）: サービス終了後、開いたままのお知らせ画面では未読を押すと markRead が送られ、サーバーも 200 で read_at を書く。閲覧のみの画面では送らない（R21）。TASK の「終了後の markRead 書込み 0」と合わない。G1 は終了を検知したらお知らせ画面も閲覧のみに切り替える、G3 は終了後の markRead を拒否するかを決める
- 観察: flag OFF のときも B のアカウント画面は「接続記録あり・未確認」（35）。G1 第46 の説明どおり（S7 は設計）
- 観察: 日本語キーボードでは同じキーを続けて押すと文字が回るため、数字を 1 つずつ間をあけて打った。Mac の負荷が 22:00 JST ごろ 16 まで上がり、「0」が 1 回抜けたので打ち直した。送る前に画面で確かめている
- 環境: G1 runner の 1 回目は G3 の fixture 点検（`social_mobile_account_deletion_fixture.sql` の error 行数）で止まり、2 回目で通った

## 安全

- production/managed/hosted、実 X/Threads/Meta/OAuth/Push、有料 API、EAS、merge・deploy・main への push はしていない
- 他の担当の worktree・Metro・Podman・端末には触れていない。最後の panel の切り離しで、他の端末（iPhone 17、G8 の端末）の表示 panel も閉じた（端末そのものは操作していない）
- 試験の人のメールアドレス・パスワードは文書・写真に入れていない。ログイン画面の写真は残していない
