# G3｜Threads 予約の HTTP 入口と worker の境界 — オフラインのテスト用の入口と E2E（2026-10-19、Issue #318 TASK 3/50）

- task_id: `postona-g3-threads-reservation-http-worker-offline-20261019`
- 返却先: POSTONA G3のちゃ
- 完了コード: K3
- 判定: **PASS_ISOLATED_FIXTURE_ONLY（本番 NO_GO）**
  - 新しく足したのは、テスト専用の入口・模擬・テスト・文書だけ。
  - 製品の Edge、SQL、RPC、権限の付与、Cron、migration は作っていないし、変えてもいない。
- 積み順: PR #339（`da0fcecffc153aa0c09df47930fd6012b2fd8f27`）の上。
  - PR #339 の 007 と、PR #334 の `threads_dispatch.ts` はそのまま使った（`THREADS_DISPATCH_ENABLED = false` も変えていない）。
- 置き場所: `supabase/candidates/postona_threads_reservations/fixture/`。`supabase/functions/` からは import されない。

## 1. 本人用の HTTP の契約（`fixture/threads_reservation_http_fixture.ts`）

- 呼び手は **模擬の判定**（`verify(token) → {userId, sessionId} | null`）で与える。
  - 本物の署名の確認と Threads の利用権は G5 の持ち分。
  - 007 には、その判定の `sub` と `session_id` を JWT のクレームとして渡す。
- 本文はちょうど次のどれか。キーの過不足・形の違いは 400 で、DB に届かない。
  - `create { socialAccountId, clientRequestId, text, scheduledAt(タイムゾーン付き ISO), consent{confirmed:true, contentSha256} }`
  - `cancel { reservationId }`
  - `receipt { socialAccountId, clientRequestId }`
- 答え:

  | 場合 | HTTP |
  |---|---|
  | 作成 | 200 `{reservationId, status, created}`。同じ要求なら `created:false` |
  | 取消 | 200 `cancelled` |
  | 受領票 | 200 `{reservationId, state, xPostId?, code?, simulated, afterFreeze}`。**本文なし**。`simulated` が false になるのは、ちょうど false の記録だけ |
  | 未認証 | 401（受領票も同じ） |
  | 確認・スイッチ・利用権 | 403 |
  | 他人・他の口座 | 404 |
  | 同じ ID の衝突・取得済みの取消 | 409 |
  | 形・本文・同意・予定 | 422 |
  | DB が書いたか分からない | **503 OUTCOME_UNKNOWN**（同じ `clientRequestId` でもう一度。作成は同じ ID なら同じ行を返す） |

- **受領票の「無い」は 1 つの答え**（404 `RECEIPT_NOT_FOUND`）。他人の ID、自分の別の口座、知らない ID で、答えはバイト単位で同じ（E2E H2）。
- 受領票は読むだけで、書かない・もう一度使えるようにしない・送らない。

## 2. worker の入口と、公開の直前の確認の口（G4 への提案）

- worker のテスト用の入口: PR #334 の dispatcher、007 の worker の 4 つの関数、模擬の G4 資格情報（DB の世代を返す）、模擬の 2 段階投稿（`simulated`、すべての要求を数える）。
- **G4 PR #337 の送信には、コンテナの準備待ち（状態の読み取り 3 回、3 秒おき）と公開の要求のあいだに再確認が無い**（G4 の引き継ぎ #6265351981）。E2E W2 で実際に確認した:
  - 確認の口が無い今の形（`honourHook: false`）では、待ちのあいだに利用が止まっても**公開される**（after_freeze=true として記録される）。
  - 確認の口があれば、公開の要求は 0 回。
- 提案する IF（変更は G4 の持ち分。この PR は G4 のファイルを変えていない）:
  ```ts
  send(credential, text, hooks?: { beforePublish(): Promise<boolean> }): Promise<ThreadsSendOutcome>
  ```
  - G4 は、コンテナが FINISHED になった**後**、公開の要求の**前**に、`beforePublish` を 1 回 await する。
  - false・例外・時間切れなら、公開の要求をしない。結果は `{ kind: "not_written", stage: "publish", code: "THREADS_PREPUBLISH_REFUSED" }`（コンテナは公開されず、期限で消える）。
  - hook はトークンを見ない。
- G3 の答え方（`withPrepublishRecheck`）:
  - **送っている行そのものについて、007 の preflight をもう 1 回**呼ぶ（柵・リース・取得時の世代）。
  - OK で、かつ資格情報の世代と同じときだけ許す。
  - 確認できない・古い行・2 回目の送信は、許さない（単体テストで確認）。
- 残る隙間（正直に書く）: 確認の口から公開の要求までの 1 回の通信のあいだに起きた停止は、防げない。after_freeze として記録し、隠さない。
- 本物にするときの G3 側の変更（次の G3 の TASK）: dispatcher が `send` に hook を渡す。G4 が IF を受け入れた後に行う。
  - 今は、送っている行を「最後に OK になった preflight」で特定している（dispatcher は 1 行ずつ送る）。
  - hook が拒否したとき、行は 007 が failed にするか planned に戻すので、DB は正しい。ただし dispatcher の報告では uncertain と数えられる（安全側）。

