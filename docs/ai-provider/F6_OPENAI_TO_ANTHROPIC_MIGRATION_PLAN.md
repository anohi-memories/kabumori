# F6 — OpenAI から Anthropic（Claude）への全面移行：棚卸しと段階計画（POSTONA 優先）

- 作成: 2026-10-15 JST（F6）
- task_id: `common-ai-f6-openai-anthropic-migration-inventory-20261015`
- 範囲: 調査と計画だけ
  - ソースの変更、本番の変更、実 API の呼び出しは 0
  - 本番は読み取りだけ（Cron の名前・時刻・有効かどうか、関数の一覧、費用の集計、Secret の名前）
- かぶモリの運用休止は G1 の担当。この文書は休止の操作をしない

## 0. 要約

- OpenAI を呼んでいる箇所は **全部で 30**（`main`、2026-10-15 時点）
  - POSTONA 2（AI 相談と、投稿文の生成部品。生成部品は 3 つの経路から使われる）
  - かぶモリ 27
  - 共通AI基盤の OpenAI の adapter 1（本番では使われていない）
- 使い方
  - 画像の編集 1 か所（朝のあいさつ画像、`gpt-image-2`）を除き、すべて Responses API
  - Web 検索のツールを使う箇所が 7（速報、shadow、探索、X の豆知識、X の朝・引け・米国の素材集め）
  - embeddings、Chat Completions、streaming は無い
- 既存の経路で、別のモデル・provider への自動切り替えをしているものは無い
  - モデルは、ソースの直書きか、2 つの登録表（`_shared/social_ai_model_policy.ts`、`_shared/kabumori_ai_models.ts`）で決まっている
- **POSTONA の AI は、共通AI基盤も予算台帳も通っておらず、費用は記録されていない**
  - 相談は console のログだけ
  - 投稿文の生成は費用を計算するが、どこにも保存しない
- POSTONA を先に移すのは、技術的には一番やさしい
  - 呼び出しは 2 種類だけで、Web 検索を使わない
  - 相談はすでに strict な JSON Schema を使っている
  - 先に要るもの: 費用の記録の仕組み（ブランドの ID が UUID でない問題）、投稿文の自由文を JSON で包む形、時間の上限
- かぶモリは G1 の運用休止の計画と重なる。休止の決定を待ってから順番を決める
  - 移す価値が最も大きいのは MIC（10月の記録額の約 6 割）
  - Web 検索を使う経路は、F6 の共通AI基盤にツールの対応を足してから
- **置き換えられないもの**: 朝のあいさつ画像（Claude に画像の生成・編集は無い）

## 1. POSTONA の呼び出し（優先して移す）

| # | 呼び出し（ファイル） | 今のモデル（`social_ai_model_policy.ts`） | 出力の形 | 時間 / 再試行 | 費用の記録 | 起動 | 主体 | 移行先の案 |
|---|---|---|---|---|---|---|---|---|
| P-A | AI 相談 `social-mobile-consult/logic.ts:474-504` | `postonaConsult` = gpt-6-luna、effort low、出力 900 | strict JSON Schema `social_mobile_consult` | 25 秒 / 再試行なし（アプリで手で再送） | **無し**（console のログにトークン数だけ） | アプリからの呼び出し | 利用者（JWT）と、その人のブランド | Haiku 5.5 と Sonnet 5.5 を比べて決める。決まりで両方を許し、既定は Haiku |
| P-B | 投稿文の生成部品 `_shared/brand/brand_post_generator.ts:171-187` | `brandPostGeneration` = gpt-6-luna、effort low、出力 600（長さ無制限のときは 2,000） | 自由文（文字数と NG ワードを後で検査） | **時間の上限なし** / 再試行なし | 計算するが **保存しない** | 下の 3 経路 | 渡されたブランド | Sonnet 5.5 か Haiku 5.5（比べて決める）。`{ text }` の JSON で包む |
| P-B1 | 試し投稿 `social-mobile-brand-dry-run`（P-B を 1 回） | 同上 | 同上 | 同上 | 無し | アプリからの呼び出し | 利用者と、X を連携済みのブランド | 最初に移す |
| P-B2 | 利用者のブランドの予約投稿 `vault_account_brand_post.ts`（`x-test-post` の中、140 字） | 同上 | 同上 | 同上 | 無し | `dispatch-scheduled-posts` → `x-test-post` | 利用者のブランドを system として実行（今は休眠） | 予約投稿の権限の窓（F3 / F5）が開く前に移す |
| P-B3 | 会社員AIらぼの予約投稿 `ai_lab_scheduled_brand_post.ts`（`x-test-post` の中、最大 3 回の作り直し） | 同上 | 同上 | 同上 | 無し | 同上 | 運営のブランド（system） | P-B1 の後 |

