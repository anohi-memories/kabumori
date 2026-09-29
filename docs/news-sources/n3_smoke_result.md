# N3 実 OpenAI Web Search smoke（1 回限定）結果 — 2026-09-29

- branch: `claude/n3-hardening-20260928`、対象 head `5ba7661`（smoke 用のコード変更なし）
- 実行方法:
  - repo 外の一時 harness（scratchpad、commit しない）から、**未改変の N3 `OpenAiWebSearchProvider`** を直接 1 回呼んだ。
  - harness の fetch は `https://api.openai.com/v1/responses` への **1 回だけ**を許可し、2 回目は通信前に例外にする。
  - Deno の権限：network は `api.openai.com` のみ。
- key の扱い:
  - ユーザーが用意した smoke 専用 key を、権限 600 の一時ファイル経由で、この 1 回のプロセスにだけ読み込んだ。
  - 実行直後にファイルを削除。repo・`.env`・ログ・出力への保存・表示なし（key persisted = 0）。
- observer 全体・DB・Edge Function は起動していない。production_mutation = 0。

## 事前確認（OpenAI 公式ドキュメント、2026-09-29）

| 項目 | 確認結果 |
|---|---|
| `gpt-5.6-luna` | `/v1/responses` 対応、`web_search` 対応、Structured Outputs 対応、reasoning `low` 対応（モデルページ） |
| `web_search` | Responses API の現行 tool 名（`web_search_preview` は旧互換） |
| `filters.blocked_domains` | 最大 100 件まで指定可（web search ガイド） |
| `include: ["web_search_call.action.sources"]` | 許容値として記載（Responses create リファレンス） |
| `max_tool_calls` | 「built-in tool の総呼び出し数の上限」（同上） |
| `text.format` json_schema＋`strict: true` | 全 field required・`additionalProperties: false`・`["string","null"]` による nullable（Structured Outputs ガイド） |
| `maxItems` | 公式ページ本文で**記載を確認できず**。実 API は受理し、schema どおりに応答した |
| 仕様差分 | 見つからなかった（上記を除く） |

## 結果

| 確認項目 | 結果 |
|---|---|
| API request 数 | **1** |
| HTTP / response | 200、`status: completed`、`model: gpt-5.6-luna`、error なし、incomplete_details なし（response id 末尾 `…440ee8`）、所要 約 5.0 s |
| output items | `web_search_call`（completed）1 件、`message`（completed）1 件 |
| web_search_call | **1 件**（`max_tool_calls: 1` どおり）。action type `search`。モデルが生成した query は 1 本 |
| sources | **15 件**。すべて type `url`。host は developers.openai.com、platform.openai.com、help.openai.com、community.openai.com、cdn.openai.com、openai.com |
| citations（`url_citation`） | **0 件**（下記「所見」） |
| structured output | JSON parse 成功、strict schema どおり（`items` 1 件、各 item の `url` / `title` / `publisher` がすべて存在、余計な key なし）。自由文を手で JSON 扱いしていない |
| structured の結果 | `https://developers.openai.com/api/docs/pricing?tab=suite`、「Pricing \| OpenAI API」、publisher「OpenAI」 |
| N3 parser | `parseOpenAiSearchResponse` がそのまま処理できた。results 1 件、`rejected_unverified: 0`（結果 URL は sources 由来の verified set に一致） |
| N3 provider | `ok: true`、usage `{model_calls: 1, web_search_calls: 1, input_tokens: 8672, output_tokens: 81}` |
| blocked_domains | 送信値は `aljazeera.com`、`ft.com`、`diamond.jp` |
| blocked / restricted の混入 | 返ってきた URL 16 件（sources 15＋structured 1）を N3 の validator で検査した。完全一致・サブドメイン・末尾ドット正規化のいずれでも **0 件**、`safeSearchUrl` 不合格も 0 件 |

usage（実レスポンス）:

| 項目 | 値 |
|---|---:|
| input_tokens | 8,672 |
| うち cache_write_tokens | 4,457 |
| うち cached_tokens | 0 |
| output_tokens | 81 |
| うち reasoning_tokens | 36 |
| total_tokens | 8,753 |

## 費用（概算、公式料金ページ 2026-09-29）

| 内訳 | 計算 | 額 |
|---|---|---:|
| Web search tool call | 1 回 × $10.00 / 1k calls | **$0.0100** |
| input tokens | 8,672 × $0.20 / 1M。cache write 4,457 を $0.25 / 1M で計算すると $0.0020 | 約 $0.0017〜0.0020 |
| output tokens | 81 × $0.75〜1.20 / 1M（料金ページとモデルページで出力単価の表記が異なる） | 約 $0.0001 |
| **合計** | | **約 $0.012** |

- search content tokens は「model rates で課金」（料金ページ）であり、上記の input tokens に含まれる。
- 参考：既存監査の推定（$0.011〜0.02 / 回）の範囲内。

## 所見

1. **citations は 0 件**。strict JSON schema で出力させると、message に `url_citation` annotation が付かなかった。
   - 公式ドキュメントに「structured output 時は annotation を付けない」という明示の記載は見つからなかったため、**観測事実**として記録する。
   - N3 の URL 検証は sources と citations の和集合で行う設計なので、sources だけで検証が成立した（結果 URL は sources に一致）。
   - citations が無いこと自体は N3 の動作に影響しない。
2. モデルが生成した検索 query には `site:` 演算子が含まれていた。N3 は query を固定しておらず、レーン query を渡してモデルに任せる設計のため、想定内。
3. sources には tracking 付きの URL（`platform.openai.com/pricing?client_id=…&session_id=…`）が含まれていた。
   - N3 の canonicalize は `client_id` / `session_id` を除去しない（現在の除去対象は utm_* 等）。
   - 観測 pool の重複率に影響し得る**軽微な改善候補**で、今回はコードを変更していない。
4. timeout 時の課金の扱い：意図的な timeout テストはしていない（2 回目の有料呼び出しになるため）。公式ドキュメントでも明確な記載を確認していない → **`timeout billing behavior: unverified`**（BLOCKER ではない）。

## 判定

- 次の条件はすべて満たした：
  - Responses API 成功、`gpt-5.6-luna`、web search 実行 1 回（≤1）
  - strict structured output 成功、sources 取得成功
  - restricted domain 混入なし、usage 取得成功、N3 parser 互換
  - secret 漏洩 0、production mutation 0
- citations は 0 件（観測のとおり。N3 は sources で検証が成立）。
- **Smoke: PASS**（citations 0 件の扱いは最終レビューで確認してほしい）。
