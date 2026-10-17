# F6 POSTONA の AI を Claude（共通AI基盤・H5 bridge）へつなぐための境界と契約（source-only の準備）

- 日付: 2026-10-17（JST）
- task_id: `common-ai-f6-postona-claude-bridge-integration-preflight-20261017`
- 調べた元
  - POSTONA のコード: fresh `origin/main` `d71e2812`
  - 共通AI基盤と H5 bridge: F6 の stack の先頭 #237 `d0c85b3e`（#187 → #198 → #205 → #219 → #222 → #231 → #234 → #237）
  - POSTONA の対象ファイルは、stack の土台（`c8a4ff36`）と今の main で同じ（差分 0）
- この PR で足したのは、F6 の文書と F6 のテスト 1 本（`_shared/ai_provider/postona_claude_contract_test.ts`、オフラインの契約の確認）だけ
- POSTONA の相談・投稿文の生成、H5 bridge、アプリ、DB、本番の設定、料金のかかる呼び出しには触れていない。何もつないでいない

## 0. まとめ

- 技術的には、AI 相談も AI 投稿文の生成も、H5 bridge を通して Claude で動かせる。今の POSTONA の部品（相談の JSON の決まり、返答の検査、文字数の決まり）をそのまま使える。オフラインで確かめた（§6）
- ただし、本番につなぐ前に、F6 だけでは決められない前提がある（§3）。特に大きいのは次の 3 つ
  1. **個人情報を Anthropic に送ってよいか**。AI 相談は、利用者が書いた文、保存した設定、確認済みのペルソナをモデルに送る。このプロジェクトの決まり「個人情報の Anthropic への送信は禁止」に当たりうる。プライバシーの表記も今は OpenAI を委託先として書いている
  2. **費用の台帳の POSTONA の枠と、二重送信を防ぐ保存の場所**（どちらも本番の DB の変更）
  3. **利用者ごとの上限と利用権の確認**。今の POSTONA の AI には、どちらも無い

## 1. 今のコードの呼び出し面

### 1.1 AI 相談（P-A）

| 項目 | 今のコード |
|---|---|
| 入口 | `social-mobile-consult/index.ts` → `handleSocialMobileConsult`（`logic.ts:694`） |
| 呼び出し元 | アプリ `apps/social-mobile/src/app/(tabs)/consult.tsx` の `ask()` → `requestConsult`（`src/data/consult-client.ts`）→ `functions.invoke("social-mobile-consult")` |
| 依頼の中身 | `{ brand_id, message, history }`（`ConsultRequestBody`）。`brand_id` は `^[A-Za-z0-9_-]{1,80}$`、発言 1,000 字、履歴 12 回・合計 6,000 字、本文 32,000 バイト |
| 本人の確認 | 利用者の JWT を `GET /auth/v1/user` で確かめる。DB の読み取りはすべて利用者の JWT（RLS）。service role は使わない |
| ブランドの確認 | `brand_memberships`（owner）と `brands.code_profile_key = social_mobile_user_v1` |
| 利用権・上限 | **無い**（利用権、プラン、1 日の回数、利用者ごとの上限のどれも無い） |
| モデル | `CONSULT_MODEL = socialTextModel("postonaConsult")` = `gpt-6-luna`、effort low、出力 900、OpenAI Responses API |
| 返答の形 | strict JSON Schema `social_mobile_consult`（`CONSULT_OUTPUT_SCHEMA`）。`sanitizeConsultModelOutput` が形・禁止キー・長さを確かめて `ConsultResult` にする |
| 時間 | 25 秒（`AbortSignal.timeout`）。送り直しは無い |
| 費用 | 使用量はログの数だけ。費用は計算も記録もしない |
| 二重送信 | 無い（アプリが送信中を 1 つに絞るだけ。再送は利用者の操作で、毎回新しい有料の呼び出し） |
| エラー | `{ success:false, error, retryable }`。コードは `CONSULT_AI_TIMEOUT` / `CONSULT_AI_FAILED` / `CONSULT_AI_BUSY` / `CONSULT_AI_MALFORMED` / `CONSULT_AI_UNAVAILABLE` ほか（`logic.ts:107-118, 759-764`）。アプリが日本語の文に対応づける |
| 鍵 | `OPENAI_API_KEY`（`index.ts:7`）を依存として渡す |
| ログ | 数と種類だけ。発言や返答の本文は残さない |