- 注意 1: P-B2 と P-B3 は `x-test-post`（かぶモリの X 自動投稿）の中で動く
  - `x-test-post` は起動のときに `OPENAI_API_KEY` を要求する
  - かぶモリの休止の候補（#213）とも同じ関数
  - deploy すると、main に溜まった未 deploy の変更が一緒に出る。担当どうしの調整が要る
- 注意 2: POSTONA のブランド ID は UUID ではない。台帳の `brand_id`（uuid）にそのまま入らない（H5 の #198 も指摘している）
- 注意 3: プライバシーの説明
  - かぶモリの `privacy.html` は、処理の委託先に OpenAI を挙げている
  - POSTONA 側には、該当する記述が見つからなかった
  - 委託先を Anthropic に変えるなら、両方の表記を確かめる

## 2. かぶモリの呼び出し（G1 の休止の計画と合わせて順番を決める）

| 区分 | 呼び出し（関数・ファイル） | 今のモデル | 出力 | Web 検索 | 費用の記録 | 起動・状態 | 移行先の案 |
|---|---|---|---|---|---|---|---|
| ニュース | 重要度の判定 `important-news-monitor/importance_judgement_logic.ts:216` | gpt-6-luna → 必要なら gpt-6-sol | strict | なし | 候補の表と `ai_usage_events` | Cron `important-news-judgement`（ON） | Haiku 5.5 → Sonnet 5.5 |
| ニュース | 投稿文と、事実・声の検査 `post_generation_logic.ts:1574` | gpt-6-luna | strict（4 種） | なし | 同上（単価の計算が古い。下の §10） | Cron `important-news-generation`（ON） | Sonnet 5.5 / Haiku 5.5 |
| ニュース | アプリ用の文 `app_copy_logic.ts:400` | gpt-6-luna | strict（2 種） | なし | `ai_usage_events`（候補の表にトークンの列なし） | 同上 | Haiku 5.5 |
| ニュース | 見出しの振り分け `headline_trigger_logic.ts:379` | gpt-6-luna | strict | なし | `ai_usage_events` | Cron `important-news-fetch`（ON） | Haiku 5.5 |
| ニュース（検索） | 速報の検索 `breaking_market_source_fetchers.ts:871` | gpt-5.6-luna | strict | **あり**（ドメイン指定、1 回） | `ai_usage_events`（検索 1 回 $0.01） | 同上 | 共通AI基盤のツール対応の後に、Haiku か Sonnet と `web_search` |
| ニュース（検索） | shadow の確認検索 `important-news-shadow/index.ts:58` | gpt-5.6-luna | 自由文 | **あり** | 表と `ai_usage_events` | Cron **OFF** | 移さない（止めたまま）でよい |
| ニュース（検索） | 探索の検索 `_shared/news_discovery/web_search.ts:216` | gpt-5.6-luna | strict | **あり**（除外ドメイン） | 表（費用の列なし） | Cron ON。10月の検索は 0 件 | ツール対応の後 |
| MIC | FOMC 声明の解釈 `mic_fed_statement_ai_logic.ts:96` | gpt-6-luna | strict | なし | `ai_usage_events`（DB の関数が `gpt-6-luna` を要求） | 手動のみ | Sonnet 5.5（DB の変更が要る） |
| MIC | 市場の状態の評価 `mic_state_ai_logic.ts:193` | gpt-5.6-luna → gpt-5.6-sol | strict（**出力の上限なし**） | なし | `ai_usage_events` | Cron `mic-evaluator-*`（ON） | Haiku 5.5 → Sonnet 5.5。出力の上限を決める |
| MIC | シナリオの評価 `mic_scenario_ai_logic.ts:316` | gpt-5.6-luna → gpt-5.6-sol | strict | なし | `ai_usage_events` | Cron `mic-scenario-*`（ON） | Haiku 5.5 → Sonnet 5.5 |
| 市況レポート | 生成と Fact `market-report-analysis/handler.ts:115` | gpt-6.1-sol（**今は `primary_both` で Claude Opus 5.5**） | strict | なし | packet、診断、台帳（Claude） | Cron ON | **移行済み**（Opus）。OpenAI の経路は戻すときのために残す |
| アプリ | 個別レポート `personalized-reports/report_logic.ts:1500`（とオンデマンドの worker） | gpt-6-luna | strict | なし | `personalized_reports` | Cron **OFF**（worker は未 deploy） | 再開のときに Sonnet 5.5 / Haiku 5.5 |
| X（かぶモリ） | 豆知識（`index.ts:830`、検索あり）、tip（:1248）、交流（:1354）、朝・引け・米国の素材集めと文章（:1637・1935・2165・2396・2488・2614）、声の評価と書き直し（:2833・2991・3026）、試しの文（:2790）、朝のあいさつの文（`morning_greeting_logic.ts:365`） | gpt-6-luna（一部 gpt-6.1-sol） | strict | 豆知識と素材集めは **あり** | 一部の表だけ（tip・交流・あいさつ・試しの文・書き直しは **記録なし**） | `dispatch-scheduled-posts`（ON）。朝・引けのレポートは、共有の市況レポートのゲートが ON の間は使われない | G1 の休止の判断の後。文章は Sonnet / Haiku、検索はツール対応の後 |
| X（かぶモリ） | 朝のあいさつ画像 `morning_greeting_image_logic.ts:138`（GitHub Actions） | gpt-image-2（画像の編集） | 画像 | — | 記録なし | GitHub Actions の Cron | **置き換え不可**（OpenAI のまま、または別の画像サービス） |

