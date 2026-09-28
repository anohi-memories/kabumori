# Claude Task 1

- task_id: kabumori-home-news-first-ui-implementation-20260928
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sonnet5（中）
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

## Report — G1 result (home news-first UI implementation)

- task_id: kabumori-home-news-first-ui-implementation-20260928
- fresh main SHA at start: `b2e1ba8`
- **result: implemented and pushed as a PR. Not self-merged, per this task's own instruction.**

### Implemented sections

- **A. Report highlight card** — primary hero card, dynamic text, 2-3 points, CTA-only navigation (no per-point chevron).
- **B. Character slot** — independent 64x64 replaceable footprint; neutral fallback (no asset generated).
- **C/D. Market news + holding news** — both from the single existing important-news feed, split by `tracking_type`.
- **E. Topic card** — typed contract + future-ready empty state (no backend exists).
- **F. Ask-AI entry** — presentational chips + disabled CTA (no route exists).
- **G. Bottom navigation** — unchanged; forcing the target tab set would need routes that don't exist yet (see gaps below).

### Changed files (exact)

- `src/app/index.tsx` (rewritten)
- `src/components/home/report-highlight-card.tsx` (new)
- `src/components/home/home-news-section.tsx` (new)
- `src/components/home/character-slot.tsx` (new)
- `src/components/home/topic-card.tsx` (new)
- `src/components/home/ask-ai-entry.tsx` (new)
- `src/lib/home-report-highlights.ts` (new)
- `src/lib/home-news-sections.ts` (new)
- `src/lib/home-news-visual.ts` (new)
- `src/lib/home-topic.ts` (new)
- `tests/app/home-report-highlights_test.ts` (new, 9 tests)
- `tests/app/home-news-sections_test.ts` (new, 3 tests)
- `tests/app/home-news-visual_test.ts` (new, 3 tests)

### Existing data source reuse

- `fetchMyImportantStockNews()` — reused unchanged; split client-side by `tracking_type` for both market and holding sections. No new news fetch.
- `fetchRecentReports()` — reused unchanged; report highlights extracted from its existing `body`/`summary_ja` columns only, no new columns, no new query.
- Dropped `fetchTrackedStocks()` entirely — holding-news identification no longer needs a separate tracked_stocks read.

### Home network calls before/after

**3 → 2** (`fetchTrackedStocks` + `fetchMyImportantStockNews` + `fetchRecentReports` → `fetchMyImportantStockNews` + `fetchRecentReports`).

### Market news / holding news separation result

Deterministic client-side split on `tracking_type` (`'market'` → 重要ニュース, `'holding'` → あなたの保有銘柄, `'watch'` items excluded from home per the approved order), each capped at 3, preserving the feed's own relevance ordering. Covered by `home-news-sections_test.ts` (3/3 pass).

### Thumbnail metadata availability + fallback

**None exists today.** Read `ImportantStockNews`'s full type and the `get_my_important_stock_news` RPC call site: there is no image/thumbnail URL field anywhere in the feed. Implemented a deterministic glyph fallback (`source_type` → `coverage_categories` → neutral) with an always-`null` `imageUrl` field reserved for a future real thumbnail field, so no call site needs to change when one is added. No scraping, no guessed URLs, no new Edge Function/RPC.

### Report point extraction strategy

Priority chain, most factual/specific first, never fabricated: `body.market_detail.today_claims[].text_ja` → `body.checkpoints_ja` → `body.market_section.claims[].text_ja` → `body.overview_ja` split into sentences → `report.summary_ja` as a single point → empty. Deduplicated, capped at 3, each point ≤ 90 characters. Covered by `home-report-highlights_test.ts` (9/9 pass, including an explicit "never fabricates when every field is empty" test).

### Character asset availability/gap

No approved cutout asset exists in the repo. `CharacterSlot` renders a neutral fallback and documents the required future contract (transparent-background PNG cutout, square canvas, ~240x240 @1x, centered subject, even padding) directly in `character-slot.tsx`.

### Topic source availability/gap

No daily-topic table/RPC/Edge Function exists anywhere in this repo. Implemented the `TopicLevel`/`HomeTopic` type contract only; the card renders a "準備中です" future-ready empty state. A follow-up task is needed to design and build the actual topic source before this card can show real content.

### AI route availability/gap

No AI chat route or service exists. `AskAiEntry` shows static question chips (presentational only, no fake send action) and a disabled "準備中です" CTA. A follow-up task is needed once a real AI chat endpoint/route exists.

### Bottom-tab decision and why

Left `src/components/app-tabs.tsx` completely unchanged. The approved mock's target tab set (Home/銘柄/レポート/AIに聞く/設定) needs an AI route and a settings-as-tab route, neither of which exist; forcing the change now would either break existing 銘柄/ポート/重要ニュース tab reachability or create dead tabs, both explicitly forbidden by this task. Recommend a separate follow-up task once the AI route exists.

### Tests / TypeScript / render checks

