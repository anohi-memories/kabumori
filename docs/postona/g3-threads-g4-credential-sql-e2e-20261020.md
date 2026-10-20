# G3｜Threads 予約を G4 の資格情報 SQL 候補・G5 の本物の判定とつなぐ隔離 E2E（2026-10-20、Issue #318 TASK 11/50）

- task_id: `postona-g3-threads-g4-credential-sql-isolated-e2e-20261020`
- 返却先: POSTONA G3のちゃ
- 完了コード: K3
- 判定: **SOURCE_ONLY（テスト・ランナー・文書だけ。使い捨て PG17・deny-net・偽の Threads Graph）／本番 NO_GO**
- 積み順: G3 PR #379（`25af9fc0679b1dfff6d2d135be5c0002665e7d80`）の上。007・dispatcher・fixture は変えていない。

## 0. PR #379 の task_id の訂正（この TASK の指示 1）
- `docs/postona/g3-threads-g5-real-sql-integration-20261020.md` の 3 行目と、PR #379 の本文の見出しを、正式な `postona-g3-threads-g5-sql-isolated-integration-20261020` に直した。
- PR #379 の HEAD は `349d21c32e3ae720310f547a576a42c925da04bb` から `25af9fc0679b1dfff6d2d135be5c0002665e7d80` に変わった。文書の 1 行だけの変更で、テスト・ランナー・SQL は変わらないため、テストの再実行は不要。
- 元の REPORT（6287890398）と訂正（6287969300）は残してある。

## 1. 何を組み合わせたか（どれも読み取り専用の写し。変えていない）

| 部品 | 持ち主・出どころ |
|---|---|
| 本物の 2a-2 の migration（`20261007150000`）と、G4-11 と同じ準備 | main。G4 PR #377 の木と同じバイト |
| PR #124 の Threads の OAuth（開始・完了）と、そのテスト用の fixture（偽の Vault の名前の列・偽の HMAC の鍵） | G4、PR #377 の木 |
| G4 の資格情報の保管の候補（`threads_account_credential_custody` と、期限を読む関数） | G4、PR #377 の木 |
| G4 PR #367 の結び付け（`state_generations`・`bindings`） | G4、`fd71450511f4a8d73e150a92bd9fe95677b70edc` |
| **G4 PR #377 の `credential_row(account, key)`**: 判断・トークン・G3 の世代を 1 つの文で返す | G4、`afab36d977bbc5588f4dce283bd5f05521b41733` |
| G4 の送信口（TS）と `threads_connect_to_send.ts` | G4、PR #377 の木（#373 の上）。もう一つの写しとして、**G4-12 の PR #381**（`8eefb3b63f4efba0727e99de980e0d56733d1d8e`、#373 の上）の TS に差し替えた木でも実行した |
| G3 PR #370 → G5 PR #303 → G5 PR #371 の R1・W1・W2 | G3・G5 |
| G3 の X の予約 001〜006、007 | G3 |

- 人物は、**G4 の本物の接続の流れ**で作った。登録 → #124 の開始 → #367 の世代の記録 → #124 の完了（偽のトークン・偽の HMAC）→ #367 の結び付けの確認 → G4 の保管の記録、の順。G4-11 の挙動テストと同じ手順で、30 人に、本物の形のアカウント ID `sa_<16 進 24 桁>` ができる。
- この実行の中に、G3 の 2a-2 の代役・保管の表の代役・G5 のテスト用の二重は無い。代役のまま残るのは、G4 の確認済みの判定（`t_threads.verified`）と、更新のリースの表の形だけ。
- 資格情報の口は 2 つを比べた。
  - G3 のテスト用の口: G4 の `credential_row` を、G4 の `parseThreadsCredentialRow` で読む。
  - G4 の出荷のままの口: `createGatedThreadsCredentialPort` を、同じ文の上で使う。

## 2. 適用の順番（ランナーの S0）
- #370 の前の #303 → 止まる。
- 007 の前の G4 #377 → `THREADS_CREDENTIAL_PRECONDITION_DEPENDENCY postona_threads_resv.threads_credential_generation` で止まる。G4 の SQL は、G3 の世代の関数に依存する。
- #370 → #303 → #124 → G4 の保管 → #367 → #371 → 007 → #377 の順なら、すべて入る。
- G5 の露出の検査は `NONE`。X の予約のスキーマの指紋は不変。

