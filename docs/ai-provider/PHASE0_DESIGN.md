# かぶモリ・POSTONA 共通AI基盤 Phase 0 — 調査と設計

- 作成: 2026-10-10（JST）、Claude Code（Opus 5.5）
- 基準: fresh `origin/main` `920daec7`（2026-10-10 取得）
- 範囲: 調査と設計のみ。既存ソース・TASK・Report の変更、merge、deploy、DB migration、Supabase 設定変更、APIキー操作、本番AI生成、X投稿、有料API呼び出しは一切行っていない。
- 本文の `file:line` は `920daec7` 時点の行番号。

> **2026-10-10 追記（Phase 1a 実装後の補正）**
> - **実装場所:** 共通層は正式TASKに従い `supabase/functions/_shared/ai_provider/` に実装した（本書の `_shared/ai/` は、この場所に読み替える）。
> - **正本:** request・result・エラー・Schema・予算の契約は `docs/ai-provider/PROVIDER_CONTRACT.md` を正とする。本書と食い違う点は、正式TASKと契約書を優先する。
> - **Phase 1a に含めていないもの:** provider 間の自動フォールバック（OFF。明示設定として後続で設計する）と、サーバー側の refusal fallback（既定では使わない）。
> - **料金とエラー仕様の公式確認:** 2026-10-10 に、料金とエラー仕様を公式ドキュメントで確認した（§5.3 と §5.5 を補正）。

---

## 0. 結論（要約）

1. **AI呼び出しは約30か所あり、すべて OpenAI Responses API を raw `fetch` で呼んでいる。** 共通クライアントはなく、URL・リクエスト形・出力抽出・usage 抽出・タイムアウト・価格表を各所が個別に持つ。価格表は少なくとも9か所あり、値が食い違っている。
2. **費用記録は機能ごとにばらばらで、POSTONA は費用・トークンを一切保存していない。** 月額やUSD単位の上限は、どこにも存在しない。
3. **土台に使える既存部品がある。**
   - モデル登録表の型: `_shared/kabumori_ai_models.ts`、`_shared/social_ai_model_policy.ts`
   - 再試行層: `market-report-analysis/transport_retry.ts`
   - 費用台帳: `ai_usage_events`
   - 比較用の部品群: 未マージ PR #115（純関数の pricing / retry / schema / redact / neutral / types）
4. **新設する共通層は `supabase/functions/_shared/ai/`。** 処理の流れは「論理ルート → モデルカタログ → Provider アダプタ → 再試行・フォールバック → 予算予約 → 費用記録」。Claude 側は公式SDKを固定版で使う（前例: `npm:unpdf@1.8.1`）。
5. **Phase 1 は 1a と 1b の2段に分ける。**
   - 1a: 純コードのライブラリ。どこからも import されないため本番影響ゼロ。
   - 1b: DB の台帳拡張と予算RPC。高リスクのため Codex レビューの対象。
6. **Phase 2（朝刊・大引け）は実測済みで、Opus 5.5 は月約 $11。** G2 の手元比較では1本 $0.269、Sol は $0.077 だった。PR #110 と、その後の誤検知修正（G2 提案の T1）が先に入る必要がある。
7. **$100/月の枠では、全機能を Opus 5.5 へ移すと収まらない。** 重要ニュースの Luna 系（高頻度・低単価）を Opus にすると単価が40倍になり、月 $110〜150 になる。Opus は「低頻度・高価値」の処理に絞り、高頻度の処理は OpenAI Luna を維持するか、同価格帯の Haiku 5.5 を比較評価のうえ選ぶ（§12）。
8. **POSTONA の AI相談には利用者ごとの回数上限がない。** Opus 化する前に、上限と費用記録が必須になる。
9. **プライバシー開示の更新が必要な処理がある。** かぶモリのプライバシーポリシーは、個別レポートの文章作成先を「OpenAI」と明記している（`apps/kabumori-web/pages/privacy.html:29`）。個別レポート（保有銘柄データを含む）や POSTONA の AI相談を Anthropic へ送る前に、開示の更新が必要。

---

## 1. 確認した現状

### 1.1 運用ファイル（origin/main から確認）

- `PROJECT_RULES.md`、`.agent/ORCHESTRATION.md`、`.agent/ACTIVE_TASK.md` を読んだ。`.agent/CURRENT_STATE.md` は約50万字あるため、索引（ACTIVE_TASK）と各TASKの該当箇所だけを確認した。`HANDOFF.md` は 2026-09-04 時点の内容。
- 固定ルーティングは次のとおり。
  - G1/G2: かぶモリアプリ
  - G3/G4: X自動投稿（POSTONA）
  - G5: 明示割当時のみ
  - H1/H2: Codex レビュー
- この作業は ChatGPT からの直接指示で、スロット TASK ではない。既存 TASK・Report には触れていない。

### 1.2 7枠の状態（origin/main `920daec7` の ACTIVE_TASK）

| 枠 | 状態 | 内容 |
|---|---|---|
| G1 | done（空き） | ポートフォリオカード改善。PR #113 merge 済み |
| G2 | review_required | 朝刊・大引けの配信優先ガード。PR #110 OPEN。merge・deploy は HOLD |
| G3 | ready | POSTONA AI相談の ABA 修正。PR #114 OPEN |
| G4 | review_required | POSTONA のマルチプロバイダ schema。PR #106 OPEN。H1 の再レビュー待ち |
| G5 | review_required | 共通アカウント Phase 3a。PR #112 OPEN。H2 の再レビュー待ち |
| H1 | ready | PR #106 の最終再レビュー |
| H2 | ready | PR #112 の最終再レビュー |

### 1.3 関連する未マージ PR

| PR | 内容 | 本設計との関係 |
|---|---|---|
| #110（G2） | `market-report-analysis/*` を広く変更（analysis_logic・各テスト・`_shared/market_report_*`・x-test-post consumer） | **Phase 2 の変更対象と全面的に重なる。** Phase 2 は #110 の merge 後に開始する |
| #116 | 重要ニュース TDnet 生成失敗の改善（`important-news-monitor/post_generation_logic.ts` と同テスト） | **Phase 3b の対象ファイルと重なる。** #116 の決着後に開始する |
| #115 | OpenAI と Claude の比較ツール（`tools/provider-compare/` と `docs/model-optimization/`）。本番コードは変更しない | Phase 1 の部品の供給源になる。ファイル重複はない |
| #114（G3） | AI相談の画面と状態（`apps/social-mobile/src/app/(tabs)/consult.tsx`、`src/domain/consult-session.ts`） | Phase 5 と機能が重なる。Edge Function 側は触っていない。Phase 5 は #114 の後に行う |
| #112（G5） | 共通アカウント削除（`account-delete`、migration 1本） | ファイル重複はない。ただし Phase 1b の migration を本番適用する区間は、G5 の DDL と直列化する |
| #106（G4） | POSTONA social_accounts の migration 候補 | ファイル重複はない。migration 適用区間は直列化する |
| #33、#11、#10、#3 | 古い管理画面・監査系 | 関係なし |

**Phase 1a は、上記のどの PR ともファイルが重ならない**（新規ディレクトリのみを追加する）。

### 1.4 すでに行われた Claude の比較（重要な前提データ）

G2 のTASK（`.agent/tasks/CLAUDE_TASK.md` 追記、2026-10-09）に、本番入力4本で Sol と Claude を手元で比較した結果がある。

- **Opus 5.5:** 1本平均 $0.269（月約 $11）。読みやすさは4本とも Sol より上。
- **Sol（PR #110 のやわらかいプロンプト）:** 1本平均 $0.077（月約 $3）。
- **Sonnet 5.5:** Sol を上回らず、この用途では選ぶ理由がない。
- **ローカル検査の誤検知:** 4種類が見つかった。自由に書く Opus ほど作り直しが増え、費用が1.5〜2倍に膨らむ。修正後の Opus は1本約 $0.2 の見込み。
- **G2 が K2 へ提案した順序:** PR #110 merge → T1（誤検知修正）→ T2/T3（Claude 対応とプロンプト調整）。**本設計の Phase 2 は、この T2/T3 に当たる。**

クレジットについて、G2 は公式ドキュメント（`platform.claude.com/docs/en/about-claude/api-credits-for-subscribers`）で次を確認している。

- Max 5x プランには毎月 $100 の API クレジットが付く。翌月への繰り越しはない。
- クレジットは Console の組織に紐づく。
- 使い切ると、購入残高がなければ API は止まる。

**一方で、実際の紐づけ先・残高・使用 tier は未確認**（PR #115 の報告書も「未確認」としている）。

---

## 2. 現在のAI利用箇所一覧

共通事項:

- 鍵は `OPENAI_API_KEY` のみ。Edge Functions と GitHub Actions の secret にある。
- `ANTHROPIC_*` を使うコードは main に存在しない。
- 呼び出しはすべて `POST https://api.openai.com/v1/responses`（画像だけ `/v1/images/edits`）で、`store:false`。
- 環境変数によるモデル上書きは、意図的に存在しない。

