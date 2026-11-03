# G6-23 POSTONA の AI 投稿補助の HTTP 入口（Edge）

- task_id: `common-ai-g6-postona-post-assist-edge-entry-product-wiring-20261029`（Issue #321、G6-23）
- 作成: 2026-10-29。製品のソース: `supabase/functions/_shared/ai_gateway/postona_post_assist_edge.ts` と入口 `supabase/functions/postona-post-assist/index.ts`（G6-24 で置いた）。**deploy していない**（本番は NO_GO）。
- 元にしたもの: G6-21 の個人 MVP の adapter（PR #556）と、G6-22 の legacy の fence（PR #558）。

## 1. アプリ（G1）が呼ぶ形

`POST https://<project>.supabase.co/functions/v1/postona-post-assist`（Edge に置いた後）

| ヘッダー | 値 |
|---|---|
| `Authorization` | `Bearer <本人のアクセストークン>`（必須。無い・Bearer でない・JWT の形（点で区切った 3 つの部分）でない → 401 `POST_ASSIST_AUTH_REQUIRED`。G5 には何も尋ねない。G6-25 で JWT の形の確認を足した） |
| `Content-Type` | `application/json`（それ以外 → 415） |
| `Idempotency-Key` | 操作ごとに新しい UUID（8〜128 文字。先頭は英数字、その後は `[A-Za-z0-9_.:-]`）。同じ操作の再試行だけ同じ値 |
| `apikey` | プロジェクトの publishable key（Supabase の Functions の入口が求める場合） |

本文（JSON。mode ごとに決まったキーだけ。足りない・余分なキーは 400）:

| mode | キー |
|---|---|
| `draft` | `brand_id`（本人のワークスペース）、`mode`、`platform`（`x` / `threads`）、`notes`（2,000 字まで） |
| `refine` | `brand_id`、`mode`、`platform`、`draft`（本人が編集した文）、`instruction`（300 字まで） |
| `hashtags` | `brand_id`、`mode`、`platform`、`draft`（文はそのまま、タグだけ提案） |

成功 200: `{ candidates: [{ platform, text, hashtags, length, limit, editable: true, requiresUserConfirmation: true }], notice }`（候補は最大 3 つ）
- 候補は編集できる欄に入れる。投稿は今までどおり本人が確認した後に、既存の投稿の画面から行う（この入口は SNS に何も送らない）。
- X: 重み付きで 280 まで・タグ 5 つまで。Threads: 500 字まで・タグ 1 つまで（合わない候補は返さない）。

失敗: `{ error, retry_same_key }`

| status | error | アプリの動き |
|---|---|---|
| 400 | `POST_ASSIST_REQUEST_INVALID` / `POST_ASSIST_IDEMPOTENCY_KEY_REQUIRED` | 入力を直す |
| 401 | `POST_ASSIST_AUTH_REQUIRED` | ログインし直す |
| 403 | `POST_ASSIST_NOT_ENTITLED` | 使えない（未ログイン・期限切れ・別のワークスペース・契約なし・停止中・世代の変化を含む）。セッションを更新して、**新しい鍵**でやり直してよい |
| 403 | `POST_ASSIST_ORIGIN_REFUSED` | ブラウザーの Origin が一覧に無い |
| 405 / 415 | `POST_ASSIST_REQUEST_INVALID` | 呼び方の誤り |
| 409 | `POST_ASSIST_IN_PROGRESS`（`retry_same_key: true`） | 少し待って**同じ鍵**で再試行 |
| 409 | `POST_ASSIST_OPERATION_REUSED` | 同じ鍵を別の内容に使った。新しい鍵で |
| 429 | `POST_ASSIST_QUOTA_EXCEEDED` | 上限。時間をおく |
| 502 | `POST_ASSIST_AI_UNKNOWN` / `_AI_FAILED` / `_AI_UNUSABLE` | その鍵の結果として保存済み（再送しない）。やり直すなら新しい鍵 |
| 503 | `POST_ASSIST_AUTH_UNAVAILABLE` / `POST_ASSIST_UNAVAILABLE`（`retry_same_key: true` のときだけ同じ鍵）/ `POST_ASSIST_NOT_SENT` | 一時的に使えない。何も送っていない |

