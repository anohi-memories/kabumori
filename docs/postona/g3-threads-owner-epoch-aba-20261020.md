# G3｜Threads 予約を G5 のサービス世代（owner_epoch・lifecycle_version）に同期（2026-10-20、Issue #318 TASK 7/50）

- task_id: `postona-g3-threads-owner-epoch-lifecycle-aba-source-20261020`
- 返却先: POSTONA G3のちゃ
- 完了コード: K3
- 判定: **SOURCE_ONLY（使い捨て PG17、G5 の R1・W1 はテスト用の二重）／本番 NO_GO**
- 根拠: G5 の一回限りの IF 通知（Issue #318 #6279933784）、G5 の Draft PR #358（`4f4ece89af51a345c0e71cb3876278789a4f3896`）
- 積み順: PR #356（`12fcba7e076e467595ae58d93af05cb09e354c6a`）の上。

## 1. 変えたこと（G3 の候補 007 と、そのテストだけ）

### 予約の作成
- 007 の `create_reservation` は、DB の中で **G5 の R1**（`common_account_authorization_verdict('postona', 'threads_publish', brand)`）を呼ぶ。
- `decision = 'allow'` のときだけ、owner_epoch トークン `g5oe:<epoch>:<lifecycle_version>` の **2 つの数**を `bound_owner_epoch`・`bound_lifecycle_version`（bigint）に保存する。
- トークンは厳格に読む: 正の 10 進、先頭 0 は不可、bigint の範囲内、形はちょうど。
  - それ以外（allow でない、トークンが無い・壊れている・0・桁あふれ）は作らない（`SERVICE_NOT_ACTIVE`）。
- 時刻は保存も比較もしない。

### 取得・送信直前・公開直前の照合
- 次の 3 か所で、**G5 の W1**（`private.account_lifecycle_worker_brand_verdict(brand, 'x_autopost', 保存した epoch, 保存した lifecycle_version)`）を呼ぶ。
  1. 取得（`claim_due` の中）
  2. 送信の直前（`preflight`）
  3. dispatcher の公開直前の確認（PR #356 の hook）。これは同じ `preflight` を呼び直すもの。
- `'active'` のときだけ進める。それ以外は送信 0。
- **G5 のコードをそのまま行の結果コードに残す**: `SERVICE_GENERATION_CHANGED`・`OWNER_EPOCH_CHANGED`・`EXPECTED_OWNER_EPOCH_REQUIRED`・`EXPECTED_LIFECYCLE_VERSION_REQUIRED`・`SERVICE_NOT_ACTIVE`・`ACCOUNT_DELETION_IN_PROGRESS` など。

### その他
- **記録**: `after_freeze` は W1 が `'active'` でないこと（世代が動いた後の記録も含む）。
- **古い行**（2 つの数が無い）は、取得の時に `EXPECTED_OWNER_EPOCH_REQUIRED` で止まる。送られない。
- **前提の検査**: R1・W1 が無い、所有者が違う、STABLE・definer でない、W1 が API の役割から届く場合は、007 を当てない（`POSTONA_THREADS_RESV_PRECONDITION_G5_VERDICT`）。
- G5 の Threads の仮の差し込み口（`g5_threads_state`、常に拒否）は削除した。G5 の本物の IF が前提になった。
- Threads 投稿の service key は、G5 の通知どおり `x_autopost`。

## 2. 本人の再確認と、自動再送をしない境界（UX の負債）
- G5 の代償: 所有者のアカウントに**関係のない変更**（Kabumori の開始・終了など）でも lifecycle_version が進み、それより前の予約は拒否される（L9f で実測）。
- テスト用の HTTP 入口の受領票に `action` を足した。
  - 世代の変化で止まった予約は `"reconfirm_and_create_new"`。本人が本文を読み直し、**新しい `clientRequestId` で新しい予約**を作る。
  - それ以外は `"none"`。
- **同じ ID での繰り返しは、止まった行を生き返らせない。再送もしない**（E2E H6）。
  - 作成は、同じ ID の照合より先に予定時刻を確かめる。そのため、時刻を過ぎた繰り返しは 422 になる。どちらにしても行は 1 つのまま。
  - 状態を読む道は受領票。

## 3. テスト