### 2.1 かぶモリ — 朝刊・大引け

| # | 処理 | モデル（設定場所） | 呼び出し元 | 入出力 | Fact チェック | 再試行・フォールバック | 費用記録 |
|---|---|---|---|---|---|---|---|
| K1 | 共有市況レポート生成（アプリと X の共通元） | `gpt-6.1-sol`、effort medium、出力上限 16k（`_shared/kabumori_ai_models.ts:77-92`） | `market-report-analysis/handler.ts:83-115` `openAiRequester`、本文は `analysis_logic.ts:180` | strict json_schema `market_report_analysis`（`analysis_logic.ts:88-165`） | ローカル検査 `localAnalysisCheck`（:636-732）とモデルによる Fact | 通信: `transport_retry.ts`（1呼び出し2回・1実行3回・待ち合計30秒。429 と 5xx を再試行、`insufficient_quota` とタイムアウトは除外）。内容: 最大2生成と品質書き直し1回。モデルのフォールバックはなし | `market_report_packets`（model、generation_calls、tokens、api_cost_usd） |
| K2 | 共有市況レポート Fact | `gpt-6.1-sol`、effort low、4k | 同上 `factRequestBody`（:202） | strict `market_report_fact {passed, issues}` | （Fact そのもの） | 同上 | 同上 |
| K3 | 個別レポート下書き（利用者ごと） | `gpt-6-luna` のリテラル（`personalized-reports/report_logic.ts:67`、登録表の外） | `report_logic.ts:1498-1519`、90秒 | strict `personalized_report` | `localReportIssues`・`holdingImpactIssues` とモデルによる Fact | なし（「never retried」:1310）。110秒・20人/実行 | `personalized_reports.api_cost_usd`（`lunaCost` が単価を直書き :1328） |
| K4 | 個別レポート Fact | `gpt-6-luna`、出力 1.2k | 同上 | strict `personalized_report_fact` | — | なし | 同上 |
| K5 | X 朝刊・大引けの旧経路（素材収集 web_search・執筆・voice 評価・voice 書き直し） | `social_ai_model_policy` の workload（すべて `gpt-6-luna`） | `x-test-post/index.ts:1637`、:1935、:2165、:2396、:2827、:2983 | strict json と web_search ツール | 出典・鮮度・因果の検査、voice 評価 | 大引け収集だけ 429/503 で1回再試行（:771-780）。朝刊は実行単位で最大3回 | `*_report_runs.api_cost_usd`。書き直し分は合算漏れ（:3562-3567） |

補足:

- K5 は、X ゲート（`market_report_consumer_settings.x_enabled`）が off のときだけ動く。on のときは `shared_market_report_consumer.ts` が K1 の結果から X 投稿をコードで組み立てるため、AI 呼び出しは発生しない。本番のゲート値はリポジトリからは分からない。
- 「朝刊・大引け」はアプリ（K1〜K4）と X（K5）のどちらも指し得る（既知の曖昧さ）。**本設計では、Phase 2 の主対象を K1/K2（共有元）とする。**

### 2.2 かぶモリ — 重要ニュース

台帳 `ai_usage_events` の実績（2026-10-06 00:31〜10-09 17:15 JST の3.7日間。PR #115 のスナップショットによる。値は台帳の推定額で、請求額ではない）を併記する。

| # | 段階 | 処理 | モデル（設定場所） | 入出力 | 検査 | 再試行 | 3.7日の実績 |
|---|---|---|---|---|---|---|---|
| N1 | 検知 | 見出しトリアージ（BBC/AJ、最大40件/回） | `gpt-6-luna`（`headline_trigger_logic.ts:31`）、low、4k、45秒 | strict `headline_trigger_triage` | 未知 id の除外 | なし。失敗した見出しは重複除外の履歴に入り、**再トリアージされない（取りこぼしの経路）** | 199回 $0.038 |
| N2 | 検知（検索） | breaking_market の web_search（1日4回） | `gpt-5.6-luna`（`breaking_market_source_fetchers.ts:229`）、出力 1200、`web_search` ツール | strict `breaking_market_candidates`（maxItems 3） | 実際に開いた URL への一致、許可ドメイン、鮮度 | なし | 15回（17検索）$0.214 |
| N3 | 判定 | 重要度の一次判定 | `gpt-6-luna`（`importance_judgement_logic.ts:11`）、low、1000、60秒 | strict `important_news_judgement`（enum、maxItems、confidence の最小・最大） | `parseModelJudgement` | HTTP 再試行なし。`pending_judgement` のまま次回の cron で再判定 | 643回 $0.170 |
| N4 | 判定 | Sol による詳細判定（一次判定の結果を見て独立に再判定） | `gpt-6-sol`（同 :11）、medium | 同上 | 不合格や Sol 無効時は `no_post` に倒す（:174-181） | 同上 | 173回 $1.076（全体の66%） |
| N5 | 生成 | 投稿下書き | `gpt-6-luna`（`post_generation_logic.ts:144`）、出力 1400 | strict `DRAFT_SCHEMA` | `localFactIssues` など | なし。例外時は `generation_failed`（終端） | 116回 $0.060 |
| N6 | Fact | 入力と生成文の照合、条件付きで fact_retry 1回 | 同上、650 | strict `CHECK_SCHEMA` | 数値・コード・日付・範囲・URL の問題は再試行しない（:755-757） | fact_retry は最大1回 | 122+6回 $0.040 |
| N7 | 文体 | voice 判定と voice_retry 1回 | 同上 | strict | 文言だけ | voice_retry は最大1回 | 99+1回 $0.034 |
| N8 | 生成と Fact | アプリ用コピー（題・要約・要点）と Fact | `gpt-6-luna`（`app_copy_logic.ts:12`）、1800/700 | strict 2種 | `localAppCopyIssues` | 条件付きで各1回 | 8+8回 $0.004 |
| N9 | 観測 | shadow targeted search | `gpt-5.6-luna`（`important-news-shadow/index.ts:35`） | 自由文と web_search | — | なし | （shadow 側で別記録） |
| N10 | 観測 | news-discovery-observer（未デプロイ） | `gpt-5.6-luna`（`_shared/news_discovery/search_config.ts:70`） | strict と web_search | URL の照合 | なし。DB RPC で1日の回数に上限 | — |

**3.7日間の合計は $1.636（30日換算で約 $13.3）。** 結果の内訳は次のとおり。

- 判定643件のうち、Sol へ回ったのが173件、重要以上が116件。
- 生成116件のうち、Fact 合格が98件、Fact 不合格が18件、voice 不合格が6件で、公開は91件。
- 直近期間の生成成功率は約77%（PR #116 本文による）。

### 2.3 POSTONA

| # | 処理 | モデル（設定場所） | 呼び出し元 | 入出力 | 検査 | 再試行 | 費用記録 | 上限 |
|---|---|---|---|---|---|---|---|---|
| P1 | AI相談 | `socialTextModel("postonaConsult")` → `gpt-6-luna`（`social-mobile-consult/logic.ts:28`）、low、900、**25秒** | `logic.ts:474-504` `callOpenAiConsultModel` | strict `social_mobile_consult`（nullable を anyOf で表現） | 禁止キーと許可リスト、値の丸め（:510-671）。アプリ側でも再検証 | なし（429→503、タイムアウト→504、画面で再送） | **console のログだけ。DB への保存なし** | **利用者ごとの回数上限なし**（入力サイズの上限だけ） |
| P2 | 通常投稿のプレビュー | `brandPostGeneration` → `gpt-6-luna`、600/2000 | `_shared/brand/brand_post_generator.ts:96-226`（`social-mobile-brand-dry-run` から） | 自由文 | 長さ・空出力・incomplete | なし。**タイムアウト未設定** | 未保存（`apiCostUsd` を計算するが捨てている） | なし |
| P3 | 通常投稿の本番予約投稿 | 同上（140字固定） | `vault_account_brand_post.ts:92-205`（`x-test-post/index.ts:4074-4098` から） | 自由文 | 文脈・長さ・NG語・ブランド横断の重複・投稿権限の再確認 | なし。失敗時は `fail_scheduled_post` | 未保存 | 予約の claim と権限の時間帯 |

存在しない処理:

- **ニュースを使った投稿生成**（AI相談のプロンプトも「ニュースは取得できない」と明記している。`logic.ts:393`）
- **POSTONA 向けの投稿評価・修正**（voice 評価と書き直しは、かぶモリ X 専用）
- **過去投稿の学習**（`social-mobile-history-learning`。規則ベースで LLM を使わない）

アプリ本体（`apps/social-mobile`）は LLM を直接呼ばず、鍵も同梱していない。`consult.test.mjs:530-535` がこれを検査している。

### 2.4 その他（今回の Phase 対象外）

