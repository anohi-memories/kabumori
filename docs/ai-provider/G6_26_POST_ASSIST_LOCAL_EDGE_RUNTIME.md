# G6-26 POSTONA の AI 投稿補助：本物のローカル Supabase ランタイムでの統合と、本番前の採用ゲート

- task_id: `common-ai-g6-postona-edge-runtime-g1-consumer-integration-20261030`（Issue #321、G6-26）
- 作成: 2026-10-30。**本番は NO_GO。deploy・managed への SQL 適用・secret の設定・有料 API はしていない。**
- 実行: `bash supabase/tests/postona_post_assist_local_edge_run.sh`（試験は `postona_post_assist_local_edge_test.ts`）

## 1. 何を本物で動かしたか

ローカルだけで動く使い捨ての Supabase（project id `g6le`、ポート 556xx）を `supabase start` で立てました。終わったら `supabase stop --no-backup` で消します。

| 部品 | 本物 / 偽物 |
|---|---|
| Kong 2.8.1、GoTrue v2.196.0（ES256 の本物の JWT。`session_id` と `is_anonymous` を含む）、PostgREST v16.1、Edge ランタイム v1.74.3、Postgres 17.6.1.165（本物の auth スキーマ） | 本物（CLI 2.116.0 が使うイメージ。手元にあったもので、ダウンロードはしていない） |
| G6 の入口 `postona-post-assist/index.ts` | 本物（変更なし） |
| `postona-post-assist-localtest` | 同じハンドラー。違いは送り先の読み替えだけ（下記） |
| G5 の R1-MVP | G5-50 の固定点 PR #569 `5c882f01`（`git archive` で読むだけ。blob を照合）。`MVP_INSTALL.sql`、`MVP_R1_EXECUTE_GRANT.sql`、`MVP_R1_EXECUTE_REVOKE.sql` を G5 の lifecycle owner として流す |
| G6 の台帳 + ai_calls + owner-held の SQL | 本物（`postgres` 役割で流す） |
| G1 の呼び出しコード | PR #576 `8d95307c` の `post-assist-client.ts` そのもの（blob を照合）＋ supabase-js 2.115.0（アプリの lock と同じ版） |
| AI（OpenAI） | 偽物（この Mac の上の試験用サーバー） |
| 個人のワークスペースの行 | 試験で作る（G5 の fixture と同じ形。下記 F4） |

`localtest` での読み替え（試験専用で、配布しない。`supabase/tests/fixtures/g6_26_local_edge/` に置く）:
- ローカルの Supabase は、関数に `SUPABASE_URL=http://kong:8000` を渡します。G6 はこれを意図して拒否します（https か、試験用の loopback だけを通す）。そのため、ハンドラーには `http://localhost:8000` を渡し、その宛先を `http://kong:8000` に送ります。
- `https://api.openai.com/v1/responses` だけを、偽の AI に送ります。それ以外の宛先は拒否するので、外へは何も出ません。

## 2. 結果（11 件 PASS）

| 確かめたこと | 結果 |
|---|---|
| 本物のログイン | GoTrue の JWT は ES256 で、`role=authenticated`、`is_anonymous=false`、`session_id` あり |
| アプリのワークスペース = G5 の個人ワークスペース | アプリと同じ読み方（`brand_memberships` → `brands`、本人のセッション）で得た id が、`u_` + md5(user id) の先頭 24 桁と一致 |
| 許可前（R1-MVP は owner だけ） | G1 の画面の状態は `not_available`。AI への送信 0、予約 0 |
| 許可後（GRANT） | X / Threads × 下書き・推敲・タグの 6 件すべて `candidates`（編集でき、本人の確認が要る。上限は 280 / 500）。AI への送信 6、`settled=6 calls:complete=6 usage:6`。台帳の主体は JWT の本人。AI へ渡る中身に、トークン・user id・メール・Supabase の鍵は無い |
| 二重課金 | 同じ鍵＋同じ内容 → 保存済みの候補（送信なし）。同じ鍵＋別の内容 → `new_key_needed`。同じ鍵を同時に 2 回 → 1 回だけ送信し、もう一方は `retry_same_key` |
| 本物の JWT での拒否 | 他人のワークスペース、POSTONA を始めていない人、匿名ログイン、共有したワークスペース、**ログアウトしたセッション**（JWT 自体は期限内なので門番は通し、G5 が拒否）、**期限切れのセッション**（`not_after`）→ どれも `not_available`。送信・予約は 0 |
| 止める（REVOKE） | `not_available` に戻る。完了済みの鍵の再送も止まる。もう一度許可すると、保存済みの候補が返る（送信なし） |
| 本物の入口（index.ts） | 読み込まれて動く。ローカルでは `SUPABASE_URL=http://kong:8000` のため 503 `POST_ASSIST_UNAVAILABLE`（意図どおり、安全側で止まる）。トークンでない鍵 → 401、`text/plain` → 415。送信・予約は 0 |

壊したコード 3 種類は、本物のランタイムの上で、すべて検出しました（理由は失敗した試験名で確認）。
- M1: 参照クライアントで、門番の 401 を「ログインし直す」にしない
- M2: G5 への問い合わせに、本人のトークンの代わりに publishable key を送る
- M3: Edge で、JWT の形でない Bearer を通す

## 3. 見つかったこと

