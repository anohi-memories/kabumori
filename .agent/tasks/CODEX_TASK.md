# Codex Task

- task_id: kabumori-mobile-ui-consistency-and-stock-search-integration-20260922
- owner: codex
- slot: codex-1
- status: done
- next_owner: chatgpt
- priority: high
- recommended_model: Luna
- purpose: 実機確認で判明したHomeと他画面の見た目の不統一、およびHomeから銘柄検索へ遷移できない問題を解消する。銘柄検索は登録銘柄画面へ統合し、アプリ全体の見た目を揃える。

## User feedback — 2026-09-22

- Homeだけ画面の色・雰囲気が変わっており、他画面が以前のままで違和感がある。
- Homeの「銘柄を検索」が機能していない。
- Bottom tabから検索が消えたため、銘柄検索は登録銘柄一覧ページへ入れてよい。

## Model policy

- **Lunaで実施。**
- UI/UX、route整理、component抽出、testsはLuna。
- Sol不要 unless unexpected Auth/RLS/runtime conflict occurs.

## Scope boundary

対象:
- root Kabumori app only: `src/app/**`, `src/components/**`, `src/constants/**`, `src/lib/**`, relevant app tests

対象外:
- `apps/social-mobile/**`
- H2/G1/G2 files
- Supabase migration/schema/RPC
- Edge Function
- Cron/secrets
- X/Push producer behavior
- EAS/App Store production operations

Production backend mutation = 0.

## Goal A — visual consistency

Current issue:
- Home uses its own light/dark palette and visual hierarchy.
- Explore/Reports/News/Search still largely use older hard-coded light styling.
- This creates a visibly inconsistent app.

Required:
1. Introduce/reuse a small shared app palette/theme for the core Kabumori screens.
2. Apply the same background/card/text/border/accent semantics to:
   - Home
   - 銘柄/登録銘柄
   - レポート
   - 重要ニュース
   - any retained Search wrapper
3. Keep the current Kabumori green/cream identity.
4. Avoid a large design-system rewrite.
5. If dark mode is supported, it must be coherent across all these screens. If coherent dark mode would expand scope too much, prefer one consistent light theme across all core screens rather than Home-only dark mode.
6. Bottom tab styling should not visually clash with screen backgrounds.

Acceptance:
- Switching between Home / 銘柄 / レポート / 重要ニュース no longer feels like different app generations.

## Goal B — integrate stock search into the stocks page

Current:
- `src/app/explore.tsx` shows registered stocks only.
- `src/app/search.tsx` contains the search flow.
- Home calls `router.push('/search')`, which did not work in the user's real-device check.

Target UX:
- 銘柄画面 itself should support both:
  1. registered holdings/watch list
  2. stock master search + add/register

Preferred implementation:
- Rename page/tab copy from `登録銘柄` to a broader `銘柄` or equivalent if it improves clarity.
- Add a search field at top of the stocks page.
- When query is empty: show registered stocks.
- When query has text: show stock search results.
- Search behavior should preserve existing debounce, ticker/company partial search, registered-state check, and TrackedStockEditor registration flow.
- After save, refresh registered list and update search result state.

Alternative acceptable implementation:
- top CTA/button `銘柄を追加・検索` expands a search panel/sheet on the same page.
- Do not rely on a separate bottom-tab Search.

## Goal C — Home quick actions

Update Home so:
- `銘柄を検索` no longer routes to broken `/search`.
- It should open the stocks page in search-ready state.
- `登録銘柄` quick action may be renamed/combined to avoid duplicate actions if needed.

Preferred:
- Home has one clear `銘柄を見る・追加` or `銘柄検索` action leading to the stocks page.
- Avoid two near-duplicate buttons.

If route params are used to request search focus, verify Expo Router/NativeTabs behavior on native and web.

## Goal D — route cleanup

- Keep `/search` only if needed for compatibility.
- If retained, it may redirect/wrap the new integrated stocks search experience.
- Do not leave a second independent search implementation that can drift.
- Existing deep links for news/reports must remain unchanged.

## Goal E — error and data safety

Preserve prior C1 guarantees:
- Home never renders raw backend `Error.message`.
- No fabricated realtime price/P&L/index values.
- Existing registered-stock edit/delete behavior remains.
- No backend production mutation.