| 処理 | モデル | 備考 |
|---|---|---|
| 会社員AIらぼの日記投稿（P2/P3 と同じ生成器） | `gpt-6-luna` | 内容違反のときだけ最大3回生成。費用は未保存 |
| かぶモリ X のお役立ち・交流投稿・米国プレマーケット・朝の挨拶文 | `gpt-6-luna`。条件付きで `gpt-6.1-sol` | `social_ai_model_policy` の管理下 |
| 朝の挨拶画像 | `gpt-image-2`（`/v1/images/edits`） | **Anthropic に画像生成はないため OpenAI に残す。** GitHub Actions の cron が1日1枚生成。費用は未記録 |
| MIC: Fed 声明の解釈・state 評価・scenario 評価 | `gpt-6-luna` / `gpt-5.6-luna` / `gpt-5.6-sol` | **DB の RPC がモデル名や費用の一致を検査している**（例: `20260923050259…:45` が `'gpt-6-luna'` を直書き）。移行には migration が要る。state 評価には出力上限の指定がない |

### 2.5 横断的に分かった問題

1. **価格表が9か所以上に分散し、値が食い違っている。**
   - `gpt-5.6-sol` は `usage_ledger.ts` では 4/20、MIC では 5/30。
   - `post_generation_logic.ts:1153` の `lunaCost` は、`gpt-6-luna` に 0.2/1.2 を使っている（正しい値は 0.1/0.5）。
   - 未知モデルの扱いがばらばらで、`gpt-6-luna` の単価で計算するもの、0 を返すもの、例外を投げるものがある。
2. **モデル名が揃っていない。** 重要ニュースは `gpt-6-sol` を使い、登録表は `gpt-6.1-sol` を使う。予備に使う「Sol」がどちらなのかを機能ごとに確認する必要がある。
3. **DB の CHECK 制約が、OpenAI のモデル名しか許していない。** 対象は `important_news_candidates.judgement_model` と `generation_model`（`20260923035652…`）。Phase 3 では migration が必要になる。
4. **キャッシュ済みトークンと推論トークンは、どこにも記録されていない。**
5. **月額・USD 単位の予算上限は、どこにも存在しない。** 回数の上限があるのは news-discovery の1日の検索数だけ。
6. **一部の呼び出しにタイムアウトがない**（brand 生成器、x-test-post の大半、画像）。

---

## 3. 共通化できる既存コード

| 既存コード | 再利用のしかた |
|---|---|
| `_shared/kabumori_ai_models.ts`（役割の登録表、価格・長文脈 tier・検証日、凍結オブジェクト、未知の役割や価格は例外、監査用の組（audit tuple）、リテラルガードのテスト） | **新しいモデルカタログとルート表の型と方針（ソース管理、環境変数による上書きなし、未知は例外）をそのまま継承する。** `responsesApiParams` は OpenAI アダプタへ移す |
| `_shared/social_ai_model_policy.ts`（workload → tier → model、リテラル禁止テスト） | workload 名をそのままルートキーへ写す。テストを `claude-` にも対応させる |
| `market-report-analysis/transport_retry.ts`（Retry-After の扱い、`insufficient_quota` の除外、実行単位の予算、sleep/now の注入） | **共通の再試行層の原型にする。** 529 と課金系エラーの分類を足す |
| `market-report-analysis/handler.ts:71-115`（出力テキストの抽出、incomplete を `_INCOMPLETE` にする処理） | OpenAI アダプタの出力抽出に使う |
| `_shared/news_discovery/web_search.ts:37-42, 201-247`（`ProviderResult` の interface、タイムアウトを課金済みとして数える） | 「タイムアウトは課金され得る」の扱いを共通化する |
| `ai_usage_events`（MIC が「横断的な単一の AI 費用台帳」として作成。RLS 有効、service_role は select/insert のみ、`usage_event_key` で冪等） | **共通台帳として拡張する**（列の追加だけで後方互換） |
| `important-news-monitor/usage_ledger.ts`・`usage_metering.ts`、`market-intelligence-ingest/mic_ai_usage_logic.ts` | 台帳へ書く処理と、ラップして計測する型を共通化する |
| `news_discovery_reserve_search`（advisory lock による1日の予約） | **予算予約 RPC の同時実行制御の前例** |
| PR #115 の `tools/provider-compare/src/`: `pricing.ts`・`retry.ts`・`types.ts`・`neutral.ts`・`schema.ts`・`redact.ts`・`usage_dimensions.ts`（純関数で Deno/Edge 互換）、`providers/anthropic.ts`（SDK 0.132.1、`maxRetries:0`、`output_config.format`、usage 抽出、refusal 処理） | **Phase 1a に取り込む候補。** ただし `budget.ts` は同時実行に安全でなく、`keys.ts` は macOS キーチェーンに依存するため、考え方だけを使う。比較ツール自体は tools に残し、将来は `_shared/ai` を import する側にする |

## 4. 新規作成が必要な共通部品

1. ニュートラルなリクエスト・結果・usage・エラーの型
2. Provider 横断のモデルカタログ（価格、キャッシュ単価、能力、検証日）
3. 論理ルート表（主・予備、effort、出力上限、タイムアウト、予算プール、モード）
4. OpenAI Responses アダプタ（既存の重複実装を一本化）
5. **Anthropic Messages アダプタ**（公式SDK、思考の扱い、構造化出力、refusal、キャッシュ）
6. **JSON Schema 変換とローカル再検証**（Claude が受け付けない制約を外し、受信後にコードで検査する）
7. **エラー分類**（429・529・タイムアウト・不完全出力・refusal・クレジット不足・利用上限・認証・不正リクエスト）
8. **再試行・フォールバックの実行器**（期限と回数の上限つき、往復なし）
9. **予算の予約と精算**（DB の RPC による原子的な処理、日額・月額・1回あたりの上限）
10. **Provider の遮断状態**（クレジット切れ・認証エラー時の circuit breaker と、DB による即時停止スイッチ）
11. **台帳の拡張**（provider・service・route・キャッシュ・推論・request_id・結果・フォールバック）
12. クレジット残高の確認記録（手入力の snapshot）と予算状況の view
13. 秘密情報のマスク、隔離テスト、モデル名リテラルのガード

---

## 5. 共通AI接続基盤の設計

### 5.1 構成

```text
呼び出し元（例: market-report-analysis）
   │ callAi(routeKey, AiRequest, deps)
   ▼
_shared/ai/router.ts
   ├─ routes.ts          … routeKey → 主・予備・予算プール・モード
   ├─ model_catalog.ts   … モデル → provider・価格・能力
   ├─ budget.ts          … 予約 → 実行 → 精算（Phase 1b の RPC）
   ├─ providers/openai_responses.ts
   ├─ providers/anthropic_messages.ts
   ├─ errors.ts          … ニュートラルなエラーコードと判断
   ├─ retry.ts           … 期限内・回数内の再試行
   ├─ schema_adapter.ts  … 制約の除去とローカル再検証
   ├─ cost.ts            … usage → USD（カタログから計算）
   └─ usage.ts           … ai_usage_events の行を作り、書き込む（冪等キー）
```

`callAi` が返す結果は provider を問わず同じ形にする。

- `{ ok, text, json, usage, provider, model, stopReason, attempts[], fallbackUsed, costUsd }`

呼び出し元が持ち続ける処理（ローカル検査・Fact・内容に基づく作り直し）はそのまま残る。共通層は「1回の論理呼び出しを、安全に1つの結果へ変える」ことだけを担う。

### 5.2 ① Provider の切替

ルート表の各ルートが持つ設定:

```ts
"kabumori.market_report.generate": {
  mode: "anthropic_primary",          // "openai_only" | "anthropic_primary"
  primary:  { model: "claude-opus-5-5", effort: "medium", maxOutputTokens: 24000, timeoutMs: 120000 },
  fallback: { model: "gpt-6.1-sol",     effort: "medium", maxOutputTokens: 16000, timeoutMs: 90000 },
  budgetPool: "claude.kabumori.market_report",
  fallbackPool: "openai.fallback",
  fallbackOn: ["RATE_LIMITED","OVERLOADED","SERVER_ERROR","NETWORK","TIMEOUT","CREDIT_EXHAUSTED",
               "SPEND_LIMIT","AUTH","INVALID_REQUEST","REFUSAL","INCOMPLETE","BUDGET_DENIED","PROVIDER_BLOCKED"],
}
```

（effort とトークン数は例。Phase 2 で実測して決める。）

- **モード変更とモデル変更は、ソース変更とレビューと再デプロイで行う。** 既存方針（`kabumori_ai_models.ts:9-11`、`social_ai_model_policy.ts:7-9`）を維持する。
- **ただし、緊急停止だけは DB で即時に行えるようにする。** `ai_provider_state` で `anthropic` を遮断すると、全ルートがレビュー済みの予備モデルを主として使う。DB でできるのは「止める」ことだけで、任意のモデルを選ぶことはできない。このため「レビューを迂回する上書き」にはならない。secret の変更や再デプロイなしに戻せる。
- 段階導入の型として、各 Phase は2段階で進める。
  1. まず `openai_only` で共通層へ載せ替える。挙動は同じで、費用記録だけが増える。
  2. 次に `anthropic_primary` へ切り替える。

