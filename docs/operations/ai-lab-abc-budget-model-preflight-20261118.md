# 会社員AIラボ A/B/C実API比較の非課金最終準備（第55TASK、2026-11-18）

非課金・非投稿の変更です。実APIの呼び出し 0、有料API 0、課金 $0、Keychain read 0、X投稿 0、本番write 0。
変更はG6比較runner（`_shared/ai_provider/ai_lab_live_compare*.ts`）とそのmockテスト、このdocsだけです。
本番X投稿のCron・Supabase Edge/DB/Auth/RLS/secrets・通常投稿用 `OPENAI_API_KEY` は触っていません。

## 1. 結論（有料実行GOの可否）

**有料実行GOは出せません。** 理由:

- 価格テーブルの単価は公式ページとの照合が 2026-10-10（Sol/Luna は 2026-11-17 に再確認）で止まっており、**実行時（24時間以内）の照合が未実施**。runnerは照合記録が無い・古い・食い違うと、無料のモデル確認も含めリクエスト0で止まります。
- Sol / Luna の個別モデル利用権限は未確認（本人申告は OpenAI `GET /v1/models` 一覧の HTTP 200 のみ）。Claude Opus の利用権限も未確認。
- 本人が承認した USD 上限・回数上限・1回あたりのトークン上限が未入力。runnerには**既定値がなく**、第53TASKの $0.30 も再利用しません。
- **ハードキャップ不可**（次節）。上限は保守的な見積りで守るもので、プロバイダが金額で止めてくれる保証はありません。

## 2. 予算ゲート（`ai_lab_live_compare_budget.ts`）と「ハードキャップ不可」

runner は次の順でしか進みません。どこで止まっても以後のリクエストは送りません（再送・他providerの起動もしない）。

1. **予算の明示承認**: `approvalRef`（本人承認の場所。Issueコメント URL 等）、`ceilingUsd`、`maxPaidCalls`、`maxInputTokensPerCall`、`maxOutputTokensPerCall` がすべて正しく入っていること。欠け・0・NaN・∞ は `BUDGET_NOT_APPROVED`。
2. **計画の確認**（第54TASKのまま）: 各runの設定が選ぶモデル＝計画のモデル。違えば `PLAN_MODEL_MISMATCH`（無断fallback禁止）。
3. **回数**: `maxPaidCalls` が計画の呼出回数（run数×2）未満なら `PLAN_EXCEEDS_CALL_CAP`（途中で尽きる計画は始めない）。
4. **価格の照合**: 計画の全モデルについて、公式ページで読んだ入力・出力単価が catalog と一致し、照合が24時間以内・未来でない・catalog version 一致であること。違えば `PRICE_UNCONFIRMED` / `PRICE_CHECK_STALE` / `PRICE_CHANGED`。
5. **計画全体の最悪値**: 宣言したトークン上限で全呼出（＋上限回数までの余り回数×最も高いモデル）を最も高い単価で計算し、`ceilingUsd` 以下であること。超えれば `BUDGET_INSUFFICIENT_FOR_PLAN`（無料のモデル確認も行わない）。
6. **無料のモデル確認**（第54TASKのまま）: 全モデルが HTTP 200 かつ同じID。1件でも違えば全体停止。
7. **1回ごとのゲート**: 送る前に
   - 出力上限（`max_tokens` / `max_output_tokens`）が無い、`tools` / `tool_choice` がある（サーバーツールは別課金）→ `REQUEST_UNBOUNDED`
   - 入力上限（本文バイト数＋2,048）または出力上限が宣言値を超える → `REQUEST_OVER_LIMITS`
   - 予約済み合計＋この回の最悪値が `ceilingUsd` を超える → `BUDGET_EXCEEDED`
   
   を確認し、通過したらこの回の最悪値を**予約**してから送ります。予約は失敗・結果不明でも戻しません（失敗課金を含めて数える）。
8. **応答後**: 401/403・非200・タイムアウト・読めない応答・別モデル（第54TASKのまま）に加え、200でも usage が読めない → `PAID_USAGE_MISSING`、usage が予約の根拠にした上限を超える → `PAID_COST_OVERRUN` で全体停止。

最悪値の計算: 入力は全トークンを「全tier・全cache種別で最も高い入力側単価」（Opus は1時間cache書込みの $8/1M）、出力は最も高い出力単価で数え、さらに安全係数 **1.25** を掛けて切り上げます。思考トークン（Claude）・reasoning トークン（OpenAI）は出力上限・出力課金に含まれます。

