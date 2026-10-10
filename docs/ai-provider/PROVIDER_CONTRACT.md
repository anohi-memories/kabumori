# 共通AI Provider 契約（Phase 1a）

- 対象: `supabase/functions/_shared/ai_provider/`（入口は `mod.ts`）
- task_id: `common-ai-provider-core-20261010`
- 状態: ソースのみ。既存のAI業務処理からはまだ import していない（`isolation_test.ts` で検査）。本番への影響はゼロ。
- 料金・機能・エラー仕様の確認日: 2026-10-10（Anthropic・OpenAI の公式ドキュメント）

## 1. 使い方（Edge Function から、将来の接続時）

```ts
import { executeAiRequest, InMemoryBudgetGuard } from "../_shared/ai_provider/mod.ts";

const budget = new InMemoryBudgetGuard([
  // この呼び出し単位（1回の実行）での上限。月額予算ではない（§6）
  { id: "market-report-run", scope: { application: "kabumori", feature: "market_report" }, maxCalls: 4, maxEstimatedUsd: 1.5 },
]);

const result = await executeAiRequest({
  logicalRole: "kabumori.market_report.generate",
  provider: "anthropic",
  model: "claude-opus-5-5",
  systemInstructions: INSTRUCTIONS,
  userContent: JSON.stringify(modelInput),
  jsonSchema: { name: "market_report_analysis", schema: GENERATION_SCHEMA },
  reasoningEffort: "medium",
  maxOutputTokens: 16_000,
  timeoutMs: 90_000,
  transport: { maxAttempts: 2 },
  usageContext: { application: "kabumori", feature: "market_report" },
}, { readEnv: (name) => Deno.env.get(name), budget });

if (result.ok) {
  // result.parsedPayload は JSON として解析でき、かつ元の Schema に合格したものだけ
} else {
  // result.errorCode / result.retryable / result.httpStatus / result.estimatedCostUsd
}
```

## 2. Request（`AiRequest`）

| 項目 | 内容 |
|---|---|
| `logicalRole` | 用途の識別子（例 `kabumori.market_report.generate`）。識別だけに使い、モデル選択には使わない |
| `provider` | `"openai"` / `"anthropic"`。必ず明示する |
| `model` | `model_catalog.ts` にあるモデルだけを指定できる。provider と一致しなければ拒否する |
| `systemInstructions` / `userContent` | 空文字は拒否 |
| `jsonSchema` | `{ name, schema }`。name は `[A-Za-z0-9_-]{1,64}`。schema は §4 の範囲 |
| `reasoningEffort` | そのモデルで公式に確認できた値だけを受け付ける（下表） |
| `maxOutputTokens` | 1 からモデル上限（128,000）まで。思考・推論のトークンもここに含まれる |
| `timeoutMs` | HTTP 1回あたり。1,000〜600,000 |
| `transport` | `{ maxAttempts: 1〜3, retryOnTimeout?: boolean }`（§5） |
| `usageContext` | `{ application, feature }`。費用・予算の集計に使う |

### モデルカタログ（単一の管理箇所）

| model | provider | 入力 | キャッシュ読み | キャッシュ書き 5分 / 1時間 | 出力 | effort |
|---|---|---|---|---|---|---|
| `claude-opus-5-5` | anthropic | $4 | $0.20 | $5 / $8 | $20 | low〜max |
| `claude-sonnet-5-5` | anthropic | $2 | $0.10 | $2.5 / $4 | $10 | low〜max |
| `claude-haiku-5-5` | anthropic | $0.10（10万トークン超は $0.50） | $0.01（$0.05） | $0.125 / $0.20（$0.625 / $1） | $0.50（$2.50） | low〜max |
| `gpt-6.1-sol` | openai | $2（27.2万トークン超は $4） | $0.10（$0.20） | — | $10（$15） | low〜max |
| `gpt-6-luna` | openai | $0.10 | $0.01 | — | $0.50 | none〜max |

- 価格は 100万トークンあたりの USD。カタログにないモデル（`gpt-6-sol`、`gpt-5.6-*` など）は `MODEL_UNKNOWN` で拒否し、0円扱いにはしない。これらは移行する Phase で公式価格を確認してから追加する。
- Anthropic の3モデルは、思考を adaptive（公式が定める標準のモード）で送る。Opus 5.5 は思考を止められない仕様のため、effort が唯一の調整手段になる。
- `temperature`・`top_p`・`tool_choice`・prefill・stream は、どちらの provider にも送らない。

## 3. Result（`AiResult`）

`ok` で成功と失敗を判別する（TypeScript の判別可能な共用型）。

