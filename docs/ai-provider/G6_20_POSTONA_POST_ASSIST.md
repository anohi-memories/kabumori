# G6-20 POSTONA の AI 文章・ハッシュタグの候補（個人 MVP）

- task_id: `common-ai-g6-postona-mvp-text-hashtag-gateway-aba-ledger-source-batch-20261028`（Issue #321、G6-20）
- 作成: 2026-10-28。**G6 の製品コード（未 deploy）**。本番・実際の SNS への投稿・有料の AI は **NO_GO**。
- 範囲: 本人 1 人・ワークスペース 1 つ・X と Threads だけ。Instagram・スタッフ・複数の管理者・権限の移譲・複数のワークスペースは対象外。

## 1. できること

`supabase/ai_gateway/postona_post_assist.ts`

| mode | 入力 | 出力 |
|---|---|---|
| draft | notes（メモ、2000 文字まで） | 投稿文の候補 1〜3 個（ハッシュタグの案つき） |
| refine | draft（本人の下書き、1000 文字まで）＋ instruction（300 文字まで） | 書き直しの候補 1〜3 個 |
| hashtags | draft | **本文はそのまま**、ハッシュタグの案だけ |

- すべての候補に `editable: true` と `requiresUserConfirmation: true` が付く。投稿するかどうかは本人が決める。**このモジュールには、X・Threads・どの SNS への道も無い**。
- 規則（G6 が決めた MVP の値。プラットフォームの事実としては NOT_VERIFIED）:
  - X: 本文＋ハッシュタグで、重み付きの 280 以内（日本語などの全角は 2 と数える）。ハッシュタグは 5 個まで。
  - Threads: 500 文字以内。ハッシュタグ（トピック）は 1 個まで。
  - ハッシュタグは本文に入れず、別の欄に `#` 付き（空白なし、50 文字以内、重複なし）。
  - 規則に合わない候補は落とす。全部落ちたら `POST_ASSIST_AI_UNUSABLE`。
- 呼び出しは、共通の呼び出し口の `postona:post_generation` 機能（G5 の v1 が知っている機能）。
  - 冪等: Idempotency-Key ＝ 操作 ID。同じ鍵は保存した答えを返す。
  - 持ち主の確認つきの台帳（G6_20_OWNER_HELD_LEDGER.md）、送信の直前の G5 の再確認、提供元は OpenAI だけ（個人のデータを Anthropic に送らない）。
- HTTP の形（Edge Function の持ち主がつなぐ）: `handlePostAssistRequest(request, gateway)`
  - 入力: POST JSON `{brand_id, mode, platform, notes?, draft?, instruction?}`、`Authorization: Bearer <本人の JWT>`、`Idempotency-Key`
  - 成功: 200 `{candidates, notice}`
  - エラー: `{error, retry_same_key}`
  - `gateway: null` のときは 503（何も送らない）

## 2. 偽の環境で通った利用者の操作（`common_ai_gateway_post_assist_test.ts`）

1. X で、メモ → 下書きの候補 3 つ → 本人が 1 つを書き換える → その文のままハッシュタグの案 → 丁寧に書き直した候補 2 つ。各段で、提供元への送信は 1 回。台帳は 3 回とも確定。
2. Threads で、タグ 2 つの候補が落ちる。どれも使えなければ 502（新しい鍵で）。
3. X の 280 を超える候補が落ちる。hashtags で本文を変えた候補が落ちる。形の悪いタグや本文の中のタグは、呼び出し口の確認で拒む。
4. 同じ Idempotency-Key の再試行は、保存した候補を返す（2 回目の送信なし）。新しい鍵は新しい依頼。
5. 拒否される場面:
   - session の失効・entitlement なし → 403
   - G5 が落ちている → 503（同じ鍵で再試行してよい）
   - 送信の直前の再確認での失効 → 403。予約は release される。
   - 呼び出し口が未設定 → 503
   - どれも送信 0。
6. 形の悪い依頼（知らないキー・別のプラットフォーム・mode と合わない欄・長すぎる・空白だけ・形の悪いワークスペース ID・Idempotency-Key なし・GET・長さなし）は 4xx。G5 にも尋ねず、送信 0。

すべて偽の G5・偽の台帳・偽の OpenAI の上での確認。本物の AI の答えの質・費用・本物の JWT は確かめていない。

## 3. 製品につなぐための差分（持ち主ごと。G6 は変えていない）

| 何を | どこ（案） | 持ち主（案） | 状態 |
|---|---|---|---|
| Edge Function: `handlePostAssistRequest` を、`createAiGateway`（owner_held）と G5 の transport で動かす。CORS、Supabase の秘密の鍵、OpenAI の鍵、公開鍵 | `supabase/functions/postona-post-assist/index.ts`（新しく） | POSTONA の Edge の持ち主（G3 / G4。担当ちゃが決める） | 未接続。deploy には、provider のモジュールの import 許可の範囲を広げる必要がある（共有のセキュリティ境界。G6 は変えない） |
| 投稿の作成・編集の画面: 「AI で下書き」「ハッシュタグの案」「書き直し」のボタン。操作ごとに Idempotency-Key を作る。候補を編集できる欄に入れる。投稿は今までどおり本人の確認の後 | `apps/social-mobile` の投稿の作成 / 編集の画面 | アプリの持ち主（G1 / G2） | 未接続 |
| 機能の設定: `postona:post_generation` を有効にする（revision・model・上限・`postona:x_autopost`）＋台帳の予算の規則（本人・日ごと・1 回あたりの上限） | 運用の設定、`ai_ledger.budget_policies` | 運用（ユーザーの決定） | 未設定（AI のプランは未決） |
| 本人・session・ワークスペース・entitlement・停止の判定 | G5 の R1（今は v1 の提案の RPC。個人 MVP の IF は G5-47 で作業中） | G5 | **BLOCKED_G5_46_IF**（G6 は v1 の互換を保っただけ。G5 の正式な IF を読み返してから、差分だけつなぐ） |
| SQL の適用（台帳 → call store → 消去 → owner-held / RC のガード → 001 の候補） | managed / 本番 | ユーザーの承認＋Codex Sol（高） | 未適用 |

## 4. 予算と費用

- 1 回の上限は、機能の設定の `maxCostUsdPerOperation`（試験の値 0.1 USD）。台帳は、予約のときに上限で押さえ、確定のときに実際の費用（使ったトークン）で記録する。答えが失われた試行は、上限のまま `unknown` で確定する（再送しない）。
- 本人・日ごとの上限は、`ai_ledger.budget_policies` の規則で決める（PG の試験の固定値は 200 回・5 USD・1 回 0.2 USD。本番の値は未決）。
- 本物の費用は確かめていない（有料の API を呼んでいない）。
