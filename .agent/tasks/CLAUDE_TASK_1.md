# Claude Task 1

- task_id: kabumori-home-news-first-ui-implementation-20260928
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（高）
- purpose: ユーザー承認済みの「ニュース中心・AI整理型」トップページを、現在のExpo/React Nativeアプリへ実装可能な形で落とし込む。既存データ取得を再利用し、重要ニュース・保有銘柄ニュース・今日のレポートを整理して見せる。ニュース取得基盤/API最適化/Edge Functionには触れない。

## Previous G1 closure

前G1 `kabumori-ios-internal-visual-qa-build-20260926` は、full-bleed icon修正後の実機確認までユーザーがPASS（「アイコンOK」）しており、icon/splash/onboarding visual QAは完了済み。旧TASKの詳細ReportはGit履歴とCURRENT_STATEに残っている。今回のTASKは別task_idの新規ホームUI実装。

## User-approved product direction

かぶモリはリアルタイム株価を主役にする証券アプリではない。

ホームの価値は、上から自然に:

1. 今日の要点
2. 市場全体の重要ニュース
3. 自分の保有銘柄に関係する最新ニュース
4. 今日ひとつ学ぶ
5. 分からなければAIへ聞く

という体験を作ること。

ユーザーが承認したモックの情報順:
- ヘッダー
- 今日のかぶモリレポート
- 重要ニュース
- あなたの保有銘柄 最新ニュース
- 今日のトピック
- AIに聞いてみる
- 下部ナビ

デザインは白〜アイボリー、淡いミントグリーン、深いブランドグリーン、柔らかい角丸、十分な余白。金融アプリとしての信頼感を優先し、キャラクターは補助に留める。

## Mandatory startup / isolation

1. G1専用の独立worktree / checkoutを使う。同じ作業ディレクトリを他slotと共有しない。
2. `PROJECT_RULES.md`、`.agent/ORCHESTRATION.md`、`.agent/CURRENT_STATE.md`、このTASKを読む。
3. fresh `origin/main` を取得し、開始SHAを記録。
4. `src/app/index.tsx`、`src/components/app-tabs.tsx`、home/dashboard/news/report関連libとtestsを先に確認し、既存挙動を壊さない実装計画を作る。
5. G2は `market-report-analysis` の429/5xx reliability hardening中。G1はそのEdge Function、shared report packet生成、consumer gate、cron、DBを触らない。
6. G3/G4/X/adminのファイル・branch・worktreeを触らない。
7. 他slotの未コミット変更を変更/stage/commitしない。

## Scope

### A. Home screen redesign

主対象は `src/app/index.tsx` と、必要に応じて新規のhome用presentational components/helpers/tests。

現在の「アクショングリッド → 銘柄一覧 → 重要ニュース → 今日のレポート」中心のホームを、承認済みの順番へ再構成する。

#### 1. Header

- かぶモリらしいコンパクトなヘッダー。
- 時間帯に応じた挨拶 + 日付。
- 通知/設定への既存導線は壊さない。
- ファーストビューの高さを使いすぎない。

#### 2. 今日のかぶモリレポート — primary card

このカードをホームの主役にする。

- タイトル: `今日の かぶモリレポート`
- 説明: 「今日の市場とあなたの保有銘柄への影響をAIが整理しました。」相当。
- 2〜3件の「今日のポイント」を表示。
- **各ポイント右端に `>` / chevronを付けない。各ポイントは個別遷移ではない。**
- 詳細遷移はカード下部の `レポートを見る →` CTAへ一本化。
- CTAは表示中の最新/当日レポートへ遷移。レポート無しなら押せるふりをせず、自然なempty state。
- タイトル/説明/ポイント/CTAは画像へ焼き込まずReact Nativeの動的テキストとして実装。
- 1ポイントは最大1〜2行で崩れない。
- 画面幅が狭くてもテキストがキャラクター領域に潜り込まない。