## 2. Edge の設定（置く人が決める。既定値なし）

| 環境変数 | 中身 |
|---|---|
| `SUPABASE_URL` | プロジェクトの URL |
| `SUPABASE_ANON_KEY` | publishable key（G5 の RPC は本人のトークンで呼ぶ。この鍵は権限を与えない） |
| `AI_GATEWAY_SERVICE_KEY` | 台帳と ai_calls の RPC 用の secret key（`sb_secret_…`。legacy の JWT は拒む） |
| `OPENAI_API_KEY` | OpenAI の鍵（provider の層だけが読む） |
| `POSTONA_POST_ASSIST_FEATURE` | `postona:post_generation` の設定の JSON（model・上限・revision など 11 キーちょうど。OpenAI だけ、`entitlements: ["postona:x_autopost"]` だけ）。**単価・予算は未決** |
| `POSTONA_POST_ASSIST_ALLOWED_ORIGINS` | ブラウザーの Origin の一覧（カンマ区切り、完全一致、`*` 不可）。空ならブラウザーからは使えない（ネイティブのアプリは Origin を送らない） |

どれかが無い・不正なら 503 `POST_ASSIST_UNAVAILABLE`（中身は出さない）。G5・台帳・AI には何も送らない。

## 3. 置き場所（G6-24 で source に置いた。deploy はしていない）

1. G6 の共通 AI の部品: `supabase/functions/_shared/ai_gateway/`（G6-24 で `supabase/ai_gateway/` から移した。中身は import の行先とコメントだけが変わった）。その隣に G6 の isolation test。
2. Edge の入口: `supabase/functions/postona-post-assist/index.ts`（handler を `Deno.serve` に渡すだけ）。
3. 共有 provider の isolation test（`supabase/functions/_shared/ai_provider/isolation_test.ts`）の許可: G6-05 の提案と G6-23 の入口の許可を、そのまま当てた。差分の記録は `supabase/tests/fixtures/g6_24_provider_isolation/provider_isolation_g6.patch`（足した行 59、消した行 5 = 古い範囲を説明するコメント 4 と `AUTHORIZED_ENTRY_POINTS` の 1 行）。

`supabase/tests/common_ai_gateway_edge_preflight.ts` が作業用の写しで確かめる:
- そのまま → PASS（入口と部品は、その場所で `deno check` OK）
- 許可を G6-24 の前に戻す → FAIL
- 入口の許可だけを抜く、またはどちらか 1 つを抜く → FAIL
- 入口がほかのファイルも import する → FAIL
- 2 つ目の入口 → FAIL
- 悪い変更 12 種類 → FAIL
- 許可を 1 つずつ抜く → 48/48 FAIL

## 4. まだ使えない理由（blocker）

- **G5（BLOCKED_G5_AUTH_EXECUTE）**: R1-MVP の RPC を本人（authenticated）が EXECUTE できる許可が未適用。G5-48 の候補（PR #563 の `MVP_R1_EXECUTE_GRANT.sql`。source のみ受入、セキュリティレビュー前）とこの入口を、G6-25 で使い捨ての PG17 上でつないで確かめた（`G6_25_POST_ASSIST_G5_48_INTEGRATION.md`）。許可が無い間は 403 → `POST_ASSIST_NOT_ENTITLED`、何も送らない。
- 共有 provider の isolation の変更と新しい Edge の入口は、Codex Sol（高）の 1 回のレビューの後。deploy・secret の設定は、さらにユーザーの承認の後。SQL（台帳 → ai_calls → owner-held の 001 → G5 の MVP）の適用も同じ。
- H2 #329 第 20 TASK（PR #553）の受入と、PR #558 の再確認が未完了。
