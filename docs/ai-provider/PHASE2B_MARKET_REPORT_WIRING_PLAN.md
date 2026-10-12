# 共通AI基盤 Phase 2b — 市況レポートへの配線計画（オフライン）

- 作成: 2026-10-12 JST（G6 くろちゃん）
- task_id: `common-ai-provider-g6-phase2b-market-report-wiring-offline-20261012`
- 範囲: **ソースとオフラインテストだけ**
  - `market-report-analysis/`（G2 所有）は**読んだだけで変更していない**。どの Edge Function にも配線していない
  - 本番 DB・Edge・Secrets・Cron の変更は 0。実 API（Anthropic / OpenAI）の呼び出しも 0
- 実装: `supabase/functions/_shared/ai_provider/market_report_wiring.ts`（Phase 2a の `market_report_shadow.ts` を import して使う。PR #148 は変更しない）
- テスト: `supabase/functions/_shared/ai_provider/market_report_wiring_test.ts`
- 前提: Phase 2a [PR #148](https://github.com/anohi-memories/kabumori/pull/148)（head `a71de72b`）。この PR は #148 の上に積んでいる

## 1. 結論

1. Phase 2a の部品を「各段階の直後に shadow を順番に送る」形のまま配線すると、レポート配信が Edge の時間制限を越える危険がある。**この形は採らない。**
2. 代わりに **後回し（deferred）方式** を作った（`prepareMarketReportShadow`）。
   - レポート生成中は、生成段階の依頼と結果を**記憶するだけ**で、何も送らない
   - レポートの確定（`complete_market_report_analysis` の成功）後に、記憶した生成を **1回だけ** Claude に送る
   - 既定では最後の生成（配信された本文のもと）だけを送る
3. 実際に配線するには `market-report-analysis/handler.ts`（G2 所有）の変更が必要になる。今回は触らず、**正確な差分案と受け入れ条件**（§8）を残す。
4. 時間の保証は、オフラインのテストでは主張しない。`EdgeRuntime.waitUntil` の挙動と Opus の実際の応答時間は、G2 の配線パッチとカナリアで確かめる（§4）。

## 2. 接続点（handler.ts を読み取りのみで確認）

`handleRequest` の流れ:

```text
X-Cron-Secret の確認 → 環境変数（SUPABASE_URL, SUPABASE_SECRET_KEYS.default, OPENAI_API_KEY）
→ 休場日 → decideRunWindow → claim_market_report_analysis
     → { cycle_id, claim_token, attempt, outcome, data_packet_id }
→ data packet → ニュース → buildAnalysisInput
→ generateSharedAnalysis(input, openAiRequester(...), deps.now, records)   ← ここが接続点（requester を差し替える）
→ diagnostics → complete_market_report_analysis → writeTraces → 応答
```

互換性の制約:

| 項目 | 今の値 | 配線での扱い |
|---|---|---|
| cycle | `claim.cycle_id`（uuid） | 呼び出し ID `mr:<cycle>:a<attempt>:generate:<n>` に入る |
| claim の試行番号 | 1〜3（4回目は `attempts_exhausted`） | 同上。試行ごとに別の呼び出し、同じ試行の再実行は台帳が拒否 |
| 段階の数 | 生成は最大2回、Fact は最大2回（合計4回まで、順番に実行） | shadow の対象は生成だけ。既定は最後の1回 |
| モデル | OpenAI は G2 のモデル登録表から決まる | shadow のモデルは設定 `KABUMORI_MARKET_REPORT_SHADOW_MODEL`（カタログ上の Anthropic モデルであること） |
| スキーマ | Responses API の `json_schema`（strict） | Phase 2a の変換が、実際の依頼本文で PASS 済み |
| 失敗の扱い | requester の例外 → `fail_market_report_analysis` | 今の requester をそのまま呼ぶので、例外も結果もそのまま |

## 3. 方式の比較

| 方式 | 内容 | レポートへの影響 | 判断 |
|---|---|---|---|
| A. 順番に送る（Phase 2a のまま） | 各生成の直後に Claude を待つ | 配信の前に最大 90 秒 × 回数が加わる。Free plan の 150 秒の制限を越えると**レポート自体が失敗**する | 採らない |
| **B. 後回し（今回の候補）** | 生成中は記憶だけ。確定後に送る | 確定と応答は今と同じ。shadow は残り時間だけを使う | 採用候補 |
| C. 別の処理に分ける | G6 所有の別 Edge Function または Cron が、確定したレポートの入力から依頼を作り直して送る | まったく無い。自分の時間枠（150 秒または 400 秒）を丸ごと使える | 将来の候補。依頼本文の再現に G2 のコード（`analysis_input.ts` / `analysis_logic.ts`）か生成 trace が要る。B のカナリアで時間切れが多ければ移る |

## 4. 時間制限と Cron の重なり

### Edge の制限

Supabase 公式ドキュメントの記載を、Phase 2b の調査時に確認した。

- wall clock: Free plan 150 秒、有料 plan 400 秒
- 応答: 150 秒以内に返さないと 504
- CPU: 2 秒

本番がどちらの plan かは、この作業では確かめていない。設計は 150 秒を前提にした。

### レポート側の時間

- 生成と Fact は合わせて最大4回で、順番に実行される
- 1回の制限は 90 秒（`OPENAI_TIMEOUT_MS`）。通信の再試行は1回の呼び出しにつき最大2回、1回の実行全体で最大3回・待ち時間30秒まで
- **最悪の場合は、shadow が無くても 150 秒を越えうる。** これは今の G2 の性質で、今回の変更とは関係がない。B 方式はこれを悪くしない

### B 方式の時間の扱い（`market_report_wiring.ts`）

- `flush({ deadlineAtMs })` の締め切りは、呼び出し側が渡す（G2 のパッチでは「処理開始 + 150 秒」を想定）
- 締め切りの 10 秒前（`SHADOW_DEADLINE_MARGIN_MS`）までを使う
- 残りが 20 秒（`MIN_SHADOW_WINDOW_MS`）未満なら、送らない（`NO_TIME`）
- 1回の制限は、残り時間に合わせて短くする（最大 90 秒）。2件目を送る前にも、残り時間を確かめ直す
- 時間切れになった送信は、台帳で**上限額で確定**する（generate は約 $0.45）。結果は得られないのに費用がかかるので、カナリアで時間切れの割合を必ず見る

### オフラインでは保証できないこと（G2 のパッチとカナリアで確かめる）

1. **応答の後にどこまで動けるか**
   - 応答を先に返して shadow を後ろで動かすには `EdgeRuntime.waitUntil` が要る
   - その挙動（応答後も wall clock の上限まで動くか）は、今回は確かめていない
   - `waitUntil` が無いときは送らない、という形にする（待たない Promise に頼らない）
2. **送信中に worker が止められた場合**
   - 予約は `sent` のまま残る
   - 回復処理（`ai_ledger_recover_stale`）が上限額の unknown として確定させる。だから**回復処理の Cron が、本番で使う前の必須条件**になる
3. **Opus の実際の応答時間**
   - 入力約 2 万トークン、出力数千トークン（思考を含む）の応答時間は、オフラインでは分からない
   - レポートが 60 秒かかった日は、shadow に残るのは約 80 秒

### Cron の重なり

`.agent/CURRENT_STATE.md` の記録を使った。本番は読み直していない。

| 枠 | 本番 | 再試行 | 間隔 |
|---|---|---|---|
| 朝 | 07:55 | 08:05 | 10 分 |
| 引け | 16:20 | 16:35 | 15 分 |

- 間隔（10〜15 分）は wall clock の最大（400 秒）より長い。だから、1回の実行の shadow が次の再試行と重なることはない
- 確定したサイクルは再試行で skip される。shadow は確定したその実行の中でしか送らないので、2回目は無い
- 1回目が失敗して再試行が確定した場合は、claim の試行番号 2 の呼び出しになる（別の呼び出し ID）
- 同じ試行番号での二重実行（手動起動と Cron の重なりなど）は、claim と台帳の両方で防ぐ（台帳は `ATTEMPT_FINALIZED` を返す。テスト済み）
- X 朝刊（08:18〜08:22）・アプリ朝刊（08:35）・アプリ大引け（17:15）は確定したレポートを読むだけ。shadow はそれらが読むものに何も書かない

## 5. 予算（試験用ポリシーのまま。拡大しない）

本番の試験用ポリシー（Phase 1f）: system・`claude-opus-5-5`・kabumori・market_report だけが対象。

| 枠 | 回数 | 金額 |
|---|---|---|
| 1回 | — | $1 |
| 1日（JST） | 6 回 | $2 |
| 1か月（JST） | 40 回 | $5 |

1回の費用:

- 実測に近い値は約 $0.27（G2 の Opus 測定）。harness の偽応答（入力 2 万・出力 9 千）は $0.26
- 予約の上限額（generate）は約 $0.45。予約は「使った額 + 上限額」が枠に収まるときだけ通る

使う量（`last` は1レポートに1回、営業日に朝と引けの2回）:

| | 回数 | 金額 | 枠との関係 |
|---|---|---|---|
| 1日 | 2 回 | 約 $0.54 | 1日の枠（6回・$2）に収まる |
| 1か月（約 21〜22 営業日） | 42〜44 回 | 約 $11〜12 | **月の枠を越える** |

月の枠を越えるときの流れ:

- 17 回目までは通る（使った額 $4.32 + 上限額 $0.45 ≤ $5）
- 18 回目からは `COST_LIMIT` で、送る前に拒否される。目安は月の 9 営業日目ごろ
- 拒否されても、レポートには影響しない（テスト済み）
- 時間切れが出ると、上限額で確定するので、回数はさらに減る
- `all`（再生成した日は2回）は費用が増えるので、既定にしない

**ポリシーは広げない。** 毎日続けるために枠を増やす場合は、別の本番変更として依頼・承認を取る。

## 6. カナリア案（別承認。今回は何も有効にしていない）

### 前提（それぞれ別の承認）

1. 回復処理の Cron（`select public.ai_ledger_recover_stale('{}'::jsonb)` を数分ごと）が本番で動いている
2. Edge Secret `ANTHROPIC_API_KEY` を登録する
   - 専用の Console workspace のキーで、workspace の spend limit を設定したもの
   - `ANTHROPIC_CUSTOM_HEADERS` は登録しない
3. G2 の配線パッチを、**mode 未設定（off）のまま** deploy する
4. 自然な1サイクルで、off のまま変化が無いことを確かめる
   - 台帳の行が増えていない
   - diagnostics とレポートの内容が今までどおり
5. その月の残りの枠（`ai_ledger_budget_status`）が「$1.6 + $0.45」以上ある

### 期間と量

- 3 営業日（朝・引けで最大6回）
- 見込みの費用は約 $1.6
- 1日の枠・月の枠に収まり、ポリシーの変更は無い
- 設定: `KABUMORI_MARKET_REPORT_AI_MODE=shadow`、`KABUMORI_MARKET_REPORT_SHADOW_MODEL=claude-opus-5-5`

### 止める条件（1つでも当てはまったら、すぐ止める）

1. 市況レポートの確定が失敗・遅延した、または `market-report-analysis` に wall clock 超過・強制終了・504 の記録がある
2. shadow の記録に `SHADOW_EXCEPTION` が出た、または予約が回復処理の後も `sent` のまま残っている
3. 1回の確定額が $0.60 を超えた、または1日の合計が $1.00 を超えた
4. 最初の4回のうち2回以上が `TIMEOUT` だった（結果が得られず上限額だけかかる）。このときは方式 C へ移る
5. ログにキー・プロンプト・本文が出た。このときはキーも作り直す
6. `GUARD_UNAVAILABLE` が2回以上出た

### 止め方（速い順）

1. 台帳 runner の `stop` で、全ポリシーを無効にする
   - 以後の shadow は、送る前にすべて拒否される
   - deploy は要らない
2. `KABUMORI_MARKET_REPORT_AI_MODE` を外すか `off` にする
   - `secrets set` は全関数の version を上げる（コードの差し替えではない）
3. G2 の配線パッチを戻す

### 成功の条件

- 6回とも記録が残っている（成功、または理由付きの失敗）
- レポートの確定・diagnostics・費用（OpenAI 分）が、今までどおり
- 応答時間・費用・構造の比較が記録された

## 7. セキュリティと運用

### Secrets

- `ANTHROPIC_API_KEY` は Edge Secret に置く
  - Edge Secret は関数ごとには分けられず、同じプロジェクトのどの関数でも読める、という前提で設計した（今回は確かめていない。登録の前に公式ドキュメントで確認する）
  - そのため、実際の歯止めは2つになる: workspace の spend limit と、台帳のポリシー（市況レポートの system 呼び出しだけ）
- 台帳には、レポートが今も使っている `SUPABASE_SECRET_KEYS.default` を使う
  - `apikey` と `Bearer` に入れる形は、Phase 1g の本番 smoke で確認済み
  - 新しい Supabase キーは作らない。Legacy の service_role JWT は使わない
- キー・本文はログにも記録にも出さない。記録の項目は15個に固定（テスト済み）

### 権限と境界

- 台帳の RPC は service_role だけが実行できる
- 主体は system だけ
  - 配線には利用者の入力が入る経路が無い
  - 予約に `user_id` / `brand_id` は付かない（テストで確認）
- 別の provider への自動切り替え（fallback）は無い。送信は1回で、再試行もしない

### 費用の分け方

- レポートの `diagnostics.cost_usd` と `p_api_cost_usd` は、OpenAI の分だけのまま（テストで、shadow あり・なしが同じ値になることを確認）
- Claude の費用は、台帳の `usage_events` だけに残る
- shadow の記録（sink）は、G2 のパッチで1行のログ（`market_report_shadow` イベント）にする想定
  - レポートの packet・diagnostics・生成 trace には入れない

### 監視

利用者が実行する、読み取りだけの確認:

- `ai_ledger_budget_status` と `ai_ledger_usage_summary`（日・月の消費）
- Edge のログの `market_report_shadow` イベント（エラーコード、応答時間）
- 市況レポートの cycle の結果（確定・失敗・試行回数）

### 取消と競合の危険

| 危険 | 対応 |
|---|---|
| 応答後の shadow が wall clock で止められる | `waitUntil` が無ければ送らない。止められた送信は、回復処理が上限額で確定させる |
| 手動起動と Cron が重なる | claim が一方だけを通す。同じ試行番号の再送は、台帳が拒否する |
| flush が2回呼ばれる | 2回目は `ALREADY_FLUSHED` で何もしない（テスト済み） |
| 取消（AbortSignal） | 送信前なら送らない。送信中なら、すぐ終わって失敗として記録される（テスト済み） |
| 記録（sink）の例外 | 飲み込む。レポートには届かない（テスト済み） |

## 8. G2 との統合計画（所有は動かさない）

### ファイルごとの担当

| ファイル・作業 | 担当 |
|---|---|
| `_shared/ai_provider/market_report_shadow.ts`・`market_report_wiring.ts`・各テスト・`mod.ts` への export・`docs/ai-provider/` | G6 |
| `market-report-analysis/handler.ts`・`index.ts`・`handler_test.ts` | G2 |
| 回復処理の Cron・Edge Secret・台帳のポリシー | G6 の本番作業（利用者の承認と実行） |
| `market-report-analysis` の deploy | G2 の本番ゲート |

### 順番

1. K6 が PR #148 とこの PR を評価する。merge は承認後に、#148 → この PR の順で行う
2. G2 の PR143 / PR149 は、市況レポート本体にも共通AI基盤にも触れていない（2026-10-12 に開いている全 PR のファイルを確認した）
   - したがって、それらの merge を待つ必要はなく、衝突も無い
   - ただし `handler.ts` のパッチは G2 の作業なので、G2 の手が空いてから、#148 とこの PR を含む新しい main をもとに、**別の G2 TASK** として行う
3. 本番の順番（それぞれ別承認）
   1. 回復処理の Cron
   2. Edge Secret
   3. off のまま deploy し、自然な1サイクルで変化が無いことを確認
   4. カナリア（§6）

### G2 の配線パッチ案（handler.ts。今回は適用していない）

```ts
import { prepareMarketReportShadow } from "../_shared/ai_provider/market_report_wiring.ts";
// Deps に追加: waitUntil?: (pending: Promise<unknown>) => void
// index.ts: waitUntil: (pending) => EdgeRuntime.waitUntil(pending)

const startedAtMs = deps.now().getTime();            // handleRequest の先頭
// ... claim の後、generateSharedAnalysis の前:
const shadow = prepareMarketReportShadow({
  legacy: openAiRequester(openAiApiKey, deps.fetch, { stats: transport, sleep: deps.sleep ?? realSleep }),
  readEnv: deps.env,
  claim,
  sink: (record) => console.log(JSON.stringify({ event: "market_report_shadow", ...record })),
  fetch: deps.fetch,
});
const outcome = await generateSharedAnalysis(input, shadow.requester, deps.now, records);
// ... complete_market_report_analysis と writeTraces が成功した後、応答を返す直前:
if (shadow.mode === "shadow" && deps.waitUntil) {
  deps.waitUntil(shadow.flush({ deadlineAtMs: startedAtMs + 150_000 }).catch(() => {}));
}
```

### G2 のパッチに要るテスト

1. off（mode 未設定）
   - 今の handler のテストが、変更なしですべて通る
   - Anthropic と台帳への fetch が 0
2. shadow
   - `complete_market_report_analysis` が、Anthropic と台帳へのどの fetch よりも先に呼ばれる
   - flush が終わる前に応答が返る
3. 失敗の経路（`outcome.ok === false`、例外、`DATA_PACKET_NOT_USABLE`、skip）では flush しない
4. `waitUntil` が無いときは flush しない
5. 締め切りが処理開始から計算されている
6. 既存の回帰（`market-report-analysis` 全体・`_shared`・モデル登録表のテスト）が通る

### 止める条件（衝突）

次の場合は、その場で止めて報告する。

- パッチの時点で、ほかの開いている PR が `handler.ts` に触れている
- G2 が requester の作り方、または claim の形を変えた
- #148 やこの PR が、変わった `ai_provider` のファイルの上に積み直しを必要とする

## 9. テスト（すべてオフライン。実 API・本番 0）

```sh
deno test --no-config --allow-env --allow-read supabase/functions/_shared/ai_provider/market_report_wiring_test.ts
```

鍵の環境変数を読み取り禁止にし、通信も禁止した状態でも 11 件すべて通る（本物の鍵・通信を使っていないことの確認）:

```sh
deno test --no-config --no-prompt --allow-env --deny-env=ANTHROPIC_API_KEY,OPENAI_API_KEY,SUPABASE_SECRET_KEYS,SUPABASE_SERVICE_ROLE_KEY,SUPABASE_URL,KABUMORI_MARKET_REPORT_AI_MODE,KABUMORI_MARKET_REPORT_SHADOW_MODEL --deny-net --allow-read=supabase/functions supabase/functions/_shared/ai_provider/market_report_wiring_test.ts
```

本物の `openAiRequester`・`generateSharedAnalysis`・リポジトリの朝刊／引け fixture を使う。通信はすべてテストの中の偽物に向かう。

- 偽 OpenAI
- 偽 Anthropic
- 偽の台帳（試験用ポリシーと「1試行1送信」を再現）
- それ以外の宛先はテスト失敗にする

11 件:

1. off と shadow で、配信される内容が今と同じ（朝刊 10/1・引け 9/30・引け 9/17 の3つ）
   - packet、content hash、diagnostics、OpenAI の使用量と費用、OpenAI への依頼のバイト列
   - off は今の requester そのもので、読む設定はモードだけ
   - shadow は生成中に送信 0、確定後に1回
2. 再生成した日
   - `last` は配信された生成だけを送る
   - `all` は両方を送る。呼び出し ID はそれぞれ別で、決まった値になる
3. `all` で1件目が時間を使い切ったら、2件目は送らない
4. 同じ claim の試行の再実行は、1回分しか払わない。次の試行は新しい呼び出しになる
5. 試験用の枠
   - 1日の7回目は `CALL_LIMIT`
   - 月 40 回で `CALL_LIMIT`
   - 月 $4.80 使用済みなら `COST_LIMIT`
   - どれも送る前に拒否され、レポートは影響を受けない
6. 確定後の失敗は shadow の中にとどまる
   - 台帳の認証拒否、Claude の 529 と 429
   - 時間切れ（残り時間に合わせて短くなり、上限額で確定する）
   - 送信中の取消、記録の例外
7. 時間が無い、事前の取消、OpenAI の失敗（400）と再試行（503 → 成功）、flush の2回目: どれも余分な送信 0
8. 設定が足りないときは off で、レポートも同じ
   - モデルが無い・OpenAI のモデル・キーが無い・台帳の設定が無い・https でない
   - cycle が無い、claim が無い
9. 記録にキーと本文が入らない。読む設定は5つだけ

ミューテーション（わざと壊した版）は 11/11 で検出した。

- off で別の関数を返す
- Fact も記憶する
- 生成中に送る
- 既定を `all` にする
- 時間の確認を外す、または1回だけにする
- flush を2回動かす
- 試行番号を固定する
- 取消の確認を外す
- 時間制限を短くしない
- 取消を渡さない

## 10. 残っていること（どれも別 TASK・別承認）

1. `handler.ts` への配線（G2）と、その中での `waitUntil` の確認
2. 回復処理の Cron（本番で使う前の必須条件）
3. Edge Secret `ANTHROPIC_API_KEY`（専用 workspace と spend limit）
4. カナリア（§6）。Opus の応答時間と時間切れの割合を測る
5. 毎日続ける場合は、ポリシーの見直し（別の本番変更）、または方式 C の検討