### 5.3 ② モデル設定の一元管理

`model_catalog.ts` は、1モデルにつき次の情報を持つ。

- `provider` と `id`
- `prices`: input、output、cacheRead、cacheWrite5m、cacheWrite1h、長文脈 tier
- `capabilities`: temperature の可否、思考を無効化できるか、effort の段階、構造化出力、最大出力
- `source` と `verifiedOn`

初期値（Phase 1a の実装時に公式の価格ページで再確認すること）:

| モデル | 入力 | 出力 | キャッシュ読み | キャッシュ書き 5分/1時間 | 注意 |
|---|---|---|---|---|---|
| `claude-opus-5-5` | $4 | $20 | $0.20 | $5 / $8 | 思考は常にオン（無効化は400）。effort の既定は **medium**。temperature・prefill・強制 tool_choice は400 |
| `claude-sonnet-5-5` | $2 | $10 | $0.10（2026-10-10 に公式で確認） | $2.5 / $4 | 思考を止めるには `between_tools` |
| `claude-haiku-5-5` | $0.10 | $0.50 | — | — | 10万トークン以下の場合。それを超えると $0.50/$2.50 |
| `gpt-6.1-sol` | $2 | $10 | $0.10 | — | 27.2万トークン超は $4/$15（既存の登録表） |
| `gpt-6-sol` | $2 | $10 | — | — | 重要ニュースが使用（`usage_ledger.ts`） |
| `gpt-6-luna` | $0.10 | $0.50 | — | — | |
| `gpt-5.6-luna` | $0.20 | $1.20 | — | — | web_search 1回 $0.01 は別途 |

ルールは次のとおり。

- カタログにないモデルはルートに指定できない（テスト時に全ルートを検査する）。
- 呼び出し後の費用計算は例外を投げない（未知モデルがあり得ない構造にする）。

### 5.4 ③ 構造化出力

**Anthropic 側:**

- `output_config: { effort, format: { type: "json_schema", schema } }` で指定する。
- 古い `output_format` は使わない。tool use の強制も使わない（Opus 5.5 では400になる）。

**OpenAI 側:**

- 既存どおり `text: { format: { type: "json_schema", name, strict: true, schema } }` で指定する。

**`schema_adapter.ts` の役割:**

- Claude が受け付けない制約を外す。対象は `minimum`・`maximum`・`multipleOf`・`minLength`・`maxLength`・複雑な配列制約・再帰。
- 外した制約は記録しておき、**受信後に `validateLocalConstraints` で再検証する。** PR #115 の `schema.ts` は再検証をしていないため、ここで補う。
- `additionalProperties` が `false` 以外の場合は例外にする。
- 実在するスキーマで影響を受けるもの:
  - 重要ニュースの判定: confidence の最小・最大、maxItems 12
  - breaking: maxItems 3
  - MIC の Fed: 数値の最小・最大

**出力の読み方:**

- Claude: 応答の `content` を **block の type で**読む（先頭に thinking block が来るため）。
- OpenAI: `output[].content[type=output_text]` を読む。

**次の場合は、スキーマどおりでなくても失敗として扱う。**

| 状態 | エラーコード |
|---|---|
| `stop_reason` が `refusal` | REFUSAL |
| `stop_reason` が `max_tokens` | INCOMPLETE |
| `pause_turn` | INCOMPLETE（Phase 1〜3 ではサーバーツールを使わない） |
| OpenAI の `status:"incomplete"` | INCOMPLETE |
| OpenAI の refusal content | REFUSAL |

`max_tokens` の決め方: Opus 5.5 は思考トークンも `max_tokens` に数える。このため、現在の `max_output_tokens`（推論込み）と同等以上を目安にし、実測で調整する。

### 5.5 ④ エラーハンドリング（ニュートラルなエラーコード）

| コード | Anthropic | OpenAI | 再試行 | 予備へ | 遮断 |
|---|---|---|---|---|---|
| RATE_LIMITED | 429 `rate_limit_error` | 429（quota 以外） | 1回まで（retry-after は上限まで尊重） | する | — |
| OVERLOADED | **529 `overloaded_error`** | 503 | 1回まで | する | — |
| SERVER_ERROR | 500 `api_error` など 5xx | 500/502/504 | 1回まで | する | — |
| NETWORK | 応答前の接続エラー | 同じ | 1回まで | する | — |
| TIMEOUT | AbortSignal | 同じ | **しない**（課金済みの可能性があるため推定額を記録） | 期限内ならする | — |
| CREDIT_EXHAUSTED | **402 `billing_error`**、または本文 "Your credit balance is too low…"（文言は公式で確認済み。HTTP ステータスは公式に記載がないため、本文で判定する） | 429 `insufficient_quota` | しない | する | **する**（手動解除か、1時間後に再確認） |
| SPEND_LIMIT | プランの月額上限: 429 で `error.details.error_code = "enforced_spend_limit_reached"`、`retry-after` なし。自分で設定した上限: 400 で、本文が "You have reached your specified (workspace) API usage limits" で始まる（どちらも公式で確認済み） | — | しない | する | する（周期の終わりまで） |
| AUTH | 401/403 | 401/403 | しない | する | する（警告を出す） |
| INVALID_REQUEST | 400/404/413/422 | 400/404 | しない | する（配信を優先。アダプタの不具合として警告） | — |
| REFUSAL | `stop_reason:"refusal"`（`stop_details.category`） | refusal content | しない | する | — |
| INCOMPLETE | `max_tokens`、`pause_turn` | `incomplete:max_output_tokens` | しない（ルートで許可された場合だけ、上限を増やして1回） | する | — |
| INVALID_OUTPUT | JSON 不正、ローカル制約の違反 | 同じ | provider 層ではしない（呼び出し元の作り直しロジックへ返す） | しない | — |
| BUDGET_DENIED | 自前の予算判定 | 同じ | — | 予備の予算内ならする | — |

分類の方針:

- Claude 側は、SDK の型付き例外（`Anthropic.RateLimitError` など）と `error.type` で分類する。**本文の文字列照合は、課金系の補助判定に限る。**
- `request-id` は記録してよい（秘密ではない）。
- エラー本文は先頭400字に切り詰め、秘密情報をマスクしてから保存する。

### 5.6 ⑤ フォールバック（上限つき）

- 1回の `callAi` で使える回数は、**主が最大2回、予備が最大2回、合計4回まで。**
- **予備からさらに予備へは移らない**（往復させない）。
- 呼び出し元が `deadlineMs` を渡し、再試行も予備も期限を超えない。Edge の実行時間の上限を守るため。
- 予備へ移る前に、**予備側の予算プールでも予約を取る。** 予約できなければ `BUDGET_EXHAUSTED` で失敗させる。このとき呼び出し元は、今日と同じ失敗処理を行う。
- 予算 DB に到達できない場合、**有料の主（Claude）は呼ばない**（fail-closed）。既存と同じ OpenAI の予備だけで動く。今日の挙動より悪くならない。
- **refusal への備え:** Anthropic は Opus 5.5 にサーバー側のフォールバック（`fallbacks: "default"`、beta `server-side-fallback-2026-07-01`。安全分類の誤検知時に別の Claude モデルで再実行する）の利用を推奨している。本設計では**ルートごとの設定で既定オン**とする。
  - 費用は Claude 枠に入る。usage の `iterations` で、どのモデルが応答したかと費用を記録する。
  - 金融文書で `cyber`・`bio` 系の誤検知が起きる可能性は低いと見込む。ただし0ではない。
  - 不要と判断した場合は、ルート単位で外せる。
  - その先の失敗は、アプリ側の Sol 予備が受ける。

### 5.7 ⑥ 費用管理

`ai_usage_events` に列を追加する（**すべて nullable か既定値つき**。既存の書き手である重要ニュースと MIC、および MIC の RPC の照合は影響を受けない）。

| 追加する列 | 内容 |
|---|---|
| `provider` | `openai` / `anthropic`。既存行は NULL のままとし、集計 view で `openai` とみなす |
| `service` | `kabumori` / `postona` / `ai_lab` / `mic` |
| `route` | 論理ルートキー |
| `cache_read_input_tokens` / `cache_creation_input_tokens` | Claude のキャッシュ。OpenAI の `cached_tokens` は読み取り側へ入れる |
| `reasoning_output_tokens` | OpenAI の `output_tokens_details.reasoning_tokens`（参考値） |
| `outcome` / `error_code` / `attempt` / `is_fallback` / `fallback_from_provider` | 結果と経路 |
| `provider_request_id`（長さ128まで）/ `latency_ms` | 調査用 |
| `catalog_version` | 単価の出所 |

**「金額」は3種類を区別して保存・表示する。**