- 行番号は `main`（`c0b6ae9f` 時点）のもの。X の行は `x-test-post/index.ts` の行番号
- 共通AI基盤の OpenAI の adapter（`_shared/ai_provider/openai_adapter.ts`）は、本番では使われていない


## 3. 本番の状態（読み取り、2026-10-15 23:30 JST ごろ）

### Cron（AI に関係するもの。JST）

| Cron | 時刻 | 有効 | 呼ぶ関数 |
|---|---|---|---|
| `important-news-fetch` | 10分ごと | ON | important-news-monitor（取得。速報の Web 検索を含む） |
| `important-news-judgement` | 毎時 7・27・47 分 | ON | important-news-monitor（重要度の判定） |
| `important-news-generation` | 毎時 14・34・54 分 | ON | important-news-monitor（投稿文・アプリ用の文） |
| `important-news-publish-ready` | 5分ごと | ON | important-news-monitor（公開） |
| `important-news-shadow` | 10分ごと | **OFF** | important-news-shadow |
| `news-discovery-observer-official` | 毎時 1・16・31・46 分 | ON | news-discovery-observer |
| `mic-ingest-*`（6種）/ `mic-evaluator-*`（12本）/ `mic-scenario-*`（2本） | 平日の各時刻 | ON | market-intelligence-ingest / state-evaluator / scenario-evaluator |
| `market-report-data-packet-*` / `market-report-analysis-*` | 朝 07:50・07:55・08:05、引け 16:15・16:20・16:35 | ON | 共有の市況レポート（**今は Claude Opus が生成**） |
| `market-report-broadcast-worker` | 毎分 | ON | 市況レポートの push |
| `dispatch-scheduled-posts` | 毎分 | ON | x-test-post（かぶモリの X 自動投稿） |
| `personalized-reports-morning` / `-close` | 08:35 / 17:15 | **OFF** | personalized-reports |
| `send-push-notifications-dispatch` | 毎分 | ON | send-push-notifications（AI なし） |