**ハードキャップ不可の明記**: どちらのプロバイダにも1リクエストの金額上限はありません。この上限が成り立つのは、(a) プロバイダが出力上限（思考・reasoning込み）を守る、(b) 入力が本文1バイトあたり1トークン＋2,048を超えない、(c) 実際の単価が照合した定価×1.25 を超えない、(d) 定価外の追加請求がない、の間だけです。どれかが崩れると超過し得ます。runner は崩れた兆候（usage欠落・上限超えusage）で即停止し再送しないだけで、**請求額そのものは保証しません**。結果にも `capKind: "client_estimate_not_hard_cap"` を必ず出します。

### 参考: 計画全体の最悪値（2題材×A/B/C＝12回、出力上限3,072、catalog単価、係数1.25）

| 入力上限/回 | Opus 1回 | Sol 1回 | Luna 1回 | 計画全体 |
|---|---|---|---|---|
| 30,000 | $0.3768 | $0.2076 | $0.00567 | **$2.76414** |
| 20,000 | $0.2768 | $0.1576 | $0.00442 | **$2.06164** |
| 12,000 | $0.1968 | $0.1176 | $0.00342 | **$1.49964** |

実際の入力バイト数は mock dry-run の ledger（`boundTokens.input`）で、実プロンプトのまま事前に測れます。上限は**その実測値を少し上回る値**にし、計画全体の最悪値を見てから本人が `ceilingUsd` を決めてください。第53TASKの実測（A 3回 $0.054）は最悪値ではないので上限の根拠にしません。

## 3. 価格テーブルの根拠と確認日時（`model_catalog.ts`、version `ai-provider-catalog/2026-10-10.1`）

| モデルID | 入力 / 出力（USD/1M） | 最悪値に使う入力側 / 出力 | 根拠 | 確認日 |
|---|---|---|---|---|
| `claude-opus-5-5` | $4 / $20 | $8（1h cache書込み）/ $20 | platform.claude.com/docs/en/about-claude/pricing | 2026-10-10 |
| `gpt-6.1-sol` | $2 / $10（272K超は $4 / $15） | $4 / $15 | developers.openai.com/api/docs/models/gpt-6.1-sol | 2026-10-10、pricingページで 2026-11-17 再確認 |
| `gpt-6-luna` | $0.1 / $0.5 | $0.1 / $0.5 | developers.openai.com/api/docs/models/gpt-6-luna | 2026-10-10、pricingページで 2026-11-17 再確認 |

**今回（2026-11-18、AutoDev）は公式ページを照合していません**（ネットワーク不使用）。有料実行の直前に、人が公式ページで上の単価とモデルIDを確認し、`priceCheck`（確認時刻・catalog version・モデルごとの入力/出力単価）として渡すまで runner は動きません。単価が変わっていたら catalog の更新（別TASK）が先です。

## 4. Macでの非課金モデル利用確認の手順（本人の直接承認後だけ。AutoDevでは実施しない）

目的: 鍵の認証と、個別モデルの利用可否を分けて記録する。課金されるのは生成（POST）だけで、この確認は `GET /v1/models/{id}` のみです。

安全ルール:
- 鍵を画面・ファイル・コマンド引数に出さない。鍵は `curl -H @-`（標準入力）でヘッダーに渡す（`$(...)` を printf に渡すのはシェル内で完結し、プロセス一覧に出ない）。
- 記録するのは **HTTPステータスと応答の `id` だけ**。応答本文全体は保存しない。
- POST（生成）は絶対に送らない。URLは下の3つだけ。

```sh
# OpenAI（Sol / Luna）。<service>/<account> は本人のKeychain項目名に置き換える
for m in gpt-6.1-sol gpt-6-luna; do
  printf 'Authorization: Bearer %s\n' "$(security find-generic-password -s '<service>' -a '<account>' -w)" \
    | curl -sS -o /tmp/g6-model-check.json -w "$m %{http_code}\n" -H @- "https://api.openai.com/v1/models/$m"
  /usr/bin/python3 -c 'import json;print(json.load(open("/tmp/g6-model-check.json")).get("id"))' 2>/dev/null
done
rm -f /tmp/g6-model-check.json

# Anthropic（Opus）
printf 'x-api-key: %s\nanthropic-version: 2023-06-01\n' "$(security find-generic-password -s '<service>' -a '<account>' -w)" \
  | curl -sS -o /tmp/g6-model-check.json -w "claude-opus-5-5 %{http_code}\n" -H @- "https://api.anthropic.com/v1/models/claude-opus-5-5"
/usr/bin/python3 -c 'import json;print(json.load(open("/tmp/g6-model-check.json")).get("id"))' 2>/dev/null
rm -f /tmp/g6-model-check.json
```

