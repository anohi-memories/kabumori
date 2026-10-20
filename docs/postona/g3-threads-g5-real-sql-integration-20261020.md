# G3｜Threads 予約を G5 の本物の SQL 候補の上で流す（2026-10-20、Issue #318 TASK 10/50）

- task_id: `postona-g3-threads-g5-real-sql-isolated-integration-20261020`
- 返却先: POSTONA G3のちゃ
- 完了コード: K3
- 判定: **SOURCE_ONLY（テスト・ランナー・文書だけ。使い捨て PG17・deny-net・偽の Threads Graph）／本番 NO_GO**
- 積み順: G3 PR #374（`e3dfbd3cce3fffccdb638159f3aa6c3313d5098c`）の上。G3 の製品のコード・007 の SQL は変えていない（変更は不要だった）。

## 1. 何を組み合わせたか
これまでの G3 のテストは、G5 の R1・W1 を**テスト用の二重**で置き換えていた。今回は、G5 の**本物の SQL 候補**（本番には未適用）を、変えずにそのまま組み込んだ。

| 順 | 部品 | 出どころ（読むだけの写し） |
|---|---|---|
| 1 | G5 の土台: fixture・Phase 9 の認証の fixture・membership の migration・チェーンの migration 13 本 | G5 PR #371 の木（`7140e416e32bafc7ce6c0463c3821e7eac96d1f6`） |
| 2 | G3 の X の予約 001〜006 と、その代役 | この木 |
| 3 | **G3 PR #370** の brand_memberships の REVOKE 候補 | `05ef903c31c120634906fa8b62481711f4a37a4c` |
| 4 | **G5 PR #303** の owner epoch | PR #371 の木（#303 `88481aef…` は祖先） |
| 5 | **G5 PR #371** の R1・W1・W2（#351・#358 の上） | PR #371 の木 |
| 6 | G3 の 007、Threads の人物データ、G4 の確認済みの代役（`g4_g5_test_doubles.sql`。G4 の部分だけ） | この木 |
| 7 | G4 の**本物の**送信口（`threads_send_port.ts`）と偽の Graph | G4 PR #364 の写し（#373 の写しでも実行） |

- G5 の R1 は、JWT の中身（`sub`・`role`・`session_id`）に加えて、**本物の `auth.sessions` の行**を確かめる。そのため、テストは人ごとに本物のセッションの行を作る。
- `auth.uid()` は、G5 自身のランナーと同じく、JSON の claims も読む形に置き換えた（[A]。managed の振る舞いは NOT_VERIFIED）。
- この実行の中に、G5 のテスト用の二重は無い（`t_g5` のスキーマは 0、R1・W1・W2 の本文に `TEST_DOUBLE` は無い）。

## 2. 適用の順番（ランナーの S0）
- G5 が無い状態で 007 を当てる → `POSTONA_THREADS_RESV_PRECONDITION_G5_VERDICT` で止まる。
- #370 の前に #303 を当てる → `OWNER_EPOCH_PRECONDITION_API_ROLE_CAN_CREATE_MEMBERSHIP_TRIGGERS` で止まる。
- #370 → #303 → #371 → 007 の順なら入る。G5 の露出の検査は `NONE`。
- 007 の SQL を変えずに、本物の G5 の上に入った。

## 3. テスト（`postona_threads_g5_real_run.sh` → `POSTONA_THREADS_G5_REAL_ALL_PASS`、12 件）

| 番号 | 確かめたこと |
|---|---|
| R0 | R1・W1・W2 は G5 の本物（二重ではない）。007 は本物の W1 を呼ぶ。#370 の取り上げが入っている。G5 の露出の検査は `NONE`、世代のトリガーの検査は true。 |
| R1 | 一つの予約: HTTP の作成の中で本物の R1 が allow を返し、`g5oe:<epoch>:<lifecycle>` の 2 つの数がそのまま保存される。W2（service_role）を同じ数で呼ぶと `active`。取得（W1）→ preflight（W1）→ G4 の送信口 → `beforePublish`（W1）→ 公開 → 読み戻しの順で、**偽の公開は 1 回だけ**。保存した数は書き換わらず、G5 の数も動かない。 |
| R2 | G4 のコンテナの待ちのあいだの変化は、どれも**公開の要求 0 回**・uncertain 0。**W2 を保存した数で呼ぶと、007 が記録したコードと同じ**答えになる。<br>・停止 → 再開 → `SERVICE_GENERATION_CHANGED`<br>・**一つのトランザクションの中で**停止 → 再開 → `SERVICE_GENERATION_CHANGED`<br>・所有者の A → B → A → `OWNER_EPOCH_CHANGED`<br>・削除の開始 → `ACCOUNT_DELETION_IN_PROGRESS`<br>・`x_autopost` の終了 → `SERVICE_NOT_ACTIVE` |
| R3 | 取得の時の本物の W1: 世代が古い → `SERVICE_GENERATION_CHANGED`、2 つの数が無い → `EXPECTED_OWNER_EPOCH_REQUIRED`、所有者が 2 人 → `WORKSPACE_OWNER_UNKNOWN`。どれも取得されず、Graph への要求も 0 回。 |
| R4 | 作成の時に本物の R1 が許可しない → 行はできない: 取り消したセッション・期限切れのセッション・利用の終了・他人の作業場所のアカウント・所有者が 2 人（R1 は `unknown`）。 |
| R5 | 007 を API の役割で直接呼ぶ: claims なし・`role: anon`・匿名の利用者 → どれも `POSTONA_*` で止まり、行はできない。 |
| R6 | 役割: worker は R1・W1・W2 を呼べない。API の役割は W1・W2 を呼べない。service_role は W1・R1 を呼べない（どれも 42501）。 |
| R7 | `beforePublish` が true を返した後（公開の要求の最中）の再開 → 1 回だけ公開、`after_freeze = true`（記録の時の本物の W1）。 |
| R8 | 再開の**後に**同じ ID で作成を繰り返す → **同じ行が返り、古い 2 つの数のまま**（今の数で上書きしない）→ 取得の時に `SERVICE_GENERATION_CHANGED`。 |
| R9 | 作成のトランザクションが戻る → 行は無く、G5 の数も動かない。待ちのあいだのリースの喪失 → 公開 0 回、後で `LEASE_EXPIRED` の uncertain。 |
| R10 | 公開の不明 → uncertain、再送なし。G4 の出荷のままの資格情報の口の門（U1・U2）の回帰の確認。#364 は `x_autopost` を拒否し、文字列のアカウント ID には資格情報が渡らない。 |
| R11 | 処理されずに残った予約は 0。G5 の露出の検査は `NONE` のまま。 |