- POSTONA の AI（相談、投稿文の生成、学習）は Cron ではなく、アプリからの呼び出しで動く（§1 の表）

### 関数（23個）

- AI を使うもの
  - important-news-monitor v104（10/07）
  - important-news-shadow v27
  - market-intelligence-ingest v51
  - market-intelligence-state-evaluator v36
  - market-intelligence-scenario-evaluator v15
  - market-report-analysis v35（10/14）
  - news-discovery-observer v16
  - personalized-reports v46
  - x-test-post v145（10/08）
  - social-mobile-consult v5
  - social-mobile-brand-dry-run v21
  - social-mobile-history-learning v21
  - brand-post-dry-run v29
- 使い方は §1 の表

### 10月の AI の利用（10/1〜10/15、記録のある表だけ）

| 用途（表） | モデル | 回数 | 入力 / 出力トークン | 費用（記録値） |
|---|---|---|---|---|
| MIC（`ai_usage_events`） | gpt-5.6-luna | 472 | 537万 / 11万 | $6.15 |
| 〃 | gpt-6-luna | 3,909 | 822万 / 76万 | $1.20 |
| 〃 | gpt-6-sol | 580 | 111万 / 15万 | $3.75 |
| 〃 | gpt-5.6-sol | 2 | 0.5万 / 0.3万 | $0.12 |
| 重要ニュースの判定（`important_news_candidates`） | gpt-6-luna | 1,354 | 278万 / 20万 | $0.38 |
| 〃 | gpt-6-sol | 580 | 214万 / 28万 | $3.91 |
| 重要ニュースの投稿文 | gpt-6-luna | 423 | 371万 / 26万 | $1.05 |
| 重要ニュースのアプリ用の文 | gpt-6-luna | 39 | 記録なし | 記録なし |
| 重要ニュースの shadow（`important_news_shadow_runs`） | （記録なし） | 724 | 20万 / 0.7万 | $0.75 |
| 共有の市況レポート（`market_report_packets`） | gpt-6.1-sol / gpt-5.6-luna | 12 | 25万 / 6万 | $0.64 |
| 〃（Claude） | claude-opus-5-5 | 5 レポート（台帳では 13 回） | 14万 / 4万 | $1.38 |
| アプリの個別レポート（`personalized_reports`） | gpt-6-luna | 15 | 16万 / 1.6万 | $0.02 |
| かぶモリの X 自動投稿（`post_execution_logs` ほか4表） | gpt-5.6 / gpt-6 | 約 40 | — | 約 $1.2 |

- OpenAI の記録額の合計は、約 $19（10/1〜10/15）
  - MIC が約 6 割、重要ニュースが約 3 割
  - Web 検索のツールの費用は、記録に入っていない可能性がある（OpenAI の請求で確かめる）
- **POSTONA の AI の費用は、どの表にも記録されていない**
  - 移行の前に、Anthropic の台帳で計上できるようにする（§5）

## 4. 機能ごとの置き換え可否（OpenAI → Anthropic）

