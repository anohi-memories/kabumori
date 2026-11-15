# G2-02 第15TASK — G1 #689 × G3 #690 通知の合成QA（第14 の未実行分の完遂）

- task_id: `postona-g2-gen2-15-compose-runner-typescript-native-terminal-qa-20261115`
- 合成した木: G1 PR #689 `c7b2ac41913530c574949293da6af87c3c44eedd` に、G3 PR #690 `0b5b997004a65c2b6bfae11add027f47f990b2ea` を手元だけで merge した
  - merge 後の HEAD は `374fc9cd246fc3c38d46d59f260f86b8771c9e91`（tree `ce9ee0ecd001efc2cf3fbf9facdaa254eea4c19d`）
  - 14 paths（SQL 3）、競合 0、push していない
  - #689 の祖先には G1 #675、#690 の祖先には G3 #663 が入っている（SQL を含む、正しい積み重ね）
- 次のものには触れていない: G3 #691（同じ task_id の未採用の候補）、第14 の記録（PR #693）、G1/G3/G5 の製品ソース
- AutoDev は、この TASK を「実画面が必要」として人の担当に回していた（state: `needs_human_prefilter`）。そのため、くろちゃんが手で実行した
- 実行: 2026-11-15 13:26〜13:56 JST

## 結果

PASS 38 / FAIL 0 / NOT_RUN 1。製品の新しい不具合（P0〜P3）は見つかっていない。

| 種類 | PASS | FAIL | NOT_RUN |
|---|---|---|---|
| A. 環境の修正と、G3 runner の通し実行 | 2 | 0 | 0 |
| B. G2 独自の合成ドライバ（実 HTTP・DB） | 20 | 0 | 0 |
| C. iOS Simulator の実タップ | 9 | 0 | 0 |
| D. G1 runner（実装者の試験。参考） | 7 | 0 | 0 |
| 実 Push の配信 | — | — | 1 |

### A. 環境の修正（第14 の FAIL の原因）

- A1: 原因は、合成した木の `apps/social-mobile` に `node_modules` がなく、`typescript` を読み込めなかったこと
  - 使い捨ての木で、既存の lockfile どおりに `npm ci` を実行した。typescript 6.0.3 が入った
  - 製品の依存の定義（package.json と lock）は変えていない
  - **環境が原因で、ソースの修正は不要**（G3 へ差し戻す必要はない）
- A2: G3 の `run.sh` を、合成した木でそのまま通した
  - Deno 45/45、G1 画面統合 11/11、`G3LS_LOCAL_STACK_PASS`（`g3-runner-summary.txt`）
  - 第14 で落ちた G1 画面統合のステップも通った
  - これは G3 の試験で、G2 の独自の結果ではない

### B. G2 独自の合成ドライバ（`driver/g2-15-driver.mts` → `driver-result.txt`）

G1 #689 の実物（`approval-client.ts` の client と `notification-pages.ts` の walk、変更なし）を読み込み、画面の hook と同じ順で HTTP を送った。経路は G1 の runner の実環境（GoTrue → Kong → Edge（G3 #690）→ PG17、127.0.0.1 だけ）。行は SYNTHETIC。

| # | 内容 | 結果 |
|---|---|---|
| D1 ×9 | 0/50/51/100/101/150/151/279/300 件 | 全件が 1 回ずつ（DB の id と一致）。厳密に新しい順。最終ページは nextCursor null。要求数は計算どおり（1/1/2/2/2/2/3/4/4）、最終ページの後の追加要求 0 |
| D1-past-end | 最終カーソルの後をサーバーに直接聞く | 200、0 件、null |
| D2 | 2,001 件 | 20 ページで止まる（1,950 件、`capped`）。21 回目の要求は 0 |
| D3-client | 壊れた cursor（0、-1、1.5、安全な整数の外） | client が送る前に REQUEST_INVALID。送信 0 |
| D3-server | 壊れた cursor・limit を直接送る（9 種類） | すべて 400 REQUEST_INVALID、行 0 |
| D4 | walk の途中で、新しい行 5 件の追加・未読の古い行 1 件の削除・既読 | 重複 0、順序は正しい。消した行は出ない。新しい行は後のページに混ざらない（299 件）。markRead 200 |
| D5 | A/B（B が A の cursor を使う場合も含む） | B は自分の 3 件だけ。A の cursor でも 0 件。漏れ 0 |
| D6 | サービス終了後 | ページは読める（130 件）。markRead は 403 SERVICE_NOT_ACTIVE、submit は拒否。行と既読の数は変わらない（130:0 → 130:0） |
| D7 | ログアウト・読み直しの後に、前の walk の答えが遅れて届く | 何も加えない（added=false） |
| D8 | limit 100 のページと look-ahead の間で、実 GoTrue からログアウトする（G3 L44 と同じ 3 秒の待ち） | 401 AUTH_REQUIRED、行 0。次の要求も 401 |
| D9 | look-ahead だけが一時的に失敗する（TEST-ONLY の fault で limit 1 の呼び出しに SERVICE_BUSY） | 100 件と cursor は残る。次のページで残りの 50 件と null が返る。fault は元に戻したことを確認した |

