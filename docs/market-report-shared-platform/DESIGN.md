# 市場レポート共通基盤 — 監査と設計（朝刊・大引け × X・アプリ）

- task_id: `market-report-shared-platform-design-audit-20260916`
- 作成: 2026-09-17、Claude slot 1（G1）
- 種別: **設計・監査のみ**。アプリのコード、Edge Function、DB、Cron、設定、ユーザー設定は一切変更していない
- 根拠: `origin/main` `84648cd` のソース ＋ 本番DB・Cron・Functionの read-only 確認 ＋ Yahoo公開チャートAPIの read-only 取得
- 本番バージョン（2026-09-17 read-only）: `x-test-post` v109、`personalized-reports` v13、`important-news-monitor` v54、`market-intelligence-ingest` v11、`market-intelligence-state-evaluator` v7、`send-push-notifications` v15
  - 注意: `x-test-post` v109 の本番ソースと `origin/main` の一致は、この設計タスクでは byte 比較していない。以下のコード引用は `origin/main` 基準

関連する既存設計:

- [docs/market-intelligence/ARCHITECTURE.md](../market-intelligence/ARCHITECTURE.md) — Market Intelligence Core（MIC）Phase 0
- [docs/market-intelligence/PHASE_1B_STATE_LAYER.md](../market-intelligence/PHASE_1B_STATE_LAYER.md) — MIC State層
- [docs/news-coverage/REDESIGN.md](../news-coverage/REDESIGN.md) — 重要ニュース収集・分類

---

## 0. 結論（先に要点）

1. **4経路は、市場データ・ニュース・AI処理をほとんど共有していない。** X朝刊・X大引けはそれぞれ独自に web_search で材料を集め、アプリの朝刊・大引けは Yahoo 日足と重要ニュースだけを使う。同じ日の同じ市場について、4回別々の「事実」が作られている。
2. **X大引けは構造的に毎日失敗している。** 9/14・9/15・9/16 の3営業日連続で `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE`。原因は「1分足の最終バーが 15:30 以降であること」を要求する判定で、Yahoo の1分足のタイムスタンプは**足の開始時刻**のため、日経平均の最終足は 15:29、1306 は 15:24 になり、条件を満たせない（§1.5）。タスク記載の「90分以内判定で 17:00:01 に stale」は、現行コードでは既に 16:45〜17:05 の窓で救済済みで、主因ではない。
3. **アプリ大引けが成功するのは日足（`interval=1d`）と `regularMarketTime` を使っているから。** 同じ Yahoo、同じ銘柄でも取得方法の差だけで成否が分かれている。
4. **X朝刊の成功率も低い。** 直近4営業日で成功は9/15の1回のみ（9/14 形式不正、9/16 OpenAI 429×3、9/17 Voice JSON 解析失敗）。
5. **費用の一部が記録されていない。** X大引けは Fact 不合格時に検索・収集の費用（1回あたり約 $0.03）を `close_report_runs` に書かない（直近3日の失敗分は `api_cost_usd = null`）。成功時も Voice rewrite 呼び出しの費用は合算されていない。
6. **推奨設計:** 「1サイクル（朝刊/大引け）につき市場分析を1回だけ作り、X・アプリ市場全体・アプリマイポートがそれを参照する」。データはコード取得（AI不使用）を正本にし、AIは説明文と構造化分析だけを担当。保存は「サイクル行＋不変 packet テーブル」（§9 案B）。
7. **費用はユーザー1人では大きく下がらない**（1営業日 約 $0.09 → 約 $0.03〜0.09。幅は web_search を既定0回で済ませられる日の割合で決まる、§10）。効果は、(a) 市場分析の費用がユーザー数に比例しない、(b) X と アプリが同じ事実を語る、(c) アプリに「市場全体」タブが追加費用なしで付く、(d) X の失敗が減る、の4点。
8. **最初の実装は共通基盤ではなく、X大引けの終値取得の修正＋失敗時費用の記録**を推奨（§13）。基盤の shadow 化より先に、毎日落ちている本番経路を直す方が価値が大きく、リスクも小さい。

---

## 1. 現行4経路の監査

### 1.1 起動タイミング（本番 read-only）

| 経路 | 起動 | 時刻（JST） | 根拠 |
|---|---|---|---|
| X朝刊 | `dispatch-scheduled-posts`（毎分）→ `x-test-post` → `claim_due_post()` | 08:18〜08:22（中心 08:20） | `morning_report_settings` |
| X大引け | 同上 | 16:58〜17:02（中心 17:00） | `close_report_settings`（`futures_target_time=15:45`） |
| アプリ朝刊 | `personalized-reports-morning` `35 23 * * 0-4`（UTC） | 08:35 | `cron.job` |
| アプリ大引け | `personalized-reports-close` `15 8 * * 1-5`（UTC） | 17:15 | `cron.job` |

`market_contexts` は X 側の `selectMarketContext()`（[index.ts:1146](../../supabase/functions/x-test-post/index.ts)）から読まれるが、本番の行数は **0**。実質未使用。

### 1.2 X朝刊（`generateMorningReport`、[index.ts:1548](../../supabase/functions/x-test-post/index.ts)）

```text
claim_due_post (morning_report)
  → generateMorningReport
      ├─ Lane A: OpenAI gpt-5.6-luna + web_search（米国市場）          … 1 call
      ├─ Lane B: OpenAI gpt-5.6-luna + web_search（マクロ・政策）       … 1 call
      ├─ Lane C: 補充（候補不足・publisher 偏り時のみ）                  … 0〜1 call
      │    上限 MAX_MORNING_SEARCH_CALLS = 3（morning_candidate_logic.ts:8）
      ├─ コード検証: 実際に開いたURLか / 許可ドメイン / 鮮度 / 因果の裏取り / publisher数
      ├─ evaluateMorningFacts（コード判定）
      └─ 執筆: OpenAI gpt-5.6-luna（Fact passed 時のみ）                 … 1 call
  → evaluateKabumoriVoice（gpt-5.6-luna、max 650 tokens）                … 1 call
      └─ 不合格なら rewrite ＋ 再 Voice                                  … 0〜2 call
  → 固定ハッシュタグ付与 → postToX
  → morning_report_runs へ保存
```

- **市場の数値を一切取得していない。** 米国3指数・SOX・日経先物は `blankMetric()` で空欄固定（[index.ts:1916-1927](../../supabase/functions/x-test-post/index.ts)）。執筆指示も「具体値は書かない」（index.ts:1884）。
- 材料はすべて web_search 由来。重要ニュース監視（`important_news_candidates`）や MIC（`market_metrics`）は参照していない。
- 米国休場判定・JPX営業日判定はコードで確定してから AI に渡している（良い設計、共通基盤でも踏襲）。

### 1.3 X大引け（`generateCloseReport`、[index.ts:2069](../../supabase/functions/x-test-post/index.ts)）

```text
claim_due_post (close_report)
  → generateCloseReport
      ├─ fetchJpxCloseMetrics（コード取得、live 時のみ）
      │    Yahoo ^N225 / 1306.T  range=5d interval=1m
      │    close_report_data_logic.ts:111
      ├─ 収集: OpenAI gpt-5.6-luna + web_search（max_tool_calls 4）      … 1 call（HTTP失敗時1回retry）
      │    3ポイント(today/next) / テーマ強弱 / 条件要因 / 明日への材料
      ├─ コード検証: URL実在 / 鮮度 / 因果 / today件数
      ├─ evaluateCloseFacts ＋ hasSameDayCloseData（日経・1306 の当日終値が必須）
      └─ 執筆: OpenAI gpt-5.6-luna（Fact passed 時のみ）                 … 1 call
  → Voice（HTTP系失敗時 retry あり）＋ rewrite ＋ 再 Voice               … 1〜3 call
  → postToX → close_report_runs
```

- **収集 web_search は終値チェックの前に実行される。** 終値が取れない日も約 $0.03 を使ってから失敗する。
- 失敗時の保存（[index.ts:4230-4257](../../supabase/functions/x-test-post/index.ts)）は `input_tokens` / `output_tokens` / `web_search_calls` / `api_cost_usd` を書かない。記録は本文が生成された `if (draft.text)` の分岐のみ（index.ts:4127）。
- 執筆指示は「日経平均・1306 の具体値は書かない」（index.ts:2340）。**終値は Fact の関門にだけ使われ、本文には出ない。**

### 1.4 アプリ朝刊・大引け（`personalized-reports`）

```text
cron → personalized-reports {mode}
  ├─ market_holidays で JPX 営業日判定（大引けは 15:30 前なら skip）
  ├─ tracked_stocks（全ユーザー分、MAX_USERS_PER_RUN まで）
  ├─ Yahoo chart range=1mo interval=1d
  │    全ユーザーの銘柄の和集合 ＋ ^N225 ＋ 1306.T（並列、index.ts:182-205）
  └─ ユーザーごとに:
       ├─ personalized_reports を claim（user_id, report_type, trading_date で一意）
       ├─ rpc personalized_report_news_inputs（重要ニュースの app copy 済み行を再利用）
       ├─ buildSnapshot（損益・相対成績・業種比率をコード計算）
       ├─ buildPacket
       ├─ draft: gpt-5.6-luna（max 4000）                                … 1 call
       ├─ localReportIssues（数字は packet 由来のみ / ISO日付 / 英単語 / 助言 / 複数日語）
       ├─ fact: gpt-5.6-luna（max 1200）                                 … 1 call
       ├─ Fact 不合格 → failed で終了（**再生成なし**）
       └─ completed → enqueue_personalized_report_notification
```

- **朝刊は「前営業日の終値」だけ。** 米国市場・SOX・為替・金利・先物は入力にない。前夜の海外の動きを説明できない。
- 市場全体の記述は `indices`（日経平均・1306）の値動きに限定する指示（report_logic.ts:574）。
- ニュースは `important-news-monitor` が作った日本語コピーを再利用しており、**本文を再度AIへ送らない設計は既に実現**している（共通基盤でも踏襲する）。
- Push の重複防止と通知設定判定は SQL 側（`enqueue_personalized_report_notification`）。

### 1.5 9/15 の「X大引けは失敗 / アプリ大引けは成功」の構造差

| | X大引け（17:00） | アプリ大引け（17:15） |
|---|---|---|
| 取得 | `range=5d&interval=1m` | `range=1mo&interval=1d` |
| 当日終値の判定 | 最後の非null 1分足の**足時刻**が 15:30 以降 | `meta.regularMarketTime` が当日かつ 15:30 以降、日足に当日行がある |
| 9/15 の実データ | 日経 最終足 **15:29**、1306 最終足 **15:24** → 不合格 | 日足に 9/15 行あり、`regularMarketTime` 当日 → 合格 |
| 結果 | `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE` | `completed / passed`、Push sent |