| OpenAI の機能 | Anthropic での対応 | 置き換え |
|---|---|---|
| Responses API の文章生成と、厳密な JSON Schema の出力 | Messages API と `output_config.format`（json_schema） | **可**。F6 の共通AI基盤がすでに対応（スキーマの変換と検査あり） |
| reasoning effort（none〜max） | `output_config.effort`（low〜max）。思考は adaptive | **可**（`none` は無い。最小は `low`） |
| Web 検索ツール（`web_search`、ドメインの許可・除外） | server tool `web_search_20250305` / `20260209` / `20260318`。`allowed_domains` か `blocked_domains`（両方は 400）、`max_uses`。1,000 回あたり $10 と、結果のトークン | **可だが、F6 の共通AI基盤は未対応**（ツール、`pause_turn`、結果のエラーの扱いが要る）。structured output との併用は要検証 |
| 画像の編集（`v1/images/edits`、朝のあいさつ画像） | Claude に画像の生成・編集は無い | **置き換え不可**。OpenAI を残すか、別の画像サービスにする |
| 埋め込み（embeddings） | Claude に埋め込みは無い | 今は使っていない（該当なし） |
| モデルの自動 fallback | 使わない（利用者の方針） | — |

- Claude のモデルの目安（M1 の決まりの仕組みで、用途ごとに選ぶ）

| モデル | 料金（$ / 100万トークン） | 向いている用途 |
|---|---|---|
| Haiku 5.5 | $0.10 / $0.50（入力 10万トークン超は $0.50 / $2.50） | 分類・判定・短い要約・大量処理 |
| Sonnet 5.5 | $2 / $10 | 投稿文・要約・相談など、品質と速さの両方が要るもの |
| Opus 5.5 | $4 / $20 | 共有の市況レポートのような、重い分析と長い文章 |

## 5. 段階の計画（POSTONA 優先）

### 段階 0 — F6 の下ごしらえ（ソースだけ。POSTONA の移行の前に必要）

| # | やること | 理由 |
|---|---|---|
| 0-1 | #187 → #198 → #205 と、J1 の独立したレビュー（Sol 高）を終えて merge を判断する | 用途ごとのモデルの決まりと、安全の境界の土台 |
| 0-2 | 決まり（model policy）が OpenAI のモデルも扱えるようにする（M2） | **2 段階で移すため**。まず今と同じ gpt-6-luna のまま共通AI基盤を通す（費用の記録、時間の上限、台帳）。次に決まりの設定だけで Claude に切り替える。比べやすく、戻しやすい |
| 0-3 | 自由文を `{ "text": string }` の JSON Schema で包む小さな部品 | 投稿文の生成は自由文。共通AI基盤は structured output が前提 |
| 0-4 | POSTONA の費用の計上の設計（ブランド ID が UUID でない問題） | 台帳の `brand_id` は uuid。利用者（user）で数えて、ブランドは別の識別（ハッシュなど）で残す案など。F5 の共通アカウントの ID との対応も確かめる |
| 0-5 | 台帳の枠の案（相談: 利用者ごと・1日、投稿文: ブランドごと・1日、会社員AIらぼ: system） | 本番の DB の変更なので別承認 |
| 0-6 | `isolation_test.ts` の許可リストに、つなぐ関数のファイルを足す | つなぐ PR と同時に入れる |
| 0-7 | Web 検索のツールへの対応（M3、server tool、`pause_turn`、結果のエラー、費用 $10/1,000 回） | かぶモリの検索の経路の前提。POSTONA には不要 |

### 段階 P — POSTONA（F3 / F4 の担当。F6 は部品と境界を出す）

1. **P1: AI 相談**（`social-mobile-consult`）
   - 呼び出しは 1 つで、strict な JSON Schema・利用者ごと・25 秒と、今の形がそのまま合う
   - 段階 0-2 の「同じモデルで共通AI基盤を通す」→ 費用の記録を確かめる → Haiku 5.5 に切り替えて評価（足りなければ Sonnet 5.5）
2. **P2: 試し投稿**（`social-mobile-brand-dry-run`）
   - 生成部品（P-B）を共通AI基盤に移す。`{ text }` で包み、時間の上限（例: 30 秒）を足す
   - 文字数と NG ワードの検査は今のまま
3. **P3: 会社員AIらぼの予約投稿**
   - P2 の部品を使う。作り直しは最大 3 回のまま（台帳の枠で上限）
   - `x-test-post` の deploy の範囲を、担当どうしで調整する