- **F1（G6 で直した。G1 は写し直しが必要）**: deploy の既定は `verify_jwt` が有効です。この場合、壊れた・期限切れ・無いトークンには Supabase の門番が先に 401 を返し、その本文は門番自身の形（`{code,message,msg}`）です。
  - G1 の PR #576 の写しは、この答えを `unavailable`（使えない）と表示します。「ログインし直す」が出ません。
  - G6 の参照クライアントを「どこからの 401 でも `relogin`」に直しました（`postona_post_assist_client_reference.ts`、契約試験に門番の 401 を追加）。
  - **G1 は自分の PR で写し直す**必要があります（`tests/post-assist-client.test.mjs` は PR #566 の写しを固定しているため）。
- **F2（G5 への申し送り）**: 本物の Supabase イメージでは、`auth.users` に RLS がかかっています（owner は `supabase_auth_admin`）。
  - `MVP_INSTALL.sql` の前提確認（`S22_PRECONDITION_RLS_HIDES_ROWS auth.users`）を通るには、lifecycle owner に BYPASSRLS が要りました。
  - G5 の関数がユーザーの行を確保するには、`postgres` と同じ auth 表の権限（`all on auth.users / sessions / identities`）が要りました。
  - 試験では、superuser でない owner にこの 2 つを与えています（この image の `postgres` 役割と同じ属性）。managed で誰を owner にするかは G5 の判断です。
- **F3（ローカルだけの事実）**: `supabase functions serve` の下では、関数に `SUPABASE_URL=http://kong:8000` と `SUPABASE_ANON_KEY=sb_publishable_…` が渡ります（`supabase start` だけのときは legacy の anon JWT）。G6 は URL を拒否するので、本物の入口はローカルでは 503 になります。hosted では https が渡る想定ですが、**NOT_VERIFIED** です。
- **F4（G5 / G1 で決めること）**: 個人のワークスペース（`u_…` の brand と owner の membership）を作る製品の経路が、ソースにありません。
  - `ensure_my_profile` も `start_x_autopost_service` も作りません。G5 の試験は fixture で作っています。
  - この経路が無いと、アプリは「所属しているワークスペースがありません」となり、AI は使えません。
- **F5（ローカルの門番の振る舞い。hosted は NOT_VERIFIED）**:
  - 門番が CORS に自分で答え、`Access-Control-Allow-Origin` を `*` に書き換えます。
  - ブラウザーの事前確認（OPTIONS、Authorization なし）は 200 です。
  - `Content-Length` の無い（chunked の）本文も、入口に届いたときには長さが付いていて 200 でした。
  - `functions serve` で Edge のコンテナを入れ替えた直後は、最初の 1 回だけ門番が 500 `An unexpected error occurred` を返すことがあります（実行スクリプトは、G6 が実際に答えるまで待ちます）。
  - G6 の入口自体は、一覧に無い Origin を 403 で拒否します（ネイティブアプリは Origin を送りません）。

## 4. 本番前の採用ゲート（実行の許可ではない。上から順に）

| # | ゲート | 担当 | ローカルでの証拠 | 残り |
|---|---|---|---|---|
| 1 | G5 の MVP の採用（`MVP_INSTALL.sql` → `MVP_R1_EXECUTE_GRANT.sql`、止めるときは REVOKE）と、そのレビュー | G5 ＋ ユーザーの承認 | 本物のイメージで、install → grant → revoke → grant が動く（F2 の owner の属性つき） | managed での owner の選び方、適用 |
| 2 | 個人のワークスペースを作る製品の経路（F4） | G5（G5-50）/ G1 | 無い（fixture で代用） | 設計と実装 |
| 3 | G6 の SQL：台帳 20261010050613 → call store 20261017120000 → erasure 20261017150000 → owner-held 20261020154536 → 候補 001 → 予算の行（値はユーザーが決める） | G6 ＋ ユーザーの承認 | 本物のイメージに `postgres` で入る | managed への適用 |
| 4 | Edge の deploy：`postona-post-assist`（`verify_jwt` は既定のまま）。secret：`AI_GATEWAY_SERVICE_KEY`（`sb_secret_…`）、`POSTONA_POST_ASSIST_FEATURE`（モデル・上限。ユーザーが決める）、`POSTONA_POST_ASSIST_ALLOWED_ORIGINS`（ネイティブだけなら空）、`OPENAI_API_KEY` | ユーザーの承認 | 入口はランタイムで読み込まれて動く。設定が足りなければ 503 | deploy、secret、hosted の `SUPABASE_URL` / `SUPABASE_ANON_KEY` の値の確認（F3） |
| 5 | managed の JWT / PostgREST / GoTrue（ES256 か HS256 か、`session_id` / `is_anonymous`、ログアウト・期限切れで G5 が拒否するか） | G5 / G6 | ローカルでは本物で通った | hosted で読むだけの確認 |
| 6 | hosted の門番の 401 の本文、CORS、`Content-Length`（F1・F5） | G6 | ローカルの事実だけ | hosted で確認 |
| 7 | G1：参照クライアントを写し直す（F1）、実機の React Native で `functions.invoke` を呼ぶ | G1 | supabase-js 2.115.0 では通った | 写し直しと、実機での確認 |
| 8 | 有料の AI への最初の 1 回 | ユーザーの承認（予算） | 偽の AI だけ | 承認 |

## 5. NOT_RUN / NOT_VERIFIED

- managed / hosted の Supabase、実機のアプリ、本物の OpenAI はどれも使っていません。
- 確認と送信の間に許可が取り消される場合は、時間の制御が要るため、本物のランタイムでは試していません。G6-25（PG17）で確認済みです。