- New tests: 15/15 pass (`home-report-highlights_test.ts` 9, `home-news-sections_test.ts` 3, `home-news-visual_test.ts` 3).
- Existing regression check: `dashboard_test.ts` + `news-labels_test.ts` + `news-presentation_test.ts` + `report-presentation_test.ts` — 38/38 still pass, no regressions.
- `npx tsc --noEmit` — 0 new errors under `src/` (2 pre-existing, unrelated CSS-module resolution errors reproduce on unmodified `main`).
- `npx expo config --json` — resolves cleanly.
- `npx expo export --platform web` — full static export succeeds; `/` (home) server-renders at 25KB with zero data, exercising every empty-state branch without throwing.
- `git diff --check` — clean.
- **Not performed**: interactive/authenticated visual QA (real small-width iPhone, signed-in state with real news/report data). This environment has no signed-in session available to drive that. The static export confirms the component tree renders without throwing; it does not confirm pixel-level layout under real data. Flagging honestly rather than claiming a visual pass I didn't do.

### PR / head SHA

- PR: https://github.com/anohi-memories/kabumori/pull/46
- Head: `2b1c666` on branch `claude/home-news-first-ui-20260928`
- Base: fresh `main` at `b2e1ba8`
- **Not self-merged**, per this task's explicit instruction. Waiting for K1/ChatGPT.

### Production mutation

**0.** No DB/RPC/Edge Function/Auth/cron/production config/deploy touched. `market-report-analysis`, `important-news-monitor` untouched, per the task's Forbidden list.

### Remaining issues