4. **P4: 利用者のブランドの予約投稿**（休眠中）
   - 予約投稿の権限の窓（F3 / F5）を開く前に、P2 の部品に揃える

### 段階 K — かぶモリ（G1 の休止の判断の後。担当: MIC の担当、F8、F2、X の担当）

| 順 | 対象 | 先に要るもの |
|---|---|---|
| K1 | MIC の状態・シナリオの評価（記録額の約 6 割） | 出力の上限を決める。FOMC の解釈は、DB の関数がモデル名 `gpt-6-luna` を要求しているので migration が要る |
| K2 | 重要ニュースの判定・投稿文・アプリ用の文・見出しの振り分け | `important_news_candidates` のモデル名の規則（OpenAI の 4 種だけ）を変える migration。単価の計算を直す |
| K3 | Web 検索の経路（速報、探索、X の素材集め） | 段階 0-7（ツールの対応）。検索の回数の上限と費用の記録 |
| K4 | X の文章（tip、交流、豆知識、あいさつ、声の評価） | G1 の休止の判断。休止なら移さない |
| K5 | 個別レポート（Cron は OFF） | 再開するとき |
| — | 市況レポート | 移行済み（Opus）。残り: Claude で作る設定でも `OPENAI_API_KEY` を要求する（F2 が直す） |
| — | 朝のあいさつ画像 | 置き換え不可 |


## 6. 安全のための関門（どの段階も共通。それぞれ別承認）

1. **source**: 用途ごとの PR で、決まり（`defineAnthropicModelPolicies`）、スキーマ、テスト（オフラインと mock）を足す
   - 古い経路（OpenAI）は消さず、設定で切り替える。既定は OFF
2. **レビュー**: 認可・予算・テナントに関わるものは Codex（J1 / Sol 高）が見る。同じ実装者が自分で承認しない
3. **台帳**: その用途・モデル・主体（system / user / brand）の枠を、本番の台帳に足す（本番の DB の変更）
4. **隔離テスト**: F6 が `isolation_test.ts` の許可リストに、その関数のファイルと import を足す
5. **deploy**: その関数だけを main から deploy し、本番のバイト列を読み直す
6. **切り替え**: 設定を ON にし、最初の実行を読み取りで確かめる（結果、台帳の確定額、品質）
7. **評価**: 数日、品質と費用を OpenAI の時と比べる（§7）

## 7. 費用と品質の測り方

- 費用
  - Claude は台帳（`ai_ledger.usage_events`）の確定額を、用途（logical role）・モデルごとに集計する
  - OpenAI は今の表の記録額（§3）
  - 同じ期間・同じ回数で比べる
- 品質
  - 用途ごとに、同じ入力で OpenAI と Claude の出力を並べる。評価は、今の検査（スキーマ、事実の検査、禁止表現）の合格率、人の確認、失敗の率で行う
  - 共有の市況レポートは、10/13 からの実運用の記録がある（Fact の合格、配信の有無）
- 速さ: Edge の時間の上限（150 秒の前提）に収まるか。生成の時間を記録する

## 8. 戻し方

- どの用途も、設定を外すと OpenAI の経路に戻る形にする（今の市況レポートと同じ）
- 台帳の枠を止める（`stop`）のは、使いすぎを止める手段。戻す手段ではない（ON のまま止めると、その用途は失敗する）
- 戻した後は、台帳の予約が詰まっていないかを確かめる（`ai_ledger_recover_stale`）

## 9. F3 / F4 への依頼の案（コピー用。割り当ては ChatGPT が行う。F6 は登録しない）