Also inspect Explore current raw backend error rendering. If changing its error UI within this task, map visible errors to short user-facing Japanese copy rather than exposing PostgREST details.

## Goal F — verification

Minimum:
1. Fresh `origin/main` check.
2. No overlap with active H2/social-mobile files.
3. App-scope TypeScript PASS.
4. Relevant app/unit tests PASS.
5. Expo web export PASS.
6. Static route/navigation verification.
7. `git diff --check` PASS.
8. Confirm on code path that:
   - Home -> stock search path works
   - stock search is accessible from stocks page
   - registered list remains accessible
   - no duplicate independent search logic remains unless intentionally wrapped
   - visual palette is consistent across Home/Stocks/Reports/News
9. Production mutation = 0.

If practical, add tests for pure search-mode/navigation helper logic.

## Deliverables / C1

Update `.agent/CODEX_REPORT.md` with:
1. changed files
2. exact UI consistency approach
3. before/after stock-search navigation
4. whether `/search` was removed, redirected, or wrapped
5. tests/typecheck/export results
6. manual/native visual QA status
7. production mutation = 0
8. H2/G1/G2 untouched
9. remaining UI inconsistencies, if any

On completion:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for C1

**推奨モデル：Luna。**


## Additional user feedback — 2026-09-22

User also wants:
- a portfolio function,
- realtime is not required; closing-price-based detail for registered holdings is desirable,
- important-news detail still feels repetitive because 「要点」 and 「詳細」 are nearly the same.

These additions are approved for the same H1 because implementation has not started yet and existing stored data already supports a no-backend-mutation V1.

## Goal G — Portfolio V1 using existing close-report snapshot

Important discovery:
- `personalized_reports.portfolio_snapshot` already contains:
  - latest report price basis date
  - per-stock close / previous close / change / changePercent
  - quantity / average_price
  - market_value
  - day_pl
  - unrealized_pl / unrealized_pl_percent
  - portfolio totals
  - sector weights
- Therefore Portfolio V1 must reuse the latest available **close report snapshot** instead of introducing realtime market data or a new quote API.

Target UX:
1. Add a dedicated portfolio view accessible clearly from the app.
2. Preferred navigation:
   - add a bottom tab `ポート` / `ポートフォリオ` if the native tab layout remains readable,
   - otherwise add a prominent Home/Stocks entry and document why a fifth tab was avoided.
3. Portfolio header:
   - basis date: e.g. `9/22 終値ベース`
   - total market value when available
   - day P/L and day change %
   - unrealized P/L when available
4. Holdings rows/cards:
   - ticker/company
   - position label (現物/信用/売り if stored)
   - quantity
   - average cost
   - latest stored close
   - previous-close change %
   - market value
   - unrealized P/L and %
   - day P/L when available
5. Show sector allocation when snapshot data exists.
6. If current-day close report does not exist yet, use the **latest completed close report** and clearly display its date. Never present old closing data as realtime/current.
7. If no close-report snapshot exists, show a clear empty state and link to registration/reports rather than fabricating values.
8. Keep watchlist securities out of portfolio totals; they may be shown separately only if clearly labelled.
9. Reuse existing deterministic formatting helpers from `report-presentation.ts` where practical.
10. No new price provider, migration, RPC, Function, Cron, or AI call in this H1.

Portfolio tests should cover:
- latest close report selection,
- stale/older basis-date label,
- totals available/unavailable,
- holding row formatting,
- watchlist exclusion from portfolio totals.

## Goal H — Important News: make 要点 and 詳細 meaningfully distinct

Observed problem:
- Current presentation can derive `listSummary`, `keyPoints`, and `detailParagraphs` from the same stored text.
- When `app_summary_ja` and `app_detail_ja` are similar, or when only `verified_text` exists, the detail page repeats nearly identical content under 「要点」 and 「詳細」.

Required behavior:
1. Never invent new facts and do not add a display-time AI call.
2. Prefer stored Fact-checked app copy:
   - `app_key_points_ja` -> 要点
   - `app_detail_ja` -> 詳細
   - `app_summary_ja` -> list/lead summary
