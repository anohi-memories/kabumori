# F2 — 共通市況レポートの handler に Opus Primary を配線（朝刊・大引け、既定 OFF）

- 作成: 2026-10-13 JST（F2）
- task_id: `kabumori-f2-opus-primary-morning-close-handler-20261013`
- 土台: F6 の PR #170（`_shared/ai_provider/market_report_primary.ts`）。この PR は #170 の上に積む
- 範囲: ソースとオフラインテストだけ。本番の DB・Edge・Secrets・Cron の変更は0件。実 API の呼び出しも0件

## 1. 設定とレポートごとの動作

設定 `KABUMORI_MARKET_REPORT_AI_MODE` の値で、レポートごとの動作が決まる。

| 値 | 朝刊 | 大引け |
|---|---|---|
| 未設定・`off`・`shadow`・その他すべて（大文字や前後の空白を含む） | OpenAI（今のまま） | OpenAI（今のまま） |
| `primary_close` | OpenAI（今のまま） | **Claude** |
| `primary_both`（F6 の部品の変更が入ったあと） | **Claude** | **Claude** |
| `primary_both`（F6 の部品の変更が入る前） | 失敗 `ANALYSIS_PRIMARY_CONFIG:MODE_UNSUPPORTED` | 同じく失敗 |

- **Claude** の行では、生成と Fact 確認の両方を `KABUMORI_MARKET_REPORT_PRIMARY_MODEL`（`claude-opus-5-5`）で行う。
  - 送るのは1回だけ。再試行も、OpenAI への自動切り替えも無い。
  - 失敗したら、そのサイクルは失敗になる。次の Cron（再試行の回）が、claim の試行番号を1つ進めて、もう一度 Claude で作る。
- 「F6 の部品の変更が入る前」の `primary_both` は、F6 の部品がまだ朝刊を扱えない状態を指す。このとき OpenAI には黙って戻さず、失敗にする。
- 戻し方: 値を外す（または `off`）。次の呼び出しから OpenAI に戻る。コードの変更は要らない。
- shadow と primary は同じ変数を使う。そのため、1つのサイクルで両方が動くことは無い。

## 2. handler の変更（F2 の担当）

- F6 の差分案（`F6_OPUS_PRIMARY_HANDLER_V0.patch`）をそのまま当てた。
  - handler の配線
  - 隔離テストの許可リスト（F6 が作成。handler が部品を読み込むと同時に入れる必要がある）
  - handler の E2E
- F2 で足したもの
  1. **`primary_both` で、F6 の部品が「対象外」と答えたとき**: OpenAI に黙って戻さず、`ANALYSIS_PRIMARY_CONFIG:MODE_UNSUPPORTED` で失敗にする。判定するのは部品で、handler は判定しない。
  2. **監査用のモデル名**: Primary のときは、`report_diagnostics` の `ai_generate_model` と `ai_fact_model` を、実際に使った Claude のモデル名にする。前は OpenAI のモデル名が残っていた。
     - `model`、packet の `model`、`p_model`、trace の `model` は、F6 の差分案のとおり。
  3. **止まった理由の記録**: 失敗した最後の呼び出しを、`report_diagnostics.primary_last_error` に `<コード>:<詳細>` の形で残す。
     - 例: `BUDGET_DENIED:CALL_LIMIT`
     - 残すのはコードだけ。詳細が英数字と記号の80文字以内でなければ `REDACTED` にする。
     - ログの行（`event: market_report_primary`）にも同じ内容が出る。
- `index.ts` は変えていない。Primary に `waitUntil` は要らない。
- OpenAI のキー（`OPENAI_API_KEY`）は、Primary のときも必須のまま。手で OFF に戻したら、すぐ OpenAI で動けるようにするため。

## 3. 予算（試験用のポリシーのまま。自動では増やさない）

今のポリシー（system・`claude-opus-5-5`・kabumori・market_report）は次のとおり。

- 1回 $1
- 1日 6回・$2
- 1か月 40回・$5

| 状況 | 1日の呼び出し | 費用の目安（F6 の見積もり：1レポート約 $0.40） |
|---|---|---|
| `primary_close`、普通の日 | 2回 | 約 $0.40 |
| `primary_both`、普通の日（朝刊・大引けとも、生成 → Fact） | 4回 | 約 $0.80 |
| `primary_both`、どちらかで再生成または再試行の回 | 6回 | 約 $1.20。その日の上限に達する |
| その日の7回目 | 送る前に拒否 | `ANALYSIS_PRIMARY_GENERATE_FAILED:BUDGET_DENIED`（`primary_last_error` = `BUDGET_DENIED:CALL_LIMIT`） |

- オフラインの検証（`market_report_primary_test.ts` の、1日分を1つの台帳で流す試験）の結果は次のとおり。
  - 朝刊、大引け、大引けの再試行の回は通る（計6回）。
  - その次は `CALL_LIMIT` で、送る前に止まる。
- 月 $5 の場合の見通し
  - 予約は上限額（生成 約 $0.45）で数える。そのため、確定済みが約 $4.55 を超えた時点で止まる。
  - `primary_both` を毎日続けると、今日（10/13）の大引けから数えて **6〜7営業日目（10/21 ごろ）に `COST_LIMIT` で止まる**。