```text
【依頼案 1】POSTONA の AI 相談を Claude へ（担当の候補: F3。F6 の段階 0 の merge の後）
- 対象: supabase/functions/social-mobile-consult（logic.ts の callOpenAiConsultModel）
- 契約: F6 の共通AI基盤の executeWithModelPolicy（または段階 0-2 の OpenAI 対応）を使う。
  role 例 "postona.consult"、feature "postona_consult"、主体は利用者（user）。今の strict JSON Schema、900 トークン、25 秒、再試行なしを保つ。
  自動 fallback なし。設定で OpenAI に戻せること。
- テスト: 今の logic_test / apps の consult テストの OpenAI の mock を、provider の fake に置き換える。
  拒否（決まりの外・予算・キーなし）・時間切れ・スキーマ違反・利用者の取り違えが無いこと。通信禁止で通ること。
- 本番: 台帳の枠（利用者ごと・1日）、isolation の許可（F6）、deploy、設定の ON はすべて別承認。

【依頼案 2】POSTONA の投稿文の生成を Claude へ（担当の候補: F3。依頼案 1 の後）
- 対象: supabase/functions/_shared/brand/brand_post_generator.ts と、その呼び出し元
  （social-mobile-brand-dry-run、ai_lab_scheduled_brand_post.ts、vault_account_brand_post.ts）
- 契約: 自由文を { "text": string } の JSON で包む。時間の上限を足す（例: 30 秒）。
  文字数・NG ワードの検査は今のまま。「長さ無制限」での打ち切りは、Claude では stop_reason max_tokens として扱う。
- 費用: ブランドごとの計上の設計（F6 の段階 0-4）に従う。今は記録されていないので、移す前後で比べられるようにする。
- 順番: 試し投稿 → 会社員AIらぼ → 利用者のブランド（休眠中）。x-test-post の deploy の範囲は担当どうしで調整する。
```

## 10. 見つかった問題（移行とは別に、担当へ）

1. **市況レポートは、Claude で作る設定でも `OPENAI_API_KEY` が無いと止まる**（`handler.ts:240-241`）。戻すためにキーを残すのはよいが、キーが無いと Claude でも動かない（F2）
2. **DB の規則がモデル名を OpenAI に限っている**
   - `important_news_candidates` の `judgement_model` / `generation_model`（migration `20260923035652`）
   - `record_mic_fed_statement_diff_usage`（`gpt-6-luna` を要求）
   - 移すには migration が要る
3. 単価の計算の食い違い
   - 重要ニュースの投稿文の費用は gpt-5.6-luna の単価で、実際（gpt-6-luna）より高く出る
   - MIC は gpt-5.6-sol を $5 / $30 で数え、知らないモデルは 0 にする
4. 費用の記録の漏れ
   - X の tip・交流・あいさつ・試しの文・声の書き直しは、記録されない
   - POSTONA は全部記録されない
   - ニュースのアプリ用の文と、探索の検索には、費用の列が無い
5. 時間の上限が無い: `x-test-post` のすべての呼び出しと、POSTONA の投稿文の生成
6. `x-test-post` の試験用のモード（dry-run など）に、認可の確認が見当たらないものがある（調査ではそこまで確かめていない。担当で確認が要る）
7. 本番に `brand-post-dry-run`（v29、09/13）があるが、リポジトリにソースのフォルダが無い（古い関数が残っている可能性）
8. `news-discovery-observer`
   - コードには「未 deploy・未スケジュール」とあるが、本番は deploy 済みで、Cron も ON
   - 10月の有料の検索は 0 件。検索は OFF とみられる
9. POSTONA のプライバシーの表記に、AI の処理の委託先が無い（変える前に確かめる）

## 11. PR の依存と順番

- 今は全部 Draft・未 merge
  - F6 #187（用途ごとのモデルの決まり）
  - H5 #198（利用側のブリッジ）
  - F6 #205（境界と SDK の守り）
- J1 の独立したセキュリティのレビュー（Sol 高）が終わるまで、統合も本番の切り替えもしない
- その後の PR
  1. F6 M2（段階 0-2〜0-4）
  2. F3 の相談の PR
  3. F3 の投稿文の PR
- 各 PR は、§6 の関門を通る
- 市況レポートの Claude 化（#170・#173・#175・#176）は merge と deploy が済んで、本番で動いている
