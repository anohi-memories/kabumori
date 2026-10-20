# G3｜Threads 予約の HTTP のエラー・受領票の契約（2026-10-20、Issue #318 TASK 13/50）

- task_id: `postona-g3-threads-http-receipt-errors-offline-20261020`
- 返却先: POSTONA G3のちゃ
- 完了コード: K3
- 判定: **SOURCE_ONLY（テストとランナーと文書だけ。モックの store と使い捨て PG17、deny-net）／本番 NO_GO**
- 積み順: G3 PR #386（`7c64c011831dea36608ebb2b62c6e96bc455d247`）の上。テスト用の HTTP の入口（`fixture/threads_reservation_http_fixture.ts`）、007、dispatcher は変えていない。
- 推奨モデルは Sonnet5（高）だったが、このチャットのモデル（Opus 5.5）で実行した。
- U8: G4 は未決定。G4 の今の TASK は G4-13 で、U8 への回答はない。本物の 2a-2 の CHECK は有効なまま。(a) も (b) も実装していないし、解除もしていない。

## 1. 画面（G1）向けの応答の一覧
呼び出し元は、本人のトークンを G5 の検証器が確かめた結果（ここではモックの判定）。トークンと本文は、どの応答にも出ない。どの応答も JSON で、`cache-control: no-store` が付く。

| 状態コード | `code` | いつ | 画面の扱い（案） | 同じ要求の繰り返し |
|---|---|---|---|---|
| 200 create | — `{reservationId, status, created}` | 作成、または同じ要求の繰り返し（`created:false`） | 予約済み | 安全（同じ行が返る） |
| 200 cancel | — `{status:"cancelled"}` | 予約中（planned）の取り消し | 取り消し済み | 2 回目は 409 |
| 200 receipt | — `{reservationId, state, xPostId?, code?, simulated, afterFreeze, action}` | 本人の予約の状態 | §2 | 安全（読むだけ） |
| 400 | `REQUEST_INVALID` | 形が違う（キーの過不足、ID の形、同意なし） | 入力の誤り | 直してから |
| 401 | `AUTH_REQUIRED` | ヘッダーが無い・形が違う・知らないトークン・判定の形が違う。**どれもバイト単位で同じ** | もう一度ログイン | ログインの後に |
| 403 | `ACCOUNT_NOT_VERIFIED` | G4 の確認が無い、または接続の途中 | 再接続の案内（U9 と一緒に決める） | 状態が変わるまで同じ |
| 403 | `PUBLISH_DISABLED` | 投稿スイッチ OFF。**U8 の世界では本物の 2a-2 が常にこれを返す** | 「Threads の予約投稿はまだ使えません」（U8 の決定待ち） | 同じ |
| 403 | `SERVICE_NOT_ACTIVE` | G5 の R1 が許可しない（終了・削除中・セッション切れ・所有者が 2 人など） | 利用の状態の案内 | 同じ |
| 404 | `NOT_FOUND` | 作成・取り消しで、他人のアカウントや予約、存在しないもの。**他人と存在しないものはバイト単位で同じ** | 「見つかりません」 | 同じ |
| 404 | `RECEIPT_NOT_FOUND` | 受領票で、他人の予約・別のアカウント・知らない ID。**どれもバイト単位で同じ** | 「見つかりません」 | 同じ |
| 405 / 413 | `METHOD_NOT_ALLOWED` / `REQUEST_TOO_LARGE` | 方法・大きさ | — | — |
| 409 | `IDEMPOTENCY_CONFLICT` | 同じ `clientRequestId` で本文か時刻が違う | 新しい予約として作り直す | 同じ |
| 409 | `NOT_CANCELLABLE` | 取得済み・送信済み・取り消し済みなど | 受領票を見る | 同じ |
| 422 | `TEXT_INVALID` / `CONSENT_REQUIRED` / `SCHEDULE_INVALID` / `REQUEST_INVALID` | 本文・同意・時刻 | 入力の誤り | 直してから |
| 503 | `OUTCOME_UNKNOWN` | 作成か取り消しの答えが失われた（書けた可能性がある） | 「確認中」。**同じ要求をもう一度**（作成は同じ `clientRequestId`）、または受領票を見る | 作成は安全（冪等）。取り消しは 2 回目が 409 になりうる |
| 503 | `RECEIPT_UNAVAILABLE` | 受領票が読めない | 後でもう一度 | 安全 |
| 503 | `AUTH_UNAVAILABLE` / `STORE_UNAVAILABLE` / `NOT_AVAILABLE` | 検証器が落ちている・想定外の拒否・門が OFF | 後でもう一度 | — |

