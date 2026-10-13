# F6 M1 — 用途ごとに Claude の Sonnet / Haiku / Opus を選ぶ共通の仕組み（ソースのみ）

- 作成: 2026-10-13 JST（F6）
- task_id: `common-ai-f6-anthropic-multimodel-shared-adapter-m1-20261013`
- 範囲: `supabase/functions/_shared/ai_provider/` とこの文書だけ
  - 本番・実 API・台帳のポリシー・Secret・配信は変更していない
  - 実際の用途への組み込みはしていない（それぞれの担当が後で行う）
- いま本番で動いている「朝刊・大引けを Opus で作る」（`market_report_primary.ts`、`primary_both`）は **変えていない**

## 1. モデルの確認（公式ドキュメント、2026-10-13 に読んだ）

| モデル | Claude API ID | 入力 / 出力（$/100万トークン） | キャッシュ読み込み | 文脈 / 出力上限 | effort の既定 |
|---|---|---|---|---|---|
| Claude Opus 5.5 | `claude-opus-5-5` | $4 / $20 | $0.20（0.05倍） | 1M / 128K | medium |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | $2 / $10 | $0.10（0.05倍） | 1M / 128K | high |
| Claude Haiku 5.5 | `claude-haiku-5-5` | $0.10 / $0.50（入力が10万トークンまで）。超えたら $0.50 / $2.50 | $0.01 / $0.05 | 1M / 128K | medium |

- 出典
  - `platform.claude.com/docs/en/about-claude/pricing`
  - `platform.claude.com/docs/en/about-claude/models/overview`
- ID は日付なしの固定版（pinned snapshot）。提供終了は早くても次の日付
  - Opus: 2027-09-22
  - Sonnet: 2027-09-28
  - Haiku: 2027-10-07
- 3つとも、思考は adaptive（Opus は常に ON）。effort は low〜max
- `model_catalog.ts` の価格は、上の公式の値と一致していた（価格は変えていない）
  - 注: 手元の参照資料（2026-10-06 時点の写し）は、Sonnet 5.5 のキャッシュ読み込みを $0.20 としていた
  - 公式ページは $0.10（0.05倍）。公式を正とした

## 2. 追加したもの

### 版付きの別名（`model_catalog.ts`）

| 別名 | モデル |
|---|---|
| `anthropic.opus@2026-10` | `claude-opus-5-5` |
| `anthropic.sonnet@2026-10` | `claude-sonnet-5-5` |
| `anthropic.haiku@2026-10` | `claude-haiku-5-5` |

- 別名は黙って動かない。新しいモデルには新しい別名を足し、呼び出し側が明示的に切り替える
- 「最新（latest）」の別名は、わざと作らない
- `resolveModelName(name)` は、別名でもカタログの ID でも、カタログの ID を返す。知らない名前は `undefined`

### 用途ごとのモデルの決まり（`model_policy.ts`）

1つの用途（logical role）ごとに、次を決める。

| 項目 | 内容 |
|---|---|
| `role` | 用途の名前。台帳の `logical_role` と、費用の集計の単位にもなる |
| `application` / `feature` | 費用をどこに計上するか |
| `allowedModels` / `defaultModel` | 使ってよいモデル（ID か別名）と、既定のモデル |
| `allowedEfforts` / `defaultEffort` | 使ってよい effort と既定 |
| `maxOutputTokens` | 出力の上限（思考を含む）。どの許可モデルのカタログ上限も超えない |
| `timeoutMs` | 1回の送信の時間の上限（1〜600 秒） |
| `maxTransportAttempts` | 1〜3。一時的な失敗（429 / 5xx）だけ再試行する。時間切れは再試行しない |
| `maxUpperBoundUsdPerAttempt`（任意） | 1回の上限額。超えるなら予約も送信もしない |

- `defineAnthropicModelPolicies(version, policies)` は、登録のときに全部を確かめる。間違いは `ModelPolicyError` で、実行時ではなく起動時に分かる
  - モデルがカタログの Anthropic モデルでない
  - 既定が許可リストにない
  - モデルが対応しない effort
  - 上限が範囲外
  - 用途名の重複
- 登録した決まりは凍結され、後から広げられない
- 呼び出し側（`resolveModelChoice` / `executeWithModelPolicy`）が変えてよいのは、決まりを **狭める方向だけ**
  - 許可されたほかのモデル、許可された effort、小さい出力上限
- それ以外は、キーの読み取り・予約・送信のどれもする前に拒否する

| 拒否のコード | 意味 |
|---|---|
| `ROLE_UNKNOWN` | 登録されていない用途 |
| `MODEL_UNKNOWN` | カタログにも別名にもない名前（日付付きの ID や `@latest` を含む） |
| `MODEL_NOT_ALLOWED` | その用途で許可されていないモデル |
| `EFFORT_NOT_ALLOWED` | 許可されていない effort |
| `OUTPUT_CAP_EXCEEDED` | 出力の上限を超えている |
| `COST_CAP_EXCEEDED` | 1回の上限額を超える |

- 送信は既存の `executeAiRequest` をそのまま通す
  - 同じキー（`ANTHROPIC_API_KEY`、Edge Secret だけ）
  - 同じ予算台帳（reserve → mark_sent → settle、`callId` と試行番号でのべき等）
  - 同じ検査、時間の上限、費用の計算、structured output のスキーマ検査