1. **計測額（metered）:** 自前で usage × カタログ単価を計算した推定額。予算判定に使う。
2. **請求額（billed）:** provider の請求・利用レポートの額。後日の照合に使う。Phase 1 の範囲外。
3. **クレジット残高（credit）:** Console で人が確認した値を、`ai_credit_snapshots` に確認日時つきで手入力する。

推定残高は「最新の確認残高 − 確認時刻以降の計測額」で出し、必ず「推定」と表示する。**推測した残高で判定はしない。** 実際の残高切れは、API のエラー（CREDIT_EXHAUSTED）で検知して遮断する。

Anthropic の Usage & Cost Admin API には Admin APIキー（組織管理権限）が要る。**Edge Functions には置かない。** 必要になった場合は、別の手動作業か読み取り専用の照合ジョブとして、別途設計する。

### 5.8 ⑦ 予算制御（かぶモリと POSTONA で共有する Claude 月 $100）

**新しく作る表:**

- `ai_budget_pools`: 予算プール。キー、provider、service、周期の起点日、月額上限、日額上限、1回の上限、警告しきい値、有効フラグ。
- `ai_budget_reservations`: 予約の記録。予約・精算・失効の状態を持つ。
- `ai_credit_snapshots`: 確認したクレジット残高の記録。
- `ai_provider_state`: provider の遮断状態（遮断の期限と理由）。

**RPC:**

- `ai_budget_reserve`、`ai_budget_settle`、`ai_provider_block`
- いずれも SECURITY DEFINER、`search_path` 固定、実行権限は service_role のみ。
- プールの行を `for update` でロックし、同時実行でも上限を超えないようにする。

**集計用の view:** `ai_budget_status`（管理者が読み取る）

**周期:** クレジットは**サブスクリプションの課金周期**で切り替わる（暦月とは限らない）。このため `cycle_anchor_day` を設定で持つ。計算は UTC、表示は JST で行う。

**初期の配分案**（ChatGPT とユーザーで決定する）:

| プール | 月額 | 根拠 |
|---|---|---|
| `claude.kabumori.market_report` | $15 | 実測 $11/月（誤検知の修正後は約 $8） |
| `claude.kabumori.important_news` | $0（Phase 3 で $30 前後を検討） | §12 |
| `claude.postona` | $0（Phase 4/5 で $25 前後を検討。上限の導入が前提） | §12 |
| `claude.eval` | $10 | 有料の比較実行用（ユーザーの事前承認が必須） |
| 未配分の予備 | 残り | 急増への備え |
| `openai.fallback` | $10 | 予備として動いた分だけを数える（Sol の予備は月 $3 程度で収まる見込み） |

**しきい値と上限到達時の処理:**

- 使用率 50% で記録、80% で警告、95% で重大。100% に達したら、そのプールのルートを予備へ回す。
- **日額の上限**（月額 ÷ 周期の日数 × 3）を設け、不具合によるループで1日のうちに使い切るのを防ぐ。
- 1回の上限: 最悪見積り（入力の推定 × 入力単価 + `max_tokens` × 出力単価）が上限を超えるルートは、テスト時に失敗させる。
- 予約したまま精算されなかった分は、失効するまで「使った」とみなす（安全側）。

**多重の安全策:** 自前の予算判定に加え、**Anthropic Console のワークスペース使用上限**を周期の予算以下に設定する（ユーザーの操作）。

### 5.9 ⑧ 安全性

- **鍵はサーバー側だけに置く。** `ANTHROPIC_API_KEY` は Supabase Edge の secret とする。`EXPO_PUBLIC_*` には絶対に入れない。アプリ（`apps/*`、`src/`）に鍵や SDK が入っていないことを隔離テストで検査する（既存の `tests/app/*` には "anthropic" 禁止のテストがある。`apps/social-mobile` と `apps/admin` にも広げる）。
- **本番用の鍵は専用ワークスペースで発行する。** 手元の比較用の鍵とは分ける。
- **ログには載せない:** プロンプト本文、出力本文、HTTP ヘッダー、鍵の一部。error 本文はマスクして400字まで。Report と HANDOFF にも鍵や本文を書かない。
- **secret の登録はユーザーが行う**（プロジェクトの記憶: `supabase secrets set` を実行すると全関数のバージョンが上がる）。他スロットの「デプロイ済みバイトの照合」基準に影響し得るため、登録の時期を他スロットと調整する。
- **データの送り先が変わる処理の開示:**
  - 個別レポート（保有銘柄データ）と AI相談（利用者の会話）を Anthropic へ送る前に、プライバシーポリシーの記載（`apps/kabumori-web/pages/privacy.html:29-31` は OpenAI と `store:false` を明記）と POSTONA 側の開示を更新する必要がある。
  - 共有市況レポート（K1/K2）は公開市場データだけで、個人データを含まない。

### 5.10 Anthropic アダプタの方針

- **公式 TypeScript SDK を固定版で使う。** 形式は `npm:@anthropic-ai/sdk@<固定版>` で、PR #115 は 0.132.1 で動作を確認済み。設定は次のとおり。
  - `maxRetries: 0`（SDK の自動再試行を止め、共通層の上限つき再試行に一本化する）
  - `timeout` をルートごとに指定
  - テストでは `fetch` を注入してネットワークなしで検証する
- Edge での `npm:` 形式は前例がある（`important-news-monitor` の `npm:unpdf@1.8.1`）。ただし、**Edge の bundle での動作は Phase 1a でローカル確認する**（本番デプロイは Phase 2 のゲートで行う）。
- **リクエスト:**
  - `model` と `max_tokens` を指定する。
  - `system` は配列にし、変わらない指示を先頭に置いて `cache_control` を付ける。最小のキャッシュ単位は 512 トークン。
  - `messages` は user 1件。多ターンなら履歴を追記するだけにする（thinking block を再送しないため、preserved thinking の制約には当たらない）。
  - `output_config` に effort と format を入れる。
  - `thinking` は省略する（adaptive）。`temperature` は送らない。
- **キャッシュの効果:** 重要ニュースの判定のように同じ指示で高頻度に呼ぶ処理では効く。朝刊・大引けは1日2回で、5分の TTL では生成と Fact の間しかヒットしないため、効果は小さい。

---

## 6. 段階的な導入計画（変更ファイル候補）

各 Phase は「独立に PR・テスト・レビュー・本番切替・切り戻しができる」単位にしてある。本番切替は、どれも「`openai_only` で載せ替えて挙動が同じことを確認する → Claude を主にする → 数日観察する」の順で行う。

### Phase 1a — 共通ライブラリ（本番影響ゼロ）

- **新規**（すべて `supabase/functions/_shared/ai/` の下）:
  - `types.ts`、`model_catalog.ts`、`routes.ts`（本番ルートは0件。テスト用だけ）
  - `errors.ts`、`retry.ts`、`schema_adapter.ts`、`cost.ts`、`budget.ts`（interface・メモリ実装・RPC クライアントの雛形）
  - `usage.ts`、`redact.ts`、`router.ts`
  - `providers/openai_responses.ts`、`providers/anthropic_messages.ts`
  - 各 `*_test.ts` と `isolation_test.ts`
- **新規文書:** `docs/ai-provider/PHASE1_FOUNDATION.md`
- **既存ファイルの変更: 0。** どこからも import しない。

### Phase 1b — 台帳と予算の DB

- **新規 migration** `supabase/migrations/<ts>_ai_provider_ledger_budget.sql`:
  - `ai_usage_events` に列を追加
  - `ai_budget_pools`、`ai_budget_reservations`、`ai_credit_snapshots`、`ai_provider_state` を作成
  - RPC 3本と view を作成
  - RLS と grant を設定
- **新規テスト:** `supabase/tests/ai_provider_budget_*`（ローカル PG17 による証明と mutation テスト）
- **変更:** `_shared/ai/budget.ts`（RPC クライアントの実装）
- **本番適用:** 別ゲートでユーザーが実行する。G5 などの DDL と直列化する。

### Phase 2a — かぶモリ朝刊・大引け（共有市況レポート K1/K2）。Opus 5.5 を主、`gpt-6.1-sol` を予備に

- **前提:**
  - PR #110 の merge
  - G2 の T1（誤検知4種の修正）
  - Phase 1a の merge
  - Phase 1b の本番適用
  - Console での準備（ユーザー）: クレジットの紐づけ確認、専用ワークスペース、使用上限、鍵の発行、`ANTHROPIC_API_KEY` の登録
- **変更:**
  - `_shared/kabumori_ai_models.ts`: 登録表を `_shared/ai` のルートへ委譲するか、provider を追加する。`KABUMORI_AI_CONFIG_VERSION` を更新する。
  - `market-report-analysis/handler.ts`: requester を `callAi` に置き換える。
  - `analysis_logic.ts`: 本文の組み立てをニュートラルなリクエストへ変える。
  - `transport_retry.ts`: 共通層へ統合するか、OpenAI 側に限定する。
  - テスト: `model_literal_guard_test.ts`（`claude-` も対象にする）、`model_registry_integration_test.ts`、`handler_test.ts`、`transport_retry_test.ts`
  - 診断: `report_diagnostics` に provider と fallback の情報を追加する（jsonb の文字列値なので migration は不要）。