HTTP の入口の中では再試行しない（store の呼び出しは 1 回だけ）。再試行するかどうかは、本人（画面）が決める。

## 2. 受領票の状態の移り変わり（本人だけに見える）

| 007 の行 | `state` | `action` | 補足 |
|---|---|---|---|
| planned | `pending` | `none` | 取り消しできる |
| claimed（リースが有効） | `pending` | `none` | 取り消しは 409 |
| claimed（リースが切れた） | `uncertain` | `none` | 送れたかどうか不明。**自動では再送しない**。受領票は読むだけで、何も書き換えない（P5） |
| published | `sent`（`xPostId` 付き。本人だけ） | `none` | `afterFreeze` が true なら、送信の後に止める変化があった |
| failed（G5 の世代の変化: `SERVICE_GENERATION_CHANGED`・`OWNER_EPOCH_CHANGED`・`EXPECTED_*_REQUIRED`） | `failed` | **`reconfirm_and_create_new`** | 本人が本文を読み直し、**新しい** `clientRequestId` で作り直す。同じ ID では生き返らない |
| failed（それ以外: `NOT_PUBLISHABLE_AT_SEND`・`THREADS_CREDENTIALS_UNAVAILABLE`・`SERVICE_GENERATION_UNAVAILABLE` など） | `failed` | `none` | 運用や接続の問題。再接続の案内は U9 と一緒に決める |
| uncertain（`LEASE_EXPIRED` ほか） | `uncertain` | `none` | 送れたかどうか不明。自動では再送しない |
| cancelled | `cancelled` | `none` | — |

未決定（G3 は決めていない）:
- **U8**: 予約投稿の許可の方式。決まるまで、作成は `PUBLISH_DISABLED` のまま。
- **U9**: 再接続の案内（`action` に「再接続」を足すかどうか）。G1・G4・G5 で一緒に決める。

## 3. テスト

### 単体（`tests/http_contract_matrix_test.ts`、モックの store、deny-net、7 件）
| 番号 | 確かめたこと |
|---|---|
| C1 | 007 が本人の経路で返すコードを**候補の SQL から読み取り**、すべてが表にあることを確かめる。取り消しと作成の両方で、決まった状態コードになる。知らないコードは 503 `STORE_UNAVAILABLE`（決まった答えにすり替えない）。 |
| C2 | 401 は、ヘッダーなし・Basic・短いトークン・知らないトークン・形の違う判定のどれでも、3 つの操作で**バイト単位で同じ**。store は呼ばれない。 |
| C3 | 受領票の 404 は、行 0・`NOT_FOUND`・ID の形が違う行のどれでも、3 種類の要求で**バイト単位で同じ**。アカウントも ID も状態も含まない。 |
| C4 | store が余計な列（本文・トークン・利用者・ブランド・リース・世代）を返しても、作成と受領票（5 つの状態）の応答には出ない。キーは決まった組だけ。 |
| C5 | 答えが失われる場合（作成・取り消し・受領票）と、成功の形が崩れている場合は、すべて 503。store の呼び出しは 1 回だけ（入口の中で再試行しない）。 |
| C6 | 成功でも、4xx でも、5xx でも、JSON・`no-store` で、要求の本文を返さない。`fetch` は 0 回。 |
| C7 | 受領票の `action`: G5 の世代の 4 つのコードの `failed` だけが `reconfirm_and_create_new`。`SERVICE_GENERATION_UNAVAILABLE`・uncertain・その他は `none`。 |

### PG17（`postona_threads_http_contract_run.sh` → `POSTONA_THREADS_HTTP_CONTRACT_ALL_PASS`、8 件）
U8 の世界（PR #386 と同じ。本物の 2a-2 の CHECK は有効、G5 #371、G4 #124・保管・#367・#377、`sa_…` の 30 人）。作成はできないので、取り消し・受領票・worker で使う行は、owner が書いたテスト用のデータ（U8 の前の行や移行の行の代わり）。G4 の写しは、#377 の木と、#377 + #381 の木の両方で合格。

