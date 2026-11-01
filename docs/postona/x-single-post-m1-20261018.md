# POSTONA X 手入力の単発投稿 — オフライン統合 M1（2026-10-18、F3）

> 追記（同日）: 送信直前のライブ確認（M1-F1）と結果の記録（M1-F3）は候補 006 で足した。Edge は 006 の手順（preflight / record / readback）を使う。詳しくは `x-single-post-m1-f1-live-fence-20261018.md`。

- 判定: **PASS_LOCAL_SYNTHETIC_ONLY（本番 NO_GO）**
  - 手元の使い捨て PostgreSQL 17 と、偽の Auth・偽の X で、テキスト投稿 1 件が次の順に最後まで通った。
    - ログインの確認 → 利用権と T13 → 本人確認済みの X アカウント → トークンの取得口 → 送信直前の再確認 → 偽の X への送信 → 結果の保存 → 別の接続での読み直し
  - 本物の X には一度も送っていない。偽の X の「成功」は、本物の投稿の証拠ではない。
  - 公開スイッチ（`POSTONA_X_SINGLE_POST_ENABLED`）は OFF。G4 のトークンの取得口は未接続（`X_CREDENTIALS_NOT_CONNECTED`）。G4 の本人確認の判定は出荷時「常に拒否」。そのため、本番では何も送れない。

## 1. 置き場所（すべて F3 の新しいパス。既存の PR の本体は変えていない）

| 層 | ファイル | 中身 |
|---|---|---|
| DB 候補 | `supabase/candidates/postona_x_reservations/005_postona_x_single_post.sql`（+ rollback） | 単発投稿は「今すぐ送る 1 件の予約」として、既存の予約の表と仕組み（送信直前の確認・結果の記録・uncertain の扱い）をそのまま使う。API 役割の関数は `post_now_begin` / `post_now_check` / `post_now_finish` / `post_now_get` の 4 つ |
| サーバーの流れ | `supabase/functions/_shared/postona_reservations/single_post.ts` | 認証 → 開始 → 直前確認 → X 送信 1 回 → 記録 → 別の接続での読み直し |
| DB の接続口 | `.../single_post_db.ts` | API 役割、確認済みの本人とセッション ID をクレームに入れる |
| Edge の入口 | `supabase/functions/postona-x-single-post/`（`http.ts`・`index.ts`） | 公開スイッチは OFF、本番の既定はトークンの取得口が未接続 |
| アプリ向けの契約 | `.../single_post_contract.ts` | `singlePostRequest()` と `singlePostResultOf()` |
| 検証 | `single_post_run.sh`、`single_post/`（挙動の SQL と e2e） | 使い捨ての DB だけ |

## 2. F1（アプリの投稿画面）への送信の契約
- 送り先: `POST /functions/v1/postona-x-single-post`。`Authorization: Bearer <本人のアクセストークン>` を付ける。本人はトークンからだけ決まる。
- 本文はちょうど次の形: `{ socialAccountId, clientRequestId, text, consent: { confirmed: true, contentSha256 } }`
  - `clientRequestId`: 1 回のタップごとに新しい UUID を使う。再試行のときは**同じ ID** を送る。サーバーは 2 回送らない。
  - `contentSha256`: 確認画面に出した本文そのものの SHA-256。「この本文を、今」という 1 回ごとの同意になる。
- 結果（`singlePostResultOf`）:

  | 結果 | 意味 | 画面での扱い |
  |---|---|---|
  | `sent{xPostId}` | サーバーが X の ID を保存し、読み直しで一致した | 投稿済み |
  | `pending` | まだ送っていない（混んでいる、または処理中） | 同じ ID で再試行できる |
  | `failed{code}` | 送られていない（X が拒否した、権限が変わった） | 理由を出す |
  | `uncertain` | 送れたか分からない | **自動で再送しない**。本人に X で確認してもらう |
  | `refused{code}` | 4xx。何も書かれていない | 理由を出す |
  | `unavailable` | 503 や通信の失敗 | 同じ ID で再試行する |

- 今は公開スイッチが OFF なので、どの呼び出しも 503 `NOT_AVAILABLE` が返る。F1 の送信ボタンは無効のままにする。

## 3. G4（X の本人確認とトークン）
- 本人確認の判定 `postona_x_resv.g4_x_account_verified(user, account)`: PR257 の K1〜K6 を満たすこと。今は常に拒否なので、単発投稿は `POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED`（403）で止まる。
- トークンの取得口 `XPostingCredentialSource.accessTokenFor(social_account_id)`: PR257 の C1〜C5 を満たすこと。未接続の間、Edge は記録する前に `X_NOT_AVAILABLE`（503）で止まる。
- 偽の X に対して期待する動き（e2e で確認済み）:
  - 送るのは保存した本文、その口座自身のトークン、1 回だけ。
  - 201 と数字の ID なら送信済み、400 / 401 / 403 / 429 なら送られていない、それ以外は結果不明。
  - トークンがないときは、X に送らずに `X_CREDENTIALS_UNAVAILABLE`（失敗）。

## 4. F5（利用権と T13）
- `post_now_begin` と `post_now_check` は、どちらも最初に `private.account_lifecycle_assert_active_service_write(caller, 'x_autopost')` を呼ぶ。
  - クレームには、Supabase Auth が確認したトークンの `session_id` を入れる。
  - サインアウト、利用終了、削除中、凍結、利用登録なしは、開始のときも送信の直前も拒否する。
  - T13 のコードは `POSTONA_RESV_AUTH_REQUIRED` / `_SERVICE_NOT_ACTIVE` / `_SERVICE_BUSY` に当てはめる。
- G5 の判定（003）、持ち主、G4、PR182 の投稿権限の `revoked` も、同じ順（G5 のロックが先）で確かめる。
- F5 のファイル、migration、RPC は変更していない。

## 5. 既存の仕組みとの関係
- **予約のワーカー（PR224）**: 単発投稿の行は、期限を作成時刻にしてあるので、ワーカーが拾うことはない。期限の切れたリースは、ワーカーの掃除で `uncertain` になる（送り直さない）。
- **削除処理（PR189/204）**: 送信中の単発投稿は「実行中」として数えられ、結果不明の投稿は記録に残る（既存の仕組みのまま）。
- **送信直前のガード（PR182）と、旧かぶモリの配信（`claim_due_post`、x-test-post）**: 変えていないし、使ってもいない。

## 6. 本番の前に必要なこと（このファイルは実行の承認ではない）
1. G4 Issue131: 本人確認の判定とトークンの取得口。
2. F5 の候補の承認と適用。
3. 適用の順は 001 → 002 → 003 → 004 → 005 → Edge。ロールバックは Edge → 005 の順。
4. 本物の Auth・PostgREST・X での確認と、Sol（高）による Auth・送信の境界の合同レビュー。
5. 実際の X への投稿は、別の明示的な承認があるまで行わない。