**共通の項目:**
- `provider`、`configuredModel`
- `actualModel`: 応答が名乗ったモデル。名乗っていなければ `null`（configuredModel で代用しない）
- `estimatedCostUsd`、`costBasis`、`transportAttempts`、`attempts[]`、`latencyMs`
- `usageKey`: `{ provider, model, application, feature, logicalRole, month }`（month は JST の暦月）

**成功（`ok: true`）:**
- `parsedPayload`（JSON として解析でき、かつ**元の Schema に合格した**もの）
- `inputTokens`（キャッシュを含む入力の総数）、`outputTokens`（思考・推論を含む）、`reasoningOutputTokens`
- `cacheUsage`、`usage`、`stopReason`、`requestId`

**失敗（`ok: false`）:**
- `errorCode`、`retryable`、`httpStatus`、`usage`
- `message`: 固定文。provider の本文・プロンプト・出力・鍵は入れない
- `detail`: 機械判定用の短い識別子

**費用の扱い（`costBasis`）:**
- `measured`: すべての試行の usage が分かり、価格表から計算した
- `includes_upper_bound`: タイムアウト・接続断・読めない応答など、usage が不明な試行を含む。その試行は**最大額で計上**する（0円扱いしない）
- `no_request`: HTTP を一度も送っていない

`estimatedCostUsd` は価格表から出した**推定値**で、API Console の請求額や Claude クレジットの消費額とは別物。照合は Phase 1b の台帳で行う。

### エラーコード

| 種類 | コード | Provider 層での再試行 |
|---|---|---|
| 送信前の拒否（課金なし） | `REQUEST_INVALID`、`MODEL_UNKNOWN`、`MODEL_PROVIDER_MISMATCH`、`CAPABILITY_UNSUPPORTED`、`SCHEMA_UNSUPPORTED`、`KEY_MISSING`、`KEY_INVALID`、`BUDGET_DENIED`、`DEADLINE_EXCEEDED` | しない |
| 一時的な障害 | `RATE_LIMITED`（429）、`OVERLOADED`（529、OpenAI は 503）、`SERVER_ERROR`（5xx）、`NETWORK` | する（§5） |
| タイムアウト | `TIMEOUT`（課金された可能性がある） | `retryOnTimeout: true` のときだけ |
| 再試行しても直らない | `AUTH`（401/403）、`CREDIT_EXHAUSTED`（クレジット不足・402・OpenAI insufficient_quota）、`SPEND_LIMIT`（上限への到達）、`INVALID_REQUEST`（その他の 4xx） | しない |
| モデルの判断 | `REFUSAL`（安全上の拒否）、`INCOMPLETE`（max_tokens などで途切れた） | しない |
| 応答の内容 | `PROTOCOL`（想定外の形）、`INVALID_JSON`、`SCHEMA_VIOLATION` | しない（作り直すかは呼び出し元が判断する） |

`SPEND_LIMIT` が返る2つのケース:
- プランの月額上限: 429 で `error.details.error_code = "enforced_spend_limit_reached"`
- 自分で設定した上限: 400 で、本文が "You have reached your specified (workspace) API usage limits" で始まる

クレジット不足の本文は "Your credit balance is too low…"。いずれも公式ドキュメントに記載された形で判定する。

## 4. JSON Schema

**受け付ける範囲:**
- 構造: `type`（配列も可）、`properties`、`required`、`additionalProperties: false`、`items`、`enum`（プリミティブ）、`const`、`anyOf`、ローカルの `$ref` / `$defs`
- 注釈: `description`、`title`、`$comment`
- 制約: `minimum`、`maximum`、`exclusiveMinimum`、`exclusiveMaximum`、`multipleOf`、`minLength`、`maxLength`、`pattern`、`minItems`、`maxItems`、`uniqueItems`

**守るべき規則:**
- すべての object で `additionalProperties: false` とし、`required` にすべての property を並べる。省略可能な項目は `null` との union で表す。
- root は object にする。
- 再帰しない。object の入れ子は10段まで、union は16個まで。

**それ以外は送信前に `SCHEMA_UNSUPPORTED` で拒否する（fail-closed）。** 例: `allOf`、`oneOf`、`not`、`format`、`default`、`patternProperties`。ローカルで検証できない制約には頼らない。

**Provider 向けの変換:** 送れない制約は外し、`description` に `[constraints: …]` として書き足す。
- Anthropic で外すもの: 数値範囲、文字列長、`maxItems`、`uniqueItems`、2以上の `minItems`
- OpenAI で外すもの: 文字列長、`uniqueItems`