- G4 #364 の写しでも、#373 の写しでも 12 件が合格した。
- 変異テスト: 007 に 8 個を入れ（`THREADS_RESV_CANDIDATE`。G5 のファイルには入れない）、**7 個を検出**した。
  - 検出したもの: 同じ ID の繰り返しで今の数に上書き（R8）、取得で W1 を飛ばす（R3）、preflight で W1 を飛ばす（R2）、after_freeze を立てない（R7）、W1 に 2 つの数を逆に渡す、epoch を lifecycle にも保存する、W1 の別の答えを active にする。
  - 残った 1 個: 作成で R1 の `unknown` も受け付ける変異。本物の R1 の `unknown` にはトークンが無いので、次のトークンの読み取りで必ず止まる（同じ結果）。
- 回帰（変えていないことの確認）:
  - #374 の横断ランナー → `POSTONA_THREADS_CROSS_OWNER_ALL_PASS`
  - #360 の 2 つのランナー → `POSTONA_THREADS_RESV_ALL_PASS`・`POSTONA_THREADS_HTTP_WORKER_ALL_PASS`
  - Deno の単体 109 件

## 4. G3 に必要な契約の変更
**無い**。007 は、G5 の本物の R1・W1 にそのまま合った。トークンの形、bigint の範囲、W1 のコード（`^[A-Z][A-Z0-9_]{1,63}$` のまま行に残る）、R1 の呼び出し（definer の中の JWT の settings）、W1 の ACL（owner だけ）が、すべて合った。

気づいたこと（変えていない）:
- 007 の作成は、R1 の allow 以外を、すべて `POSTONA_THREADS_RESV_SERVICE_NOT_ACTIVE` にまとめる（セッション切れ・所有者が 2 人なども同じ）。安全側だが、利用者への理由の表示が粗い。画面（G1）が理由を出したいときは、R1 の `reason` を受領票に通す小さな変更の候補になる（今回は作っていない）。
- W1 には、G5 #371 で `SERVICE_GENERATION_UNAVAILABLE` が加わった。G3 の 007 はそのまま行に残し、受領票の `action` は `none` になる（本人の再確認ではなく、運用の問題のため）。この場面を作るにはトリガーを壊す必要があり、範囲の外なので試していない。

## 5. 所有者の境界で残ること
| # | 内容 | 持ち主 |
|---|---|---|
| U1 | G4 #364 は `x_autopost` を拒否する（#373 で採用中・受入前） | G4 |
| U2 | G4 の資格情報の口と結び付けが UUID のアカウント ID しか受け付けない（#374 で通知済み。G4-11 で対応中の可能性） | G4 |
| U3 | 資格情報の 1 文の SQL が無い（G4-11 の TASK） | G4 |
| U7（新） | G4 の W1/W2 のコードの一覧（`G5_WORKER_VERDICT_CODES`）に、G5 #371 の `SERVICE_GENERATION_UNAVAILABLE` が無い（#364・#373 の両方）。G4 の縦の流れでは `WORKER_VERDICT_UNKNOWN` になる（安全側）。G4 Issue #319 に 1 回だけ通知。 | G4 |
| — | G3 PR #370 のレビューは終わっていない（MAINTAIN・PUBLIC・BYPASSRLS は未検証）。G5 #303・#358・#371 も未レビュー・未適用。 | G3・G5、Sol |

## 6. NOT_VERIFIED
- managed の Auth（本物の JWT・PostgREST の settings・`auth.uid()` の定義）、managed の DB・RLS・付与。
- G5 の SQL の本番への適用。G5 のレビューの結果。
- G4 の本物の資格情報の 1 文・本物のトークン・Vault。本物の Threads・Meta・Graph。
- Edge・Cron。アプリ・実機。