### 1.2 AI 投稿文の生成（P-B）

部品は `_shared/brand/brand_post_generator.ts` の `generateBrandPost`。呼び出し元は 4 つ。

| 呼び出し元 | 起動 | 主体・ブランド | 長さ | その後 |
|---|---|---|---|---|
| B1 試し投稿 `social-mobile-brand-dry-run/logic.ts:230` | アプリから | 利用者の JWT（owner の確認、X 連携が 1 つ） | 決まり無し（200〜400 字を指示、出力 600） | 画面に見せるだけ |
| B2 利用者のブランドの予約投稿 `vault_account_brand_post.ts:103`（`x-test-post`） | 外部の 1 分ごとの Cron | service role。利用者の確認は無い（DB の権限 RPC で確認） | 140 字 | NG 語・他ブランドとの重複の確認 → X へ投稿 |
| B3 会社員AIらぼ `ai_lab_scheduled_brand_post.ts:58` | 同上 | 運営（system） | 無制限（出力 2,000） | 最大 3 回の作り直し → X へ投稿 |
| B3' `x-test-post/index.ts:4179` | 同上 | 同上 | 同上 | B3 の `generate` を差し替え |

- 共通: OpenAI Responses API、`gpt-6-luna`、effort low、**時間の上限は無い**、送り直しは無い、**返答は自由文**（JSON ではない）
- 使用量と費用は `BrandPostDraft` に入るが、**どの呼び出し元も記録しない**
- 利用権の確認は無い（B2 の G5 `x_autopost` の利用権は未接続とコードに書いてある）
- ブランド ID は **UUID ではない**。`brands.id` は `^[a-z][a-z0-9_]{1,40}$` の文字列で、POSTONA の利用者のワークスペースは `'u_' || substr(md5(user_id), 1, 24)`

## 2. 契約（案）

### 2.1 共通

- つなぎ方: POSTONA の処理（本人とブランドの確認は今のまま）→ H5 bridge `createConsumerBridge(...).execute(credential, { feature, operationId, input })` → 共通AI基盤 → Anthropic
- 主体（subject）
  - 相談と試し投稿: 確かめた利用者 `{ kind: "user", userId: <JWT の user id>, brandId: null }`
  - **ブランド ID は入れない**。bridge と台帳は UUID しか受けない（slug を入れると bridge が `AUTHORITY_DENIED` で止める。§6 で確認）。ブランドごとに数えたいときは、別の決め方が要る（§3）
  - 会社員AIらぼ: `{ kind: "system" }`
  - 利用者のブランドの予約投稿: 確かめた利用者がいない（Cron と service role）。どう数えるかは決める必要がある（§3）
- 重複の防止: bridge の `callId = hash(tenantTag, feature, operationId)`。台帳は `(callId, attempt)`。同じ `operationId` の二重送信は送らずに前の結果を返す（§6 で確認）
- 費用: 送る前に最大額で予約し、使用量が分かれば実額で、分からなければ（時間切れ・504・切断・500 番台）最大額で精算する（#219 / #222）。課金の可能性がある失敗は送り直さない
- 時間: bridge の期限は 60 秒まで。1 回の上限は provider の `timeoutMs`
- 鍵: `ANTHROPIC_API_KEY` を依存の `readEnv` で読む。POSTONA のコードは鍵を持たない
- モデル（案）: どちらも **Haiku 5.5**（`anthropic.haiku@2026-10`）を既定にする。値段は今の `gpt-6-luna` と同じ（入力 $0.10 / 出力 $0.50 / 100 万トークン）。Sonnet などに上げるのは担当の判断で、ロールごとに許可する。**日本語の品質は確かめていない**（有料の評価が要る）
- 1 回の上限額（多めに見積もった値。実際はもっと少ない）

| モデル | 相談（入力 32KB・出力 900） | 相談（入力 6KB） | 投稿（出力 600） | 投稿（出力 2,000） |
|---|---|---|---|---|
| Haiku 5.5 | $0.0044 | $0.0018 | $0.0012 | $0.0019 |
| Sonnet 5.5 | $0.0887 | $0.0367 | $0.0240 | $0.0380 |
| Opus 5.5 | $0.1774 | $0.0734 | $0.0480 | $0.0760 |