**応答の検証:** `JSON.parse` が通るだけでは成功にしない。必ず**元の Schema** で検証し、違反は `SCHEMA_VIOLATION` の失敗として返す。違反の詳細はパスとキーワードだけで、出力の値や想定外のキー名は含めない。

## 5. 再試行・タイムアウトの契約

- **この層が持つのは通信の再試行だけ。** 内容による作り直しは呼び出し元が持つ。provider を自動で切り替えることはなく、安全上の拒否を回避するための再実行もしない。
- **`maxAttempts` は HTTP の試行回数の上限（最大3）。**
  - 既存の `market-report-analysis/transport_retry.ts` を残したまま接続する場合は `maxAttempts: 1` にする。こうすると2つの再試行層が掛け算にならない。
  - SDK 内部の再試行は常に無効にしている（`maxRetries: 0`。テストで fetch が1回だけであることを確認済み）。
- **G2 の上限（MAX_GENERATIONS = 2 / MAX_MODEL_CALLS = 4）は、接続後もそのまま維持できる。**
  - 結果の `transportAttempts` を MAX_MODEL_CALLS に数える。
  - または、実行ごとの `InMemoryBudgetGuard` に `maxCalls: 4` を設定すれば、再試行も含めて4回を超えない。
- **待ち時間:** 指数バックオフ（1秒・2秒、最大8秒、揺らぎあり）。provider が `retry-after` を返せばそれに従う。ただし20秒を超える待ちは再試行せずに終える。
- **期限:** `deps.deadlineAtMs`（Edge の実行時間の上限に合わせる）を超えて新しい試行は始めない。
- **タイムアウトしたリクエストは課金された可能性がある。** そのため既定では再試行せず、最大額で計上する。

## 6. Budget Guard（Phase 1a の範囲と限界）

- **予約の順序:** 各 HTTP 試行（再試行を含む）は、送信**前**にその試行の最大額を予約する。終わったら推定額で精算する。usage が不明なら最大額のまま残す。
- **上限の種類:** `maxCalls`（回数）、`maxEstimatedUsd`（推定額の合計）、`maxUsdPerCall`（1回の上限）を、`provider` / `application` / `feature` / `logicalRole` の範囲ごとに設定できる。
- **拒否される場合:** 該当する上限が1つもない呼び出しは `NO_MATCHING_LIMIT` で拒否する。ガードが例外を投げた場合も Claude は呼ばない（fail-closed）。
- **同時実行:** 同じプロセス内では、確認と確保を await を挟まずに行うため、並行呼び出しで上限を超えない（テスト済み）。状態はインスタンスごとに持ち、モジュール全体で共有する状態はない。
- **限界（重要）:** `InMemoryBudgetGuard` は1つのインスタンス（1回の Edge 実行や1回の run）の中だけで効く。**複数の Edge Function・複数のプロセスをまたぐ月額予算（Claude の月 $100 枠）は保証しない。** DB に予約と台帳を持つガードは Phase 1b で、同じ `BudgetGuard` interface の別実装として作る。

## 7. Secrets・ログ

- **鍵の読み方:** 環境変数 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` だけを、呼び出し元が渡す `readEnv` で読む。モジュール自身は `Deno.env`・ファイル・キーチェーンに触れない。
- **鍵の扱い:** 鍵は `ProviderApiKey` に包む。文字列化・JSON化・inspect のどれでも `[REDACTED]` になり、`reveal()` するのはアダプタだけ。Anthropic の Admin APIキーは推論に使わせない。
- **SDK の設定:** Anthropic SDK には、鍵を明示し `authToken: null`、固定の `baseURL`、`logLevel: "off"` を渡す。こうして環境変数による接続先の変更や、二重の認証を防ぐ。
  - 既知の残リスク: 環境変数 `ANTHROPIC_CUSTOM_HEADERS` は SDK が自動で読む。本番の secrets に設定しないこと。
- **ログ:** モジュール自体はログを出さない。`onAttempt` に渡すのは件数・識別子・費用だけで、プロンプト・出力・鍵・provider の本文は含めない（テストで確認済み）。

## 8. Phase 1a の対象外（後続の Phase）

- 呼び出し側（朝刊・大引け、重要ニュース、POSTONA）への接続（Phase 2 以降）
- 永続的な台帳と月額予算（`ai_usage_events` の拡張、予約 RPC。Phase 1b）
- provider 間のフォールバック（明示的な設定として後続で設計する。この層は自動では行わない）
- Anthropic のサーバー側 refusal fallback（beta）、プロンプトキャッシュの指定、ストリーミング、web 検索ツール、複数ターンの会話
