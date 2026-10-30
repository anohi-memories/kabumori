# G6-27 POSTONA の AI 投稿補助：G5・G6 の SQL が未採用のとき（PGRST202 など）の分類修正と、G5 W0 / g5pv ピンとの実接続

- task_id: `common-ai-g6-postona-pgrst202-g5-personal-pin-client-real-integration-20261030`（Issue #321、G6-27）
- 作成: 2026-10-30。**本番は NO_GO。deploy・managed への SQL 適用・secret の設定・有料 API はしていない。**
- 実行: `bash supabase/tests/postona_post_assist_g5_pin_local_run.sh`（試験は `postona_post_assist_g5_pin_local_test.ts`）

## 1. 直した不具合

| 場面 | 直す前（G6-26 / PR #582） | 直した後 |
|---|---|---|
| G5 の R1 認可 RPC が無い（PostgREST 404 `PGRST202`。未採用、または採用直後でスキーマキャッシュが古い） | 例外 → `AUTH_UNAVAILABLE` → **503 `POST_ASSIST_AUTH_UNAVAILABLE`、`retry_same_key: true`**。G1 は「混み合っています。同じ依頼を再試行」と表示 | 拒否（deny、理由 `G5_RPC_NOT_ADOPTED`）→ **403 `POST_ASSIST_NOT_ENTITLED`、`retry_same_key: false`**。G1 は「いまは使えません」（新しい鍵でだけ再依頼） |
| G5 の RPC を PostgREST がそもそも受け付けない（300 `PGRST203`、400、406、409 など、408 / 429 以外の 3xx / 4xx） | 同上（503・同じ鍵で再試行） | 拒否（`G5_RPC_REFUSED`）→ 403・再試行なし |
| G6 の `ai_calls_claim` が無い（G6 の SQL 未採用、404 `PGRST202`）、または受け付けない（401 / 403 / 400 / 3xx） | 例外 → `STORE_UNAVAILABLE` → **503 `POST_ASSIST_UNAVAILABLE`、`retry_same_key: true`** | `CallStoreRefusedError` → `LEDGER_UNAVAILABLE` → **503 `POST_ASSIST_NOT_SENT`、`retry_same_key: false`**。G1 は「いまは AI を使えません」 |
| G5 / G6 の RPC が転送（redirect）を返す | 転送先へ、本人の JWT・service key を付けたまま付いていく（Deno の fetch は `apikey` ヘッダーを残す。ローカルで確認） | `redirect: "manual"`：付いていかない。拒否として扱う（G5 の RPC、ai_calls、ledger の 3 か所） |

変えていないこと:
- 401 / 403（JWT が受け付けられない、または実行権限が無い）は、これまでどおり拒否（`AUTH_REQUIRED`）→ 403 です。
- 5xx・408・429・接続失敗・時間切れは、一時的な可能性があるので、これまでどおり 503 で「同じ鍵で再試行してよい」です。
- 何も予約されていない段階の失敗なので、どの場合も AI への送信・台帳の予約・課金は 0 です。
- 送信の後に台帳の `ai_calls_complete` が失敗した場合は、これまでどおり `UNKNOWN` です（再送しない）。

理由: PostgREST が 3xx / 4xx で答えたときは、RPC は走っていません（エラーになった RPC はロールバックされます）。同じ鍵で何度聞いても、G5 または G6 の SQL が採用・修正されるまでは結果が変わりません。そのため、「同じ鍵で再試行」ではなく「使えない」と答えます。

変えたファイル（G6 所有だけ）:
- `_shared/ai_gateway/g5_rpc_transport.ts`
- `_shared/ai_gateway/ai_calls_store.ts`（`definiteRefusal`、`AiCallsClaimRefused`）
- `_shared/ai_gateway/gateway.ts`（`CallStoreRefusedError` を 1 つ追加し、claim の catch で使う）
- `_shared/ai_provider/ledger_guard.ts`（`redirect: "manual"` の 1 行）

`gateway.ts` の他の部分、`authority_port.ts`、`runtime.ts`、`postona_post_assist*.ts`、SQL は変えていません。

## 2. 本物のローカル Supabase での実測（before / after）

使った部品:
- **本物**: Kong（verify_jwt）、GoTrue（ES256 の JWT）、PostgREST v16.1、Edge ランタイム v1.74.3、Postgres 17.6.1.165（CLI 2.116.0 の手元のイメージ）
- **G5**: PR #590 `2c8087fc`（`MVP_INSTALL` / `MVP_W0_INSTALL` / R1・W0 の GRANT。blob を照合）。R1 のファイルは PR #569 と同じバイト列です。
- **G1**: PR #592 `eb8f5e98` の次のファイル（blob を照合）
  - `domain/personal-workspace.ts`（W0 の初回）
  - `features/schedule/post-assist.ts`（作成画面の依頼と表示）
  - `data/post-assist-client.ts`
- **偽物**: AI だけ。
- **直す前と後**: 同じ DB に対して並べて動かしました。
  - 「before」= G6-26 の `_shared`（PR #582）
  - 「after」= この PR

DB は、テストが段階ごとに採用していきます（`postgres` として）。