Yahoo 公開チャートAPIの read-only 確認（2026-09-17 取得、`range=5d&interval=1m`）:

| 日付 | ^N225 最終1分足 | 1306.T 最終1分足 | 15:30 条件 |
|---|---|---|---|
| 09-10 | 15:29 | 15:24 | 不合格 |
| 09-11 | 15:29 | 15:24 | 不合格 |
| 09-14 | 15:29 | 15:24 | 不合格 |
| 09-15 | 15:29 | 15:24 | 不合格 |
| 09-16 | 15:30（後から追加された足） | 15:30（同） | 合格（ただし 17:00 の実行時点では無かった） |

- 1分足は「その分の開始時刻」で刻まれる。15:25〜15:30 はクロージング・オークションのため 1306 は 15:24 の足が最後になる。
- 9/16 の 15:30 足は後から付与されたもの。本番の 9/16 17:00 実行は失敗しているので、17:00 時点では存在しなかったと判断できる（**時刻の確定は未検証**）。
- 以前の成功例（9/9 16:00）は、web_search が返した日経記事の値で代替できていた時期のもの。現在は live で AI 由来の値を採用しない（index.ts:2252-2261）ため、コード取得が唯一の経路になり、判定の欠陥が表面化した。

**共通基盤での扱い:** 当日終値は **日足＋`regularMarketTime`** を正本とし、1分足は使わない。鮮度は「経過分数」ではなく「取引日の一致」と「セッション終了後の観測」で判定する（§6.3）。

### 1.6 直近の実行結果（本番 read-only、2026-08-27〜09-17）

| 経路 | 成功 | 失敗 | 備考 |
|---|---|---|---|
| X朝刊 | 4 | 25 | 失敗には開発期間を含む。9/14 以降は 4日中1日のみ成功 |
| X大引け | 1 | 14 | 9/14・9/15・9/16 は全て終値取得不能 |
| アプリ朝刊 | 2 | 2 | 9/14 Fact 不合格、ほか1件は Phase 1B 初期 |
| アプリ大引け | 3 | 1 | 9/14 Fact 不合格 |

X朝刊の直近の失敗要因: `MORNING_REPORT_FORMAT_INVALID`（9/14）、`MORNING_REPORT_LANE_A_US_MARKET_FAILED:429` ×3（9/16、OpenAI レート制限）、`VOICE_EVALUATION_JSON_PARSE_FAILED`（9/17、Fact は passed）。

---

## 2. 重複マトリクス

### 2.1 データ取得

| データ | X朝刊 | X大引け | アプリ朝刊 | アプリ大引け | MIC | 重要ニュース監視 |
|---|---|---|---|---|---|---|
| 日経平均 | — | Yahoo 1分足 | Yahoo 日足（前日） | Yahoo 日足（当日） | — | — |
| TOPIX（1306 代替） | — | Yahoo 1分足 | Yahoo 日足 | Yahoo 日足 | — | — |
| グロース250 | — | web_search（任意） | — | — | — | — |
| 日経先物 | 空欄固定 | web_search（任意） | — | — | — | — |
| 米国3指数・SOX | 空欄固定（方向感は web_search 記事） | — | — | — | — | — |
| 為替 | web_search 記事 | web_search 記事 | — | — | `fx` 未取得 | — |
| 米金利 | web_search 記事 | web_search 記事 | — | — | **FRED US2Y/US10Y** | — |
| 日本国債 | — | — | — | — | **MOF JGB2Y/10Y** | — |
| 原油 | web_search 記事 | web_search 記事 | — | — | **EIA WTI/Brent** | — |
| 個別銘柄の価格 | — | — | Yahoo 日足 | Yahoo 日足 | — | — |
| 市場ニュース | web_search（Lane A/B/C） | web_search | 重要ニュース（app copy） | 重要ニュース（app copy） | — | 収集・分類・和訳済み |
| TDnet・企業IR | web_search（許可ドメイン） | web_search | 重要ニュース | 重要ニュース | — | **TDnet 取得済み** |

太字は「既にシステム内に構造化されて存在するのに、レポートが使っていない」もの。

### 2.2 AI 処理（1サイクルあたり）

| 処理 | X朝刊 | X大引け | アプリ（1ユーザー） |
|---|---|---|---|
| 材料収集（web_search付き） | 2〜3 | 1（検索2〜4回） | 0 |
| 執筆 | 1 | 1 | 1（draft） |
| Fact（AI） | 0（コード判定） | 0（コード判定） | 1 |
| Voice | 1〜2 | 1〜2（HTTP retry別） | 0 |
| rewrite | 0〜1 | 0〜1 | 0 |
| 再生成 | なし | なし | **なし** |

### 2.3 重複している具体的な仕事

1. **同じ日本市場を X大引け とアプリ大引けで2回取得**（17:00 と 17:15、方法違いで結果も違う）。
2. **市場の「なぜ動いたか」を X だけが web_search で作り、アプリは作れない。** アプリ大引けは「理由を推測しない」指示のため、市場全体の説明が薄い。
3. **ニュースを X は web_search で別取得、アプリは重要ニュース監視から取得。** 同じ TDnet 開示を X は検索し直している。
4. **米金利・原油は MIC が公式ソースから取得済みなのに、X は記事から方向感を拾っている。**
5. **営業日・休場判定が3か所**（X の `plan_*` / `JpxTradingDayState`、`personalized-reports` の `isTradingDay`、MIC の cron 条件）。

### 2.4 共通化すべき処理 / 用途別に残す処理

| 共通化する | 用途別に残す |
|---|---|
| 営業日・休場・米国セッション日付の確定 | X の文体（かぶモリ Voice）、固定ハッシュタグ、X 文字数 |
| 指数・為替・金利・商品の数値取得と鮮度判定 | X の投稿・publish claim・再投稿防止 |
| 市場ニュース・TDnet の参照（重要ニュース監視の結果を使う） | アプリのユーザー別ポートフォリオ計算 |
| 「今日の市場で何が起きたか・なぜか」の分析（1回） | アプリの Push enqueue と通知設定判定 |
| 出典・時刻・因果の強さの検証（コード） | ユーザー別の Fact（ポートフォリオ記述の検証） |

---

## 3. 目標アーキテクチャ

```mermaid
flowchart TD
  subgraph Sources[既存の取得元]
    Y[Yahoo 日足<br/>指数・ETF・為替・米指数]
    MIC[MIC market_metrics<br/>FRED / MOF JGB / EIA]
    INM[important_news_candidates<br/>分類・app copy 済み]
    CAL[market_holidays<br/>US session 判定]
  end

  subgraph Cycle[市場レポートサイクル（朝刊/大引けごとに1回）]
    D[market_data_packet<br/>コードのみ・AIなし・不変]
    G[材料の補完 web_search<br/>不足時のみ 0〜1 call]
    R[market_report_packet<br/>分析 1 call ＋ コード検証<br/>＋ Fact 1 call]
  end

  Y --> D
  MIC --> D
  INM --> D
  CAL --> D
  D --> G
  D --> R
  G --> R

  R --> XS[X要約<br/>軽量変換 1 call ＋ Voice]
  R --> AM[アプリ「市場全体」<br/>追加AIなし・packetをそのまま表示]
  R --> PR[アプリ「マイポート」<br/>ユーザー差分のみ draft＋Fact]
  D --> PR

  XS --> X[(X 投稿)]
  PR --> PUSH[(Push)]
```

### 3.1 時刻設計

| サイクル | packet 作成開始 | 再試行の締切 | X 消費 | アプリ消費 |
|---|---|---|---|---|
| 朝刊 | 07:50 | 08:15 | 08:20 | 08:35 |
| 大引け | 16:15（日足・`regularMarketTime` 確定後） | 16:50 | 17:00 | 17:15 |

- packet を先に作ることで、X の投稿時刻に外部 API 失敗が重なっても、**再試行の余裕（25〜35分）**を持てる。
- 大引けの 16:15 は、Yahoo の日足と `regularMarketTime` が 15:30〜15:45 に確定する実データ（9/16: ^N225 15:45、1306.T 15:30）に基づく。**毎日の確定時刻の分布は未計測**のため、Phase 0 で計測する（§12）。
- X とアプリは packet が無い・Fact 不合格なら**投稿しない / 市場全体タブを出さない**（fail-closed）。

---

## 4. `market_data_packet` スキーマ案

「事実の正本」。AIは一切書かない。値と説明文を混ぜない。

```jsonc
{
  "schema_version": "market_data_packet.v1",
  "report_type": "morning",               // morning | close
  "trading_date": "2026-09-17",           // JPX 取引日（朝刊は当日、大引けは当日）
  "as_of": "2026-09-16T23:05:00Z",        // この packet が表す時点
  "generated_at": "2026-09-16T23:05:12Z",
  "session": {
    "jpx_trading_day": true,
    "us_session_date": "2026-09-16",      // 朝刊のみ。コード確定
    "us_previous_night_closed": false,
    "us_closure_name": null
  },
  "metrics": [
    {
      "key": "nikkei225",                 // 固定キー
      "label_ja": "日経平均",
      "kind": "index",                    // index | proxy_etf | fx | rate | commodity | futures
      "is_proxy": false,
      "proxy_of": null,
      "value": 63923.0,
      "previous_close": 63611.84,
      "change": 311.16,                   // コード計算
      "change_percent": 0.49,             // コード計算
      "unit": "円",
      "session_date": "2026-09-16",       // 値が属する取引日
      "observed_at": "2026-09-16T06:45:00Z",
      "fetched_at": "2026-09-16T23:05:03Z",
      "provider": "yahoo_chart",
      "source_url": "https://query2.finance.yahoo.com/v8/finance/chart/%5EN225?range=1mo&interval=1d",
      "freshness": "fresh",               // fresh | stale | unavailable
      "quality": "delayed_unofficial",    // official | delayed_unofficial | proxy
      "gap_reason": null                  // unavailable 時: fetch_failed | not_yet_published | no_source
    },
    {
      "key": "topix_proxy_1306",
      "label_ja": "TOPIX連動ETF（1306）",
      "kind": "proxy_etf",
      "is_proxy": true,
      "proxy_of": "TOPIX"
      // ...
    }
  ],
  "sectors": {                            // 取得元が確定するまでは status のみ
    "status": "unavailable",
    "gap_reason": "no_source",
    "items": []
  },
  "news_refs": [
    {
      "ref_id": "news:9a1c…",             // important_news_candidates.id
      "kind": "market",                   // market | company | tdnet
      "coverage_severity": "high",
      "coverage_categories": ["geopolitics", "shipping_logistics"],
      "emergency_class": null,
      "company_code": null,
      "headline_ja": "…",                 // app copy 済みのみ。原文は持たない
      "published_at": "…",
      "source_url": "…",
      "fact_check_status": "passed"
    }
  ],
  "macro_state_refs": [                   // MIC market_state_current の参照（AI解釈は別枠）
    { "domain": "rates", "as_of": "…", "fact_status": "ai_interpretation", "data_confidence": 0.6 }
  ],
  "event_calendar": [],                   // 取得元未確定。Phase 1 は空で status を明記
  "data_quality": {
    "required_missing": [],               // 必須項目の欠落（あれば packet は blocked）
    "optional_missing": ["growth250", "nikkei_futures"],
    "proxy_labels": ["topix_proxy_1306"],
    "status": "ok"                        // ok | partial | blocked
  },
  "lineage": {
    "code_version": "git sha",
    "inputs_hash": "sha256 of normalized metrics + news ref ids"
  }
}
```