- **プロンプトの Opus 向け調整（G2 提案の T3）:** 絵文字の数、略語の説明、締め方。同じ PR でも別 PR でもよい。
- **デプロイ:**
  - 対象は `market-report-analysis` だけ。x-test-post は K1 の結果を読むだけなので、再デプロイは不要。
  - 念のため、デプロイ前に import のつながりを確認する。

### Phase 2b — 個別レポート（K3/K4、任意）

- **前提:** プライバシー開示の更新と、モデルの選択（Luna 比で Opus は約40倍）。
- **変更:**
  - `personalized-reports/report_logic.ts`: リテラルのモデル名、本文、送信処理、`lunaCost` を共通層へ移す。
  - `personalized-reports/index.ts`: 配線だけ。
  - テスト
- **推奨:** まず `openai_only` のまま共通層へ載せ、費用記録を得てから判断する。

### Phase 3 — かぶモリ重要ニュース（検知・判定・生成を分けて移行。ニュース取得は維持）

- **3a 判定:**
  - Sol 段の詳細判定（N4、`gpt-6-sol`）を Opus 5.5 へ移し、`gpt-6-sol` を予備にする。
  - 一次判定（N3）とトリアージ（N1）は Luna のまま。
  - 変更: `importance_judgement_logic.ts`、`usage_metering.ts`、`usage_ledger.ts`（価格を共通カタログへ）、`index.ts`、**CHECK 制約を緩める migration**（`judgement_model`）、`cost_path_audit_test.ts`、`gpt6_model_constraint_migration_test.ts`。
- **3b 生成:**
  - 下書き（N5）を Opus 5.5 へ移す。狙いは Fact 不合格16%（取りこぼし）の削減。
  - Fact 判定（N6）は**別 provider（Luna）のまま**とし、提供元をまたいで照合する。
  - voice（N7）は Luna のまま。
  - 変更: `post_generation_logic.ts`（**PR #116 と競合**）、`generation_dispatch_logic.ts`、`index.ts:1076`、`generation_model` の CHECK 制約。
- **3c アプリ用コピー**（N8。件数が少なく安い）: `app_copy_logic.ts`
- **移さないもの:** web_search 系（N2・N9・N10、X の素材収集）。取りこぼし防止の中核である「実際に開いた URL への一致」が OpenAI の応答形に依存しており、移行には作り直しが要る。高難度のため、別の判断とする。
- **取りこぼし防止の追加提案（provider の選択とは独立）:** N1 で失敗した見出しが重複除外の履歴に入り、再トリアージされない問題（`headline_trigger_logic.ts:243-244`, `:694-724`）を、同じ Phase で直すことを推奨する。

### Phase 4 — POSTONA 通常投稿の生成

- **4a 準備:** brand 生成器を共通層へ載せる（`openai_only`）。合わせて次を行う。
  - **タイムアウトを追加**し、**費用記録（service=postona / ai_lab）を開始**する。
  - workload を `postonaPostGeneration` と `aiLabPostGeneration` に分け、別々に移せるようにする。
  - 変更: `_shared/brand/brand_post_generator.ts`、`_shared/social_ai_model_policy.ts`、同テスト、`social-mobile-brand-dry-run/{index,logic}.ts`、テスト。
- **4b プレビューの切替:** `social-mobile-brand-dry-run` だけをデプロイする（小さい関数）。
- **4c 本番予約投稿の切替:**
  - 変更: `vault_account_brand_post.ts`、`x-test-post/index.ts:3328` 周辺（鍵の配線）。
  - **x-test-post の再デプロイを伴う**（かぶモリ X・AI らぼ・POSTONA が同居し、未デプロイ PR を一緒に運ぶ危険がある）。独立の本番ゲートが必要。
- **前提:** **ブランドごと・利用者ごとの1日の生成上限**。DB で数える（新しい migration）。

### Phase 5 — POSTONA AI相談とその他

- **変更:** `social-mobile-consult/{logic,index}.ts`、`logic_test.ts`、`apps/social-mobile/tests/consult.test.mjs` と `consult-memory-generation.test.mjs`（`api.openai.com` のモックを直す）。
- **前提:**
  - PR #114 の merge
  - **利用者ごとの1日の回数上限**
  - 開示の更新
  - 25秒のタイムアウトに収まるかの実測（Opus は常に思考するため、effort low から測る）
- POSTONA に「ニュース投稿」や「投稿評価」の新機能を作る場合は、この Phase の後に新規機能として別途設計する。

### 対象外（OpenAI のまま）

- 朝の挨拶画像（`gpt-image-2`）
- web_search 系
- MIC（RPC がモデル名を直書き）
- かぶモリ X の旧経路とお役立ち投稿など
- このため `OPENAI_API_KEY` は今後も必要。

---

## 7. 機能別の実装難易度

| 項目 | 難易度 | 主な理由 |
|---|---|---|
| Phase 1a ライブラリ | 中〜高 | 純コードだが、エラーと予備の判断表の正しさが要 |
| Phase 1b DB 予算 | **高** | migration、RPC（SECURITY DEFINER）、同時実行、RLS |
| Phase 2a 共有市況レポート | 中 | 登録表と実測比較がすでにある。PR #110 との順序の問題だけ |
| Phase 2b 個別レポート | 中 | 開示の更新と費用の判断 |
| Phase 3a 判定 | 中 | 注入可能な runner がある。CHECK 制約の migration |
| Phase 3b 生成 | 中〜高 | Fact retry の分類、PR #116 との競合、品質評価 |
| Phase 3c アプリ用コピー | 低〜中 | |
| web_search の移行 | **高** | 出典検証の作り直し（今回は推奨しない） |
| Phase 4a/4b | 低〜中 | 小さい関数 |
| Phase 4c | 中〜高 | x-test-post の本番デプロイ |
| Phase 5 AI相談 | 中 | 遅延、利用上限、開示 |
| MIC | 中〜高 | RPC の照合と多数のリテラル検査（対象外） |

---

## 8. 担当の推奨割当

> **2026-10-10 追記:** ユーザーの指示により、この作業は G1〜G5 とは別の**専属の流れ**として進める。共通AI基盤担当のくろちゃん（Claude）と、専属のちゃ（ChatGPT）が担当する。下の表は、専属の流れを前提に書き直した案。最終的な割当は専属のちゃが決める。

| Phase | 推奨 | モデル | 他スロットとの調整 |
|---|---|---|---|
| 1a | **共通AI基盤くろちゃん** | Opus5.5（高） | 不要（新規ディレクトリだけ） |
| 1b | 共通AI基盤くろちゃん | Opus5.5（高） | DB と RPC は Codex レビューが必須。本番の DDL 区間は G5・G4 と直列化する |
| 2a | 共通AI基盤くろちゃん。または G2 へ依頼 | Opus5.5（高） | **PR #110 と T1 は G2 の所有物。** それらの merge 後に、G2 の作業が止まっていることを確認してから着手する |
| 2b | 共通AI基盤くろちゃん | Sonnet5（高） | G1 が個別レポートを触っていないか確認する |
| 3a〜3c | 共通AI基盤くろちゃん | Opus5.5（高） | PR #116 の決着を待つ |
| 4a〜4c | 共通AI基盤くろちゃん。または G4 へ依頼 | 4a/4b は Sonnet5（高）、4c は Opus5.5（高） | brand 生成器と x-test-post は G3/G4 の領域。4c の本番デプロイは G3/G4 と調整する |
| 5 | 共通AI基盤くろちゃん。または G3 へ依頼 | Opus5.5（中） | PR #114 の merge 後 |

- 既存の G1〜G5 と H1/H2 の TASK・Report は書き換えない。
- 他スロットの PR が触っているファイルは、そのスロットの作業が終わるまで編集しない。
- G5 は使わない（共通アカウントの critical path のため）。
- Codex（H1/H2）には、1b、2a の本番ゲート、4c、3a の migration のレビューを依頼する。返却先（`return_to`）は「共通AI基盤のちゃ」とする想定（専属のちゃが確定する）。

## 9. 他スロット・未マージ PR との競合

- **今すぐの競合はない:** Phase 1a は新規ディレクトリだけを追加する。
- **順序で解消するもの:**
  - 2a は PR #110 と T1 の後。
  - 3b は PR #116 の後。
  - 5 は PR #114 の後。
  - 4c は x-test-post の他の未デプロイ変更と調整する。