| 段階 | 状態 | before | after |
|---|---|---|---|
| 0 | G5 の R1 / W0 も G6 の SQL も無い | 直接の呼び出し: `retry_same_key`（503 `POST_ASSIST_AUTH_UNAVAILABLE` / true） | `not_available`（403 `POST_ASSIST_NOT_ENTITLED` / false）。同じ鍵でもう一度呼んでも同じ |
| 0 | 同上（G1 の画面） | ― | G1 の W0 初回は `off`（W0 の 404 PGRST202）。作成画面は送信しない（`workspace_off`） |
| 1 | G5 PR #590 を採用、G6 の SQL はまだ | 作成画面: `retry_same_key`（G1 の表示は「同じ依頼を再試行」）、503 `POST_ASSIST_UNAVAILABLE` / true | `unavailable`（新しい鍵で）、503 `POST_ASSIST_NOT_SENT` / false |
| 2 | G6 の SQL も採用 | ― | `candidates`。送信 1、`settled=1 calls:complete=1 usage:1`。同じ依頼の再送は保存済み（送信なし） |

どの段階でも、拒否のときは AI への送信 0、台帳の予約 0 でした。段階 0・1 では、台帳の表自体がありません。

G5 の W0 / R1 とのつながり（読み取りで確認したこと）:
- W0 の初回: `ready`、`created: true` → 2 回目は `created: false`。
- id の一致: `workspace_id`、アプリが snapshot から読む id（`brand_memberships` → `brands`）、G5 の `u_` + md5(user)[0:24] の 3 つが一致します。
- メンバーシップ: owner が 1 件だけです。
- G5 の R1 の答え: `allow`、`owner_epoch = g5pv:<n>`（G6 のアダプターが固定する形）、`entitlements = ["postona:x_autopost"]`、`session.ref` あり。

拒否（本物の JWT で、after）:
- 他人の W0 ワークスペース、誰のものでもない id、POSTONA を始めていない人（G1 の W0 初回は `service_inactive`）は、どれも `not_available` です。
- ログアウトしたセッションも `not_available` です。JWT はまだ期限内なので Kong は通し、G5 が拒否します。
- G1 の作成画面は、他人のワークスペースへは自分で送りません（`other_workspace`）。
- 送信 0、台帳は変化なしでした。

サービスと世代の確認:
- **サービス停止（entitlement ended）**: `not_available` になります。保存済みの鍵も拒否されます。G1 の W0 初回は `service_inactive` です。
- **再開**: 新しい g5pv の世代になります。前の依頼は保存済みの候補を返し（送信なし）、新しい依頼は 1 回だけ送られます。
- **送信の途中で世代が変わる場合（A-B-A）**:
  - 1 回目の試行で、偽の AI が 429 を返す前に、サービスを止めて再開しました（g5pv が進む）。
  - 2 回目の試行の直前の再確認で拒否され、`not_available`（新しい鍵で）になりました。
  - AI に届いたのは 1 回だけです。台帳には、その試行が「失敗・RATE_LIMITED・429・費用 0」として残り、次の試行の予約は送信前に解放（released）されました。
  - 同じ依頼（同じ鍵）をもう一度送ると、その鍵に保存された結果 `NOT_SENT`（503、同じ鍵での再試行なし。G1 の表示は `unavailable`）が返り、送信されません。最初の答え（403 `not_available`）とは表示が違いますが、どちらも送信 0、新しい鍵でだけ再依頼できます（G6-25 からの既存の振る舞い。今回は変えていない）。
  - 新しい依頼は 1 回だけ送られました。

ローカルで分かった事実（hosted は NOT_VERIFIED）:
- SQL を採用した直後、PostgREST は数十〜百数十 ms のあいだ `404 PGRST202` を返しました。実測は、W0 が 125 ms、ai_calls_claim が 65 ms です。
- この間に来た依頼は、after では「使えない」と答えます（送信 0）。本人がもう一度押せば（新しい鍵）、使えます。

## 3. 残りの接続条件（担当）

- **G5**: managed では、採用の手順として次のどちらかが要ります。まだ決まっていない場合は G5 / 運用者が決めます。
  - 採用の後にスキーマキャッシュの再読み込みを待つ
  - `NOTIFY pgrst, 'reload schema'`
- **G1**: クライアントの写しを直す必要はありません（PR #592 の写しのままで、状態の意味が正しくなりました）。G1 の画面の文言は G1 の担当です。
  - `not_available`: G1 の文言は「ログインの状態やご契約をご確認ください」です。G5 / G6 の未採用にも使われるようになりました。
  - `unavailable`: 「いまは AI を使えません」と表示されます。
- **G6（このあと）**: managed / hosted での確認は、G6-26 の採用ゲート表（§4）のとおりです。ここでは何も実行していません。

## 4. NOT_RUN / NOT_VERIFIED

- managed / hosted の Supabase、実機のアプリ、本物の OpenAI は、どれも使っていません。
- hosted の PostgREST が未採用の RPC に返す本文と、スキーマキャッシュの再読み込みにかかる時間は、まだ確認していません。
- G1 の snapshot は、アプリと同じ読み方（`brand_memberships` → `brands`）を試験側で再現しました。G1 の `supabase-repository.ts` 自体は読み込んでいません（G5 PR #590 の試験では読み込んでいます）。