## 3. テスト（`postona_threads_g4_credential_run.sh` → `POSTONA_THREADS_G4_CREDENTIAL_ALL_PASS`、11 件。#377 の木と、#377 + #381 の TS の木の両方で合格）

| 番号 | 確かめたこと |
|---|---|
| K0 | `credential_row` の ACL は owner だけ。worker・anon・authenticated・service_role は呼べない（42501）。本物の 2a-2 の公開の禁止の制約がある。G4 の保管の表は RLS が有効。30 人が `sa_` のアカウント。G5 の本物の W1。 |
| K1 | **U8**: 本物の 2a-2 は、Threads の行の公開スイッチを OFF に保つ。そのため 007 は予約を拒否し（`PUBLISH_DISABLED`）、行はできない。その後、**テスト用だけの解除**（制約を外してスイッチを ON）をして先に進む。 |
| K2 | 正常系: `credential_row` の 1 つの文が、このアカウントの偽のトークンと 007 の世代を返す。G4 の送信口は、**そのトークンだけ**で 1 回だけ公開する。順番はコンテナ → 状態 → hook → 公開 → 読み戻し。W2 は保存した数で `active`。 |
| K3 | **U2**: G4 の出荷のままの口を、同じ文の上で使う。<br>・#377 の木（未修正）: `sa_` の ID を文の前で拒否する（文には行がある）→ `THREADS_CREDENTIALS_UNAVAILABLE`、Graph への要求 0 回。<br>・#381 の TS（G4-12 の修正）: `sa_` の ID を受け付け、**G4 の出荷のままの口 + G4 #377 の文 + G3 の dispatcher + G5 の本物で、1 回だけ公開**。トークンはこのアカウントのもの。 |
| K4 | `credential_row` が行を返さない → `THREADS_CREDENTIALS_UNAVAILABLE`、Graph 0 回。場面は次のとおり。<br>・キーが `kabumori`<br>・保管の期限切れ<br>・Vault の入れ替えが保管に記録されていない<br>・**U9**: 接続の後に再開した・接続の後に所有者が A → B → A になった → 予約の 2 つの数は今のもの（W2 は `active`）でも、G4 の結び付けは古い数のままで行が出ない |
| K5 | コンテナの待ちのあいだの変化は、どれも公開 0 回。<br>・資格情報の入れ替え → 007 の `CREDENTIAL_CHANGED`<br>・更新のリース → 戻され、後で 1 回だけ公開<br>・再開 → W1 の `SERVICE_GENERATION_CHANGED`（W2 も同じ） |
| K6 | 再確認の時間切れ → 公開 0 回。公開の不明 → uncertain、再送なし。待ちのあいだのリースの喪失 → 公開 0 回、後で `LEASE_EXPIRED`。 |
| K7 | 2 つの worker で 6 行 → それぞれ 1 回だけ。どのトークンも、その行のアカウントのもの。 |
| K8 | 他人の `sa_` アカウントへの予約は拒否。受領票は本人だけ（他人は 404）で、本文とトークンを含まない。 |
| K9 | U1: G4 の口は `x_autopost` だけで開く。U7: #377 の木ではコードの一覧に `SERVICE_GENERATION_UNAVAILABLE` が無い。#381 の TS では入っている。 |
| K10 | 処理されずに残った予約 0、露出の検査は `NONE`。 |

- 変異テスト（最終）: 8 個を入れ、**7 個を検出**した。G4 の SQL と TS は scratch の写しにだけ入れた（G4 の木には触らない）。007 は `THREADS_RESV_CANDIDATE` で入れた。
  - 検出した G4 の写しへの変異（4 個）: `credential_row` が W1 を飛ばす（K4）、保管の期限を無視する（K4）、どのキーでも答える（K4）、別の世代を返す（K2 ほか）。
  - 検出した 007 への変異（3 個）: 世代が保管を含まない（K5）、fence が公開スイッチを無視する（K1）、更新のリースを無視する（K5）。
  - **残った 1 個**: 「G4 の口が UUID の確認を外す」。K3 を、G4-12（#381）の修正後の正しい振る舞い（`sa_` の ID を受け付ける）でも合格するように変えたため、この変異は修正後と同じ結果になる。最初の版の K3（UUID だけを受け付ける前提）では検出していた。形の正しくない ID を口に渡す確認は G4 の単体テスト（#381 の `social_account_id_cases.ts`）の範囲で、G3 はしていない。