### 4.1 必須・任意

| 項目 | 朝刊 | 大引け | 取得元案 | 状態 |
|---|---|---|---|---|
| 日経平均 | 前営業日終値（任意） | **当日終値（必須）** | Yahoo `^N225` 日足 | 実績あり（アプリ） |
| TOPIX（1306代替） | 任意 | **必須** | Yahoo `1306.T` 日足、ラベル固定 | 実績あり（アプリ） |
| 米3指数・SOX | **必須（うち2つ以上）** | 任意 | Yahoo `^DJI` `^GSPC` `^IXIC` `^SOX` 日足 | **未検証**（銘柄の実在・時刻は Phase 0 で確認） |
| ドル円 | 必須 | 必須 | Yahoo `JPY=X` | **未検証** |
| 米金利 | 任意 | 任意 | MIC `US2Y` `US10Y`（FRED） | 取得中 |
| 日本国債 | 任意 | 任意 | MIC `JGB2Y` `JGB10Y`（MOF） | 取得中 |
| 原油 | 任意 | 任意 | MIC `WTI` `BRENT`（EIA、日次遅延あり） | 取得中 |
| グロース250 | — | 任意 | 信頼できる取得元なし | **未解決**（§14） |
| 日経先物 | 任意 | 任意 | 信頼できる取得元なし（現行も空欄） | **未解決** |
| 業種別騰落 | — | 任意 | 取得元なし（東証業種別指数は未調査） | **未解決** |
| 市場ニュース・TDnet | 任意 | 任意 | `important_news_candidates` | 取得中 |

「必須」が欠けた packet は `data_quality.status = blocked` とし、分析を作らない。

### 4.2 Yahoo 以外への移行余地

Yahoo チャートAPIは公式の提供契約がない非公式エンドポイントで、`^TPX` が CBOE の別銘柄に化けていた前例がある（close_report_data_logic.ts:78-84）。`provider` と `quality` を metric 単位に持たせ、**取得元を差し替えても packet の形を変えない**ことを最優先にする。MIC の `mic_source_registry` に Yahoo を登録し、`market_metrics` に保存する案（§9.3）を推奨。

---

## 5. `market_report_packet` スキーマ案

`market_data_packet` を根拠にした、1回の分析結果。アプリ「市場全体」はこれをそのまま表示する。

```jsonc
{
  "schema_version": "market_report_packet.v1",
  "report_type": "close",
  "trading_date": "2026-09-16",
  "data_packet_id": "uuid",                     // 根拠の packet（不変）
  "generated_at": "…",
  "model": "gpt-5.6-luna",
  "headline_ja": "…",                            // 40字以内
  "market_summary_ja": "…",                      // 200〜400字
  "major_moves": [                               // 数値は data packet の key 参照のみ
    { "metric_key": "nikkei225", "note_ja": "…", "evidence_refs": ["metric:nikkei225"] }
  ],
  "claims": [                                    // 「なぜ動いたか」はすべてここ
    {
      "claim_id": "c1",
      "text_ja": "…",
      "claim_type": "reported_cause",            // observation | reported_cause | consistent_with | watch_point
      "evidence_refs": ["news:9a1c…", "metric:usdjpy"],
      "confidence": "medium",                    // high | medium | low
      "scope": "today"                           // today | overnight | next
    }
  ],
  "strong_sectors": [ { "name_ja": "…", "claim_ids": ["c2"] } ],
  "weak_sectors": [],
  "strong_themes": [],
  "weak_themes": [],
  "key_news": [ { "ref_id": "news:…", "why_it_matters_ja": "…", "claim_ids": [] } ],
  "macro_policy_geopolitics": [ { "claim_ids": ["c3"] } ],
  "overseas_to_japan_effects": [ { "claim_ids": ["c4"] } ],   // 朝刊中心
  "next_session_watch": [ { "text_ja": "…", "evidence_refs": [] } ],
  "risks": [ { "text_ja": "…", "evidence_refs": [] } ],
  "event_calendar": [],
  "data_gaps_ja": ["グロース250は取得できませんでした"],
  "fact": {
    "local_status": "passed",                    // コード検証
    "ai_status": "passed",                       // Fact AI
    "issues": [],
    "attempts": 1                                // 再生成回数（上限 2）
  },
  "usage": { "calls": 2, "input_tokens": 0, "output_tokens": 0, "web_search_calls": 0, "cost_usd": 0 }
}
```

### 5.1 大引けの「なぜ今日この値動きになったか」

- `major_moves` は **数値の事実だけ**（コードで data packet から生成してよい。AI 不要）。
- 理由は `claims` に分離し、`reported_cause` は**出典が理由として明記しているもの**に限定。出典がない共起は `consistent_with` にし、本文で「〜と同じ日に〜が出ています」と書かせる。
- `evidence_refs` が空の `reported_cause` はコード検証で落とす。
- 指数羅列を避けるため、`claims` のうち `today` かつ `reported_cause | consistent_with` が1件以上ない場合は `market_summary_ja` を「材料が確認できない日」の定型文に切り替える（無理に理由を作らない）。

### 5.2 web_search の位置づけ

- 既定は **0 回**。重要ニュース監視の結果と data packet で分析する。
- `news_refs` が「今日」の市場ニュースを0件しか持たない、または必須の米国材料が無い場合だけ、補完の web_search を **1回** 許可する（現行 X朝刊の Lane C と同じ考え方）。
- 補完で得た材料も「実際に開いた URL」検証（`collectMorningWebSourceUrls` / `isAllowedMorningUrl`）を再利用して `news_refs` 相当の形に正規化してから分析へ渡す。

---

## 6. Fact / 因果の安全モデル

### 6.1 三層

| 層 | 誰が | 何を |
|---|---|---|
| L1 データ | コード | 数値・日付・鮮度・代替ラベル。AI は数値を**生成しない**（key 参照のみ） |
| L2 構造 | コード | `evidence_refs` の実在、`reported_cause` の出典要件、未来情報の混入、禁止語、数値トークンが packet 由来か（`allowedNumbers` / `unknownNumbers` を移植） |
| L3 意味 | Fact AI 1 call | 本文が claims の強さを超えていないか（「影響した」と断定していないか等） |

### 6.2 再生成

- L2 または L3 不合格時、**不合格理由を添えて1回だけ再生成**（計 2 attempts）。現行アプリの「再生成なし」と、X の「Voice rewrite のみ」を統一する。
- 2回目も不合格なら packet は `failed`。X は投稿しない、アプリは「市場全体」を出さない（マイポートは data packet のみで生成可、§7.4）。

### 6.3 鮮度

- 大引けの必須値は「`session_date == trading_date` かつ `observed_at` が 15:30 JST 以降」。**経過分数では判定しない。**
- 朝刊の米国値は `session_date == us_session_date`（コード確定）。休場日は前営業日の値に `previous_session` ラベルを付ける。
- 任意値は `fresh / stale / unavailable` を付けて残し、stale は本文で使わない（表示では「◯日時点」と明記）。

### 6.4 9/14 朝刊の未根拠表現の防止

9/14 アプリ朝刊の不合格理由は「指数の値動きが保有銘柄に影響する可能性」という、packet にない因果。設計上は:

- ポートフォリオ側 AI には「指数と銘柄の関係」を**自由記述させない**。§7.2 の `portfolio_effect` をコードで作り、AI はそれを文にするだけ。
- 指数と銘柄を同じ文で結ぶ表現は `market_effect` がある場合に限定し、L2 で「indices の label と銘柄名が同一文にあり、対応する effect が無い」場合を検出する。

---

## 7. ポートフォリオ分析 contract

### 7.1 入力

```jsonc
{
  "market_data_packet_id": "uuid",
  "market_report_packet_id": "uuid | null",     // Fact 不合格なら null（マイポートは作れる）
  "user_id": "uuid",
  "portfolio_snapshot": { /* 現行 buildSnapshot の出力を踏襲 */ },
  "positions": [
    { "ticker": "4751", "sector": "サービス業", "tracking_type": "holding",
      "quantity": 100, "average_price": 1800, "position_type": "margin", "side": "long" }
  ],
  "company_news_refs": ["news:…"],               // personalized_report_news_inputs を踏襲
  "sector_theme_map": "important_news_theme_sectors の結果"
}
```

### 7.2 コードで作る `portfolio_effect`（AI なし）

```jsonc
{
  "ticker": "4751",
  "day_change_percent": -2.1,
  "benchmark_key": "topix_proxy_1306",
  "relative_move_pt": -2.6,                      // 銘柄 − ベンチマーク
  "market_effect": { "status": "consistent_with", "note_key": "same_direction_as_benchmark" },
  "sector_effect": { "status": "insufficient_evidence" },   // 業種別指数の取得元が無い間は固定
  "company_news_effect": { "status": "reported", "refs": ["news:…"] },
  "fx_effect": { "status": "insufficient_evidence" },
  "theme_effect": { "status": "consistent_with", "claim_ids": ["c4"] },   // market_report の claim 参照
  "confidence": "low"
}
```

- `status`: `reported`（出典が明記） / `consistent_with`（同方向・同時期に確認できるだけ） / `insufficient_evidence` / `not_applicable`。
- **`causal` は使わない。** 出典が「A が理由で B が動いた」と書いていても、ポートフォリオ単位では `reported` とし、本文も「〜と報じられています」に留める。

### 7.3 出力

現行 `personalized_reports.body` を拡張し、互換を保つ:

| 現行 | 拡張 |
|---|---|
| `overview_ja` / `stock_notes` / `watch_notes` / `risk_notes_ja` / `checkpoints_ja` | そのまま |
| — | `contributors`: 上位プラス/マイナス寄与（コード計算） |
| — | `holding_effects`: §7.2 の配列 |
| — | `leverage_cautions_ja`: 信用・空売りポジションがある場合のみ（コード判定＋定型文） |
| — | `market_report_packet_id` |