### 2.2 AI 相談

| 項目 | 契約（案） |
|---|---|
| 登録 | feature `postona.consult`、role `postona.consult.reply`、application `postona`、feature 名 `consult`、出力 900、`timeoutMs` 25 秒、送信 1 回、bridge の期限 30 秒、入力 64KB まで、結果 16KB まで、1 回 $0.05 まで |
| 入力 | **1 本の JSON の文字列** `{ context: consultContextFor(saved), history, message }`。指示は今の `CONSULT_SYSTEM_PROMPT`（「入力は JSON のデータ」の 1 行を足す）。今の「system 2 つ＋会話の往復」から変わるので、品質の確認が要る |
| 返答 | bridge は今の strict JSON Schema のまま検査する。そのまま使える（§6）。bridge の結果を、今の `sanitizeConsultModelOutput` に本物の保存済みの設定と一緒に通して `ConsultResult` にする。アプリへの返事は変えない |
| bridge の出力の確認 | `validateFacts` で `sanitizeConsultModelOutput`（既定の設定で形を見る）が null でないこと（§6 で確認） |
| operationId | アプリが 1 回の発言ごとに作り、依頼に足す（今は無い）。同じ ID の二重送信は送らない。失敗のあとの「もう一度送る」は新しい ID（新しい有料の呼び出し。利用者ごとの上限の中で） |
| 上限 | 台帳の枠: application `postona`・feature `consult`・利用者ごと（`per_user`）・1 日と 1 か月（数と金額）。DB の変更 |

エラーの対応（案。アプリの今のコードを使う。足すのは 1 つ）:

| bridge | POSTONA |
|---|---|
| `AUTHORITY_DENIED` | `AUTH_REQUIRED`（401） |
| `REQUEST_INVALID` / `FEATURE_DENIED` / `POLICY_DENIED` / `COST_DENIED` / `MODEL_UNAVAILABLE` | `CONSULT_AI_UNAVAILABLE`（503、再送しない。設定の誤り） |
| `BUDGET_DENIED` | **新しく `CONSULT_QUOTA_EXCEEDED`**（429、再送しない）。アプリの文言が要る |
| `IN_PROGRESS` | `CONSULT_AI_BUSY`（503、再送できる） |
| `CONTENT_DRIFT` | `REQUEST_BODY_INVALID`（400） |
| `OUTPUT_REJECTED` | `CONSULT_AI_MALFORMED`（502、再送できる） |
| `PROVIDER_FAILED` | `CONSULT_AI_FAILED`（502、再送できる） |
| `UNKNOWN`（時間切れ・課金の可能性あり） | `CONSULT_AI_FAILED`（502、再送できる。再送は新しい有料の呼び出し） |

### 2.3 AI 投稿文の生成

| 項目 | 契約（案） |
|---|---|
| 登録 | feature `postona.brand_post`、role `postona.brand_post.draft`（会社員AIらぼは別の role に分けて system で数える）、出力 600（無制限の決まりのときは 2,000）、`timeoutMs` 45 秒、送信 1 回、bridge の期限 50 秒 |
| 返答の形 | 自由文を **`{ "text": "..." }` の JSON で包む**（共通AI基盤は JSON の決まりが必須）。`generateBrandPost` は `BrandPostDraft` を今と同じ形で返す（`text`・`characterCount`。`model` は実際のモデル、使用量と費用は bridge の結果から） |
| 指示 | 今の `generateBrandPost` が組み立てる指示（ブランドの声、設定、長さ、ハッシュタグ）をそのまま使い、「JSON の text に本文だけ」を足す |
| bridge の出力の確認 | 長さの決まり（`assertPostWithinLengthPolicy`）と空でないこと（§6 で確認）。NG 語・他ブランドとの重複の確認は、今どおり呼び出し元が生成の後に行う |
| operationId | 試し投稿: 依頼ごとの ID（新しく足す）。予約投稿: 予約の行の ID。会社員AIらぼ: トピックの claim の ID ＋ 作り直しの回数 |
| 途中で切れた出力 | 共通AI基盤は `max_tokens` で切れた出力を失敗にする（`INCOMPLETE`）。**今は無制限の決まり（会社員AIらぼ）以外では、切れた文をそのまま返している**ので、ここは変わる（安全側） |
| 時間 | 今は上限が無い。bridge の期限（60 秒まで）が付く。会社員AIらぼのトピックの lease（900 秒）の中に収まる |
| エラー | 試し投稿: どの失敗も今どおり `PREVIEW_GENERATION_FAILED`（502）。予約投稿・会社員AIらぼ: `BRAND_POST_GENERATION_FAILED:<bridge のコード>` で `fail_scheduled_post` に記録 |