- 回帰（すべて合格）:
  - #379 → `POSTONA_THREADS_G5_REAL_ALL_PASS`
  - #374 → `POSTONA_THREADS_CROSS_OWNER_ALL_PASS`
  - #360 → `POSTONA_THREADS_RESV_ALL_PASS`・`POSTONA_THREADS_HTTP_WORKER_ALL_PASS`
  - Deno の単体 109 件

## 4. 契約ごとの状態

| # | 契約 | 状態 | 持ち主 |
|---|---|---|---|
| U1 | サービスキー `x_autopost` | PR #373 の上の #377 の木では、G4 の口が `x_autopost` だけを受け付ける。受入前 | G4 |
| U2 | 本物のアカウント ID（文字列） | #377 の木（#373 の TS）では未修正。**G4-12 の PR #381 では修正されている**（K3 で、出荷のままの口のまま 1 回公開できた）。#381 は Draft・受入前 | G4 |
| U3 | 資格情報の 1 文の SQL | **G4 #377 で合った**。判断・トークン・007 の世代が 1 つの文で返り、dispatcher の世代の比較と一致する（K2）。ただし、dispatcher の役割への付与は無い（K0。別の、レビュー付きの手順） | G4 |
| U7 | W1/W2 のコード `SERVICE_GENERATION_UNAVAILABLE` | #377 の木では未修正。**#381 で修正されている**（K9）。受入前 | G4 |
| **U8（新）** | **Threads の自動投稿のスイッチ** | 本物の 2a-2 は Threads の `publish_enabled` を常に OFF にする（CHECK `social_accounts_meta_publish_disabled`）。G4 の手動投稿は、別の許可の表を使う設計。G3 の予約（007）はこのスイッチ ON を求めるので、**本物の世界では予約が作れない**（K1）。<br>決める必要があること: (a) レビュー付きの解除の migration と、スイッチを ON にする本人の書き込み口を作るか、(b) 007 が予約投稿用の別の許可（手動投稿の許可の表と同じ形）を読むか。<br>G3 は決めず、テスト用の解除で先の経路を確かめただけ。 | G3 と G4（POSTONA の判断） |
| **U9（新）** | **G4 の結び付けの有効期限** | G4 の `credential_row` は、接続の時の 2 つの数で W1 を呼ぶ。そのため、接続の後にサービスの世代が動く（再開・関係のない利用の開始・所有者の A → B → A）と、**再接続するまで資格情報が出ない**（K4）。安全側だが、本人には「再接続が必要」と見せる道が無い。 | G4・G5（UX）、G1（画面） |

## 5. 本番までに必要なこと（どれも未実施）
1. G4: U2・U7 の修正（#381）と U1（#373）の受入、#367・#377 のレビュー、#377 と #381 の積み順の整理（今は #373 の上の兄弟）、`credential_row` の dispatcher の役割への付与（別のレビュー）。
2. U8 の決定と、その実装（解除の migration か、007 の許可の読み先の変更）。G3 側の変更が要るなら、G3 の別の TASK にする。
3. U9 の本人への見せ方（再接続の案内）。
4. G5: #303・#358・#371 のレビューと受入。G3 #370 のレビュー（MAINTAIN・PUBLIC・BYPASSRLS は未検証）。
5. Codex Sol（高）のレビュー:
   - G3: #370・007・#356
   - G4: #124・保管・#367・#377
   - G5: #303・#371
6. 本番の作業時間で当てる順番: #370 → #303 → #371 → 2a-2 の解除（U8 の決定次第）→ #124 → G4 の保管 → #367 → 007 → #377 → 付与。その後に読み戻し。
7. x-test-post の本番の Cron の認証（#349・#352）は未確認のまま。

## 6. NOT_VERIFIED
- managed の Auth・DB・Vault（Vault は fixture の表）、本物のトークン・HMAC の鍵。
- 本物の Threads・Meta・Graph の応答。Edge・Cron。アプリ・実機。
- G4 の確認済みの判定（代役のまま）と、更新のリースの書き手。
- 本番の SQL の適用。どのレビューも、まだ受けていない。