3. Add deterministic de-duplication:
   - normalize whitespace/punctuation/markup,
   - detect exact or near-duplicate summary/key-point/detail text,
   - suppress repeated lines/paragraphs instead of showing the same statement twice.
4. If detail has no materially new information beyond key points/summary:
   - hide the duplicate 詳細 section, or
   - show a short note that additional detail is unavailable and keep the source link.
   Do not pad it with rewritten duplicate prose.
5. For `verified_post` fallback:
   - key points should come from the first distinct factual sentences,
   - detail should prefer remaining distinct sentences/paragraphs,
   - do not repeat the same sentences in both sections.
6. For disclosure/japanese_body fallback:
   - same principle: summary/key points first, detail only from remaining distinct content.
7. Preserve original/source link and market-relation section.

Acceptance examples:
- a short 2-sentence item should not show the same 2 sentences under both 要点 and 詳細.
- a 5-sentence item may use 2-3 distinct sentences as 要点 and the remaining distinct sentences as 詳細.
- app_summary identical to the first app_detail paragraph must not be repeated twice.

Add regression tests covering:
- exact duplicate app summary/detail,
- near-duplicate whitespace/punctuation variants,
- verified-post sentence partitioning,
- short item with no extra detail,
- long item with distinct detail.

## Scope update

The same H1 may now touch:
- portfolio route/component(s)
- app tabs if a portfolio tab is chosen
- personalized report read helper for latest close snapshot
- news presentation/detail rendering and tests

Still forbidden:
- backend production mutations
- realtime quote API integration
- social-mobile/H2 files
- X/Push producer behavior
- migrations/RPC/Functions/Cron/secrets.

## Updated C1 deliverables

In addition to prior deliverables, report:
- exact Portfolio V1 navigation choice,
- exact source of closing-price data and basis-date behavior,
- portfolio empty/stale-state behavior,
- news de-duplication algorithm and test cases,
- confirmation that no display-time AI call was added.

**Recommended model remains Luna.**


## Completion record — 2026-09-22

- status: review_required
- final_commit: b27c4362c3e8a4264d64afd71b451f8f06293a62
- pull_request: https://github.com/anohi-memories/kabumori/pull/6 (open; do not merge in H1)
- verification: 45 relevant tests passed; app-scope TypeScript passed; Expo web export and diff check passed.
- production_mutation: 0
- next_owner: chatgpt (C1 review)


## Final C1 review — 2026-09-22

**PASS — PR #6 candidate accepted.**

Important clarification:
- The later user requests for Portfolio V1 and Important News 要点/詳細 de-duplication are already included in PR #6 head `b27c4362c3e8a4264d64afd71b451f8f06293a62`; they are not missing from the candidate.
- They are not visible in the user's current app yet because PR #6 is still open and not merged to main.

Reviewed and accepted:
- shared light Kabumori palette across core screens,
- stock search integrated into `/explore`, with `/search` reduced to compatibility routing,
- Home stock-search action targets the integrated stocks flow,
- Portfolio V1 exists as a fifth `ポート` tab and uses only the latest stored close-report `portfolio_snapshot`,
- basis date is explicitly shown as stored closing-price data, not realtime,
- watchlist rows are excluded from portfolio totals,
- Important News uses deterministic exact/near-duplicate suppression and does not add a display-time AI call,
- short news no longer needs to repeat the same text under both 要点 and 詳細,
- user-facing fetch errors are mapped to fixed Japanese copy,
- production/backend mutation = 0.

Verification evidence:
- relevant tests: 45 passed / 0 failed,
- app-scope TypeScript passed,
- Expo web export passed,
- static routes include /, /explore, /portfolio, /search, /news, /reports,
- git diff --check passed.

Freshness:
- PR #6 branch is behind current main, but the main-side implementation diff is limited to H2 social-mobile migration/test plus .agent control/report files.
- None of PR #6's Kabumori app implementation files overlap those main-side changes.

Remaining non-blocking QA:
- native/iOS visual QA was not run by Codex. User should re-open latest main after merge and visually confirm five-tab layout, search keyboard/focus behavior, Portfolio layout, and News detail copy.

C1 judgment:
- Candidate is approved.
- Next H1 should freshen/rebase PR #6 onto latest main, rerun checks, merge it, and then allow user real-device verification.

**Recommended model: Luna.**