判定（runner の ledger の `auth` / `modelAvailable` と同じ区分）:

| 結果 | 鍵（auth） | このモデル（modelAvailable） | 有料実行 |
|---|---|---|---|
| 200 かつ id が同じモデル | ok | 利用可 | 他条件がそろえば可 |
| 200 だが id が違う | ok | 利用不可扱い | STOP |
| 404 | ok（鍵は通った） | 利用不可 | STOP |
| 401 | rejected | 不明 | STOP |
| 403 | forbidden（鍵か、このモデルの権限か区別不可） | 不明 | STOP |
| その他・通信エラー | 不明 | 不明 | STOP |

一覧（`GET /v1/models`）の200は「鍵が通った」ことしか示しません。モデルごとの確認を3つすべて取るまで有料実行に進みません。

## 5. 第56TASK以降で有料実行に進む条件（すべて必要）

1. 本人の別途明示許可（`ceilingUsd`、`maxPaidCalls`、1回の入力/出力上限、承認場所）
2. 実行当日の公式価格・モデルIDの照合（第3節）と `priceCheck` の記録
3. 第4節のモデル別確認で3モデルとも 200＋同じid
4. 実プロンプトでの mock dry-run で `BUDGET_INSUFFICIENT_FOR_PLAN` にならず、ledger の `boundTokens` が上限内
5. 安全停止の検証（このTASKのテスト）が最新ブランチで全件PASS
6. 実行は1回だけ。停止したら再実行せず、ledger（status・モデル・予約額・usage由来の見積額）をREPORTに出し、プロバイダ側の請求画面で実額を人が確認する

## 6. 比較資料テンプレート（非投稿）

```md
# A/B/C比較 第__TASK（____-__-__、非投稿）

- 実行: approvalRef=__ / ceilingUsd=$__ / maxPaidCalls=__ / 入力上限=__ / 出力上限=__
- 価格照合: ____-__-__ __:__ JST（catalog version __）
- 結果: status=__ / stop=__ / stoppedAt=__ / paidCalls=__ / reservedUsd=$__ / planWorstCaseUsd=$__ / capKind=client_estimate_not_hard_cap
- 実額（プロバイダ請求画面、人が確認）: Anthropic $__ / OpenAI $__

## 題材 10/09
### 元題材
（開発日記の題材そのまま）
### 題材品質
- 具体性: / 読者が得るもの: / 出典ガードで止まる危険語:
### A（Opus→Opus）
- 原案: …
- 自然化結果: …（保留なら理由コード）
- 文体評価（私・読点・。笑・絵文字・敬体混在・タグ）: …
- 費用（予約 / usage由来見積）: $__ / $__
### B（Sol→Sol）
（Aと同じ項目）
### C（Luna→Sol）
（Aと同じ項目）

## 題材 10/10
（10/09と同じ構成）

## 総評
- 自然さの順位と理由:
- 題材への忠実さ（出典ガード保留の有無）:
- 1投稿あたり費用の比較:
- 採用候補（受入判定はちゃ）:
```

## 7. テスト

`supabase/functions/_shared/ai_provider/ai_lab_live_compare_test.ts`（mockのみ、21件）に第55TASK分11件を追加:
予算未承認（既定値なし・$0.30再利用なし）／回数上限が計画未満／価格未確認・24時間超・未来時刻・単価変更・catalog version違い（無料確認も0回）／24時間ちょうどは可／最悪単価（最上位tier・cache書込み）／上限ちょうどは可・1単位下は0リクエストで停止／出力上限なし・tools付き・上限超えの本文は送らず停止／usage欠落・上限超えusage で全体停止（予約は残る）／Claude完了後にOpenAI 401 → C は開始しない／実行中の上限超えは送らず拒否／鍵の認証とモデル利用可否を分けて記録／2題材×A/B/C の mock dry-run（予約≧usage由来見積、`capKind`）。
