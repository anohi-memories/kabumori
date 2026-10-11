# 共通AI基盤 Phase 2a — 市況レポート向け Provider 接続部品（ソースのみ）

- 作成: 2026-10-12 JST（G6 くろちゃん）
- task_id: `common-ai-provider-g6-phase2a-market-report-adapter-offline-20261012`
- 範囲: **ソースとオフラインテストのみ**。どの Edge Function にも配線していない
  - 本番 DB・Edge・Secrets・Cron への変更は 0
  - 実 API（Anthropic / OpenAI）の呼び出しは 0
- 実装: `supabase/functions/_shared/ai_provider/market_report_shadow.ts`
- テスト: `supabase/functions/_shared/ai_provider/market_report_shadow_test.ts`

## 1. Phase 2a で実装したもの（ソースのみ）

共有市況レポート（`market-report-analysis`）は、モデルを `Requester` 経由で呼んでいる。

```text
(step: "generate" | "fact", body: OpenAI Responses の依頼本文) => { payload, inputTokens, outputTokens }
```

`createMarketReportRequester` は、この `Requester` を包む。

| モード | 条件 | 動作 |
|---|---|---|
| `off`（既定） | 環境変数 `KABUMORI_MARKET_REPORT_AI_MODE` が未設定・`off`・それ以外の値（`on`・`primary`・大文字小文字違い・前後の空白を含む） | **今の requester をそのまま返す（同じ関数）**。読む環境変数はモードの1つだけ。送信・記録は一切しない |
| `shadow` | 値がちょうど `shadow`、かつ下の条件をすべて満たす | 今の requester がレポートの結果をすべて作る。その結果が返った後で、同じ依頼を shadow モデルに1回送り、比較用の記録だけを残す |

`shadow` の条件（1つでも欠けると `off` になり、理由が付く）:

- `ANTHROPIC_API_KEY` が使えること（Admin キーは不可）→ 欠けると `KEY_MISSING` / `KEY_INVALID`
- 予算台帳の Guard があること → 欠けると `NO_LEDGER`
- レポートの cycle（uuid）と claim の試行番号（1〜99）が渡されていること → 欠けると `BAD_CONTEXT`
- shadow モデルが、カタログにある Anthropic のモデルであること → それ以外は `SHADOW_MODEL_INVALID`
  - モデルは呼び出し側が渡す。この層はモデルを選ばない（Provider の契約）
  - Phase 2a の候補は Claude Opus 5.5。台帳の試験用ポリシーが許可するのも、このモデルだけ

### shadow の動作

1. **レポートの結果は変えない。** 返すのは、今の requester の戻り値そのもの
   - 実際のレポート生成処理（`generateSharedAnalysis`）に組み込んでも、packet・呼び出し回数・トークン数・費用が完全に一致することをテストで確認した
2. **今の段階が成功した後だけ動く。** 今の requester が例外を出したら、そのまま伝え、shadow は動かない
3. 対象は既定で `generate` だけ（`fact` は対象外。`steps` で変更できる）。1回の実行で最大2回（`maxShadowCalls`）
4. 依頼の中身は、今の依頼本文の `instructions`・`input`・JSON スキーマ・最大出力・effort をそのまま使う
   - 送り先は shadow モデル。主体は system、名目は `kabumori` / `market_report`、logical role は `kabumori.market_report.<step>.shadow`
   - 本文にある今のモデル ID（gpt-6.1-sol）は使わない
5. **送信は1回だけ。** 再試行しない。別の AI への切り替え（fallback）もしない
6. **予算台帳を必ず通す。** 予約 → 送信の確認 → 確定
   - 台帳が拒否したら送らない（`BUDGET_DENIED`）
7. **二重送信を防ぐ。** 呼び出し ID は次の形で決まる
   - `mr:<cycle uuid>:a<claim の試行番号>:<step>:<その実行内の何回目か>`
   - 同じ claim の試行が再実行されても、台帳が「確定済み」として拒否し、2回目の課金は起きない
8. **時間の上限と取消。** 既定 90 秒（`timeoutMs`）。呼び出し側の `AbortSignal` で、開始前・送信中のどちらでも止められる
9. **記録（sink）に本文は入らない。** 入るのは次だけ
   - 段階、何回目か、呼び出し ID、モデル、成否、エラーコード、送信回数、実際に応答したモデル
   - 入力・出力のトークン数、推定費用（台帳を確定させた金額と同じ）、費用の根拠、所要時間
   - 構造の比較（スキーマのキー名・種類・配列の長さ・文字数だけ）
   - プロンプト・入力・出力の本文・キーが含まれないことは、テストで検査した
   - sink が例外を出しても、レポートには伝わらない
10. `ledgerGuardFromEdgeEnv`: Edge Function の環境（`SUPABASE_URL` と `SUPABASE_SECRET_KEYS["default"]`、市況レポートが既に使っている形）から台帳 Guard を作る。欠けていれば null（＝ shadow は off）。作るときに通信はしない

## 2. 互換性の確認（オフライン）

- 実際の依頼本文（リポジトリのオフライン fixture `close_2026-09-17` から作ったもの）は、生成用・ファクトチェック用のどちらも、Provider の検査と Anthropic 向けのスキーマ変換に通った
- 1回あたりの上限見積もり（入力の UTF-8 バイト数で過大に見積もる）:
  - 生成用 ≒ **$0.45**、ファクトチェック用 ≒ **$0.16**
  - どちらも、台帳の試験用ポリシーの「1回 $1.00 まで」に収まる

## 3. 費用と台帳の突合