1. Character asset: no approved cutout PNG exists yet (see `character-slot.tsx`'s documented spec).
2. Topic backend: no daily-topic data source exists yet; card is future-ready-empty only.
3. AI chat: no route/service exists yet; entry is disabled-only.
4. Bottom-tab redesign to the full target set is deferred until an AI route exists.
5. Real-device / small-width-iPhone visual QA with a live signed-in session is still needed before this can be called visually final — not performed in this pass.

### Safety checks

- No file in `supabase/functions/important-news-monitor/**` or `supabase/functions/market-report-analysis/**` touched.
- No DB schema/migration/RPC/cron/Auth/RLS/permission change.
- No X/admin/G2/G3/G4 file touched.
- No new character artwork generated.
- No production deploy, no App Store/TestFlight submission.
- Fresh `origin/main` re-checked immediately before commit; no non-fast-forward conflict.

### Next recommendation

1. K1/ChatGPT reviews and merges PR #46 (or requests changes).
2. Once merged, a real-device or authenticated-preview visual pass (iPhone 17 Pro + a small-width iPhone) should confirm layout under real data before this is considered visually final.
3. Three follow-up tasks worth queuing separately when ready: (a) daily-topic backend/source, (b) AI chat route/service, (c) character cutout asset + bottom-tab redesign to match the full approved mock.


## K1 review — changes required before merge

Verdict: **CHANGES REQUIRED**. PR #46 is mergeable and scope stayed UI/read-only, but two correctness/fail-soft issues must be fixed before merge. No Codex review is required.

### K1 finding 1 — stale report can be mislabeled as "today"

Current `latestReport(reports)` selects the newest stored report across all trading dates. If today's report has not been generated yet (before the morning report, weekend/holiday, or a generation failure), the Home hero can show a previous trading day's report under:

- `TODAY'S REPORT`
- `今日の かぶモリレポート`
- `今日の市場と...`

This is misleading.

Required fix:
- The hero must only use a report whose `trading_date === todayJst()`.
- If both morning and close exist today, choose the later generated one (normally close).
- If no report exists for today, render the honest empty/waiting state; do **not** silently fall back to an older report.
- Add deterministic tests covering:
  1. yesterday-only -> no current report;
  2. today morning -> morning;
  3. today morning + close -> newest same-day report;
  4. future/older rows do not leak into the hero.

You may reuse/extend `todaysReports()` or replace `latestReport` with a date-scoped helper, whichever is smaller and clearer.

### K1 finding 2 — report fetch failure is shown as "not generated yet"

`errors.reports` is populated in `index.tsx` but never presented to `ReportHighlightCard`. When `fetchRecentReports()` fails, the hero currently falls through to:

`今日のレポートはまだありません。生成され次第ここに表示されます。`

That converts a network/data-load failure into a false product-state message.

Required fix:
- Pass the reports error into the hero card.
- Error state must take precedence over normal no-report empty state once loading ends.
- Show the existing `dashboardSectionError('reports')` message or equivalent and a working retry action.
- Do not add a new network path; reuse the existing `load(true)`.
- Add a focused deterministic/presentation test where practical; at minimum ensure the render branch is explicit and TypeScript-safe.

### Keep unchanged

- Point rows still have **no individual chevron**.
- One CTA only for report detail.
- No backend/LLM generation at Home open.
- No DB/RPC/Edge/cron/Auth changes.
- No `important-news-monitor` or `market-report-analysis` changes.
- No character generation.
- Topic/AI remain honest "準備中" shells.
- Bottom tabs remain unchanged in this PR.
- Production mutation remains 0.

### Rebase/fresh-main safety

Current main advanced after the PR base only in orchestration/control files; PR #46 remains GitHub-mergeable. Before push:
- fresh fetch `origin/main`;
- confirm no new Home-source overlap;
- do not merge main into the branch unless needed; keep PR narrow.

### Re-verification

After the two fixes:
- rerun new Home tests + prior focused regressions;
- `npx tsc --noEmit` and separate pre-existing errors;
- `npx expo config --json`;
- safe export/render check;
- `git diff --check`;
- confirm PR #46 head SHA and mergeability;
- update this Report with the fix commit, tests, and remaining issues;
- set status -> `review_required`, next_owner -> `chatgpt`;
- STOP for K1.

Recommended model: **Sonnet5（中）**.

## Report — G1 result (K1 changes-required fix)

- task_id: kabumori-home-news-first-ui-implementation-20260928
- fresh main SHA at start: `942cefc` (advanced only in unrelated G2/control files since PR #46's base; no Home-source overlap)
- **result: both K1 findings fixed, pushed to the same PR branch. Not self-merged.**

### Fix 1 — report hero scoped strictly to today

Replaced `latestReport()` (newest report across all dates) with `currentReport(reports, today)`, which filters to `trading_date === today` first and only then picks the later-generated row (close over morning when both exist). Returns `null` — not an older fallback — when nothing was generated for today yet; the hero renders its existing honest empty state in that case.

New tests in `home-report-highlights_test.ts`:
1. `currentReport: yesterday-only rows never leak in as today's report` — PASS
2. `currentReport: today's morning report is used when it's the only one today` — PASS
3. `currentReport: with both morning and close today, the later-generated one wins` — PASS (checked both input orders)
4. `currentReport: a future-dated row never leaks in either` — PASS

### Fix 2 — reports fetch error no longer shown as "not generated yet"

Extracted the hero card's render branch into an explicit, independently-tested `reportCardStatus(hasReport, loading, error): 'loading' | 'error' | 'report' | 'empty'` in `home-report-highlights.ts` (not duplicated in the `.tsx`, so it's Deno-testable like the rest of this module). `index.tsx` now passes `errors.reports` and an `onRetry` (reusing the existing `load(true)`, no new network path) into `ReportHighlightCard`, which renders the same error+retry visual pattern already used by the news sections when `status === 'error'`. An already-successfully-loaded report is still shown if a later background refresh fails (error only wins when there is no report to show).

New tests:
- `reportCardStatus: loading only applies while nothing is shown yet` — PASS
- `reportCardStatus: a fetch error is never shown as the empty/not-generated state` — PASS
- `reportCardStatus: an already-loaded report is shown even if a later refresh errors` — PASS
- `reportCardStatus: no report and no error, loading finished, is the honest empty state` — PASS

### Changed files (this fix, on top of the prior PR)

- `src/lib/home-report-highlights.ts` (`latestReport` → `currentReport`; added `reportCardStatus`)
- `src/components/home/report-highlight-card.tsx` (added `error`/`onRetry` props, uses `reportCardStatus`, added error+retry UI)
- `src/app/index.tsx` (uses `currentReport(reports, todayJst())`; passes `errors.reports`/`onRetry` to the hero card)
- `tests/app/home-report-highlights_test.ts` (replaced the old `latestReport` test with 4 `currentReport` tests; added 4 `reportCardStatus` tests)

### Re-verification

- New/updated tests: **22/22 pass** (up from 15; 8 new/replaced for these two fixes).
- Regression check: `dashboard_test.ts` + `news-labels_test.ts` + `news-presentation_test.ts` + `report-presentation_test.ts` — 38/38 still pass.
- `npx tsc --noEmit` — 0 new errors under `src/` (same 2 pre-existing, unrelated CSS-module errors as before).
- `npx expo config --json` — resolves cleanly.
- `npx expo export --platform web` — full static export succeeds again, `/` (home) server-renders at 25KB.
- `git diff --check` — clean.
- Fresh `origin/main` re-checked immediately before push; PR #46's own branch had no non-fast-forward conflict.

### PR / mergeability

- PR: https://github.com/anohi-memories/kabumori/pull/46 (unchanged, same PR — fix pushed to its existing branch, not a new PR)
- New head: `f95f9c2` on `claude/home-news-first-ui-20260928`
- Confirmed via `gh pr view 46`: `state: OPEN`, `mergeable: MERGEABLE`
- **Not self-merged**, per this task's explicit instruction.

### Unchanged (confirmed still true after the fix)

- Point rows still have no individual chevron; one CTA only for report detail.
- No backend/LLM generation at Home open; no new network path (retry reuses `load(true)`).
- No DB/RPC/Edge/cron/Auth changes; `important-news-monitor`/`market-report-analysis` untouched.
- No character generation. Topic/AI remain honest "準備中" shells. Bottom tabs unchanged.
- Production mutation: **0**.

### Remaining issues

Same as the prior report (character asset, topic backend, AI chat route, bottom-tab redesign, and real-device/authenticated visual QA are all still open follow-ups) — nothing new introduced by this fix.

### Next recommendation

K1/ChatGPT re-review of the fix commit on PR #46; merge if satisfied, or a further changes-required round if not.