- 結果には `attribution` が付く（role、model、application、feature、month、見積もり額、費用の根拠、決まりの版）
- **別のモデルや別の provider への自動切り替えは無い**
  - API がそのモデルを出さない（404 `not_found_error`）ときは `modelUnavailable: true` を返し、ほかは何も試さない
  - Anthropic の server-side の `fallbacks` も使わない（「自動 Fallback は OFF」という利用者の方針）
  - 拒否（`refusal`）は、今までどおり失敗として返る

## 3. 使い方（後でつなぐ担当向けの例。このタスクでは、どの用途にもつないでいない）

```ts
import { defineAnthropicModelPolicies, executeWithModelPolicy, SupabaseLedgerBudgetGuard } from "../_shared/ai_provider/mod.ts";

// 用途ごとの決まりは、その用途の担当のファイルに置く（F6 は形と検査だけを持つ）。
const POLICIES = defineAnthropicModelPolicies("news-policy/2026-10", [{
  role: "kabumori.news.importance",           // 台帳と費用の集計の単位
  application: "kabumori",
  feature: "news_importance",
  allowedModels: ["anthropic.haiku@2026-10", "anthropic.sonnet@2026-10"],
  defaultModel: "anthropic.haiku@2026-10",
  allowedEfforts: ["low", "medium"],
  defaultEffort: "low",
  maxOutputTokens: 2_000,
  timeoutMs: 30_000,
  maxTransportAttempts: 2,
  maxUpperBoundUsdPerAttempt: 0.02,
}]);

const outcome = await executeWithModelPolicy(POLICIES, {
  role: "kabumori.news.importance",
  systemInstructions, userContent, jsonSchema,    // 今と同じ厳格さのスキーマ
  callId: `news:${candidateId}:importance`,       // 同じ処理をやり直しても二重に払わない
}, { readEnv: (name) => Deno.env.get(name), budget: ledger });

if (outcome.kind === "refused") { /* 決まりの外。何も送っていない */ }
else if (!outcome.result.ok) { /* outcome.result.errorCode、outcome.modelUnavailable */ }
else { /* outcome.result.parsedPayload、outcome.attribution */ }
```

つなぐ前に、それぞれ別の作業・別の承認が必要なもの:

1. **台帳のポリシー**（本番の DB の変更）
   - 台帳は provider + model + application + feature + subject で絞った枠しか通さない
   - 今ある枠は「market_report の system の Opus」だけ。新しい用途・モデルには、それぞれの枠が要る。無ければ `BUDGET_DENIED`（安全側）
2. **隔離テストの許可リスト**（`isolation_test.ts`、F6）
   - 今、provider を参照してよいのは `market-report-analysis/handler.ts` だけ
   - 新しい関数がつなぐときは、F6 がその関数のファイルと import を許可リストに足す
3. 用途ごとの評価（品質と費用）と、OFF に戻す手順

## 4. 用途ごとの見積もり（カタログの価格での目安。実際の値は台帳で確かめる）

| 用途の例（担当） | モデルの候補 | 1回の目安 | 月の目安 |
|---|---|---|---|
| 共有の市況レポート（F2・本番中） | Opus 5.5（今のまま） | 2回で約 $0.19（10/13 の大引けの実測） | 平日に朝刊と大引けで、約 $8〜18 |
| ニュースの重要度判定（F8） | Haiku 5.5、迷うものだけ Sonnet 5.5 | 入力 3,000 / 出力 300 で約 $0.00045 | 1日 500 件なら約 $7 |
| ニュースの要約（F8） | Sonnet 5.5 | 入力 8,000 / 出力 1,500 で約 $0.031 | 1日 50 件なら約 $47 |
| API・Web 検索の費用の最適化（F9） | Haiku 5.5 で前処理し、必要なときだけ上位のモデル | 用途による | F9 が測ってから決める |
| AI への質問（F1、利用者ごと） | Sonnet 5.5（重い質問だけ Opus） | 入力 6,000 / 出力 1,200 で約 $0.024 | 利用者数で決める。利用者ごとの枠（`user`）が要る |
| POSTONA の投稿の下書き（F3/F4） | Sonnet 5.5 または Haiku 5.5 | 入力 3,000 / 出力 800 で約 $0.014（Sonnet） | ブランドごとの枠が要る |

- Haiku 5.5 は、入力が10万トークンを超えると、その要求全体が高い単価（$0.50 / $2.50）になる
  - 例: 入力 15 万 / 出力 1,000 で約 $0.078
  - 長い入力を Haiku に送る用途では注意する

## 5. テスト（すべてオフライン。実 API・本番 0）

```sh
deno test --no-config --allow-env --allow-read supabase/functions/_shared/ai_provider/model_policy_test.ts
```

- 3つの用途で、既定の別名から Haiku / Sonnet / Opus が送られ、effort・上限・時間・キーが正しい
- structured output が解析され、スキーマで検査される
- 上書きは狭める方向だけ（許可されたほかのモデル・effort、小さい上限）
- 決まりの外は、キーの読み取り・予約・送信の前に拒否される（10通り）
- キーが無い、ほかの用途の枠しか無い、枠を使い切った: どれも送信 0
- 529 の再試行は決まりの回数まで（同じ `callId`・試行番号ごとに予約）。回数1なら再試行しない。時間切れは再試行しない
- 404 `not_found_error` は `modelUnavailable`。ほかのモデルは試さない
- 費用の計上は用途とモデルごと。Haiku の 10 万トークン超の単価も確かめる
- スキーマ違反は失敗になる
- 間違った決まり（12通りと重複）は登録のときに拒否する。登録後は広げられない
- 別名は版付きの3つだけで、「最新」は無い
- 結果にキー・プロンプト・入力の文が入らない