**ポイント生成について重要:**
- page open時に新規LLM/API生成を追加しない。
- `fetchRecentReports()` が返す保存済みcompleted reportの既存fields/body/summaryを確認し、既存構造から安全に抽出できる短い要点だけを使う。
- 2〜3点を安全に抽出できない場合はsummary等の既存保存済みテキストへfail-softし、内容を捏造しない。
- backend/prompt/report generatorの変更はこのTASK外。

#### 3. Character slot

右側に「日替わりミニゆめちゃん＋ロボ」を差し替えられる独立画像slotを設ける設計にする。

ただし:
- 新しいゆめちゃん/ロボ画像をClaudeが勝手に生成・描き直ししない。
- repoに承認済みの独立cutout assetが存在する場合だけ利用可。
- 存在しない場合は、レイアウトを壊さないneutral fallback/空きslotにし、必要asset仕様をReportする。
- onboardingの正本画像を雑にcropして代用品にしない。
- 将来8〜12種類程度を同じ占有サイズで差し替え可能な構造にする。
- キャラはカード主役にしない。

### B. 重要ニュース

既存 `fetchMyImportantStockNews()` の結果を再利用し、新規network callを増やさないことを優先。

- `tracking_type === 'market'` 等、既存feedで市場全体ニュースを識別できる契約を確認して重要ニュース枠に最大3件。
- severity/importance/news_time等の既存metadataを使って、重要度と鮮度が分かるようにする。
- 見出しは2行程度、補足は必要最小限。
- `すべて見る` は既存news画面へ。
- 空データ/取得失敗時もホーム全体を巻き込まずsection単位でfail-soft。

### C. あなたの保有銘柄 最新ニュース

同じ既存news feedを使い、保有銘柄に紐づく新着を最大3件。

- `tracking_type === 'holding'` を基本に、保有銘柄だけを対象。
- 監視銘柄を勝手に「保有」と表示しない。
- 銘柄名/コード/見出し/カテゴリ/更新時刻を表示。
- リアルタイム株価は追加しない。
- item tapは既存 `/news/[id]` 詳細へ。
- section `すべて見る` は既存news一覧へ。

### D. News thumbnail contract / fallback

モックはサムネ付きだが、現在の `ImportantStockNews` には画像URLが常にある前提を置かない。

このTASKではニュース取得基盤やOG scrapingを新設しない。

UI側だけ以下の拡張可能な順序を持てる構造にする:
1. 将来、正規のthumbnail/image URLがfeedへ来た場合は表示可能
2. 無い場合はcategory/source_typeに応じた安全な標準visual/icon
3. それも無ければneutral fallback

禁止:
- article URLをhome側から直接scrape
- 任意外部画像URLを推測
- 企業ロゴを勝手にWeb検索/取得
- image取得のための新規Edge Function/RPC
- API最適化側のimportant-news-monitor変更

**Reportでは、現時点で実サムネmetadataがどこまで存在したかを明記すること。**

### E. 今日のトピック

ユーザー方針:
- 設定で `初心者向け / 中級者向け / 上級者向け`
- 同じテーマでも説明の深さを変えられる将来設計
- ホームにはレベルバッジ + 1件カード

ただし現状repoに日次トピックの正式backend/sourceが無い場合:
- このTASKで新しいLLM生成/DB/RPC/Edge Functionを勝手に作らない。
- reusable TopicCard + typed data contract + loading/empty/future-ready stateまで実装可。
- production表示に「今日生成された」と誤認させる架空ニュース/架空トピックをハードコードしない。
- 既存の安全なソースが見つかる場合のみ実データ接続。
- 必要なbackend/data-source gapをReportへ明記。

### F. AIに聞いてみる

モック同様、home下部に入口を設ける方向。

ただし現時点で正式AI chat route/serviceが無い場合:
- dead button / fake chatを作らない。
- UI shell・質問chipのpresentational componentまでは可。
- 実際に遷移できる既存routeが無ければdisabled/準備状態を明示し、Reportにgapを書く。
- 新規LLM endpoint/Edge FunctionはこのTASK外。

### G. Bottom navigation

現在の `app-tabs.tsx` は Home / 銘柄 / ポート / レポート / 重要ニュース。