- **本番 DDL の直列化:** 1b と 3a の migration は、G5（PR #112）と G4（PR #106）の migration 適用区間と重ねない。
- **secret の登録:** 全関数のバージョンが上がるため、他スロットのデプロイ照合と時期を調整する。
- **PR #115:** 比較ツールは tools に残す。共通層とファイルの重複はない。重複実装を避けるため、#115 の所有者（B担当）に「本番部品は `_shared/ai` が正本」と共有する。
- **既存の価格表・登録表を持つファイル:** Phase ごとの担当が共通カタログへ寄せる。同時に複数の枠が触らないよう、Phase と対象ファイルを1対1にする。

## 10. 推奨する実装順

1. **（今すぐ・並行可）** 共通AI基盤くろちゃんで Phase 1a を行う。
2. G2: PR #110 のレビュー・merge → T1（誤検知の修正）。
3. 共通AI基盤くろちゃんで Phase 1b → Codex レビュー → 本番適用（ユーザー、DDL の直列化）。
4. ユーザーによる Console の準備:
   - クレジットの紐づけと残高の確認
   - 専用ワークスペースと使用上限
   - 鍵の発行
   - secret の登録（時期を調整）
5. 共通AI基盤くろちゃん（または G2 へ依頼）で Phase 2a:
   1. `openai_only` で載せ替えてデプロイし、バイト単位で照合する。
   2. Opus を主にする。
   3. 1〜2週間観察する（配信成功率、Fact 合格率、予備の発生数、日ごとの費用）。
6. Phase 3a → 3b → 3c（PR #116 の決着後）。
7. POSTONA: Phase 4a（費用記録の開始）→ 1週間以上の計測 → 4b → 4c。Phase 5 は G3 の PR #114 の後。
8. Phase 2b は、開示とモデルの判断ができ次第。

## 11. テスト・レビュー計画

**Phase 1a**（ネットワークなし、`deno test --no-config`、lint の件数は main と比べる）:

- 両 provider のリクエストのゴールデン JSON（Anthropic 側に temperature や `thinking.disabled` を送らないことも含む）
- 応答の解析: thinking block が先頭に来る場合、複数の text block、usage のキャッシュ値と iterations
- エラー分類の網羅表:
  - 402 `billing_error`、400 のクレジット文言、429 の rate、429 の spend limit、429 `insufficient_quota`
  - 529、500、タイムアウト、ネットワーク
  - refusal、`max_tokens`、`pause_turn`、OpenAI の incomplete と refusal
- 再試行と期限: 回数の上限、retry-after の上限、期限超過で打ち切ること、タイムアウトは再試行しないこと
- 予備の判断表: 往復しないこと、予備の予算拒否、遮断中は主を飛ばすこと
- schema_adapter: 制約を外したあと、ローカル再検証が違反を検出すること
- 費用: 単価、長文脈 tier、キャッシュの書き込み・読み取り、web 検索の料金。全ルートのモデルがカタログにあること
- 隔離:
  - アプリへの import がないこと
  - 鍵の文字列がないこと
  - モデル名リテラルのガード（`gpt-` と `claude-`）
  - ログに本文やヘッダーがないこと（redact テスト）

**Phase 1b:**

- ローカル PG17 による証明（記憶のレシピ: 短い /tmp ソケット、`lc_messages=C`）
- 同時予約の競合テスト
- mutation テスト
- RLS と grant の catalog 照合
- **Codex レビュー**

**Phase 2 以降:**

- 本番前に、PR #115 のツールで記録済みの入力を使ったオフライン比較を行う。**有料。予算はユーザーが事前承認する**（README の見積りは約 $1.6〜3.3）。
- `openai_only` での載せ替え時は、出力・費用・診断が変わらないことを回帰テストで確認する。
- 本番の観察指標:
  - 配信成功率、Fact 合格率、作り直しの回数
  - 予備の発生率とその理由
  - 1日の計測額
  - 遅延の p90
- 切り戻しの手順（DB による即時停止）を、デプロイ前に確認する。

**レビュー頻度**は PROJECT_RULES の方針に従う。

- DB・RPC・本番ゲートは Codex がレビューする。
- プロンプト・UI・局所変更は、Claude の実装と ChatGPT の確認で進める。

## 12. 費用の見積りと予算の目安

すべて推定。Claude のトークン数は、同じ文章でも OpenAI の 1.0〜1.35倍になり得る。thinking も出力として課金される。

単価の比較（入力/出力）:

- Opus 5.5 は **Sol（`gpt-6.1-sol` / `gpt-6-sol`）のちょうど2倍、Luna の40倍**。
- Haiku 5.5 は **Luna と同額**、Sonnet 5.5 は Sol と同額。

| 移行対象 | 現在（月換算） | Opus 5.5 にした場合 | 備考 |
|---|---|---|---|
| 共有市況レポート（K1/K2） | Sol 約 $3（やわらかいプロンプト） | **約 $11（実測）**、誤検知の修正後は約 $8 | G2 の実測（4本） |
| 重要ニュースの Sol 詳細判定（N4） | 約 $8.7 | 約 $17〜24（2〜2.7倍の機械換算） | PR #115 のシミュレーションは思考を多めに見て $39.9 |
| 重要ニュースの下書き（N5） | 約 $0.49 | 約 $19〜26 | 取りこぼし削減の効果と比べて判断する |
| 重要ニュースの Fact・voice・retry（N6/N7） | 約 $0.6 | 約 $24〜33 | **非推奨**（Luna のまま。Haiku 5.5 なら同額） |
| 重要ニュースの一次判定とトリアージ（N3/N1） | 約 $1.7 | 約 $67〜90 | **非推奨** |
| アプリ用コピー（N8） | 約 $0.03 | 約 $1.3 | 少額 |
| POSTONA の AI相談（1回） | 約 $0.0009 | 約 $0.03 以上 | 利用者100人 × 10回/日なら月 $900 以上。**上限なしでは不可** |
| POSTONA の投稿生成（1件） | 約 $0.0004 | 約 $0.015〜0.02 | 利用者数に比例。上限が必須 |

**$100 に収まる推奨構成**（上限の範囲で約 $45〜60 + POSTONA 枠）:

- 市況レポート（約 $8〜11）
- 重要ニュースの詳細判定（約 $17〜24）
- 重要ニュースの下書き（約 $19〜26）
- 残りを POSTONA（上限つき）と評価・予備に充てる

ユーザーの「Opus 5.5 を主力候補」の方針と、高頻度の処理を Luna または Haiku 5.5 に残すこととの調整は、**ChatGPT とユーザーの判断事項**。

## 13. 未解決のリスク

1. **クレジットが未確認:** Max 5x の $100 が、どの Console 組織に紐づいているか、残高、tier、ワークスペースの使用上限。Phase 2 の本番前に必須。
2. **クレジット切れのエラーの形が実地で未確認:** 402 `billing_error` か、400 の文言か。分類は両方に備えるが、Phase 2 の観察で確認する。
3. **予算の超過:** Opus を高頻度の処理へ広げると $100 を超える（§12）。ルートごとのモデル選択と上限で管理する。
4. **遅延:** Opus は常に思考する。市況レポートは90秒、AI相談は25秒の上限に収まるかを実測する必要がある。
5. **構造化出力の差:** 外した制約は、ローカル再検証で補う必要がある。
6. **プロンプトへの反応の差:** 誤検知による作り直しの増加（G2 の所見）。T1 と T3 が前提。
7. **refusal の誤検知:** 低確率。サーバー側のフォールバックと Sol の予備で受ける。
8. **秘密情報の運用:** secret の登録が全関数のバージョンに影響する。鍵の分離。
9. **開示:** プライバシーポリシーと POSTONA の開示の更新（2b・5 の前提）。
10. **DB の制約:** 重要ニュースの CHECK 制約、MIC の RPC のモデル照合。
11. **価格表の不整合:** 移行と同時に統一しないと、費用記録が食い違う。
12. **POSTONA の上限がない:** AI相談と生成に、利用者単位の上限が必要。
13. **web_search は移さない前提:** 将来移す場合は出典検証の作り直しが必要。PR #115 の報告書のツール版（`web_search_20260318`）は、手元の参照（`web_search_20260209`）と食い違っており、要確認。
14. **X ゲートの本番値が不明:** K5 の旧経路が今も動いているかは本番の読み取りが必要。
15. ~~Sonnet 5.5 のキャッシュ単価の食い違い~~ → 解消。公式の値は $0.10（2026-10-10 確認）。

## 14. 次の実装 TASK 案

### 14.1 Phase 1a（共通AI基盤くろちゃん）— そのまま指示として使える案

