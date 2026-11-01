# G3｜Threads 予約の G3・G4・G5 横断のオフライン E2E ゲート（2026-10-20、Issue #318 TASK 9/50）

- task_id: `postona-g3-threads-cross-owner-offline-e2e-gate-20261020`
- 返却先: POSTONA G3のちゃ
- 完了コード: K3
- 判定: **SOURCE_ONLY（テスト・fixture・文書だけ。使い捨て PG17・deny-net・偽の Threads Graph）／本番 NO_GO**
- 積み順: G3 PR #360（`266e6119f36c3d1a7a451a6254a5b26a569e7e0b`）の上。G3 の製品のコード・007 の SQL は変えていない。

## 1. 何を組み合わせたか
一つの予約を、作成から受領票まで、三者の部品をつないで流した。

| 持ち主 | 使ったもの | 形 |
|---|---|---|
| G3 | 候補 007（作成・`claim_due`・`preflight`・`record`・`receipt`）、テスト用の HTTP 入口、PR #356 の dispatcher と `beforePublish` | この木のまま |
| G4 | **本物の** `threads_send_port.ts`・`threads_publish_contract.ts`・`g5_owner_epoch_token.ts` | 固定した G4 の head の**写し**を、変えずに読み込む（`THREADS_G4_SOURCE_DIR`）。G4 の木と PR には触らない |
| G5 | R1・W1 のテスト用の二重（`tests/g5_verdict_test_double.sql`） | PR #360 と同じ |
| Threads | **偽の Graph API**（プロセスの中の `fetch`）。コンテナの作成 → 状態 → 公開 → 読み戻し | 本物の Threads・Meta には届かない |

- 送信は G4 の `createGatedThreadsSendPort(true, 'simulated', 偽の Graph)` で行った。G4 のコンテナの待ちと、`beforePublish` を 1 回だけ await する部分も、G4 の本物のコードのまま。
- 資格情報は G3 のテスト用の **1 文**の SQL で読んだ（判断・偽のトークン・007 の世代を同時に返す）。行の形は G4 の `parseThreadsCredentialRow` で読んだ。
- Deno の許可は `--allow-net=127.0.0.1:<port>` だけ。Threads・Meta・X のホストへの許可は無い（X0 で確認）。
- G4 の写しは 2 つの版で流した。
  - PR #364（`6fe75405196baa52f1b71936f87569b070904e77`、承認済みの口）
  - PR #373（`61e94a10026df2eb6aa5f3acdc4f4512c4cb96fd`、G4-10 は作業中で受入前。参考）

## 2. テスト（`postona_threads_cross_owner_run.sh` → `POSTONA_THREADS_CROSS_OWNER_ALL_PASS`、17 件）