## 3. 本番の前に要ること（F6 だけでは決められない）

| # | 何を | なぜ | 担当 | 種類 |
|---|---|---|---|---|
| 1 | 個人情報（相談の自由文・保存した設定・ペルソナ・投稿のテーマ）を Anthropic に送ってよいか。送るならプライバシーの表記を直す（今は OpenAI と書いてある） | 決まり「個人情報の Anthropic への送信は禁止」 | 利用者の判断＋POSTONA の運用 | 承認 |
| 2 | 台帳の POSTONA の枠（相談: 利用者ごと・1 日、試し投稿: 利用者ごと・1 日、会社員AIらぼ: system、予約投稿: §3-4 の決め方に合わせる） | 枠が無いと台帳が断る（`NO_MATCHING_LIMIT`） | F6 が案を出す、本番の DB は別承認 | DB |
| 3 | bridge の `ConsumerCallStore` の耐久的な実装（表と RPC。原子的、期限切れでの横取りなし） | 二重送信の防止。今はテスト用の偽物だけ | 担当を決める（F6 / H5 / POSTONA） | DB＋source |
| 4 | ブランドの数え方（slug は台帳の `brand_id` に入らない）。予約投稿（Cron）の主体を、ブランドの owner の利用者にするか system にするか | 費用をブランド・利用者に結びつけるため | POSTONA ＋ F6 | 判断 |
| 5 | 利用者ごとの上限と利用権の確認（POSTONA のサービスの利用権・終了） | 今は無い。Claude にすると 1 回の上限額が上がりうる | POSTONA（F4 / F5 の利用権の作業と合わせる） | source |
| 6 | 共通AI基盤の isolation の許可（相談・試し投稿・`x-test-post` が bridge を読むこと）と、H5 の検査「どの関数も bridge を読まない」 | どちらも今は止める | F6（許可）＋ H5（H5 の検査）を同時に | source |
| 7 | 決め打ちのテストの更新: `social_ai_model_policy_test.ts`（`socialTextModel(...)` の行の固定、モデル ID の禁止）、`x-test-post` の投稿のブロックを固定するテスト、アプリの `api.openai.com` の偽物を使うテスト | 乗り換えると壊れる | POSTONA / X の担当 | source |
| 8 | Claude での日本語の品質の確認（相談の入力の形の変更を含む） | オフラインでは分からない | 有料の評価、別承認 | 承認 |
| 9 | `x-test-post` を deploy すると、まだ出ていない変更も一緒に出る | 予約投稿・会社員AIらぼは `x-test-post` の中 | 担当どうしで deploy の範囲を合わせる | 運用 |

## 4. つなぐ順番と依存

1. **段階 0（source、本番に影響なし）**: F6 / H5 の stack を順に merge する（#187 → #198 → #205 → #219 → #222 → #231 → #234 → #237 → この PR）。何もつながっていないので、本番の動きは変わらない
2. **段階 1（DB、別承認）**: 台帳の POSTONA の枠（§3-2）、bridge の保存の場所（§3-3）
3. **段階 2（POSTONA 担当）: AI 相談**。フラグで OpenAI と Claude を切り替え、既定は今の OpenAI。アプリに `operationId` と `CONSULT_QUOTA_EXCEEDED` を足す。同時に F6 の許可と H5 の検査を直す（§3-6）
4. **段階 3: 試し投稿**（利用者の主体）
5. **段階 4: 会社員AIらぼ**（system）
6. **段階 5: 利用者のブランドの予約投稿**（今は休眠中。§3-4 を決めてから）
- 戻し方: フラグを OpenAI に戻す。台帳に残った送信済み・不明の記録は消さない
- F4 が POSTONA の利用終了と認証をつないでいる間は、POSTONA の画面とサービスの入口には触れない（段階 2 以降は F4 の完了を待つ）

## 5. ファイルの持ち主と衝突