### 7.4 市場分析が無い日

`market_report_packet` が failed でも、マイポートは data packet と会社ニュースだけで作る（現行と同等）。`theme_effect` は全て `insufficient_evidence`。

### 7.5 ユーザー数に比例させない

- ユーザーへ渡す市場情報は、market_report_packet の **headline・summary・関係する claim だけ**（そのユーザーの保有業種・テーマに一致する claim を SQL/コードで選ぶ）。全文は渡さない。
- 1ユーザーあたり入力は現行の約 5,000 tokens から **+1,000〜1,500 tokens 程度**の増加に抑える（見積もり、未計測）。

---

## 8. アプリ表示仕様

### 8.1 構成

```text
┌──────────────────────────────────────┐
│ 大引け 9月16日（水）                       │
│ [ 市場全体 ]  [ マイポート ]                 │  ← セグメント切替。既定はマイポート
└──────────────────────────────────────┘
```

- 既定タブは「マイポート」。Push から開いた時の期待（自分の結果）を優先する。**要ユーザー判断**（§14）。
- `market_report_packet` が無い日は「市場全体」タブを出さず、マイポートのみ（現行と同じ見た目）。

### 8.2 市場全体

| 区画 | データ | 追加AI |
|---|---|---|
| 見出し・要約 | `headline_ja` / `market_summary_ja` | なし |
| 指標カード（指数・為替・金利・商品） | data packet `metrics`（代替ラベル・鮮度を表示） | なし |
| 主な値動きと理由 | `major_moves` ＋ `claims`（`claim_type` に応じた言い回しバッジ: 「報道」「同時期に確認」） | なし |
| 強かった/弱かった業種・テーマ | `strong_*` / `weak_*` | なし |
| 重要ニュース・開示 | `key_news` → 既存ニュース詳細画面へ遷移 | なし |
| リスク・次に見る点 | `risks` / `next_session_watch` | なし |
| 取得できなかったデータ | `data_gaps_ja` | なし |

### 8.3 マイポート

現行 [src/app/reports/[id].tsx](../../src/app/reports/%5Bid%5D.tsx) の区画をほぼ流用する:

| 現行区画 | 扱い |
|---|---|
| 指数カード・保有の今日の損益・評価額・市場との比較 | 流用 |
| 今日のポート総括 / 見通し | 流用（市場全体への一行リンクを追加） |
| 上昇・下落に効いた保有銘柄 | `contributors` に置換 |
| 保有銘柄の値動きと材料 | `holding_effects` のバッジを追加 |
| 監視銘柄・業種バランス・気をつけたい点・市場ニュース・チェックポイント | 流用 |
| — | 信用・空売りの注意（該当時のみ） |

### 8.4 データ取得（アプリ）

- `personalized_reports` は現行どおり RLS で本人行のみ。
- `market_report_packets` は**ユーザー固有情報を含まない**ため、`authenticated` に `fact.ai_status = 'passed'` の行だけ読める RLS を付ける。data packet は直接公開せず、表示に必要な `metrics` は report packet 側に**コピーではなく view** で出す案を推奨（§9.2）。

---

## 9. DB 保存形式

### 9.1 比較

| 観点 | A. 1テーブル＋jsonb | B. サイクル表＋不変 packet 表 | C. 現行 report テーブル拡張 |
|---|---|---|---|
| 版管理 | 行の上書きで失われやすい | packet ごとに新行。サイクル行が現行版を指す | 消費者ごとにコピーが増える |
| 不変の根拠 | 保証しにくい | insert-only（update 禁止の権限） | 保証できない |
| 再試行・冪等 | サイクル一意にすると再試行の履歴が消える | `(report_type, trading_date)` 一意のサイクル行＋packet は attempt ごと | 既存の claim と二重管理 |
| 朝刊/大引けの一意性 | 可能 | サイクル行で保証 | テーブルごとに別々 |
| 由来の追跡 | jsonb 内のみ | FK（report → data、personalized → report） | 困難 |
| アプリ読み出し速度 | 良い | 良い（サイクル行の現行版 id で1行取得） | 良い |
| X の参照 | 可能 | FK で参照 | X と アプリで別テーブル |
| スキーマ変更 | `schema_version` で可能 | 同左 | テーブルごとに移行 |
| ロールバック | 難しい（上書き） | サイクル行の参照先を戻すだけ | 列追加の巻き戻し |
| 容量 | 小 | 中（1日 2サイクル × 数 attempt × 数十KB） | 大（ユーザー数 × コピー） |

### 9.2 推奨: B

```text
market_report_cycles
  id uuid pk
  report_type text check (morning, close)
  trading_date date
  status text  -- pending | data_ready | report_ready | failed | skipped
  current_data_packet_id uuid fk
  current_report_packet_id uuid fk null
  attempts int
  last_error text
  unique (report_type, trading_date)

market_data_packets            -- insert-only
  id uuid pk
  cycle_id uuid fk
  attempt int
  payload jsonb                -- §4
  data_quality_status text
  inputs_hash text
  created_at timestamptz

market_report_packets          -- insert-only
  id uuid pk
  cycle_id uuid fk
  data_packet_id uuid fk
  attempt int
  payload jsonb                -- §5
  local_fact_status text
  ai_fact_status text
  model text, input_tokens int, output_tokens int, web_search_calls int, api_cost_usd numeric(12,6)
  created_at timestamptz

-- 既存テーブルへの追加（nullable、互換維持）
personalized_reports.market_report_packet_id uuid fk null
morning_report_runs.market_report_packet_id  uuid fk null
close_report_runs.market_report_packet_id    uuid fk null
```

- A を退ける理由: 再試行・Fact 不合格の履歴と「どの根拠でどの文が出たか」を失う。
- C を退ける理由: 同じ市場分析を X 用とユーザー数分コピーすることになり、「ユーザー数に比例しない」目標に反する。
- 権限: 書き込みは service_role のみ。`market_report_packets` は authenticated に passed 行のみ select。`market_data_packets` は admin のみ。

### 9.3 MIC との関係

- 指数・為替の日足は MIC `market_metrics` に保存し（`provider = yahoo_chart`、`quality_tier = delayed_unofficial`）、data packet は MIC から**組み立てる**。こうすると取得の失敗・再試行・鮮度判定が MIC の既存の仕組み（`mic_ingestion_runs`、`mic_metric_domain_map.observation_stale_after_minutes`）に乗る。
- MIC `mic_source_registry` の全行が本番で `is_active = false` になっている一方、ingest Cron は稼働して `market_metrics` に行がある。**この不一致は未確認**（MIC 側の担当確認が必要、§14）。

---

## 10. 費用 before / after

### 10.1 単価（コード記載値）

- `gpt-5.6-luna`: 入力 $0.2 / 出力 $1.2（100万 tokens あたり）
- web_search: 1回 $0.01（`morningApiCostUsd`、index.ts:705）

### 10.2 Before（本番の保存値、2026-08-27〜09-17）

| 経路 | 呼び出し（成功時） | 平均 入力/出力 tokens | 平均 web_search | 記録費用（平均） |
|---|---|---|---|---|
| X朝刊 | 収集2〜3 ＋ 執筆1 ＋ Voice 1〜2 | 41,726 / 4,865 | 2.5 | $0.039（成功、Voice込み） |
| X大引け | 収集1 ＋ 執筆1 ＋ Voice 1〜3 | 29,836 / 3,339 | 4.0 | $0.050（成功1件のみ、Voice込み） |
| アプリ朝刊 | draft 1 ＋ Fact 1 | 5,056 / 934 | 0 | $0.0021 / ユーザー |
| アプリ大引け | draft 1 ＋ Fact 1 | 5,487 / 1,167 | 0 | $0.0025 / ユーザー |

注意:

- X の成功時の記録費用は「収集＋執筆＋Voice 評価（1回目と最終回）」を合算している（index.ts:4000-4006、4185-4190）。**rewrite 呼び出しの費用は合算されていない**（`attemptCloseReportVoiceRewrite` は費用を返すが呼び出し側で加算していない）。rewrite は luna 1回で $0.001〜0.003 程度（見積もり）。
- **X大引けの失敗時費用は未記録。** 9/14〜9/16 は収集呼び出し（約 $0.03）が実行されたが `api_cost_usd = null`。

1営業日あたり（ユーザー数 N）:

| | N=1 | N=10 | N=100 | N=1,000 |
|---|---|---|---|---|
| X朝刊＋X大引け | 約 $0.08〜0.09 | 同左 | 同左 | 同左 |
| アプリ（朝＋大引け） | $0.0046 | $0.046 | $0.46 | $4.6 |
| 合計 | **約 $0.09** | 約 $0.13 | 約 $0.55 | 約 $4.7 |

※ アプリは MAX_USERS_PER_RUN と時間予算で打ち切られるため、現行実装のまま 1,000 ユーザーは処理できない（別課題）。

### 10.3 After（見積もり、未計測）

1サイクルあたり:

| 処理 | 呼び出し | 見積もり |
|---|---|---|
| data packet | AI 0、HTTP（Yahoo 日足 6〜8 銘柄＋MIC 読み出し） | $0 |
| 補完 web_search | 0〜1（不足日のみ） | $0〜0.02 |
| 市場分析 | luna 1（入力 15,000〜25,000 / 出力 2,000〜3,500） | $0.006〜0.009 |
| Fact AI | luna 1（再生成時 +2） | $0.002〜0.006 |
| X 要約 | luna 1（入力 3,000〜5,000 / 出力 600〜900）＋ Voice 1〜2 | $0.003〜0.006 |
| アプリ市場全体 | 0 | $0 |
| マイポート | ユーザーごと draft 1 ＋ Fact 1（入力 +1,000〜1,500） | $0.0025〜0.003 / ユーザー |

1営業日あたり（2サイクル）:

| | N=1 | N=10 | N=100 | N=1,000 |
|---|---|---|---|---|
| 共通（分析＋X） | 約 $0.02〜0.08 | 同左 | 同左 | 同左 |
| マイポート | $0.005〜0.006 | $0.05〜0.06 | $0.5〜0.6 | $5〜6 |
| 合計 | **約 $0.03〜0.09** | 約 $0.07〜0.14 | 約 $0.52〜0.68 | 約 $5.0〜6.1 |

読み方:

- **web_search を既定0回にできるかが費用の大半を決める。** 現行 X の費用の約 2/3 は検索（$0.025〜0.04）。重要ニュース監視の結果で足りる日が多ければ下がり、足りない日は現行並み。
- **マイポートはユーザー当たり 1〜2割増える**（市場の文脈を渡すため）。それでも市場分析はユーザー数に比例しない。
- ユーザー1人の今は「同程度〜やや安い」。効果は費用より、成功率・一貫性・アプリ市場全体の追加。

---

## 11. 段階移行計画

big-bang は行わない。各 Phase は単独でロールバックできる。

### Phase 0 — 現行経路の修正と計測（共通基盤とは独立）

| 項目 | 内容 |
|---|---|
| 変更 | (1) X大引けの終値取得を日足＋`regularMarketTime` に変更（`close_report_data_logic.ts`）(2) X大引けの失敗時にも tokens・検索回数・費用を記録し、rewrite の費用も合算（index.ts）(3) 終値の判定を収集 web_search **より前**に行い、取れない日は検索しない (4) 日足・`regularMarketTime` の確定時刻を毎営業日ログに残す |
| 触るもの | `x-test-post` のみ。DB 変更なし |
| リスク | 中（本番 X 投稿経路）。ただし現状は毎日失敗しているため、悪化の余地は小さい |
| テスト | 実データ（9/10〜9/16 の Yahoo 応答）を fixture にした単体テスト。1分足 15:29 / 15:24 で失敗していた日が日足で成功すること。前場値・前日値を当日終値と誤認しないこと |
| ロールバック | 前バージョンを再 deploy |
| 費用効果 | 終値が無い日の検索費（約 $0.03/日）を削減。費用の記録漏れ解消 |

### Phase 1 — `market_data_packet` を shadow 生成

| 項目 | 内容 |
|---|---|
| 変更 | migration（§9.2 の3テーブル、既存テーブル変更なし）。新 Function（または MIC ingest の拡張）で 07:50 / 16:15 に data packet を作るだけ。消費者なし |
| 触るもの | 新テーブル、新 Cron 2本、MIC に Yahoo ソース登録 |
| リスク | 低（既存経路に影響なし） |
| テスト | 2週間、X・アプリが実際に使った値との一致率を日次比較（日経・1306 は完全一致を期待） |
| ロールバック | Cron 停止。テーブルは残してよい |
| 費用効果 | $0（AI なし） |

### Phase 2 — `market_report_packet` を shadow 生成

| 項目 | 内容 |
|---|---|
| 変更 | 分析 1 call ＋ L2 ＋ Fact 1 call（再生成1回）。結果は保存のみ |
| 触るもの | 新 Function、`market_report_packets` |
| リスク | 低（公開しない） |
| テスト | 2週間、X 実投稿・アプリ実レポートと並べて人手レビュー（K1）。Fact 合格率、claims の `evidence_refs` 充足率、web_search 補完の発生率を計測 |
| ロールバック | Cron 停止 |
| 費用効果 | **一時的に増える**（shadow 分 +$0.02〜0.06/日） |

### Phase 3 — アプリ「市場全体」タブを公開

| 項目 | 内容 |
|---|---|
| 変更 | RLS（passed 行の select）、アプリのセグメント UI。マイポート側は現行のまま |
| 触るもの | `src/app/reports/[id].tsx`、`src/lib/personalized-reports.ts`、新 RLS migration |
| リスク | 低〜中（表示のみ。packet が無い日はタブ非表示） |
| テスト | packet 有り/無し/failed の3状態の表示。代替ラベル・鮮度表示 |
| ロールバック | タブ非表示のフラグ（アプリ側定数）、RLS はそのまま |
| 費用効果 | $0 |

**X より先にアプリを切り替える理由:** アプリは「市場全体」が現状存在しないため、置き換えではなく追加になり、既存体験を壊さない。X は公開投稿で、誤りの影響が大きい。

### Phase 4 — マイポートを共通 packet 参照へ

| 項目 | 内容 |
|---|---|
| 変更 | `personalized-reports` が packet を読み、§7.2 の `portfolio_effect` をコードで作る。Fact 不合格時の再生成1回を追加。`personalized_reports.market_report_packet_id` 追加 |
| リスク | 中（Push 対象のレポート本文が変わる） |
| テスト | 2週間の dry_run 並走で、現行本文と新本文の Fact 合格率・禁止語検出を比較 |
| ロールバック | packet 参照を外すフラグで現行ロジックに戻す（旧コードを Phase 6 まで残す） |
| 費用効果 | ユーザー当たり +10〜20%、再生成分で +α |

### Phase 5 — X朝刊・大引けを共通 packet の要約へ

| 項目 | 内容 |
|---|---|
| 変更 | X は packet を読み、要約 1 call ＋ Voice。収集 web_search を削除。packet が無い・failed なら投稿しない |
| 触るもの | `x-test-post` の morning/close 分岐。`*_report_runs.market_report_packet_id` 追加 |
| リスク | **高**（公開投稿、H1 の担当領域と重なる） |
| テスト | dry_run（`dry_run_succeeded`）を2週間並走し、K1 が現行投稿と比較。300字前後・現行の見出し形式を維持 |
| ロールバック | 旧 `generateMorningReport` / `generateCloseReport` を分岐で残し、設定で切替 |
| 費用効果 | X 側 約 -$0.05〜0.07/日（web_search 削減） |

### Phase 6 — 旧取得・旧生成の削除

Phase 4・5 が各2週間安定してから、旧コード・`market_contexts`（未使用確認後）を削除。

---

## 12. Phase 0 で先に計測すべきこと

1. Yahoo 日足の当日行と `regularMarketTime` が確定する時刻（毎営業日、^N225 / 1306.T / 米指数 / 為替）
2. 米国休場日・JPX 半日立会（大納会等）の日足の振る舞い
3. X の Voice・rewrite を含めた実費用（現行の記録漏れを補う）
4. OpenAI 429 の発生時刻の偏り（9/16 朝に3連続）— packet の作成時刻をずらす根拠になる
5. 重要ニュース監視の「朝刊・大引け時点で今日の市場ニュースが何件あるか」の分布 — web_search を0回にできる日の割合

---

## 13. 最初の実装タスクの推奨

**`x-close-report-daily-close-source-fix`（Phase 0 の (1)〜(3)）**

- 目的: 3営業日連続で失敗している X大引けを、アプリで実績のある日足＋`regularMarketTime` 判定で復旧し、終値が無い日は web_search を使わず、失敗時も費用を記録する。
- 範囲: `supabase/functions/x-test-post/close_report_data_logic.ts`、`close_report_logic.ts`、`index.ts` の close 分岐のみ。DB・Cron・設定の変更なし。
- 担当候補: H1（`x-test-post` の担当）。ただし H1 は AI Lab の本番 hotfix 中のため、`x-test-post` の同時 deploy を避ける順序調整が必要。
- 受け入れ条件: 9/10〜9/16 の実 Yahoo 応答 fixture で、日足判定が当日終値を正しく取り、前場値・前日値・`^TPX` を拒否すること。live 窓 16:45〜17:05 の判定は変更しない。

共通基盤の最初の実装は、その後の **Phase 1（data packet の shadow 生成、AI なし）** を推奨する。

---

## 14. リスクと未解決事項（要判断）

| # | 内容 | 判断者 |
|---|---|---|
| 1 | Yahoo チャートAPI（非公式）を正本の取得元にしてよいか。代替（JPX 公式データ等）の調査を先にするか | ユーザー / K1 |
| 2 | グロース250・日経先物・業種別騰落の取得元。見つかるまで「取得できませんでした」表示で公開してよいか | K1 |
| 3 | アプリの既定タブ（マイポート / 市場全体） | ユーザー |
| 4 | X の文体・長さ（現行 500〜800字の目安）とタスク記載の「300字前後」のどちらに合わせるか | ユーザー |
| 5 | packet 作成時刻（朝 07:50 / 大引け 16:15）。X 投稿時刻を動かさずに再試行余裕を取る案で良いか | K1 |
| 6 | MIC `mic_source_registry` 全行 `is_active=false` と ingest 稼働の不一致（MIC 担当の確認） | MIC 担当 |
| 7 | `x-test-post` v109 の本番ソースと `origin/main` の差分有無（本タスクでは未比較） | H1 |
| 8 | Phase 5 は H1 の担当領域。H1 の AI Lab 作業との deploy 競合の回避順序 | K1 |
| 9 | ユーザー数増加時に `personalized-reports` の時間予算・`MAX_USERS_PER_RUN` を超える問題（本設計の範囲外、別タスク） | K1 |
| 10 | Fact 再生成の上限（本設計は2回）。費用と成功率のどちらを優先するか | K1 |

---

## 15. Presentation v2（2026-10-01、consumer gate OFFのまま）

共通packetの「正確だが短い」出力を、Xは約500字の読み物、アプリ「市場全体」は見出し付きの長文へ広げた。事実の正本は1つのまま。

### 15.1 契約

- `market_report_packets.schema_version` はtable checkで `market_report_packet.v1` に固定されている。**版は変えず、任意項目を足した**：`presentation_version = "market_presentation.v2"`、`x_post.context_ja / news_ja / watch_ja`、`app_story`、`session_views`、`key_news[].scope`、`fact.quality_warnings`。項目の無い保存済みpacketは、従来の短い形式で表示する。
- 生成は1回のまま。同じ生成がXの6項目とアプリの8項目を返す（Xとアプリで別々に市場を分析しない）。呼び出しの上限は従来どおり、生成2回・Fact 2回。
- **X**（`_shared/market_report_packet.ts`）：見出し → 導入 → 📌 3点 → 背景 → 📰 ニュース → 👀 次に見る点 → 💬 ひとこと。小見出しと絵文字はコードが付ける。根拠が薄い段落は省く。
- **アプリ**（`_shared/market_report_story.ts`）：見出し・絵文字・指標の行はコードが描画し、AIの文は各セクションの本文だけ。指標は必ず**その指標自身の日付**の下に並ぶ。大引けの「朝刊との答え合わせ」は、同じ取引日の朝刊packetからコードで組み立てる。`market_detail.story` として保存する（既存の項目は変えない）。

### 15.2 Hard BLOCK と Quality WARN

- **Hard BLOCK**（作り直し。残れば fail closed）：
  - 入力に無い数値
  - 指標と数値の不一致
  - 指標と日付の不一致（別日の値を1つの日付で書く）、「同じ日」の誤用
  - 上げ下げの向きの逆転（語・前日比の符号・📈📉）
  - 古い値を日付なしで記載
  - 1306をTOPIXと表記
  - 根拠の無い因果の断定
  - 範囲を示さない「材料なし」の断定（入力にニュースがある場合）
  - 入力に無いref・ニュース、複数日を前提にする語、売買推奨、URL・ハッシュタグ・HTML、内部の項目名、必須項目の欠落、Xの3点が3つでない・長さが投稿不能
  - LLMのFact不合格