| 番号 | 確かめたこと |
|---|---|
| X0 | Threads・Meta・X のホストへのネットワーク許可が無い。dispatcher の定数は OFF のまま。 |
| X1 | 一つの流れが、偽の Graph の上で**この順番**になる: コンテナ → 状態 → `beforePublish`（W1 をもう一度）→ 公開 → 読み戻し。結果は published・`simulated`。保存した 2 つの数（owner_epoch・lifecycle_version）は書き換わらない。偽の Graph に届いたのは、このアカウントの偽のトークンだけ。 |
| X2 | G4 のコンテナの待ちのあいだに、次の変化が起きると `beforePublish` が false になり、**公開の要求は 0 回**。行には W1 のコードが残り、uncertain にはならない。2 つの数も不変。<br>・サービスの停止と再開（同じ瞬間の ABA）→ `SERVICE_GENERATION_CHANGED`<br>・所有者の A → B → A → `OWNER_EPOCH_CHANGED`<br>・削除の開始 → `ACCOUNT_DELETION_IN_PROGRESS`<br>・利用の終了 → `SERVICE_NOT_ACTIVE`<br>・G4 の資格情報の入れ替え → 007 が取得の時の世代と比べて先に止める（`CREDENTIAL_CHANGED`） |
| X3 | 再確認が例外になる・遅れる → G4 は公開しない。`THREADS_PREPUBLISH_UNVERIFIED`。 |
| X4 | hook が true の後（公開の要求の最中）に変化 → 1 回だけ公開。`after_freeze = true`。 |
| X5 | 公開が不明・読み戻しが不明・読み戻しが別人 → uncertain。受領票は `uncertain`・`action: none`・投稿 ID なし。次の worker の実行では何も送らない。 |
| X6 | コンテナの作成が不明 → コンテナの ID を持っていないので投稿にはならない。`THREADS_CONTAINER_UNKNOWN_NOT_POSTED`、公開 0 回。 |
| X7 | 待ちのあいだにリースを失う → 公開 0 回。リースが切れた後は uncertain（`LEASE_EXPIRED`）で、送らない。 |
| X8 | G4 の資格情報の世代（64 桁の 16 進）の不一致は、どれも Graph への要求 0 回。<br>・形は正しいが 007 と違う → `CREDENTIAL_GENERATION_CHANGED`<br>・大文字・短い → G4 の読み取りが拒否 → `THREADS_CREDENTIALS_UNAVAILABLE` |
| X9 | 2 つの worker が同時に 6 行を処理 → どの行も 1 回だけ公開。 |
| X10 | 公開の後で記録の答えが失われる → uncertain と数える。リースが切れたら uncertain で、送らない。 |
| X11 | HTTP: 同じ ID の 2 回の作成は 1 行で、公開も 1 回。他人の作業場所の Threads アカウントへの予約は拒否される。受領票は本人だけが見られ（他人は 404）、本文とトークンは含まれない。 |
| X12 | Cron の worker の役割は予約を作れない。API の役割は取得できない（どちらも 42501）。 |
| X13 | OFF・使えないときは、取得 0 回で Graph への要求も 0 回。対象は、dispatcher OFF、G4 の送信口が閉じている場合、G4 の配備用の送信口と資格情報の口。 |
| X14 | G4 の資格情報の口（出荷のまま）: サービスキーの門と、アカウント ID の門。§3 の U1・U2・U6。 |
| X15 | G4 の `g5oe` の読み取りと、007 の読み取りが、18 の例ですべて一致する（bigint の上限・先頭の 0・符号・余計な部分）。 |
| X16 | 処理されずに残った予約は 0。 |

- 変異テスト: 12 個を入れ、**10 個を検出**した。
  - 入れた場所: G3 の dispatcher（この worktree で、1 回ごとに元のバイトに戻した）、G4 の写し（scratch の写しだけ。G4 の木には触らない）、007（`THREADS_RESV_CANDIDATE`）。
  - 検出したもの: hook が常に true、読み戻しの不明を published にする、送信前の世代の比較を消す、コンテナの不明を uncertain にする、G4 が hook を飛ばす、G4 が別人の読み戻しを confirmed にする、G4 が UUID の確認を消す、007 の preflight が W1 を飛ばす、007 の記録が after_freeze を立てない、007 が先頭の 0 を受け付ける。
  - **残った 2 個**（この組み合わせでは起きない形）:
    - hook が世代を比べない: 007 は取得の時の世代を自分で比べ、違えば `CREDENTIAL_CHANGED` で先に止める（X2 の入れ替えの例）。「店は OK なのに世代だけ違う」答えを 007 は返さない。PR #356 の単体 P3 では検出している。
    - G4 が、例外を投げた hook の後に公開する: G3 の hook は例外を投げない（すべて false で返す）。G4 自身の単体テストの範囲。
- 回帰（変えていないことの確認）:
  - `postona_threads_reservations_run.sh` → `POSTONA_THREADS_RESV_ALL_PASS`
  - `postona_threads_http_worker_run.sh` → `POSTONA_THREADS_HTTP_WORKER_ALL_PASS`（16 件）
  - Deno の単体 109 件
  - 新しいテストの型検査・lint

## 3. 所有者の境界の未接続点（実測）

