# G3｜Threads 予約の SQL 候補 007 と、使い捨て PostgreSQL 17 での検証（2026-10-19、Issue #318 TASK 2/50）

- task_id: `postona-g3-threads-reservation-007-isolated-pg17-contract-20261019`
- 返却先: POSTONA G3のちゃ
- 完了コード: K3
- 判定: **PASS_ISOLATED_PG17_SOURCE_ONLY（本番 NO_GO）**
  - 候補は `supabase/candidates/postona_threads_reservations/` に置いた。`supabase/migrations/` には何も足していない。
  - 当てたのは、手元の使い捨て DB だけ。
  - 本物の Threads・Meta・Auth・Vault・managed Supabase には触れていない。
- 積み順: PR #334（`8f7a1e3914e41a6db5dcaee64224c4b5817afce9`）の上。PR #334 の `threads_dispatch.ts` は変更していない（`THREADS_DISPATCH_ENABLED = false` のまま）。

## 1. 007 の形

- **X の予約（`postona_x_resv`、001〜006）は 1 バイトも変えない**。
  - Threads の予約は、新しいスキーマ `postona_threads_resv` に置く。
  - 001 の `caller()` と `sha256_hex()`、既存の 2 つの役割（`postona_resv_api`＝本人、`postona_resv_worker`＝dispatcher）だけを使う。
  - ランナーは、X のスキーマの関数・設定・権限・表の権限の指紋を、適用前・適用後・ロールバック後・再適用後で比べる。
- 関数:

  | 役割 | 関数 | 内容 |
  |---|---|---|
  | 本人 | `create_reservation(account, client_request_id, text, sha256, scheduled_at)` | 柵を通ったら作る。同じ ID なら同じ行を返し、同じ ID で本文か時刻が違えば衝突。本文は 1〜500 文字で、制御文字なし。予定は 1 分後〜60 日後。同意は本文の SHA-256 |
  | 本人 | `cancel_reservation(id)` | 本人の planned だけ |
  | 本人 | `receipt(account, client_request_id)` | **本文なし**で、状態・Threads の media id・結果コード・after_freeze・simulated を返す。他人・不明な ID は、どれも同じ NOT_FOUND |
  | dispatcher | `claim_due(worker, lease, limit)` | 期限の来た行を SKIP LOCKED で取り、その時点の資格情報の世代を結び付ける。リースの切れた claimed は uncertain にし、二度と取らない |
  | dispatcher | `preflight(id, lease)` | リース、G4 の延長中（送らずに戻す）、柵をもう一度（failed NOT_PUBLISHABLE_AT_SEND）、取得時からの世代の変化（failed CREDENTIAL_CHANGED）を見て、OK なら世代を返す |
  | dispatcher | `record(id, lease, outcome, media_id, code, transport)` | 結果・送信手段・after_freeze（G5 の状態を読み直す）を記録する。リース切れは uncertain（`lease_lost`）。同じ内容の published の再送は何も変えない |
  | dispatcher | `release_unsent(id, lease)` | 送っていない行を、自分のリースでだけ戻す |

- 柵（作成時と送信直前の両方）:
  - Threads の口座であること。
  - `social_mobile_user_v1` の作業場所で、**F5 の `account_lifecycle_brand_owner` がちょうど本人**であること。
  - identity_verified・verified_at・Threads のユーザー ID・アクセスの参照があり、接続エラーがないこと。
  - **G4 の確認**、投稿スイッチ ON、**G5 の Threads の状態**。
- 世代（64 桁の小文字の 16 進）は、次の値をまとめた SHA-256。Vault の中身は読まない。
  - provider・口座・作業場所・F5 の所有者
  - Threads のユーザー ID・アクセスの参照・接続状態・verified_at・`updated_at`
  - G4 の保管（secret・期限・記録時刻）と延長のリース（表があれば）
- 権限:
  - 本人の役割は 3 つ、dispatcher の役割は 4 つの関数だけを実行できる。
  - 内部の関数と表には、どの役割も届かない。anon・authenticated・service_role にはスキーマの USAGE も無い。
  - 適用の後に、これを事後検査で確かめる。
- 他の持ち主の口は、**出荷時は拒否**:
  - `g4_threads_account_verified` → false
  - `g5_threads_state` → `'THREADS_ENTITLEMENT_KEY_UNDECIDED'`
  - Threads の利用権の service key は決まっていないので、仮の名前は入れていない。

## 2. 検証（`postona_threads_reservations_run.sh` → `POSTONA_THREADS_RESV_ALL_PASS`）