- shadow の記録の `estimatedCostUsd` は、台帳を確定させた金額と同じ
  - カタログの単価 × provider が返した usage。usage が不明なときは上限額
- 今のレポートの費用（`diagnostics.cost_usd`）は、モデル登録表の OpenAI 単価で計算されている。shadow の費用はそこに**入らない**
  - Claude 側の費用は台帳（`ai_ledger_usage_summary`、logical role 別）で確認する
- **今の試験用ポリシーでは、毎日の shadow は月の途中で止まる**（止まっても安全側。台帳が拒否し、レポートには影響しない）
  - 回数: 営業日 約21日 × 1日2本 × 生成1〜2回 ≒ 月 42〜84回 > 月 40回
  - 金額: Opus は約 $0.27/回（G2 の測定）≒ 月 $11〜23 > 月 $5
  - 1日の上限（6回・$2）には、ほぼ収まる
  - 毎日続けて shadow するには、ポリシーの引き上げ（別の承認）が必要

## 4. まだ承認されていない本番の手順（Phase 2b 以降。どれも別 TASK・別承認）

| # | 手順 | 注意 |
|---|---|---|
| 1 | `market-report-analysis/handler.ts` に配線する。`openAiRequester(...)` を `createMarketReportRequester({ legacy: openAiRequester(...), shadowModel, readEnv, context: { cycleId: claim.cycle_id, claimAttempt: claim.attempt }, budget: ledgerGuardFromEdgeEnv(readEnv), sink })` で包む | **G2 が所有するファイル。G2 と調整が必要。** `mod.ts` へのエクスポートの追加も、このとき行う |
| 2 | sink の記録先を決める（例: 既存の generation traces、またはログ） | 本文を入れない形を保つ |
| 3 | Edge Function の時間内に収まるか | shadow は今の段階の後に順番に走るので、1回あたり最大 `timeoutMs` 分、実行が延びる。レポートの実行時間の予算から `timeoutMs` と `signal` を決める |
| 4 | Supabase の Edge Secret に `ANTHROPIC_API_KEY` を登録する | runbook（PHASE1D §2 手順8）。`ANTHROPIC_*` はほかに置かない |
| 5 | 台帳の回復処理の Cron を設定する | 応答が失われた予約を確定させる。台帳を使う本番の呼び出しより前に必要 |
| 6 | ポリシーを見直す（毎日 shadow するなら） | §3 の試算。広い範囲のポリシーは作らない |
| 7 | deploy して、`KABUMORI_MARKET_REPORT_AI_MODE=shadow` を設定する | 最初は数日だけ、記録を確認しながら |
| 8 | （将来）Claude の結果を配信に使う（primary） | このモジュールには存在しない。shadow の記録で品質・ファクトチェック・費用・遅延を評価してから、別の設計・承認で行う |

## 5. 戻し方（rollback）

- `KABUMORI_MARKET_REPORT_AI_MODE` を外すか `off` にすると、次の実行から今の requester そのものに戻る
  - 配線後も、データの移行や巻き戻しは不要
  - `supabase secrets` の変更は、全関数の version を上げる（コードは変わらない）
- 緊急時は、台帳の停止スイッチ（runner `stop`）でも止まる。全ポリシーを無効化し、shadow は `BUDGET_DENIED` になる。レポートには影響しない

## 6. テスト（すべてオフライン。実 API・本番 0）

`market_report_shadow_test.ts` の18件。Claude の応答は合成の偽物、台帳は「1回の試行につき送信1回」の規則を持つ偽物。

| 観点 | 内容 |
|---|---|
| 既定 OFF | `shadow` の完全一致以外はすべて off。off は同じ関数を返し、読む環境変数はモードの1つだけ |
| fail-safe | キーが無い・Admin キー・台帳が無い・context が不正・モデルが不正（OpenAI のモデル、未知のモデル）→ off |
| 変換 | 実際の generate / fact の本文 → 同じプロンプト・スキーマ・上限、system 主体、1回だけの送信。上限見積もり ≦ $1 |
| 不正な本文 | 送信前に拒否（5種類） |
| 成功 | 今の結果をそのまま返す。Claude への送信1回。台帳は予約 → 送信 → 確定（succeeded・measured）。記録の費用 = 台帳の金額 |
| 対象と回数 | fact は既定で対象外、回数の上限、今の段階が失敗したら shadow しない |
| エラー | 429・529・500・利用上限・クレジット切れ・401。いずれも送信1回、再試行なし、記録あり、レポートは今のまま |
| 出力の異常 | スキーマ違反、max_tokens での打ち切り → 失敗として記録 |
| 予算 | 4種類の拒否で送信 0 |
| 冪等性 | 同じ claim の試行を再実行 → 台帳が拒否、課金は1回だけ。次の試行は別の呼び出し |
| 一部の失敗 | 送信後の確定が失敗 → 予約は回復処理のために残る |
| 時間切れ・取消 | 時間切れ、開始前の取消、送信中の取消 |
| sink | 例外を出しても、レポートには伝わらない |
| 漏洩 | キー・プロンプト・入力・出力の本文が記録に無い。記録の項目は決まった15個だけ |
| 構造比較 | 本文を含まない |
| 実際の流れ | `generateSharedAnalysis` の結果が、shadow あり・なしで完全に一致 |
| Edge 環境 | `ledgerGuardFromEdgeEnv` の欠落・不正の扱い。通信しない |

- mutation: 次の4つの改変は、すべてテストで検出された
  - off で別の関数を返す
  - 再試行を許す
  - 記録に本文を混ぜる
  - 既定で fact も対象にする
- 回帰: 共通 Provider 112件（分離の規則のテストを含む）、市況レポート 283件、型チェック、lint