- **毎日の朝刊・大引けを続けるなら、上限の見直しが要る**（提案。別の本番変更として明示の承認が要る）
  - 月: $25・120回（10月の残りは約13営業日 × $0.80 ＋ 再試行）
  - 1日: $3・8回（各レポートに再試行の回を1つ残す）
  - 1回: $1 のまま

### 止まるとき・失敗するときのコード（`p_error`）

| コード | 意味 |
|---|---|
| `ANALYSIS_PRIMARY_CONFIG:MODEL_INVALID` | モデルの設定が無い、または Anthropic のモデルではない |
| `ANALYSIS_PRIMARY_CONFIG:KEY_MISSING` / `KEY_INVALID` | Anthropic のキーが無い、または形式が不正（値は出さない） |
| `ANALYSIS_PRIMARY_CONFIG:NO_LEDGER` | 台帳の接続設定が無い |
| `ANALYSIS_PRIMARY_CONFIG:BAD_CONTEXT` | claim の情報が不正 |
| `ANALYSIS_PRIMARY_CONFIG:MODE_UNSUPPORTED` | `primary_both` だが、F6 の部品がまだ対応していない |
| `ANALYSIS_PRIMARY_GENERATE_FAILED:BUDGET_DENIED` | 予算で止まった。詳細は `primary_last_error`（`CALL_LIMIT`・`COST_LIMIT`・`PER_CALL_LIMIT`・`GUARD_UNAVAILABLE`・`ATTEMPT_FINALIZED` など） |
| `ANALYSIS_PRIMARY_GENERATE_FAILED:DEADLINE_EXCEEDED` | 処理開始から130秒の枠の残りが6秒未満で、送らなかった |
| `ANALYSIS_PRIMARY_GENERATE_FAILED:TIMEOUT` | 応答が時間内に来なかった（上限額で確定する） |
| `ANALYSIS_PRIMARY_GENERATE_FAILED:OVERLOADED` / `RATE_LIMITED` / `SERVER_ERROR` / `AUTH` / `CREDIT_EXHAUSTED` / `SPEND_LIMIT` / `INVALID_JSON` / `SCHEMA_VIOLATION` など | Anthropic の失敗。共通の部品の分類のとおり |

- Fact の呼び出しが失敗した場合（予算・時間切れ・API の失敗）は、今までの約束どおり「Fact 未実施」で配信する。`primary_last_error` には理由が残る。

## 4. 本番で有効にする手順（どれも別承認。この作業では何もしていない）

本番の Cron（2026-10-13 に読み取りだけで確認した。時刻はすべて JST・平日）は次のとおり。

| レポート | データ | 生成 | 再試行 |
|---|---|---|---|
| 朝刊 | 07:50 | 07:55 | 08:05 |
| 大引け | 16:15 | 16:20 | 16:35 |

| # | 作業 | 実行者 | 注意 |
|---|---|---|---|
| 0 | L2 のレビュー（この PR）。`primary_both` のときは、F6 の部品の変更（`F2_PRIMARY_BOTH_F6_HANDOFF.patch`）の承認も | ChatGPT / 利用者 | パッチの部品の部分は F6 の担当 |
| 1 | PR #170 → この PR の順に main へ merge | 承認者 | 直前に `git merge-tree` で確かめる |
| 2 | Edge Secret: `ANTHROPIC_API_KEY`（30日の期限付きのキー）と `KABUMORI_MARKET_REPORT_PRIMARY_MODEL=claude-opus-5-5`。**モードはまだ入れない** | 利用者（Claude はキーを読まない・写さない・表示しない） | `secrets set` で全関数の version が上がる（コードは変わらない） |
| 3 | 本番で動いている `market-report-analysis` と main の差を、バイト単位で比べる | 承認されたスロット | 他の merge 済みで未 deploy の変更が混ざらないか |
| 4 | `market-report-analysis` だけを main から deploy し、deploy 後にバイト単位で確かめる | 利用者 / 承認されたスロット | worktree からの deploy は、`supabase/config.toml` の位置に注意 |
| 5 | モードを設定する。大引けだけなら15:55〜16:15 に `primary_close`。朝刊からなら前日の夜〜07:45 に `primary_both`（F6 の部品の変更が入ってから） | 利用者 | 次の Cron から効く |
| 6 | 観察（読み取りだけ）: サイクルの結果、`report_diagnostics` の `ai_primary` / `primary_calls` / `cost_usd` / `primary_last_error`、台帳の確定額、ログの `market_report_primary` の行 | 利用者 / 読み取りのみ | |
| 7 | 止める条件に当たったら、モードを外す | 利用者 | 下の「止める条件」 |

- **今の配信の状態**: 共通市況レポートの利用側のゲート（`market_report_consumer_settings`）は、2026-10-13 の朝は X・アプリとも OFF だった。
  - Opus で作った共通レポートを X やアプリに届けるには、ゲートを ON にする必要がある。これは別承認。
  - ゲートが OFF のままだと、Opus のレポートは保存されるだけで、利用者には届かない。