| 区分 | 確かめたこと |
|---|---|
| P | `social_accounts` が X だけ（`CHECK (platform = 'x')`）の間は 007 を当てない。その後に、テスト用の代役（2a-2 の platform の規則だけ）・テストの表・人物 39 人（Threads 口座はテストのデータ）を置く |
| **FB（修正前）** | 007 の前は、X の予約・単発投稿の API が Threads の口座を拒否する。Threads の予約の store が無い。X の dispatcher は Threads の行を持たない |
| S0 | 001〜006 が無い、または F5 の所有者の関数が無いときは当てない。途中の失敗で何も残らない。二重適用は拒否。**X の指紋は不変**。**出荷時の拒否の口のままでは、作成も ACCOUNT_NOT_VERIFIED で止まる** |
| L1 | 権限（4 つの API 役割 × 関数、本人と dispatcher の取り違え、内部の関数、表） |
| L2 | 作成の拒否 16 種で、記録は 0 件。他人・X・不明な口座、所有者 2 人、G4 の未確認、接続失敗・接続エラー、スイッチ OFF、利用終了、削除中・凍結、同意、本文が長すぎる・制御文字・空白だけ、予定が過去・遠すぎる |
| L3 | 同じ ID は同じ行。本文違い・時刻違いは衝突。他人の同じ ID は別の行。500 文字は受け付ける |
| L4 | 取得 → 世代の結び付け → preflight OK → published の記録 → 同じ内容の再送は何も変えない → 違う ID の再送は拒否 → 受領票（本文の列が無い）→ 二度と取らない |
| L5 | 取得の後の変化 12 種。所有者 2 人・G4 の確認の取り消し・スイッチ OFF・切断・利用終了・削除中は failed NOT_PUBLISHABLE_AT_SEND。保管の入れ替え・Threads のユーザーの変更・アクセスの参照の変更・行の更新は failed CREDENTIAL_CHANGED。延長中・リース切れは送らずに戻す |
| L6 | 記録の形の拒否 6 種。**送信中に利用終了すると、published のまま after_freeze=true**。遅い記録は uncertain（`lease_lost`）。uncertain の記録。掃除でリース切れを uncertain にする。uncertain は二度と取らない |
| L7 | 戻すのは自分のリースでだけ。取消は本人の planned だけ。他人と不明な ID の受領票は同じ NOT_FOUND。呼び手が無いと AUTH_REQUIRED |
| R | dispatcher の 2 つの取引が同時に取りに来ても、別々の行を取る（SKIP LOCKED） |
| E | **PR #334 の dispatcher → テスト用の store → 007**（模擬の G4・Threads）の 5 件。1 件の予約が 1 回だけ送られる。2 つの dispatcher で 8 件がそれぞれ 1 回。publish 段階の不明は uncertain で再送しない。container 段階の不明は failed。読み戻しの不一致は uncertain。資格情報の取得後の変化 4 種は送信 0 回。延長中は戻し、終われば 1 回送る。X の表は触れない |
| RB | ロールバックで 007 だけが消え、X の指紋は不変。2 回流しても同じ。再適用できる |

- 変異テストは、PR の Report を参照。

## 3. 未解決の持ち主の IF（実装していない。別 TASK とレビュー）

| 持ち主 | 必要なもの |
|---|---|
| **G5** | Threads の投稿の service key（`x_autopost` を流用するか、新しい key にするか）と、`g5_threads_state(user) → null｜code` の本物（セッション・アカウント・利用権・削除中）。key を使わない、アカウント単位の凍結の読み取りがあれば、柵に直接使える |
| **G4** | `g4_threads_account_verified` の本物（接続の記録から）。2a-2 の「Threads の行は投稿スイッチを ON にできない」を外す、レビュー済みの migration。保管・延長の表（PR #258・#263）の本物。`credentialFor` を 1 つの文で（判断・トークン・`threads_credential_generation`）。送信口 |
| **G3（次）** | 本人の Edge（作成・取消・受領票）と dispatcher の Edge・Cron の配線。どちらも固定の OFF で |
| **共通** | 世代関数を G4 の取得口から呼ぶための付与。dispatcher の役割の login。2a-2 の本番の形への適用。**Codex Sol（高）の限定レビューの対象**: `postona_threads_resv` の SECURITY DEFINER 関数 12 個、付与 7 つ、柵の順序、世代の入力 |

## 4. この文書が承認しないこと
- migration の作成・適用、権限の付与、Edge・Cron の配備
- 本物の Threads への投稿、OAuth、トークン・Vault の取得
- G4・G5・G1 のファイルの変更、merge、deploy、main への push
