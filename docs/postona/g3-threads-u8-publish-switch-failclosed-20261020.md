# G3｜U8 Threads の投稿スイッチ: 決まるまで予約を作らない・送らない隔離ゲート（2026-10-20、Issue #318 TASK 12/50）

- task_id: `postona-g3-threads-u8-publish-switch-failclosed-offline-20261020`
- 返却先: POSTONA G3のちゃ
- 完了コード: K3
- 判定: **SOURCE_ONLY（テスト・ランナー・文書だけ。使い捨て PG17・deny-net・偽の Graph）／本番 NO_GO**
- 積み順: G3 PR #382（`20090e950cc91c99598cd1d19ab315ceb5fcd20d`）の上。007・dispatcher・fixture は変えていない。
- U8 の持ち主: **G4**（Issue #319。2a-2 の CHECK と、本番の投稿の許可の実装）。G3 は 007・dispatcher・fixture、G5 はサービスの世代と認可を持つ。
- G4 の回答: G4 Issue #319 への G3 の通知（6288265105）に、まだ回答は無い（2026-10-20 20:10 JST 時点）。G4 の今の TASK は G4-12。**どちらの案も採用していない**。同じ通知は再投稿していない。

## 1. 何を実証したか
本物の 2a-2 の CHECK `social_accounts_meta_publish_disabled` を、**最初から最後まで有効のまま**にした（テスト用の解除はこの実行に無い。ランナーが前後で、制約が 1 つあり、スイッチ ON の Threads の行が 0 であることを確かめる）。そのうえで、G3 の 007 が次のとおり動くことを確かめた。
- 予約を作らない（行 0）
- 送らない（偽の Graph への要求 0）
- 自動で再試行しない
- 他人のアカウントの有無を漏らさない

この世界では、G4 の資格情報（#377 の行）も G5 の判定も、ふつうに答える。つまり、止めているのは投稿スイッチ（U8）だけである。

土台は PR #382 と同じ。G5 #371 の土台、本物の 2a-2、#370 → #303 → #124 → G4 の保管 → #367 → #371 → 007 → #377、G4 の本物の接続の流れの 30 人（`sa_…`）。G4 の TS は、#377 の木と、#377 + #381 の木の両方で流した。

## 2. テスト（`postona_threads_u8_gate_run.sh` → `POSTONA_THREADS_U8_FAILCLOSED_ALL_PASS`、10 件、2 つの G4 の写しで合格）

| 番号 | 確かめたこと |
|---|---|
| U0 | CHECK が有効で、スイッチ ON の Threads は 0。予約も 0。G4 の `credential_row` は行を返す（止めているのはスイッチだけ）。 |
| U1 | スイッチを ON にできない。owner は CHECK で 23514、service_role は 2a-2 のガードのトリガーで止まる（P0001）、authenticated は 42501。スイッチ ON は 0 のまま。 |
| U2 | 確認済みで資格情報もある 3 人の作成は、HTTP（同じ ID の繰り返しも）でも、API の役割で 007 を直接呼んでも、`PUBLISH_DISABLED`。行 0。G5 の数（owner_epoch・lifecycle_version）も動かない。 |
| U3 | G4 の確認を外した場合と、接続の途中（`authorization_pending`、#124 の開始だけ）の場合は `ACCOUNT_NOT_VERIFIED`。利用の終了と削除の開始は `PUBLISH_DISABLED`（fence が R1 より先）。どれも行 0。 |
| U4 | 存在の漏えいなし。他人の `sa_` のアカウントと、存在しないアカウントは**同じ答え**（スイッチの状態も明かさない）。 |
| U5 | create を通らずに入った行（owner が書いたテスト用のデータ。古い行や移行の行の代わり）も、Graph への要求の前に止まる。<br>・スイッチ OFF → preflight の fence で `NOT_PUBLISHABLE_AT_SEND`<br>・世代が古い → 取得の W1 で `SERVICE_GENERATION_CHANGED`<br>・削除の開始 → `ACCOUNT_DELETION_IN_PROGRESS`<br>・所有者の A → B → A → `OWNER_EPOCH_CHANGED`<br>2 回目の実行では何も取得しない（自動の再試行なし）。 |
| U6 | 不明な答え（資格情報の文が例外・preflight の答えが失われる）でも、Graph への要求は 0。preflight が読めないと、行は戻されるだけ（何も送っていない）。次の実行で `failed`（`NOT_PUBLISHABLE_AT_SEND`）になり、uncertain にはならない。3 回目は何も取得しない。 |
| U7 | 受領票: 本人には `failed`・`action: none`・投稿 ID なし・本文なし・トークンなし。他人には一定の 404。 |
| U8 | どちらの案も採用していない: 007 の fence は `publish_enabled` を読み、別の許可の表は無い。dispatcher が OFF なら取得 0。 |
| U9 | 公開 0・処理されずに残った予約 0・uncertain 0。スイッチ ON は 0 のまま。 |

- 変異テスト: 007 に 3 個を入れ、**3 個すべてを検出**した。
  - fence が公開スイッチを無視する → U2・U3・U4・U5・U6・U8
  - fence が、どのアカウントでもスイッチの状態を先に明かす → U4
  - preflight が fence の拒否を OK として扱う → U5・U6
- 回帰（すべて合格）:
  - #382 → `POSTONA_THREADS_G4_CREDENTIAL_ALL_PASS`（#377 の木、#377 + #381 の木）
  - #379 → `POSTONA_THREADS_G5_REAL_ALL_PASS`
  - #374 → `POSTONA_THREADS_CROSS_OWNER_ALL_PASS`
  - #360 → `POSTONA_THREADS_RESV_ALL_PASS`・`POSTONA_THREADS_HTTP_WORKER_ALL_PASS`
  - Deno の単体 109 件
  - 型検査・lint
