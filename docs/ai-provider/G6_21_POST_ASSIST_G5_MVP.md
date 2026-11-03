# G6-21 POSTONA の AI 文章・ハッシュタグを、G5-47 の個人 MVP の認可につなぐ

- task_id: `common-ai-g6-postona-post-assist-g5-mvp-consumer-adapter-source-integration-20261028`（Issue #321、G6-21）
- 作成: 2026-10-28。**G6 の新しいファイルと試験だけ**。H2 がレビュー中の SQL・`ledger_guard.ts`・`gateway.ts`・`runtime.ts`、`authority_port.ts` は変えていない。本番・接続・merge は **NO_GO**。
- 元: G5-47（Issue #320、PR #550 `4c97140a`、`docs/common-account/g5-47-postona-mvp-r1-personal-token.md`）

## 1. G5-47 の契約と、G6 の受け取り方

| 項目 | G5-47（R1-MVP） | G6（`supabase/ai_gateway/postona_post_assist_mvp.ts`） |
|---|---|---|
| 呼び方 | v1 と同じ（`common_account_authorization_verdict`、`{p_app,p_feature,p_brand_id}`、本人の JWT） | 既存の `createG5RpcTransport` のまま |
| 答え | v1 の 8 キー。ワークスペースの allow は `owner_epoch = g5pv:<lifecycle_version>` | **個人 MVP に固定**（`G5_R1_PERSONAL_MVP_PROFILE = "g5-47-r1-personal-mvp-v1"`）。`g5pv:<n>`（n は 1 以上、19 桁まで）だけを受け付ける。`g5oe`・形の悪い値・数値は拒む（unknown） |
| 世代 | 本人のアカウント・entitlement が変わるたびに +1、再利用しない | 有効な `g5pv:<n>` を、port に `g5oe:1:<n>` として渡す。port の形の確認と世代（本人・session・token・entitlement）はそのまま働き、n が違えば送らない。この変換は adapter の中だけ |
| entitlement | `["postona:x_autopost"]` | 設定で `postona:x_autopost` だけを許す。ほかの値は起動時の設定の誤り |
| 新しい理由 | `OWN_WORKSPACE_CONFLICT`（deny）、`SERVICE_GENERATION_UNAVAILABLE`（unknown） | 既存の port がそのまま通す（403） |
| R1-MVP の ACL（authenticated） | **未決**（出荷時は所有者だけ） | **BLOCKED_G5_AUTH_EXECUTE**。今の本物の呼び出しは 401 / 403（→ 403）か 404（→ 503）で、何も送らない |
| 移行の順番 | 1. G6 が g5pv を受け付ける（個人に固定）→ 2. G5 の MVP を適用し ACL を決める → 3. 配線 | 1 はこの adapter（候補）。2・3 は G5 とユーザーの決定の後 |

`authority_port.ts` の 1 行の変更（G5 の推奨）の代わりに、新しい adapter で受け付けた。理由は、TASK が既存のファイルを変えずに新しいファイルで作るよう求めているため。既存の port の厳しい確認は 1 か所だけのまま（重複させていない）。

## 2. つなぐための形（持ち主に渡すもの）

```ts
import { createPostonaPostAssistMvp, G5_R1_PERSONAL_MVP_PROFILE } from "../_shared/ai_gateway/postona_post_assist_mvp.ts";
const app = createPostonaPostAssistMvp({
  profile: G5_R1_PERSONAL_MVP_PROFILE,
  supabaseUrl, publishableKey,                              // 公開の値
  serviceKey: new SecretValue("AI_GATEWAY_SERVICE_KEY", …), // 秘密（Edge の secret から）
  readEnv: (name) => Deno.env.get(name),                     // OPENAI_API_KEY だけが読まれる
  feature: { enabled: true, revision, provider: "openai", model, …, entitlements: ["postona:x_autopost"] },
});
Deno.serve((req) => withCors(app.handle(req)));
```

| 持ち主 | 最小の差分 | 状態 |
|---|---|---|
| POSTONA の Edge（G3 / G4。担当ちゃが決める） | `supabase/functions/postona-post-assist/index.ts` を新しく作る（上のとおり＋CORS）。`supabase/ai_gateway/` を `_shared/ai_gateway/` に置く。provider の import の許可の範囲を広げる（G6-05 の提案の写し。今回、新しいファイルを 1 つ足した。許可を 1 つずつ外す検査は 45/45） | 未接続 |
| アプリ（G1 / G2） | `apps/social-mobile` の投稿の作成 / 編集の画面に、「AI で下書き」「ハッシュタグの案」「書き直し」の操作を足す。操作ごとに Idempotency-Key（UUID）を作る。`Authorization: Bearer <本人の JWT>`、`{brand_id: 本人のワークスペース, mode, platform, notes / draft / instruction}`。候補は編集できる欄に入れ、投稿は今までどおり本人の確認の後。エラー `retry_same_key: true` のときだけ同じ鍵で再試行 | 未接続 |
| G5 | R1-MVP の適用と、authenticated の ACL の決定 | **BLOCKED_G5_AUTH_EXECUTE** |
| 運用 / ユーザー | 機能の設定（model・上限・revision）と、台帳の予算の規則。SQL の適用（台帳 → call store → 消去 → owner-held / RC のガード → G6-20 の 001 → G5 の MVP） | 未決 / 未適用 |

## 3. 確かめたこと（`common_ai_gateway_post_assist_mvp_test.ts`、オフライン）

1. 固定: `g5pv:<n>` だけが通る。`g5oe`・`g5pv:0`・先頭が 0・負の数・2 つの数・大文字・空・20 桁・数値・真偽値は拒む。拒否の答えはそのまま通す。
2. X と Threads の利用者の操作（下書き → 本人が編集した文のハッシュタグ → Threads の下書き）: 各段で送信 1 回、台帳は確定、候補は編集でき確認が要る。判定と再確認の両方に本人の JWT。
3. 世代: 判定と再確認の間で token が +1・小さくなる・g5oe になる → 403。予約は release、送信 0。同じ token なら 1 回送る。
4. G5-47 の拒否（匿名・session の期限 / 不明・別のワークスペース・2 人目の member・owner 2 人・一時停止・終了処理中・trigger の改ざん）、固定（g5oe・token なし）、entitlement なし、別のワークスペースの allow、余分なキー、ACL が無い（403）・JWT の拒否（401）・未適用（404）・5xx・落ちている・遅い: どれも予約・送信・課金が 0。
5. 同じ Idempotency-Key は再生（送信 1 回）。OpenAI の 429 は、その鍵の失敗として保存し、再送しない（確定は 1 回）。形の悪い依頼は G5 に尋ねる前に 400。
6. 設定: 個人 MVP 以外の profile・Anthropic・ほかの entitlement・2 つの entitlement・無効な機能は、起動時に止まる。

わざと壊した写し（6 種類）: 5 種類を検出。残り 1 種類（OpenAI 以外を拒む確認を外す）は、共通の機能カタログが post_generation を OpenAI だけに限っているため、同じ設定の誤りで止まる（実質同じ動き）。

## 4. 残るもの

- G5 の ACL と、本物の R1-MVP の RPC・JWT（BLOCKED_G5_AUTH_EXECUTE）
- Edge・画面の配線（持ち主の作業）
- H2 の PR #553 のレビューの結果（CHANGES_REQUIRED なら、その直しを先にする）
- 本物の OpenAI の答えの質と費用