| # | 未接続点 | 証拠 | 持ち主・次の一歩 |
|---|---|---|---|
| **U1** | PR #364 の G4 の資格情報の口は、G5 の共通のキー `x_autopost` を拒否する → 口が使えない → dispatcher は何も取得しない。 | X14（#364 の写し） | **G4**: G4-10（PR #373）で `x_autopost` だけを受け付けるように変更中。#373 の写しでは開く。受入前なので UNKNOWN 扱い。 |
| **U2** | G4 の資格情報の口（`credentialFor`）と結び付け（`threads_account_binding.ts`）は、**UUID の形のアカウント ID しか受け付けない**。本物の `public.social_accounts.id` は文字列（CHECK `^[a-z][a-z0-9_]{1,80}$`、main の `20261007150000` が固定）。G4 自身の PR #124 は `sa_<16 進 24 桁>` を作り、G4 の PR #367 も `social_account_id text references public.social_accounts (id)` を使う。**本物の行には、資格情報も結び付けも渡らない**。 | X14: `th_88` と `sa_0123…` の両方で `credentialFor` が null → `THREADS_CREDENTIALS_UNAVAILABLE`、Graph への要求 0 回（#364・#373 の両方） | **G4**: ID の確認を、DB の CHECK と同じ形にそろえる必要がある。差分の提案は G4 Issue #319 に 1 回だけ通知する。G3 は G4 のファイルを変えない。 |
| U3 | 資格情報の **1 文**の SQL（判断・トークン・世代を同時に返す）が無い。#367 は結び付けの世代を保存するだけで、トークンを返さない。 | G3 はテスト用の 1 文（偽のトークン）で代えた | **G4**（SQL）・**G3**（世代の関数は 007 にある）。Sol のレビューの対象。 |
| U4 | G4 の縦の流れ（`postOnce` と W2）は、PG の上では流せない。結び付けが UUID を求め（U2）、W2 の二重も無いため。 | — | G3 の dispatcher は、007 の中で W1 を使う（取得・preflight・`beforePublish`）。W2 は G4 の手動の流れの道。 |
| U5 | G5 の R1・W1 はテスト用の二重。本物（PR #358・#371）は未適用。PR #303 の install の前提の G3 PR #370 も、レビューが終わっていない（MAINTAIN・PUBLIC・BYPASSRLS は未検証）。 | — | **G5**・**G3**。Sol のレビュー。 |
| U6 | PR #364 の G4 の門の付いた口は、G5 のキーでない**仮のキー**（例 `threads_autopost`）でも開く。配備用の口はキーが null なので閉じている。 | X14 | #373 で `x_autopost` だけになる。G4-10 の受入で解消する見込み。 |

## 4. 統合の候補に必要な最小の積み順
1. G5: #303（前提: G3 #370）→ #351 → #358 → #371
2. G4: #337 → #341 → #347 → #359 → #364 → #373（+ U2 の修正）→ #367、と資格情報の 1 文の SQL（U3）
3. G3: #334 → #339（007）→ #343 → #356 → #360 → **この PR**（テストだけ）
4. 本物の部品で、この横断のテストを流し直す（G5 の本物の R1・W1、G4 の資格情報の 1 文）。
5. 実機・本番まで: 007 の migration 化（G3）、Edge・Cron（G3）、G4 の本物の送信口の配備、Meta のアプリの審査と権限、x-test-post の本番の Cron の認証（G3 PR #349・#352）。

**Codex Sol（高）のレビューの対象**:
- G3: #370、007（#339・#360）、dispatcher と hook（#356）
- G5: #303・#358・#371
- G4: 送信口（#359・#364・#373）と、資格情報・結び付けの SQL（#367 と U3）

## 5. NOT_VERIFIED
- 本物の Threads・Meta・Graph の応答（偽の Graph の応答の形は、G4 の `threads_publish_contract.ts` が読む形に合わせただけ）。
- G4 の本物の資格情報の 1 文、本物のトークン、Vault。
- G5 の本物の R1・W1・W2。managed の Auth・DB・RLS。
- Edge・Cron・付与。アプリ・実機。
- G4-10（PR #373）は作業中で、受入前。