```text
- task_id: ai-provider-foundation-phase1a-20261010
- owner: claude（共通AI基盤くろちゃん。G スロットの外の専属の流れ）
- status: ready（専属のちゃが着手を指示した時点）
- next_owner: claude
- recommended_model: Opus5.5（高）
- review: Phase 1a は既存コードを変更しない純ライブラリのため、ChatGPT 確認でよい（Codex は 1b でまとめて行う）

## 目的
かぶモリと POSTONA が OpenAI と Anthropic を安全に切り替えて使うための共通 AI 層を、
supabase/functions/_shared/ai/ に新設する。今回はどこからも import しない（本番影響ゼロ）。
設計は docs/ai-provider/PHASE0_DESIGN.md の §5 に従う。

## 作業場所
/Users/yuya/Developer/kabumori-fresh で fresh origin/main を確認し、専用の新規 worktree を作る。
他スロットの worktree・branch には触れない。

## 変更範囲（新規ファイルのみ）
supabase/functions/_shared/ai/
  types.ts, model_catalog.ts, routes.ts, errors.ts, retry.ts, schema_adapter.ts,
  cost.ts, budget.ts, usage.ts, redact.ts, router.ts,
  providers/openai_responses.ts, providers/anthropic_messages.ts,
  各 *_test.ts, isolation_test.ts
docs/ai-provider/PHASE1_FOUNDATION.md
既存ファイルの変更: 0（PR #115 からの取り込みはコピーし、出所をコメントに書く）

## 仕様の要点
1. callAi(routeKey, request, deps)
   - deps で fetch・Anthropic クライアント・予算・台帳への書き込み・時計・logger を注入する
   - 結果はニュートラルな型で返す
2. model_catalog
   - 価格（入力、出力、キャッシュ読み、キャッシュ書き 5分/1時間、長文脈 tier）、能力、出所、検証日
   - Claude の価格は公式の価格ページで再確認し、verifiedOn を入れる
3. routes
   - 本番ルートは0件。テスト用ルートだけを置く
   - モードは openai_only と anthropic_primary
   - 全ルートのモデルがカタログにあることをテストで保証する
4. Anthropic アダプタ
   - npm:@anthropic-ai/sdk を固定版で使う。maxRetries:0、ルートごとの timeout
   - thinking は省略、temperature は送らない
   - output_config.effort と output_config.format（json_schema）
   - system を配列にして cache_control を付ける
   - content は type で読む
   - stop_reason（refusal、max_tokens、pause_turn）を扱う
   - usage（input、cache_read、cache_creation、output、iterations）を取る
   - request-id を取る
   - サーバー側の refusal フォールバックは、ルートの設定でオン・オフできるようにする
5. OpenAI アダプタ
   - 既存の Responses 形（store:false、text.format strict、reasoning.effort、max_output_tokens）
   - incomplete と refusal の検出
   - cached_tokens と reasoning_tokens の取得
6. errors
   - 設計 §5.5 の表のとおりに分類する
   - SDK の型付き例外と error.type を使う。文字列照合は課金系の補助判定に限る
7. retry と フォールバック
   - 主・予備とも最大2回、往復しない、deadlineMs を厳守する
   - タイムアウトは再試行しない（推定額を記録する）
8. schema_adapter
   - 非対応の制約を外し、外した制約をローカルで再検証する
   - additionalProperties が false 以外なら例外
9. budget
   - interface と、メモリ実装（テスト用）
   - RPC クライアントは型と雛形だけ（DB は 1b）
   - 予算判定に失敗したら Claude を呼ばない（fail-closed）
10. usage
   - ai_usage_events に書く行の組み立て（1b の列を想定した型。1a では書き込まない）
11. redact と ログ
   - 本文・ヘッダー・鍵はログに出さない。エラー本文はマスクして400字まで

## 禁止
- 既存ソースの変更、既存 TASK と Report の上書き、merge、deploy、migration
- Supabase の設定や secret の変更、API キーの登録や表示
- 有料 API の呼び出し（テストはすべて fetch を注入。npm パッケージの取得は可）
- 本番の AI 生成や X 投稿

## テストと確認
- deno test --no-config -A supabase/functions/_shared/ai がすべて PASS
- ネットワークを遮断した状態でも PASS（テストが外部へ出ないこと）
- deno lint の件数を main と比べる
- 設計 §11 の Phase 1a の観点を網羅する
- SDK を import した Edge bundle が作れることをローカルで確認する
  （deno check、または supabase functions serve で import だけを確認。本番デプロイはしない）
- 秘密情報スキャンと diff-check

## 完了条件
- PR 作成（draft 可）。CI が緑
- Report に task_id、result、changed_files、tests、commit_hash、push、deploy（0）、
  remaining_issues、safety_checks、next_recommendation を書く
- status を review_required、next_owner を chatgpt にする
```

### 14.2 Phase 1b（共通AI基盤くろちゃん、1a の後）— 概要

- **migration 1本:**
  - `ai_usage_events` に列を追加（後方互換）
  - 予算用の4表、RPC 3本（SECURITY DEFINER、search_path 固定、service_role のみ）、view
  - RLS は有効にし、anon と authenticated は revoke、管理者は select のみ
- **ローカル PG17 による証明:**
  - 同時予約が上限を超えないこと
  - 失効の処理
  - 既存の書き手（重要ニュース、MIC の RPC）が無変更で動く回帰
  - mutation テスト
- **Codex レビュー**の後、本番適用はユーザーが実行する（DDL の区間は G5 などと直列化）。
- **予算プールの初期値**（§5.8）は ChatGPT とユーザーが決める。Claude 枠は「無効」で作り、Phase 2 のゲートで有効にする。

### 14.3 Phase 2a（PR #110 → T1 の後）— 概要

- 共有市況レポートの生成と Fact を `callAi` へ移す（まず `openai_only`）。
- 次に、Opus 5.5 を主、`gpt-6.1-sol` を予備にする。
- Opus 向けのプロンプト調整（T3）を行う。
- `report_diagnostics` に provider と予備の情報を追加する。
- デプロイは `market-report-analysis` だけ。本番ゲートは Codex。1〜2週間観察し、切り戻し手順を用意する。

---

## 付録 A. 本番の読み取り専用確認（ユーザーが実行する）

自動モードでは本番 DB を読めないため、必要に応じてユーザーが実行する。集計だけで、個人データは出力しない。

```sql
-- A1. 過去30日の機能別 AI 費用（重要ニュース・MIC・shadow）
select feature, model, count(*) as calls,
       sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens,
       sum(web_search_calls) as web_search_calls, round(sum(cost_usd), 4) as usd
from public.ai_usage_events
where created_at >= now() - interval '30 days'
group by feature, model
order by usd desc;

-- A2. 共有市況レポートの1本あたりの実績（過去30日）
select report_type, model, count(*) as packets,
       round(avg(generation_calls), 2) as avg_calls,
       round(avg(input_tokens)) as avg_in, round(avg(output_tokens)) as avg_out,
       round(avg(api_cost_usd), 4) as avg_usd, round(sum(api_cost_usd), 4) as total_usd
from public.market_report_packets
where created_at >= now() - interval '30 days'
group by report_type, model;

-- A3. 個別レポートの実績（過去30日。利用者は数えるだけ）
select report_type, model_used, status, count(*) as reports,
       count(distinct user_id) as users,
       round(avg(input_tokens)) as avg_in, round(avg(output_tokens)) as avg_out,
       round(sum(api_cost_usd), 4) as total_usd
from public.personalized_reports
where created_at >= now() - interval '30 days'
group by report_type, model_used, status;

-- A4. X 共有経路のゲートの現在値
select x_enabled, app_enabled from public.market_report_consumer_settings;
```

（A4 のテーブル名と列名は migration `20260920100000…:165-166` による。本番で実行する前に、列の存在を確認すること。）

## 付録 B. Claude API について確認した事実（2026-10-06 時点の Anthropic 公式の参照による）

- **Opus 5.5:**
  - 識別子は `claude-opus-5-5`。料金は入力 $4 / 出力 $20、キャッシュ読み $0.20、キャッシュ書き（5分）$5、（1時間）$8、batch は $2/$10。
  - 文脈は1M、最大出力は128K。
  - 思考は常にオンで、effort の既定は medium。
  - 送ると400になるもの: temperature、top_p、prefill、強制 tool_choice、`thinking.disabled`、budget_tokens。
  - 安全分類による refusal（200 応答で `stop_reason:"refusal"`）があり得る。
- **構造化出力:**
  - `output_config.format` で `{type:"json_schema", schema}` を指定する。
  - 非対応: 数値の最小・最大、文字列の長さ、複雑な配列制約、再帰。`additionalProperties` は false が必須。
  - 初回にスキーマのコンパイルによる遅延があり、24時間キャッシュされる。
  - citations とは併用できない。
- **エラー:**
  - 400 `invalid_request_error`、401、402 `billing_error`、403、404、413
  - 429 `rate_limit_error`（`retry-after`）
  - 500 `api_error`、529 `overloaded_error`
- **usage:**
  - `input_tokens` はキャッシュされなかった残りだけ。
  - 総入力は `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`。
  - `output_tokens` には思考が含まれる。
- **キャッシュ:** Opus 5.5 の最小単位は 512 トークン。書き込みは5分で1.25倍、1時間で2倍。読み取りは 0.05倍（Opus 5.5）。
- **SDK:** TypeScript SDK の既定は `maxRetries: 2`（408/409/429/5xx を自動で再試行する）。共通層の上限つき再試行と二重にしないため、0 にする。