- **Quality WARN**（記録するだけで、配信は止めない）：目標より短い・長い、任意セクションの省略、絵文字の数、不確実性の注記の繰り返し、`insufficient_evidence` の重複、テーマ名が指数・根拠なし（packetからは除く）、重要材料の未掲載、見出し・要約の長さ、ニュースの優先順位。
- WARNだけの下書きは、1回だけ書き直しを試みる。書き直しがHardで落ちたら、安全な元の下書きを配信する（質の理由でcycleを落とさない）。

### 15.2.2 質の書き直しの条件（2026-10-02 の較正）

最初に完成したv2（2026-10-02朝刊）は、事実の検査をすべて通った下書きに対して、質の書き直しを1回行い、3回目の呼び出しを使った。原因は次の2つで、どちらも書き直す価値の無いものだった。

- **ニュースの優先順位は、順番で判定する**。Xの読み順（導入 → ニュース段落。段落が無ければ本文全体）で、次の場合だけWARNにする。
  - 個別企業の開示が、市場全体のニュースより前に出る。
  - 市場全体のニュースが入力にあるのに触れず、個別企業だけを扱う。
  - （これまで通り）`key_news` に市場全体のニュースが1件も無い。
  - 市場全体のニュースを先に書き、あとで企業に触れる段落は、WARNにしない。
- **アプリの読み物の長さ**：
  - 900字以上：指摘なし。
  - 700〜899字：WARNとして記録するだけ（書き直さない）。
  - 700字未満：WARN＋書き直し1回。
  - 700の根拠：必須7項目の本文の最低字数の合計が600字（60+100+120+80+120+60+60）、見出しと区切りが約100字。700未満は、必須のどこかが欠けているか、最低字数を下回っている。
- Xの長さの目標（430〜560字）、呼び出しの上限、安全な元の下書きへのfallback、Hardの検査は変えていない。

### 15.2.1 因果の検査の範囲（2026-10-01 の較正）

v2の最初の自然な大引け（2026-10-01）は、ニュース本文の言い換え「AI向け半導体需要を背景に半導体輸出も大幅増と報じられました」を、根拠の無い因果として2回とも不合格にした。検査は「市場の値動きの理由」を止めるためのもので、ニュース自身の原因と結果を伝える文は対象ではない。

- **市場・指数・指標の値動きの理由**（結果側が市場や指標、または主語の無い値動き）：これまで通りHard。`causal` 型のclaimが引用するニュースが、原因を同じ向きで述べ、かつ市場の話であることを求める。市場の話ではないニュースを、市場の理由に使うことはできない。
- **ニュースの中身の言い換え**（結果側が市場ではない）：claimの型は問わない。入力のニュース1件の1文が、自分の因果の表現で原因と結果を結んでいて、書かれた原因がその文の原因側に、書かれた結果がそのニュースに、それぞれ十分に重なり、増減・高安の向きが逆でなければ合格。ニュースが入力にあるだけでは合格にしない。原因と結果を入れ替えた文は合格しない。
- 入力に無いref（書き間違いを含む）は、これまで通りHard。あいまいな照合はしない。

### 15.3 日付・セッションの整合

- `metric -> session_date -> value / change` は `market_data_packet` が正本。再利用した値も、元の `session_date` のまま扱う。
- 2026-10-01の旧アプリ朝刊は、9/29の日経平均（65,481.27、−0.60%）と9/30の1306（431.5、+1.43%）を「9月30日」として並べた。新しい経路では、(a) コードが描画する行は指標ごとの日付付き、(b) AIの文は `hard_fact_guards.ts` が機械的に検査する。LLMのFactには頼らない。
- 朝刊の `market_direction` は米国3指数の方向。東京（前営業日）と米国（前夜）は `session_views` で別々に持ち、読み物でも別のセクションに書く。

### 15.3.1 当日の日付と「見る点」の文（2026-10-02 の較正）

2026-10-02朝刊の1回目は、「10月2日は、米国株高や半導体株高が日本株でどう表れるかを見ます」を、米国株の値動きを10月2日のものとして書いた文と読み、Hardにした。この文の「10月2日」は今日の見る点の日付で、「米国株高」はすでに分かっている10月1日のセッションを指している。

日付の照合から外すのは、次を**すべて**満たす場合だけ。

1. その指標の値・前日比を書いていない。
2. 向きの語が名詞として参照されているだけ（「米国株高が」「米国株高を踏まえ」「上昇の受け止め方」）。「上昇しました」「米国株高でした」「米国株高。」のような、セッションが動いたという言い切りではない。
3. 文の日付がレポートの取引日で、文の主題になっている（「10月2日は、…」）。「10月2日の米国株」のように指標にかかる形ではない。
4. **値動きそのものが、見る点の対象になっている**。値動きの語の直後から読んで、次のどれかの形であること。文のうしろに「確認します」などがあるだけでは足りない（「10月2日は、米国株高が続き、日本株の反応を確認します」は、米国株高が今日も続くと言い切ってから見る点を足しているので、Hardのまま）。
   - 「〜が（日本株で）どう…か」＋見る・確認する・注目
   - 「〜が（日本株に）続くか／波及するかどうか」＋見る・確認する・注目
   - 「〜の受け止め方／の影響／の波及／への反応（を）」の直後に、見る・確認する・注目
   - 「〜を踏まえ（て）／を受け（て）、日本株の反応を」＋見る・確認する（「前夜の米国株高を受け、日本株の反応を見る」）
   - 「〜の流れを（日本株で）どう…か」＋見る・確認する・注目・焦点（「米国株高の流れをどう受け止めるかが焦点」）
   - 「〜を受けた動き（流れ・反応など）が続くか／どう…か」＋見る・確認する
   - 値動きの語と見る点の述語のあいだに置けるのは、名詞（漢字・カタカナ・英数字と「の・や・と」）と助詞だけ。「続き」「確認され」「鮮明となり」「強まり」「買いが先行し」のような、動いていると述べる語は、ここに入らない。値動きの語のすぐ後ろの並列（「米国株高や半導体株高」）は、名詞の値動き（〜高・〜安・〜上昇・〜下落）だけを読み飛ばす。

1つでも外れれば、これまで通りHard。値や前日比を別の日付で書く文、セッションが動いたと言い切る文、10/1の別日の値の混同は、変わらず止まる。向きの逆転（「米国株安が…」）の検査は、この場合も行う。「前夜」と書いてあることは、それだけでは外す理由にならない（「10月2日は、前夜の米国株高が続き、日本株の反応を確認します」はHard）。

**仮定の言い方と、言い切った値動き（2026-10-03 の修正・H1再検証）。** 節全体の仮定語ではなく、向きの語の直後の短い述語が疑問・条件に直接かかる場合だけ、向き・日付の照合から外す。範囲は助詞「が・は・も」、任意の程度副詞「一段と／さらに」、漢字・カタカナ6字以内＋ひらがな3字以内。「強まるかどうか」「上昇すれば」「株安が続くか」は仮定だが、「下落しており次も続くか」「強まり波及するかどうか」の前半は断定として検査する。

「続くから／するから／なるから」は原因を断定する語で、疑問の「か」と部分一致させない。watch relationの「続くか」も同じ境界を持つ。また疑問語の直前が「で・し・て・り」で終わる連用形は、先に前提を言い切る形として外さない（「下落が明白で続くか」）。正当な過去の問い「上昇したかどうか」は保つ。これは限定的な文字列分類であり、任意の修飾・長い述語・あらゆる日本語構文を解析するものではない。

**因果検査との接続。** 日付の検査を通るだけで正当な見る点が別のHardで落ちないよう、次の完成した効果側だけは因果の断定と扱わない。「を受け、／を受けて」＋「日本株／東京市場の反応・値動き・動き・受け止め方を、見る／見ます／確認する／確認します」、または「を受けた」＋「動き・流れ・買い・売り・反応・値動き・展開が／は／も続くかを、見る／見ます／確認する／確認します」。実装はそれぞれの効果側の全文一致（追加の読点は除く）であり、要約・X・App・claimでも同じ扱い。後ろに上昇の断定、過去の確認、可能性の主張などがあれば一致せず、従来の因果検査を行う。原因側の数値・日付・向き・参照の検査は免除しない。

### 15.4 ニュースの優先順位

- `coverage_severity` だけで並べない。範囲（`broad` 市場全体 → `sector` 業種・テーマ → `company` 個別企業）を先に見る。範囲はカテゴリと企業コードの有無からコードで決める。
- 「必ず取り上げる重要材料」は、政策決定と、個別企業のものではないemergency/critical。個別企業のcriticalな開示は、市場全体の話の必須項目にしない（マイポート側で扱える）。

### 15.4.1 3つのポイント（2026-10-05 の編集方針）

2026-10-05大引けの `x_post.points_ja` は「日経平均は69,946.86（前日比+2.40%）。」「TOPIX連動ETF（1306）は436.3円（前日比+1.42%）。」「10月2日のSOXは13,136.67（前日比+2.40%）。」の3つで、どれも指標と数値を並べただけだった。10/1・10/2の出力も同じ形。これでは、その日に何を見るか・何が重要だったかが伝わらない。

- 表示先：X投稿の「📌 今日の注目ポイント／今日の3ポイント」と、アプリのホームカード「今日のポイント」。どちらも同じ `x_post.points_ja` を使う（アプリは `market_detail.points_ja` を経由。presentation v2 のときだけ入り、v1 や古いレポートでは空なので、従来どおり `today_claims` → `checkpoints_ja` … に戻る）。
- 役割：朝刊は「注目点・注意点・相場を見る軸」。今日の東京市場はまだ動いていないので、動いたとは書かない。大引けは「起きたこと・重要だった材料・次に見る点」。
- 数値は見出しの主役にせず、`context_ja` と `app_story` に回す。数値そのものがニュースの核心（政策金利の決定など）の場合だけ例外。
- 安全性は変えない：ポイントは従来どおり「起きたことを述べる文」として、日付・値・向き・1306・因果・ref の検査をすべて受ける。相場を動かした理由を見出しにできるのは causal の claim がある場合だけ。無いときは「主因は絞れず」と書いてよく、それは品質不足にしない。
- 記録（Quality WARN、書き直しはしない）：
  - `X_POINTS_METRIC_RECAP:<数>`：3つのうち2つ以上が、指標名＋数値、または指標名＋向きだけ（「米国株も上昇」）の行。
  - `X_POINTS_NEAR_DUPLICATE`：2つのポイントの文字bigramの重なりが0.5以上。
  - どちらも書き直しの理由にしない。指標の行は事実として安全で、書き直しは2呼び出し（約$0.005）かかる。PR #77で減らした呼び出しを戻さないため。プロンプトが本体で、警告は退行の測定に使う。実運用で `X_POINTS_METRIC_RECAP:3` が続くようなら、`worthRewrite` で `3` だけを書き直しの対象にできる（呼び出しの上限は変わらない）。