| 番号 | 確かめたこと |
|---|---|
| P1 | 本人の確認済みのアカウント → 403 `PUBLISH_DISABLED`、行 0。他人のアカウントと存在しないアカウント → **バイト単位で同じ** 404。 |
| P2 | 他人の予約の受領票と、別のアカウント・知らない ID → バイト単位で同じ 404。他人の予約の取り消しと知らない ID → バイト単位で同じ 404。他人の行は変わらない。 |
| P3 | 同時に 2 回の取り消し → 200 と 409 が 1 つずつ。取り消しと worker の競合（3 回）→ 取り消し済み（取得 0）か、取得済み（409、その後 preflight で止まる）の**どちらか一方だけ**。Graph は 0。 |
| P4 | 取り消しの答えが COMMIT の後に失われる → 503 `OUTCOME_UNKNOWN`。受領票は `cancelled`。もう一度の取り消しは 409。 |
| P5 | リースが切れた行の受領票は `uncertain`・`action:none`・投稿 ID なしで、2 回読んでも同じバイト。行は書き換わらない。止めた後に送られた行は `sent`・`afterFreeze:true`・`xPostId` で、本人だけに見える（他人は 404 で ID も出ない）。本文・トークン・利用者・ブランドは出ない。 |
| P6 | G5 の本物の W1 の止め（世代が古い・2 つの数が無い）→ 受領票は `reconfirm_and_create_new`。同じ ID では生き返らない。Graph は 0。 |
| P7 | **見つかったこと（直していない）**: 007 の取り消しと受領票は `auth.uid()` しか確かめない。そのため、セッションの行が消えた・期限切れでも、本人には答える。作成は G5 の R1 でセッションを確かめる。§4 を参照。 |
| P8 | 公開 0（テスト用のデータを除く）、スイッチ ON 0。 |

- 変異テスト: テスト用の HTTP の入口に 9 個を入れ、**9 個すべてを検出**した（1 回ごとに元のバイトに戻した）。
  - 受領票の 404 がアカウントを出す
  - アカウントが無いと 403 になる
  - 作成が store の列をそのまま返す
  - `no-store` が無い
  - 受領票を 1 回だけ再試行する
  - `SERVICE_GENERATION_UNAVAILABLE` を再確認にする
  - 知らないトークンに別のコードを返す
  - `NOT_CANCELLABLE` を 404 にする
  - 受領票の別の拒否を 404 にする
- 回帰（すべて合格）:
  - #386 → `POSTONA_THREADS_U8_FAILCLOSED_ALL_PASS`
  - #382 → `POSTONA_THREADS_G4_CREDENTIAL_ALL_PASS`
  - #379 → `POSTONA_THREADS_G5_REAL_ALL_PASS`
  - #374 → `POSTONA_THREADS_CROSS_OWNER_ALL_PASS`
  - #360 → `POSTONA_THREADS_RESV_ALL_PASS`・`POSTONA_THREADS_HTTP_WORKER_ALL_PASS`
  - Deno の単体 116 件（今回の 7 件を含む）
  - 型検査・lint

## 4. 候補として報告すること（作っていない）
- **P7**: 007 の `cancel_reservation` と `receipt` は、`postona_x_resv.caller()`（`auth.uid()` だけ）で本人を決める。セッションの有効性は見ない。本物の Edge では G5 の検証器が先に取り消し・期限切れを断る想定だが、深い層で防ぐなら次の候補がある。
  - 案 1: 取り消しと受領票の始めに、G5 の R1 を呼び、`subject` と `session.state` だけを確かめる。
  - 案 2: G5 が出す、セッションだけを確かめる口を使う。
  - どちらも SECURITY DEFINER の候補 SQL の変更で、G5 の口の決定も要る。Codex Sol（高）のレビューが必要なので、別の TASK にする。
- HTTP の入口の小さな不具合は見つからなかった（変異はすべてテストで捕まった）。

## 5. 依存と未完了
- G4: U8 の決定（(a)・(b)）。U9 の再接続の案内。U2・U7（#381）・U3（#377）・U1（#373）の受入。
- G5: R1・W1・W2（#371）と owner epoch（#303）の適用。P7 の案 2 の口。
- G1: §1 と §2 の画面の文言と流れ（G1 の UI は変えていない）。
- G3: #370 の権限のレビュー（MAINTAIN・PUBLIC・BYPASSRLS）、#349・#352 の Cron の認証は未完了のまま。
- NOT_VERIFIED:
  - managed の Auth（本物の JWT と検証器）・DB・RLS・Vault
  - 本物の Edge・Threads・Meta、アプリ・実機
