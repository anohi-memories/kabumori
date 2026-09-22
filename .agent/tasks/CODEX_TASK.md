# Codex Task

- task_id: kabumori-mobile-ui-consistency-and-stock-search-integration-20260922
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
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