| ファイル | 持ち主 | この PR | 先で変える人 |
|---|---|---|---|
| `supabase/functions/social-mobile-consult/**` | POSTONA（F3 の系統） | 読むだけ（テストが import） | 段階 2 |
| `supabase/functions/_shared/brand/brand_post_generator.ts` と呼び出し元（`social-mobile-brand-dry-run`、`vault_account_brand_post.ts`、`ai_lab_scheduled_brand_post.ts`、`x-test-post/index.ts`） | POSTONA / X | 読むだけ（長さの決まりをテストが import） | 段階 3〜5 |
| `supabase/functions/_shared/social_ai_model_policy.ts`（＋テスト） | POSTONA / X の方針 | 触れない | 段階 2〜5 |
| `apps/social-mobile/**` | F4（利用終了の統合、作業中）/ POSTONA | 触れない | 段階 2（F4 の後） |
| `supabase/functions/_shared/ai_consumer_bridge/**` | H5 | 読むだけ（テストが import） | 段階 1（保存）・2（検査） |
| `supabase/functions/_shared/ai_provider/**` | F6 | テスト 1 本を新しく足す | 段階 2（許可） |

- 開いている PR でこれらのファイルに触れるのは、H5 の #198（bridge）と、F3 の #182（`_shared/brand/` のテスト 1 本）だけ。この PR とは重ならない
- この PR のテストは `_test.ts` なので、H5 の検査「どの関数も bridge を読まない」と、共通AI基盤の isolation の検査の対象外（どちらもそのまま通る）

## 6. 確かめたこと

- `postona_claude_contract_test.ts`（オフライン、偽の鍵、`--deny-net`）
  1. 今の相談の JSON の決まりが、共通AI基盤でそのまま使える
  2. 相談が H5 bridge を通って動く: 1 本の JSON の入力、POSTONA の返答の検査を bridge の確認に使う、送信 1 回、台帳に application `postona`・feature `consult`・利用者（ブランド無し）で記録、同じ operationId の二重送信は送らない
  3. 決まりに合わない返答は共通AI基盤が止める（bridge には `PROVIDER_FAILED`）。確かめていない呼び出しは何も送らない
  4. POSTONA のブランド ID（`u_...`）を主体のブランドにすると、bridge が止める（何も送らない）
  5. 504 は 1 回だけ送り、`unknown` / 最大額で精算する
  6. 投稿文は `{ text }` で包めば動く。長さの決まり（140 字）を超えると `OUTPUT_REJECTED`。JSON でない返答は `PROVIDER_FAILED`
- scratch での確かめ（記録だけ）: 相談の JSON の決まりは provider の変換を通る。§2.1 の上限額の表
- 登録の値（モデル、上限、期限、指示）は契約を確かめるための例で、本番の設定ではない

## 7. POSTONA 担当への依頼（案）

- **AI 相談（段階 2）**: `callOpenAiConsultModel` の代わりに、bridge を呼ぶ `ConsultModelCall` を足し、フラグで切り替える。入力は §2.2 の JSON、結果は今の `sanitizeConsultModelOutput` を通す。アプリに `operationId`（発言ごと）と `CONSULT_QUOTA_EXCEEDED` の文言を足す。`OPENAI_API_KEY` は Claude の経路では読まない。テストは今の偽物の fetch を Anthropic の形に変える（`postona_claude_contract_test.ts` の形が参考になる）
- **投稿文の生成（段階 3〜5）**: `generateBrandPost` に bridge の経路を足し、`{ text }` の JSON を受ける。`BrandPostDraft` の形は変えない。時間の上限を付ける。呼び出し元の NG 語・重複の確認は今のまま
- **共通**: 本番の前に §3 の 1〜5 が決まっていること。F6 は許可（§3-6）と台帳の枠の案（§3-2）を出す

## 8. 残るリスク・NOT_VERIFIED

- Claude での日本語の相談・投稿の品質、相談の入力の形を変えたときの振る舞い（有料の評価をしていない）
- 本物の Anthropic の応答、実際の請求、本番の台帳と保存の場所
- `supabase/config.toml` が main に無いので、各関数の `verify_jwt` の設定は分からない
- プライバシーの表記のページの中身（リポジトリの外。今の設計の文書には OpenAI が書かれているとある）
- `x-test-post` の Edge の実行時間の上限との関係