### C. iOS Simulator の実タップ（専用の `G2-INT15-20261115`、操作ごとに UDID を指定）

| # | 操作 | 結果 | 記録 |
|---|---|---|---|
| R1 | 130 件のある A でお知らせを開く | 最初のページの 50 件、未読 50件 | 01 |
| R2 | 一番下まで | 「さらに読み込む」が出る | 02 |
| R3 | 押す | notifications が 1 回だけ増える（合計 2） | — |
| R4 | 一番下まで | 「これより古いお知らせはありません。」。さらに読み込むボタンは出ず、追加の要求は 0（合計 2 のまま） | 03 |
| R5 | 画面を開いたまま、別の場所でサービスを終える → 未読を押す | markRead 0、DB は 130 行とも未読のまま。退会済みの gate に切り替わる | 04 |
| R6 | 閲覧のみを開く | 通信は notifications だけ。書込み 0 | 05 |
| R7 | 上の「‹ 戻る」→「利用登録する」 | active に戻ってホームに入る | — |
| R8 | サーバー側で A の session を消す → お知らせを開く | 401 AUTH_REQUIRED。行は表示されず「ログインを確認できませんでした。ログインし直してください」 | 06 |
| R9 | 落ちた記録 | 0 | — |

### D. G1 runner（実装者の試験。G2 の結果とは別）

- 末尾 15 pass / 1 skip
- 承認の e2e 17/18。1 回目に T47 だけが「only reads: [] vs ['notifications']」で落ちた
  - 落ちる前の確認（markRead 0、未読のまま、閲覧のみ）は通っていた
  - 同じ環境で T47 だけを 2 回動かすと、2 回とも PASS した（`g1-t47-rerun.txt`）
  - 負荷が 700 台から下がる途中だった。通信の数え方の時間に依存して揺れたと見られる
  - 製品の不具合ではないと判断した。G1 には観察として返す
- G1T51_PAGING、G1T52_FINAL_PAGE、T44〜T46 は PASS

## NOT_RUN

- 実 Push の配信。実 iPhone・実 OAuth・実 SNS 投稿は範囲外で、PASS としていない

## 課題

- P0〜P3（製品）: なし
- 観察 G1: T47 e2e の「読み取りだけ」の確認が、高い負荷の後に 1 回だけ空の配列になった。再実行は 2/2 PASS
- 観察 G3: 第14 の「typescript 欠落」は、木の作り方（`npm ci` をしていない）が原因で、G3 のソースの問題ではない。差し戻し候補を取り下げる
- 環境: Mac の負荷が一時 740 まで上がった（build の最中、この作業の外のプロセスも含む）

## 安全

- production/managed/hosted、実 X/Threads/Meta/OAuth/Push、有料 API、EAS・署名、merge・deploy・main への push はしていない
- 他の担当の worktree・container・端末には触れていない
  - 今回は、すべての操作で端末を指定した。他の端末にはタップしていない
  - panel の切り離し（detach）もしていない。自分の端末を削除しただけ
- TEST-ONLY の fault（D9）と barrier（D8）は、使い捨ての DB で入れて、その場で外した
- 試験の人のメールアドレス・パスワード・JWT は、文書・写真に入れていない（文字で検索して 0 件）