- モデル呼び出しの上限（生成2回＋Fact2回）、packet の schema、consumer gate は変えていない。

#### 15.4.1.1 具体性の修正（2026-10-07、10/6大引けの最初の自然観測を受けて）

PR #87 の最初の自然サイクル（2026-10-06大引け）の3ポイントは「主要指数は上昇、主因は一つに絞れず」「国際情勢のニュースを確認」「次は米国株と為替の動きを見る」だった。事実は正しかったが、1つ目と3つ目はプロンプトに入れた例文のほぼ丸写し、2つ目はどの日にも当てはまる文、その日の最大の事実（日経平均が前日の69,946.86から70,683.98へ上がり7万円台に乗せた）は見出しに無かった。数値の羅列より読む価値が低い、というのが運用者の評価。

- 原因：(1) プロンプトの完成例文を、モデルが中身として使った。(2) 「数値を見出しの主役にしない」が強すぎ、例外が政策金利だけで、節目・大幅高安まで見出しから外れた。(3) 具体性を求める指示が無く、汎用の見出しを検出する手段も無かった。
- プロンプト：完成した例文をすべて外し、役割と規則だけにした。各見出しは、その日の入力にある具体的な語（国・地域、企業・業種、指標、出来事の名前）を最低1つ入れる。「ニュースを確認」「動きを見る」「情勢に注目」「材料を確認」「今後の動向に注意」は書かない。数値を入れてよいのは、節目を超えた・大幅な上昇や下落・急変・政策金利の決定のように数値そのものが出来事のとき。そのときも入力の値と前日比から確かめられる範囲（前日の終値を上回った等）に限り、「初めて」「史上最高」「〜年ぶり」は書かない（1日分の入力では確かめられない。この語は Hard にしていない：ニュース本文の「初の〜」の言い換えを誤って止めるため。プロンプトの規則と観測で扱う）。3つはその日にもっとも重要な別々のテーマを選び、固定の型（市場全体・材料・次の注目）にはしない。材料が薄い日は、理由が確認できないことを正直に書いてよいが、3つすべてを抽象的にしない。
- 記録（Quality WARN、書き直しなし）：`X_POINTS_GENERIC:<数>`。市場名・日付・助詞と、固定語彙（ニュース・情勢・材料・動向・動き・状況・確認・注目・注意・見る …）を取り除くと内容の字が1字以下しか残らない見出しを「汎用」と数える。数字を含む見出しは汎用にしない。2つ以上で記録する（「次は米国株と為替の動きを見る」のような見る点が1つだけ汎用なのは許容）。固定の語彙だけを見るので、固有名詞を含む具体的な見出しは当たらない。Hard にも書き直しの理由にもしない。
- 節目の例外：`X_POINTS_METRIC_RECAP` は、節目・超え・上回る・大幅・急騰落・政策金利などの語を含む見出しを値の再掲に数えない。
- 書き直しの条件：`X_POST_SHORTER_THAN_TARGET`（X本文が430字未満）だけでは書き直さない。300字未満（段落が欠けている／切れている）のときだけ書き直す（`X_POST_REWRITE_BELOW_CHARS`）。PR #87 で見出しが短くなったため、プロンプトの各段落の下限（context 90・news 70・watch 50・closing 40）どおりに書くと本文は約390字で、430字の目標には水増ししないと届かない。10/6大引けはこれ（387字）とアプリ本文657字の両方で書き直しが走り、書き直し版が Fact で不合格になって最初の版が配信され、呼び出しが4回になった。アプリ本文700字未満の条件（PR #77）は変えていないので、10/6のようにアプリ本文が各項目の下限を2割ほど下回る日は、書き直しが1回走る。
- 診断：書き直しが Fact などで不合格になったとき、本文や指摘文を保存せず、固定コードだけを `report_diagnostics.rejection_reasons` に残す（例 `date+ref:2` = 日付・参照の2件、`1306`、`causal` …）。分類は指摘の「ラベル」部分（最初のコロンの前）だけを見る。指摘文は引用を含むため、引用の中の語では分類しない。DB の変更は無い（`report_diagnostics` は任意キーの jsonb）。
- 変えていないもの：Hard の判定（日付・値・符号・古い値・1306・ref・根拠の無い因果・「無い」と言い切る文・ちょうど3つ）、安全な最初の版へのフォールバック、モデル呼び出しの上限。

### 15.5 観測

- 内容の作り直し（`generation_attempts` / `content_regenerations` / `hard_rejections` / `quality_rewrite`）、通信のretry（`transport_*`）、cronの再実行（`report_attempt_count`）は別々に記録する。

### 15.6 生成トレース（テスト期間のデバッグ保存、2026-10-07）

2026-10-07朝刊の分析は2回とも不合格で、残ったのは固定コードとFactの最後の指摘1件だけだった。生成された本文、1回目のローカル指摘、07:55の1回目の実行は、いずれも上書きされ（再試行が `market_report_cycles.report_diagnostics` を置き換える）、モデルが誤った本文を書いたのか、guardが安全な本文を止めたのかを、後から区別できなかった。テスト期間は診断性を優先し、**モデルの出力と判定内容を残す**。認証の秘密だけを除く。

- 保存先：`market_report_generation_traces`（追記専用。migration候補 `20261007120000_market_report_generation_traces.sql`、本番未適用）。1回のモデル生成＝1行。1回の実行（スケジュールされた1回の分析）が複数の行を持つ。更新・削除・TRUNCATはトリガで拒否。RLS有効・policyなし・anon/authenticatedへの権限なし。service_roleだけが insert / select。
- 1行の内容：`invocation_id`（実行の識別）、`attempt`（そのcycleの再試行番号。07:55=1、08:05=2）、`generation_index`、`cycle_id` / `data_packet_id` / `report_packet_id`（失敗した生成では null）、`model`、`base_prompt_hash`（指示文のハッシュ。再試行の指摘メモを含まない＝同じプロンプトなら全生成で同じ）、`request_hash`（**その生成が実際に送ったリクエスト**＝再試行の指摘メモを含む指示文＋入力のハッシュ。1回目と書き直しは別の値になる）、`stage`（invalid_output / local / fact / safe_candidate / delivered / request_failed）、`hard_rejection`、**`candidate`（モデルが返した構造化出力そのもの：headline・要約・claims・x_post・app_story など）**、`local_passed` / `local_issues` / `local_warnings`、`fact_ran` / `fact_passed` / `fact_issues`、`selected_for_delivery`、`fallback_reason`、`error_code`、実行内の累計の calls / tokens / cost、`candidate_chars` / `local_issue_count` / `fact_issue_count`（保存前の大きさと件数）、`truncated` / `truncation`（後述の宣言付き切り詰めがあったときだけ）。
- 将来の個人向けレポート用：`source`（`shared_market_report` | `personalized_report`）と `subject_ref`（ユーザー・アカウント・レポートの識別子。共有分析では null）。個人向け生成の実装は含まない。QA段階で、個人向けの生成本文も同じ形で残せる。
- 書き込み（`debug_trace.ts`）：生成が終わったあと（成功なら packet 保存の後、失敗なら fail 記録の後、例外でも）に、ベストエフォートで1回だけ insert する。**失敗しても配信は止めない・再試行しない・モデルを呼ばない**（ログに固定コードを1行出すだけ）。テーブルが未適用でも動く（insert が失敗してログに残るだけ）ので、Function のデプロイと migration の適用は順不同でよい。
- **全量保持**（2026-10-07、H2 F3）：保存は、秘密の置換後の**全文**。文字列ごと・指摘ごと・件数の上限は無い（以前の4,000字／700字／10件／80要素の切り詰めは撤去）。上限は**1つだけ・宣言済み**：各フィールド（candidate・local_issues・local_warnings・fact_issues）の直列化長 `MAX_FIELD_CHARS = 200,000` 字（モデルの出力は最大10,000トークンなので、実際の candidate はその数分の1）。切り詰めには宣言済みの種類が2つだけある：(1) 入れ子が64段を超える部分は `[depth-limit]` の印に置き換える（`depth_limit`）、(2) 直列化長が上限を超えたら先頭を残す（`field_bound`。両方なら `depth_limit+field_bound`）。どちらも `truncated = true`、`truncation.<field> = { reason, original_chars, kept_chars (, original_count, kept_count) }` を記録する。**`original_chars` は、どの切り詰めよりも前の（秘密を置換した）証拠の直列化長**で、深さで切ったあとの表現から数えない（測れないときは null と理由を記録する）。`kept_chars` は実際に保存した表現の長さ（上限で切った candidate は残した先頭の長さ、リストは保存したリストの `JSON.stringify` 長と**完全に一致**。先頭項目の前にカンマを数えない）。candidate は `{truncated, reason, original_chars, kept_chars, head}`、指摘リストは収まる先頭の件を残す。`truncated` と `truncation` は一致を制約で保証。**Factの判定・再試行のメモに使う「指摘は10件まで」は変えていない**（trace の保存とは別）。
- **秘密の除外**（H2 F2で強化）：キー名（token / access・refresh・id・auth_token / api_key / secret / client_secret / private_key / password / credential / cookie / authorization / vault …）の値は丸ごと `[redacted]`。文字列中は、引用符付き・エスケープ付きJSONキー（`\"password\":\"…\"`、`'api_key': '…'`）、`key=value`、`Authorization:`、**大文字小文字を問わない** Bearer / Basic、PEM秘密鍵ブロック（END が無くても末尾まで）、JWT、`sk-…` / `sk_live_…` / `sb_secret_…` / `ghp_…` / `github_pat_…` / `glpat-…` / `xox…` / `AIza…` / `AKIA…` を置換。**すべての一致を置換**し（最初の1件だけではない）、通常の日本語・金融・ニュース本文（「パスワード管理」「Bearer bonds」「token economics」「input_tokens」等）は変えない。引用符付きの値は、JSONのエスケープ（`\"` `\\` `\n` `\uXXXX` など）を最後まで読んで閉じ引用符まで置換する（途中の `\"` で止まって後ろの断片が残ることはない）。JSON文字列の中のJSON（エスケープが重なった形）も同じ数のバックスラッシュで閉じる規則で読み、閉じ引用符が見つからない・読めない場合は、**そのテキストの末尾まで置換**する（取りこぼすより多く隠す）。裸の `key=value` の値は、引用符やバックスラッシュを含んでも1つの値として置換する。単独の `Basic …` は、数字・記号を含む12字以上のトークンか、**base64として復号すると `user:password` の形になる**トークン（`basic dXNlcjpwYXNz` のような英字だけ・パディングなしを含む）だけを秘密とみなし、`basic income` / `basic materials` のような通常の語は変えない。置換は冪等で、書き込み前に「まだ秘密の形が残るか」を**全体に対して**検査し、残る行は**書かずに捨てる**（insert の関数は呼ばれない）。この破棄・失敗は配信に影響せず、モデルも再度呼ばない。ニュース本文・市場データそのものは保存しない（`base_prompt_hash` / `request_hash` と各 id で特定）。
- **権限は検証する**（H2 F1）：migration は、オブジェクトと権限を作った**同じトランザクション内**で、(1) 所有者が anon / authenticated / service_role でない、(2) どの application role も所有者や superuser のメンバーでない、(3) テーブルの直接ACLが「所有者＋service_role の SELECT・INSERT（grant option なし）」だけ、(4) ヘルパー関数の直接ACLが所有者だけ（既定の EXECUTE が残らない）、(5) **実効権限**（継承・PUBLIC・grant option・列権限・`pg_read_all_data` / `pg_write_all_data` 等の定義済みロール）が、service_role は SELECT + INSERT のみ・anon / authenticated は何も無い、(6) 列に個別ACLが無い、を確認し、違えば例外で**全体をロールバック**する。**修復はしない**（既定権限やロールのメンバーシップは触らない）ので、拒否したあとに trace のオブジェクトは残らず、無関係な状態も変わらない。本番適用の前に、読み取り専用の `supabase/tests/market_report_generation_traces_preflight.sql` を実行して、既定権限とメンバーシップを確認する。
- 見方（SQL。service role か SQL editor）：
  - ある日の朝刊の全生成：`select attempt, generation_index, stage, hard_rejection, local_issues, fact_issues, selected_for_delivery, fallback_reason, candidate from market_report_generation_traces where trading_date = '2026-10-07' and report_type = 'morning' order by created_at, generation_index;`
  - 07:55 と 08:05 の比較：`attempt` と `invocation_id` で分かれる。1回目の失敗は再試行で消えない。
  - 書き直しがFactで不合格になった本文：`stage = 'fact'` の行の `candidate` と `fact_issues`、配信された安全な最初の版は `selected_for_delivery = true` と `fallback_reason = 'rewrite_rejected_fact'`。