## 3. 本番に接続するときに必要なもの（持ち主・パス・権限・レビュー）

| 項目 | 持ち主 | 対象（予定のパス・権限） | レビュー |
|---|---|---|---|
| 本人用の Edge（作成・取消・受領票） | G3 | 新しい `supabase/functions/postona-threads-reservations/`（§1 の契約、固定 OFF）。API の login role（`postona_resv_api` のメンバー、service_role ではない） | Codex Sol（高）: 呼び手の確認、クレームの組み立て |
| 呼び手の確認（JWT・セッション・Threads の利用権） | G5 | 本物の verifier と、`g5_threads_state` の本物。**service key の決定** | G5 と Sol |
| 007 の適用（SQL） | G3 | 007 を migration にする。12 個の SECURITY DEFINER 関数、付与 7 つ | Sol（高） |
| 2a-2（Threads の行）と、投稿スイッチの解除 | G4 | `20261007150000_postona_social_accounts_multi_provider.sql` と、その後の解除の migration | G4 と Sol |
| G4 の確認・資格情報・送信口 | G4 | `g4_threads_account_verified`、`credentialFor` を 1 つの文で、PR #337 の送信口と**公開の直前の確認の口**（§2） | G4 と Sol |
| dispatcher の Edge と Cron | G3（Cron の承認はユーザー） | 新しい worker の Edge（固定 OFF）、`postona_resv_worker` の login role、Cron の設定 | Sol（高）、ユーザーの明示の承認 |

## 4. 予約とは別の P1 候補（G5 からの一回限りの通知 #6267545726）

- **ソースで確かめたこと**（`origin/main` の `supabase/functions/x-test-post/index.ts`）:
  - 入口（3302 行目）で呼び手の認可を確かめているのは、`morning_greeting_manual_publish` のモードだけ（3348 行目の `resolveAdminAuthorization`）。
  - 試行（`*_dry_run`。OpenAI を呼ぶ）や、通常の予約投稿のモードには、呼び手の確認が見当たらない。
  - `supabase/config.toml` は main に無い（関数の `verify_jwt` はソースでは決まらない）。
- **確かめていないこと**: 本番の `verify_jwt` の設定と、匿名で実際に到達できるか。この TASK に、本番を読む許可は無い。匿名で到達できるとは断定しない。
- 提案（G3 の担当ちゃが判断）: G3 の限定修正の TASK として、次を入れる。
  - x-test-post の全モードに呼び手の確認を入れる（Cron の秘密の header、または service の JWT の確認）。
  - 試行モードを本番では閉じる。
  - 本番の `verify_jwt` を読むだけで確かめる（明示の許可の後）。

## 5. テスト（`postona_threads_http_worker_run.sh` → `POSTONA_THREADS_HTTP_WORKER_ALL_PASS`）

| 区分 | 確かめたこと |
|---|---|
| H1 | HTTP で作成。同じ要求は同じ行。同じ ID で本文・時刻が違えば 409。受領票は pending・simulated で、本文なし |
| H2 | 他人の口座は 404。他人の ID・自分の別の口座・知らない ID の受領票は、バイト単位で同じ 404。未認証は 401 |
| H3 | G4 の未確認・スイッチ OFF・利用終了・削除中は 403。知らないトークンは 401。どれも記録 0 件 |
| H4 | 確定の後に答えが失われると 503 OUTCOME_UNKNOWN。同じ要求でもう一度 → `created:false`、行は 1 つ |
| H5 | 取消した行は送られない。取得済みは 409。他人は 404 |
| W1 | 1 件を 1 回公開（確認の口を 1 回通る）。受領票は sent（media id、simulated）。二度と送らない |
| **W2** | **修正前（確認の口なし）は、待ちのあいだの停止の後でも公開される → 口があれば公開 0 回、failed** |
| W3 | 口があれば、待ちのあいだの資格情報の入れ替え（CREDENTIAL_CHANGED）・スイッチ OFF・所有者 2 人は公開 0 回。延長中は戻し、後で 1 回 |
| W4 | PR #337 の配備用の形（OFF）は取得 0 件。32 桁の世代は送信 0。publish 段階の不明は uncertain で再送しない。2 つの worker で 6 件を 1 回ずつ |

- 単体テスト（ネット不許可）:
  - `http_fixture_test.ts`: 5 件。ゲート、形、認証、対応表、受領票の一つの答え、ソースにネット・env が無いこと。
  - `worker_fixture_test.ts`: 3 件。確認の口の条件、古い行で許さないこと、例外で拒否すること。
- 変異テスト: 入口・worker の組み合わせ・PostgreSQL の口に 14 個。すべて検出した（最初は 1 個が生き残ったため、単体テストを足した）。
- 回帰:
  - 007 のランナー（PR #339）`POSTONA_THREADS_RESV_ALL_PASS`
  - Deno の予約・単発投稿・worker・dispatcher で 103 件
  - 型検査（7 ファイル）・lint・`git diff --check`
  - X の予約のスキーマの指紋は不変
- NOT_VERIFIED:
  - 本物の G4 の口・G5 の利用権
  - managed Auth、本物の Threads・Meta
  - 本物の Edge・Cron
  - アプリ
  - x-test-post の本番の設定