### 止める条件（1つでも当てはまったら、すぐモードを外す）

1. ログや記録に、キー・プロンプト・本文が出た。このときはキーも作り直す。
2. 1回の確定額が $0.60 を超えた、または1日の合計が $1.50 を超えた（`primary_both` のときは $2 の上限に任せる）。
3. `BUDGET_DENIED:GUARD_UNAVAILABLE`（台帳に届かない）が出た。
4. 同じレポートの本番と再試行の両方が失敗した。その日はそのレポートが出ない。利用者は了承済み。

## 5. 30日の期限付きのキーの入れ替え

- キーは Supabase の Edge Secret（暗号化して保存される）にだけ置く。コード・記録・会話・ログには出さない。
- 期限の**7日前まで**に、次の順で入れ替える。
  1. Anthropic の Console で新しいキーを作る（専用の workspace、spend limit 付き）。
  2. 利用者が `ANTHROPIC_API_KEY` を新しい値で上書きする。
  3. 次の Cron の結果が `KEY_INVALID` / `AUTH` でないことを確かめる。
  4. 古いキーを無効にする。
- 期限が切れると、Primary のレポートは `ANALYSIS_PRIMARY_GENERATE_FAILED:AUTH` で失敗する。
  - 戻すには、モードを外して OpenAI に戻すか、キーを入れ替える。
- 期限の日は、利用者が手元で管理する（このリポジトリには書かない）。

## 6. F6 への引き継ぎ（`primary_both` に必要な、F6 の担当の部品の変更）

- F6 の部品は「`primary_close` かつ大引け」しか Claude に回さない。そのため、`primary_both` には F6 の部品の変更が要る。
- F2 は F6 のファイルを直接変えていない。検証済みの差分を `docs/ai-provider/F2_PRIMARY_BOTH_F6_HANDOFF.patch` として渡す。

| ファイル | 担当 | 変更 |
|---|---|---|
| `_shared/ai_provider/market_report_primary.ts` | F6 | `PRIMARY_BOTH_MODE = "primary_both"` を足す。`primary_both` は朝刊と大引けを、`primary_close` は今までどおり大引けだけを回す。他は変えない（+10 / -6） |
| `_shared/ai_provider/market_report_primary_test.ts` | F6 | `primary_both` の E2E を2件足す |
| `market-report-analysis/opus_primary_handler_test.ts` | F2 | `MODE_UNSUPPORTED` の2件を、`primary_both` で朝刊・大引けとも Claude になる確認（と、朝刊のキーが無い場合）に置き換える |

- F6 の部品の E2E 2件の中身
  - 朝刊（10/1）と大引け（9/30）のどちらも、OpenAI の経路と同じ packet と hash になる
  - 綴りの違う値は OFF のまま
  - 1日分を1つの台帳で流したときの上限の動き
- 当て方: F6（または F6 が許可したスロット）が、パッチの3ファイルを**同時に**当てる。部品だけを先に入れると、F2 の `MODE_UNSUPPORTED` の試験が落ちる。
- 検証: このブランチ（`72655376`）にパッチを当てた使い捨ての worktree で、次がすべて PASS した。
  - `market-report-analysis/` 全体
  - `_shared/ai_provider/` 全体
  - `kabumori_ai_models_test.ts`
  - 合わせて441件。`--deny-net` を付け、型検査込みで実行した。lint も問題なし。

## 7. テスト（すべてオフライン。実 API・本番0件）

```sh
deno test --no-config --allow-read --allow-env --deny-net supabase/functions/market-report-analysis/opus_primary_handler_test.ts
```

```sh
deno test --no-config --allow-read --allow-env --deny-net supabase/functions/market-report-analysis/ supabase/functions/_shared/ai_provider/ supabase/functions/_shared/kabumori_ai_models_test.ts supabase/functions/market-report-data-packet/
```

- handler の E2E は38件。本物の `handleRequest` を、偽の DB・OpenAI・Anthropic・台帳で動かす。
  - 朝刊・大引け
  - OFF と、その他の値16通り
  - 設定不足
  - 予算の上限3種と、台帳に届かない場合
  - Fact の時点での上限
  - 時間切れ（送る前・Fact の前・応答なし）
  - 二重実行（試行番号 2、終わった試行の再実行）
  - claim が取れない場合3種
  - キーの漏れ
- わざと壊した版での確認: 3つの追加（`MODE_UNSUPPORTED`、監査用のモデル名、`primary_last_error`）を、それぞれ1つずつ外すと落ちる。
- 関連する4つのスイートは計480件で、すべて PASS（型検査込み）。

## 8. まだ分からないこと（オフラインでは確かめられない。F6 の文書と同じ）

- Opus の応答時間。生成が90秒を超えると `TIMEOUT` になる。生成と Fact の合計が130秒の枠に収まるかも分からない。朝刊の入力は大引けと同程度。
- 本番の Edge の wall clock（150秒か400秒か）。
- Anthropic が、このスキーマの strict な structured output を本番で受け付けるか。