### G5 のテスト用の二重（`tests/g5_verdict_test_double.sql`）
- R1・W1 と同じ名前・同じ引数・同じ判断の順。
- この土台には F5 P1 の lifecycle_version と PR #303 の所有者世代が無いので、2 つの数を G5 の文書と同じ規則で数える。
  - lifecycle_version: 利用権の追加・変更・削除と、アカウントの状態の変更のたびに増える。
  - 所有者世代: owner の membership の変更のたびに増える。
  - どちらも減らない。

### `postona_threads_reservations_run.sh` → `POSTONA_THREADS_RESV_ALL_PASS`
- S0: G5 の W1 が無い場合と、worker の役割から届く場合は、当てない。
- L5: 取得後の利用終了は `SERVICE_NOT_ACTIVE`、削除中は `ACCOUNT_DELETION_IN_PROGRESS`。
- **L9（新規）**:

  | 番号 | 確かめたこと |
  |---|---|
  | a | 保存した 2 つの数が R1 のトークンと同じ |
  | b | 停止 → 再開（サービスは active に戻っている）→ 取得されず `SERVICE_GENERATION_CHANGED` |
  | c | **同じトランザクションの中での停止 → 再開**も `SERVICE_GENERATION_CHANGED`（時刻の方式では通っていた） |
  | d | ロールバックした停止は何も変えない（取得される） |
  | e | 所有者の A → B → A は `OWNER_EPOCH_CHANGED` |
  | f | 関係のない Kabumori の開始でも `SERVICE_GENERATION_CHANGED`（UX の負債） |
  | g | 取得後・送信前の再開は、preflight で `SERVICE_GENERATION_CHANGED` |
  | h | 2 つの数の無い古い行は `EXPECTED_OWNER_EPOCH_REQUIRED` |
  | i | 壊れたトークン 14 種、allow でトークンなし、unknown でトークンあり、答えなしは、どれも作らない（bigint の最大値は受け付ける） |
  | j | preflight と記録のあいだの再開は after_freeze=true |

- E2E（PR #339 の 5 件）: 予約に 2 つの数を持たせて合格。利用終了の結果コードは `SERVICE_NOT_ACTIVE`。

### `postona_threads_http_worker_run.sh` → `POSTONA_THREADS_HTTP_WORKER_ALL_PASS`（16 件）
- PR #356 の公開直前の確認の E2E に、**コンテナの準備待ちのあいだのサービスの再開**（`SERVICE_GENERATION_CHANGED`）と**所有者の A → B → A**（`OWNER_EPOCH_CHANGED`）を足した。どちらも公開の要求 0 回。
- H6（新規）: 再開の前の予約は取得の時に止まり、受領票は `reconfirm_and_create_new`。同じ ID は生き返らず、送られない。新しい予約は 1 回だけ送られる。

### 変異テスト・回帰
- 単体: テスト用の入口 6 件（受領票の `action` を含む）と、worker の組み合わせ 3 件（そのまま）。合わせて 9 件。
- 変異テスト: 007 の G5 の部分と受領票の `action` に 13 個。すべて検出した。
- 回帰:
  - Deno の予約・単発投稿・worker・dispatcher で 112 件
  - 型検査 0 件・lint・`git diff --check`・秘密値の走査 0 件
  - X の予約のスキーマの指紋は不変
- NOT_VERIFIED:
  - G5 の本物の R1・W1（F5 P1〜P10 と PR #303 の上で）
  - 本物の Auth・Threads
  - G4 の本物の送信口
  - Edge・Cron・付与

## 4. 残ること
1. G5 の候補（PR #358 とその下の F5 の鎖、PR #303）の適用の後に、本物の R1・W1 で再試験する。
2. G5 の文書（PR #303 L-1）は、本物の世界で G5 の SQL を入れる前に、F3/G3 が `public.brand_memberships` の TRIGGER・TRUNCATE・REFERENCES を API の役割から取り上げることを前提にしている。G3 の別 TASK として、付与の変更と Sol（高）のレビューが必要。
3. 本人の再確認の画面（受領票の `action`）は G1 の画面の担当。G3 はテスト用の入口で契約だけを示した。
4. 007 の migration 化・付与・Edge・Cron は、別のレビューとユーザーの承認の後。production は NO_GO。