- **参考**: TASK 11（PR #382）の K1 は、テスト用だけの解除の後で正常な経路を確かめた。これは参考用の fixture で、本番の接続の GO ではない。今回のゲートは、その解除を一切使っていない。

## 3. U8 の 2 つの案（G4 が決めるまで、どちらも採用しない）

| 観点 | (a) 2a-2 の CHECK の解除 + 本人の書き込み口 | (b) 予約投稿用の別の許可（G4 の手動投稿の許可の表と同じ形） |
|---|---|---|
| 意味 | `publish_enabled` を、Threads の自動投稿の本人の同意として使う | `publish_enabled` は OFF のまま。予約投稿には別の表の行（本人の明示の許可）を求める |
| G4 の仕事 | CHECK を外す、レビュー付きの migration。本人がスイッチを ON/OFF する definer の書き込み口（2a-2 のガードのトリガーは owner の書き込みだけを通す）。G4 の手動投稿の設計（「Threads の自動投稿のスイッチは OFF のまま」）の見直し | 許可の表（例: `social_account_scheduled_publish_permissions`）と、本人の付与・取り消しの口。手動の許可と分けるか一緒にするかの決定 |
| G3 の 007 の変更 | **無し**（fence は今のまま `publish_enabled` を読む） | fence の 1 か所: `v_sa.publish_enabled is not true` を「許可の行がある」に置き換える。preflight も同じ fence を通るので、そこで自動的に追従する。資格情報の世代（`threads_credential_generation`）に許可の行を含めるかは要検討（取り消しを送信の直前に必ず見るため）。**今回は作っていない** |
| 適用の順番 | #370 → #303 → #371 → **(a) の migration** → #124 → 保管 → #367 → 007 → #377 → 付与 | #370 → #303 → #371 → #124 → 保管 → #367 → **(b) の表** → **007（変更後）** → #377 → 付与 |
| 戻し方 | (a) を戻すと CHECK が戻る。ON の行があると CHECK を足せない（戻す前に OFF にするか、`NOT VALID` の扱いを決める）。G3 の予約は、すぐに `NOT_PUBLISHABLE_AT_SEND` で止まる（U5 と同じ） | 表を消すか、行を消す。007 の fence が許可なしで止める。007 を元に戻すなら (b) より先に |
| G5（owner_epoch・lifecycle_version）への影響 | 無し。スイッチは G5 の数を動かさない。G3 の予約の 2 つの数・W1 の照合は今のまま | 無し（G5 の世代とは別の事実）。許可の取り消しは G5 の数を動かさないので、007 が送信の直前に許可を読み直す必要がある |
| G4 の資格情報（#377）・2a-2 への影響 | `credential_row` は変更なし（スイッチを見ない）。2a-2 の CHECK が 1 本消える（Instagram にも及ぶので、Threads だけに絞るかの決定が必要） | `credential_row` も 2a-2 も変更なし |
| 本人への見え方（G1） | 画面に自動投稿のスイッチ（ON/OFF）が要る | 画面に予約投稿の許可（付与・取り消し）が要る。手動の許可と同じ画面にするかの決定 |
| Sol（高）のレビューの対象 | migration（CHECK の解除）、書き込み口（definer・ACL・ガードのトリガーとの関係） | 表・RLS・付与の口、007 の fence の差分 |

G3 の考え（決定ではない）: (b) は、G4 の手動投稿の設計（スイッチを OFF のまま）と矛盾しない。2a-2 の CHECK も Instagram に影響しないまま残せる。G3 の差分は fence の 1 か所で済む。ただし、どちらにするかは G4 と POSTONA の判断である。

## 4. G3 に必要な IF の差分（ほかの未決の点との照合）

| # | 内容 | 状態 | G3 に要る差分 |
|---|---|---|---|
| U8 | 投稿スイッチ | 未決（G4） | (a) なら無し。(b) なら 007 の fence の 1 か所と、世代に許可を含めるかの決定 |
| U9 | G4 の結び付けの有効期限（接続の後の世代の変化で再接続が必要） | 未決（G4・G5） | 無し。007 は `THREADS_CREDENTIALS_UNAVAILABLE` で止まる。受領票の `action` に「再接続」を足すかは G1 の画面と一緒に決める（今は `none`）。**G1 の UX の依存**: 再接続の案内とスイッチ／許可の画面 |
| U2・U7 | 本物のアカウント ID、新しいコード | G4 #381 で修正済み・受入前 | 無し（PR #382 K3・K9 で確認済み） |
| U3 | 資格情報の 1 文 | G4 #377 で合った・受入前。#377 と #381 は #373 の上の兄弟なので、積み順の整理が必要 | 無し。dispatcher の役割への `credential_row` の付与は、G4 の別のレビュー付きの手順 |
| U1 | サービスキー `x_autopost` | G4 #373・受入前 | 無し |
| G5 | R1・W1・W2（#371）、owner epoch（#303） | 未レビュー・未適用 | 無し |

## 5. 未完了のまま維持すること
- G3 PR #370 の権限のレビュー（MAINTAIN・PUBLIC・BYPASSRLS は未検証）。
- G3 PR #349・#352 の x-test-post の Cron の呼び出し元の認証（本番は未確認）。
- G5 #303・#371 の本番への適用。G4 の U8 の決定と、そのセキュリティのレビュー。
- production は NO_GO。

## 6. NOT_VERIFIED
- managed の Auth・DB・Vault、本番の 2a-2 の実際の状態（本番に Threads の行があるか、CHECK が入っているか）。
- 本物の Threads・Meta・Graph、Edge・Cron、アプリ・実機。
- (a)・(b) のどちらの実装も、作っていないし試していない。