- 検証と適用の順序：使い捨てPostgresで `TRC_PGHOST=/tmp/… TRC_PGPORT=… TRC_PGSUPER=… bash supabase/tests/market_report_generation_traces_run.sh`（通常経路：追記専用・権限・一意性・全量保持・宣言付き切り詰め・形の制約、Supabase 風の既定権限でも適用できること。**敵対的なアクセスグラフ13通りの拒否**：未知ロールへの既定SELECT／既定EXECUTE、service_role が TRIGGER を継承、authenticated / anon / service_role が所有者や superuser のメンバー、service_role が superuser、`pg_read_all_data` / `pg_write_all_data` のメンバー、grant option 付きの既定権限、未知ロールを継承。いずれも**原子的に拒否され、trace のオブジェクトは残らず、無関係な既定ACL・メンバーシップ・ロール属性は変わらない**。検証の各ステップを1つずつ外すと失敗することを変異で確認済み）と、`supabase/tests/market_report_generation_traces_source_test.ts`。**本番への適用は別のgate（承認後に migration 1本だけ）**。Function のデプロイと順不同でよい：テーブルが無い間は insert が失敗してログに1行残るだけ。適用後は、次の自然サイクルから行が入る。テスト期間が終わったら、保持期間を決めて整理する（追記専用なので、整理は管理者が別のmigrationで行う）。
- 同時に直した指示文：朝刊の「前回の引け以降に確認できたニュース」（2026-09-17から）は、モデルが本文に写し、Factが「入力で確認できない時間関係」として止めた。朝刊・大引けとも「ニュースがいつ取得・公表されたかには、入力に書かれた日時の範囲でしか触れません」に置き換えた（入力のニュースには日時の項目が無い）。完成した例文は足していない。
- 変えていないもの：Hardの判定、PR #99の記録（`X_POINTS_*`）と書き直しの条件（X 300字、アプリ700字）、安全な最初の版へのフォールバック、生成2＋Fact2の上限、packet の schema、consumer gate。

### 15.7 Kabumori AI モデル registry（2026-10-07）

Kabumori の共有朝刊・大引け（アプリと、同じ本文を使う Kabumori の X 朝刊・大引け）の**生成**と **Fact チェック**が使う OpenAI モデルを、ソースで管理する1か所にまとめた。POSTONA / social-auto-post（`_shared/social_ai_model_policy.ts`）、important-news-monitor、MIC、個人向けレポートは対象外。

- 場所：`supabase/functions/_shared/kabumori_ai_models.ts`。呼び出し側は**論理ロール**で引く（生のモデルIDを書かない）：
  - `kabumori.market_report.generate` → `gpt-6.1-sol` / reasoning `medium` / `max_output_tokens` 16,000
  - `kabumori.market_report.fact` → `gpt-6.1-sol` / reasoning `low` / `max_output_tokens` 4,000
  - 設定の版 `KABUMORI_AI_CONFIG_VERSION`（モデルや設定を変えるたびに上げる）。環境変数・DBによる上書きは**無い**（レビューを通らずに本番のモデルが変わらない）。未知のロールは固定コードの例外で、既定のモデルに黙って落ちない。
- 2026-10-07 に公式ドキュメントで確認した事項（`developers.openai.com/api/docs/models/gpt-6.1-sol`、`/api/docs/pricing`、`/api/docs/guides/reasoning`）：モデルID `gpt-6.1-sol`、Responses API と Structured Outputs に対応、コンテキスト 1,050,000・最大出力 128,000、reasoning は `"reasoning": {"effort": …}` で `low` / `medium`（既定）/ `high` / `xhigh` / `max`（`none` と `minimal` は非対応）、reasoning トークンは出力として課金され `max_output_tokens` に含まれる。料金（標準・100万トークンあたり）：入力 $2 / キャッシュ入力 $0.10 / 出力 $10。入力が272Kトークンを超えるリクエストは入力 $4 / $0.20 / 出力 $15。
- 変更点：旧 `gpt-5.6-luna`（low、10,000 / 1,500）から、生成は medium・Fact は low に。**出力上限を広げた**のは、reasoning を上げると reasoning トークンが上限を先に使い切るおそれがあるため（上限は費用の天井で、費用を増やさない）。実モデルでの reasoning の使用量は未観測なので、最初の自然サイクルで `output_tokens` と失敗コードを見る。
- 費用（`estimateCallCostUsd`）：**リクエストごと**に、そのモデルの公式料金で計算（入力が272K超のリクエストは長文料金）。キャッシュ入力の割引は数えない（上限側の見積り）。価格が無いモデルは例外（0円扱いにしない）。旧モデル（luna）の料金は削除。
- 監査メタデータ：`report_diagnostics` に、`ai_config_version`、`ai_generate_role` / `ai_generate_model` / `ai_generate_reasoning`、`ai_fact_role` / `ai_fact_model` / `ai_fact_reasoning`（成功・失敗の両方、DB変更なし）。実際のモデルは従来どおり `market_report_packets.model`・trace の `model` にも入る。**trace の1行ごとの `logical_role` / `config_version` の列は無い**（追加には migration が必要。G4/G5 の本番変更窓が動いている間は作らない。必要になったら `market_report_generation_traces` に `logical_role text` と `ai_config_version text` を足す別 migration）。
- 途中打ち切りの区別：応答が `status = incomplete`（`max_output_tokens` 到達など）で本文が空または不正だった場合、`ANALYSIS_OPENAI_<STEP>_INCOMPLETE:<理由>` で報告する（従来は `_EMPTY` / `_INVALID_JSON`）。成功する応答の扱いは変えていない。
- 一覧：`npm run kabumori-ai-models`（または `deno run --no-config --no-prompt scripts/kabumori-ai-models.ts [--json]`）。ネットワーク・環境変数・ファイルを使わず、OpenAI にも本番にも触れない。
- 生のモデルID対策：`market-report-analysis/model_literal_guard_test.ts` が、この共有朝刊・大引けの実行コード（`market-report-analysis/*.ts` のテスト以外、`_shared/market_report_*`、`kabumori_voice`、`absence_claims`、`market-report-data-packet/session_logic.ts`、`x-test-post/shared_market_report_consumer.ts`）に `gpt-…` が現れたら、ファイルと行とリテラルを示して失敗する。registry、テスト、fixture、文書、他のプロダクトは対象外。
- 変えていないもの：プロンプトと編集方針、Hard の判定、ちょうど3つ、PR #99 の記録、X 300字・アプリ700字の書き直し条件、`MAX_GENERATIONS=2`・最大4呼び出し、安全な最初の版へのフォールバック、PR #101 の trace（全量保持・非ブロッキング）。

## 付録: 監査に使った主な場所

- `supabase/functions/x-test-post/index.ts` — `selectMarketContext` 1146、`morningFactBasis` 1535、`generateMorningReport` 1548、`closeFactBasis` 1983、`generateCloseReport` 2069、`evaluateKabumoriVoice` 2755、morning 分岐 3939、close 分岐 4119、close 失敗保存 4230
- `supabase/functions/x-test-post/close_report_data_logic.ts` — `fetchYahooJpxCloseMetric`（1分足・15:30 判定）、`fetchJpxCloseMetrics`
- `supabase/functions/x-test-post/close_report_logic.ts` — `hasSameDayCloseData`、`validateCloseFreshness`、`resolveCloseRunMode`
- `supabase/functions/x-test-post/morning_candidate_logic.ts` — `MAX_MORNING_SEARCH_CALLS`
- `supabase/functions/personalized-reports/index.ts` — `fetchSeries`（日足）、ユーザーループ、通知 enqueue
- `supabase/functions/personalized-reports/report_logic.ts` — `priceFactFor`、`buildSnapshot`、`buildPacket`、指示文、`generateReport`、`localReportIssues`
- `src/app/reports/[id].tsx`、`src/lib/personalized-reports.ts`
- 本番 read-only: `cron.job`、`morning_report_settings`、`close_report_settings`、`morning_report_runs`、`close_report_runs`、`personalized_reports`、`market_metrics`、`market_state_current`、`mic_source_registry`、`market_contexts`、`supabase functions list`
- 外部 read-only: Yahoo `v8/finance/chart` `^N225` / `1306.T`（`range=5d&interval=1m`）