承認モックは Home / 銘柄 / レポート / AIに聞く / 設定。

今回は**機能を失う変更やdead tabを作らないことを優先**する。

- AI/設定の正式routeが存在しないなら、無理にtab構成を完成モックへ合わせない。
- portfolio/newsへの既存到達性を消さない。
- home UI実装を先行し、tab差分は「安全に実装できる範囲」だけ。
- 必要な別TASKをReportに明記。
- settings sheetの既存auth/notification/legal/logout導線を壊さない。

## Data / performance constraints

- home open時のnetwork fan-outを増やさない。
- 既存の `Promise.allSettled` とsection-level failure isolation思想を維持/改善。
- 同じimportant-news feedを「市場重要ニュース」「保有銘柄最新ニュース」に再利用し、同一データを二重fetchしない。
- reportは保存済みデータを読むだけ。home render時に生成処理を呼ばない。
- unnecessary pollingは禁止。
- pull-to-refreshは維持可。
- loading skeleton/placeholderは必要最小限でlayout shiftを抑える。

## Visual requirements

- user-approved mockをピクセルコピーするのではなく、実端末/動的データで成立するよう再現。
- white / ivory / pale mint / deep green。
- rounded cards、明確なtype hierarchy、余白。
- iPhone 17 Proを基準にしつつsmall-width iPhoneでも破綻しない。
- font scaling / accessibility labelsを壊さない。
- 重要ニュースのカードは実機で文字が小さくなりすぎないこと。3枚横並びが窮屈なら、1大+2小またはhorizontal scrollなど実装上安全な方を選ぶ。
- point rowsのchevronは**無し**。

## Allowed changes

主に:
- `src/app/index.tsx`
- 新規/既存のhome UI components
- UI presentation helpers/types
- `src/constants` のhome用theme token（必要最小限）
- home/dashboard/news presentationのfocused tests
- `src/components/app-tabs.tsx` は上記navigation制約を守る場合のみ

既存query/read helperのごく小さな整理は、network semanticsを変えない場合のみ可。

## Forbidden

- `supabase/functions/important-news-monitor/**`
- `supabase/functions/market-report-analysis/**`
- personalized report生成ロジック/prompt/Fact/VOICE変更
- DB schema / migration / RPC変更
- cron変更
- app_enabled/x_enabled変更
- shared market-report consumer gate変更
- API cost optimization / search trigger変更
- OG scraper / 新規外部ニュースAPI追加
- auth/RLS/permission変更
- X/admin/G2/G3/G4 scope
- production deploy
- App Store/TestFlight submission
- キャラクター画像の新規生成

上記が必要になった場合は勝手に越境せずSTOPし、必要な別TASKを報告。

## Tests / verification

最低限:
- home/dashboard presentationのfocused unit testsを追加/更新
- market vs holding news分離のdeterministic test
- report point extraction/fallbackのtest
- empty/error/loading state test可能範囲
- `npx tsc --noEmit`（pre-existing issueは分離して記録）
- Expo config / web export or equivalent safe render/build check
- `git diff --check`

可能なら複数widthでvisual確認:
- iPhone 17 Pro相当
- small iPhone相当

このTASKではEAS buildは不要。source implementation + safe preview/render validationまで。

## PR / completion

- narrow feature branch + PR。
- mainへ自己mergeしない。K1でChatGPTが確認する。
- production mutation = 0。
- low-risk UI/read-only scopeに留まる限り、Codexレビューは原則不要。API/DB/Auth/security境界へ変更が拡大した場合はSTOP。

完了時:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOPしてK1待ち。

## Report

最低限:
- fresh main SHA
- implemented sections
- exact changed_files
- existing data source reuse
- number of home network calls before/after
- market news / holding news separation result
- thumbnail metadata availability + fallback
- report point extraction strategy
- character asset availability/gap
- topic source availability/gap
- AI route availability/gap
- bottom-tab decision and why
- tests / TypeScript / render checks
- PR URL / head SHA
- production mutation
- remaining_issues
- safety_checks
- next_recommendation
