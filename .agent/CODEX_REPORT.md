## Latest H1 result — GPT-6 Important News unification stopped for schema review (2026-09-23)

- task_id: `kabumori-important-news-full-gpt6-model-unification-20260923`
- result: `review_required` — implementation prototype passed its tests but was stopped before source commit/PR when existing persisted-model CHECK constraints showed GPT-6 requires a schema change. The TASK explicitly says to stop for C1 if a migration seems necessary.
- source_base: fresh `origin/main` `e7a5e3c09e8a51a5e99ecdb902d6a20754f8274d`.
- local_prototype: isolated worktree `/private/tmp/kabumori-important-news-gpt6-unification`, branch `codex/kabumori-important-news-gpt6-unification-20260923`; changes remain uncommitted and unpushed. No commit or PR was created.
- production_mutation: **0**. No production DB query/write, migration, Edge Function deploy, Cron/config/secret change, report regeneration/backfill, X post, or Push occurred.

### Blocking schema evidence

- `supabase/migrations/20260830120000_add_important_news_ai_judgement.sql:19-20` constrains `important_news_candidates.judgement_model` to `gpt-5.6-luna` or `gpt-5.6-sol`.
- `supabase/migrations/20260830130000_add_important_news_post_generation.sql:12-14` constrains `generation_model` to the same two GPT-5.6 IDs.
- The monitor writes `final.model` to `judgement_model` (`index.ts:710`) and `generated.model` to `generation_model` (`index.ts:892`); its failure-metadata path also writes `generation_model` (`index.ts:918`). GPT-6 IDs would therefore violate the declared constraints. No migration candidate was created, and no assumption was made about the live database's migration state.
- C1 decision needed: whether to create a separate, narrowly scoped migration candidate extending both CHECK constraints to GPT-6 IDs, before restarting the source unification task. Do not deploy the local prototype as-is.

### Official IDs, pricing, and model-reference inventory

- OpenAI official docs were re-checked: model IDs `gpt-6-luna` / `gpt-6-sol`; standard short-context rates per 1M tokens Luna `$0.10` input / `$0.50` output, Sol `$2` / `$10`. Sources: [OpenAI model catalog](https://developers.openai.com/api/docs/models), [OpenAI API pricing](https://developers.openai.com/api/docs/pricing). Values match the task's expected values.
- Pre-edit `supabase/functions/important-news-monitor/` inventory:
  - `importance_judgement_logic.ts`: active Luna first pass, Sol escalation, both model labels in the type, reasoning selection, prompt branch and Luna preliminary-result branch were GPT-5.6.
  - `breaking_market_source_fetchers.ts`: active search `MODEL` was GPT-5.6 Luna.
  - `post_generation_logic.ts`: active model constant and result/retry model types were GPT-5.6 Luna.
  - `index.ts`: generation-failure metadata default was GPT-5.6 Luna; normal save uses the generated result model. Judgment persistence uses the final result model.
  - `usage_ledger.ts`: rates contained Luna `$0.20/$1.20` and Sol `$4/$20` per 1M, plus existing GPT-6 Luna `$0.10/$0.50`; unknown IDs fell back to GPT-5.6 Luna rates. GPT-6 Sol had no rate entry.
  - Tests and mock diagnostics in `importance_judgement_logic_test.ts`, `post_generation_logic_test.ts`, `generation_dispatch_logic_test.ts`, and `usage_ledger_test.ts` asserted the GPT-5.6 active models and costs; those fixtures were updated in the local prototype. Existing GPT-5.6 ledger fixtures were retained for legacy-row accounting.
- Local prototype post-edit inventory: the four active runtime entrypoints use GPT-6 only; no active runtime path selects GPT-5.6. GPT-5.6 string literals remain only in `usage_ledger.ts` as historical cost rates and in `usage_ledger_test.ts` as historical-rate / already-written-row fixtures. These legacy rates are needed for historical ledger cost recomputation and are not used as runtime fallbacks.

### Local prototype changes and preserved behavior

- Changed locally: `supabase/functions/important-news-monitor/importance_judgement_logic.ts`, `importance_judgement_logic_test.ts`, `breaking_market_source_fetchers.ts`, `post_generation_logic.ts`, `post_generation_logic_test.ts`, `generation_dispatch_logic_test.ts`, `usage_ledger.ts`, `usage_ledger_test.ts`, `cost_path_audit_test.ts`, `index.ts`.
- Proposed routing: judgement GPT-6 Luna first pass; existing escalation reasons/thresholds unchanged and route to GPT-6 Sol; breaking-market search GPT-6 Luna; draft/Fact/Voice and existing retry sequence GPT-6 Luna. Reasoning efforts remain low for Luna and medium for Sol. Search source allowlist/validation/query rotation and publication/retry gates were untouched.
- Proposed accounting: GPT-6 Luna `$0.10/$0.50`; GPT-6 Sol `$2/$10`; unknown-model fallback GPT-6 Luna. Historical GPT-5.6 rates remain for prior ledger records only.
- Added a static test that rejects GPT-5.6 model selection in active runtime entrypoints and cost assertions for GPT-6 Luna/Sol.

### Verification and remaining checks

- Targeted model-path tests: **172 passed / 0 failed**.
- Full `important-news-monitor` suite: **423 passed / 0 failed** with `deno test --no-check`.
- `deno check --no-config --no-lock` passed for all changed logic/test modules except `index.ts`. Checking `index.ts` reports a pre-existing TS2322 `Uint8Array<ArrayBufferLike>` vs `BufferSource` incompatibility in unchanged `supabase/functions/_shared/x_oauth2_post.ts:66`; the helper is outside the diff.
- `git diff --check`: passed.
- Optional `deno fmt --check` did not pass: Deno 2.9's default formatter proposes broad reformatting in all 10 touched files, and also flags untouched neighboring baseline files. No broad formatting churn was applied.
- No source PR/commit was created due to the schema blocker. Prototype is not production-ready until C1 resolves the schema step.

## Latest H1 result — PR #8 freshened and merged (2026-09-23)

- task_id: `kabumori-pr8-gpt6-news-portfolio-final-merge-20260923`
- result: `review_required` — the C1-approved PR was rebased onto latest main, checks rerun, merged, and read back. Stop for C1.
- pre_freshen_main: `3e0a346bb99f09cf9480021f1e4a4b540ea0929f`
- final_feature_head: `ab593c74fe6825ffbf9ba8ef2bed004a5b92b731`
- merge_commit / resulting_main: `cd7ad8994d6e20c752735a52b0d933e1c2bb0a16`
- pull_request: https://github.com/anohi-memories/kabumori/pull/8 (merged and closed)
- required_checks: Vercel `pass`; Vercel Preview Comments `pass` on the final PR head.
- freshen evidence: Main changes since merge-base `3de9881207983460ac5379cc3066398b00ad4bba` were limited to `.agent` controls and social-mobile Phase20/21 files. Overlap against the 11 approved PR files was empty. The two PR commits were rebased without conflict; no `.agent` history was carried into the PR.
- read-back: `git diff --exit-code ab593c74fe6825ffbf9ba8ef2bed004a5b92b731 cd7ad8994d6e20c752735a52b0d933e1c2bb0a16 -- <11 approved files>` returned no differences.

### Preserved behavior on main

- Important News source-backed app-copy V2 remains intact; draft and Fact use `gpt-6-luna` and GPT-6 Luna cost rates.
- Portfolio validator retains the full-width Japanese-company-name exception; ASCII `UFJ銀行` and ordinary English remain blocked.
- Personalized Reports draft and Fact use `gpt-6-luna`; cost estimator uses `$0.10` input / `$0.50` output per 1M tokens.
- Out-of-scope GPT-5.6 Luna judgement, breaking-market search, and X-post-generation paths remain unchanged.

### Verification and safety

- Freshened targeted Important News tests: **31 passed / 0 failed**.
- Personalized Reports and shared-market consumer tests: **26 passed / 0 failed**.
- Full Important News suite: **421 passed / 0 failed** with `--no-check`.
- `deno check --no-lock` passed for the nine changed/approved logic and test files excluding `index.ts`. Including `index.ts` reaches a pre-existing TS2769 `ArrayBufferLike`/`BufferSource` error in unchanged `supabase/functions/_shared/x_oauth2_post.ts:66`; that helper is outside the approved files and main delta.
- `git diff --check origin/main...HEAD`: passed.
- The PR merge triggered an automatic Vercel `Production` deployment for resulting main `cd7ad89`; GitHub reports it completed successfully at https://admin-l8y08p1vr-kabumori.vercel.app. This is the repository’s automatic web build, not a manual Supabase Function deployment.
- Supabase production mutation = **0**: no migration apply, `important-news-monitor` deploy, `personalized-reports` deploy, Cron change, secret/Vault change, or 9/18 report regeneration/backfill.
- H2/G1/G2 implementation files untouched. The pre-existing untracked `docs/deployment/` and `netlify.toml` were preserved and not staged.
- remaining_production_rollout: separately apply the exact approved migration, deploy `important-news-monitor`, deploy `personalized-reports`, and decide whether/how to regenerate/backfill the 9/18 close report.
- next_recommendation: C1 review main `cd7ad8994d6e20c752735a52b0d933e1c2bb0a16`; do not perform Supabase production rollout from this H1 turn.

## Latest H1 result — GPT-6 Luna upgrade on PR #8 (2026-09-23)

- task_id: `kabumori-gpt6-luna-model-upgrade-on-pr8-20260923`
- result: `review_required` — updated the existing PR #8 branch and stopped for C1.
- official_model: `gpt-6-luna`, verified at [OpenAI GPT-6 Luna model documentation](https://developers.openai.com/api/docs/models/gpt-6-luna).
- pricing_source: [OpenAI API pricing](https://developers.openai.com/api/docs/pricing) — input `$0.10 / 1M tokens`, output `$0.50 / 1M tokens`.
- branch: `codex/kabumori-news-producer-portfolio-freshen-20260922`
- previous_head: `f5978b1f8d101f48206a65bc38772fb65db95de8`
- commit / PR head: `6f5b184bfd7406d356f2f499342013774fec02d5`
- pull_request: https://github.com/anohi-memories/kabumori/pull/8 (open, not merged)
- checks: `gh pr checks 8` reports Vercel `pass` and Vercel Preview Comments `pass`. The earlier rate-limit condition no longer blocks this head.

### Changed files

- `supabase/functions/important-news-monitor/app_copy_logic.ts`
- `supabase/functions/important-news-monitor/app_copy_logic_test.ts`
- `supabase/functions/important-news-monitor/usage_ledger.ts`
- `supabase/functions/important-news-monitor/usage_ledger_test.ts`
- `supabase/functions/important-news-monitor/cost_path_audit_test.ts`
- `supabase/functions/personalized-reports/report_logic.ts`
- `supabase/functions/personalized-reports/report_logic_test.ts`
- `supabase/functions/personalized-reports/shared_market_consumer_test.ts`

### Model, pricing, and preserved scope

- `APP_COPY_MODEL`: `gpt-5.6-luna` → `gpt-6-luna`; both app-copy draft and Fact use this constant.
- `REPORT_MODEL`: `gpt-5.6-luna` → `gpt-6-luna`; both personalized-report draft and Fact use this constant.
- Both application-side estimators: input `$0.20` → `$0.10` / 1M tokens; output `$1.20` → `$0.50` / 1M tokens.
- Usage ledger adds GPT-6 Luna rates while retaining GPT-5.6 Luna rates for untouched paths.
- Other GPT-5.6 Luna usages intentionally remain in `importance_judgement_logic.ts` and its tests, `breaking_market_source_fetchers.ts`, and X-post generation metadata/logic in `index.ts`, `post_generation_logic.ts`, and related tests. These are outside app-copy and personalized-report draft/Fact scope and were not changed.
- Diff from the pre-task PR head is limited to the eight files above; source-backed app-copy selection and the full-width Japanese proper-name validator remain present and unchanged apart from model/pricing constants and assertions.

### Verification and safety

- Important News app-copy tests: **13 passed / 0 failed**.
- Usage ledger + cost-path audit tests: **11 passed / 0 failed**.
- Full Important News test suite: **421 passed / 0 failed** with `--no-check`; normal whole-suite typechecking was blocked because `npm:unpdf@1.8.1` is not installed in the local Deno node_modules cache.
- Personalized report and shared-market consumer tests: **26 passed / 0 failed** with normal Deno typechecking.
- `deno check --no-lock` across all eight changed TypeScript files: passed.
- `git diff --check`: passed.
- Production mutation = **0**. No database migration/write, Edge Function deploy, Cron change, secret/Vault setting, report regeneration/backfill, or X/Push behavior change.
- Existing Important News producer V2 and Portfolio validator candidate remain in PR #8; no production rollout or merge was performed.
- next_recommendation: C1 review PR #8 at `6f5b184bfd7406d356f2f499342013774fec02d5`; do not merge/deploy from this H1 turn.

## Latest H1 result — PR #7 freshened and merged (2026-09-22)

- task_id: `kabumori-mobile-holdings-watch-news-detail-merge-retry-20260922`
- result: `review_required` — PR #7 merged successfully; stop for C1.
- pre_freshen_main: `c2f18de8c609693b4255b710e3798c2df72dda95`
- final_feature_head: `c50dd6ad238cda2750ba2222c7a1546e433c5562`
- merge_commit / resulting_main: `b2fb397173c042d328ef87d02a0d8d993bef9fbb`
- pull_request: https://github.com/anohi-memories/kabumori/pull/7 (merged and closed)
- freshen evidence: PR base → current main had no changes in the five approved implementation/test files. The single PR commit was rebased onto latest main without conflict; no semantic behavior was auto-resolved.
- changed files: `src/app/explore.tsx`, `src/lib/stock-sections.ts`, `src/lib/news-presentation.ts`, `tests/app/stock-sections_test.ts`, `tests/app/news-presentation_test.ts`.
- holdings/watch behavior preserved: empty-query list is segmented into 保有/監視 with counts, holdings preferred when present, section-specific empty states, and integrated search/edit/register/delete preserved.
- Important News behavior preserved: verified Japanese copy keeps distinct event/status facts in 詳しい内容 and excludes generic market filler; thin sources remain fail-closed; no display-time AI.
- verification: **50 passed / 0 failed** app regression tests; app-scope TypeScript passed; Expo web export passed (10 static routes); `git diff --check` passed; final main read-back matches the freshened feature head across all five approved files.
- H2/G1/G2 implementation files untouched. Production mutation = 0; no migration, RPC, Edge Function deploy, Cron, secret/Vault, OAuth, X/Push, EAS, or App Store operation.
- known limitations: manual iOS/native QA remains outstanding; colors/icons visual polish remains deferred.
- next_recommendation: C1 review resulting main `b2fb3971`; no further H1 action.

## Latest H1 result — PR #7 freshen blocked by semantic main drift (2026-09-22)

- task_id: `kabumori-mobile-holdings-watch-news-detail-merge-20260922`
- result: `review_required` — PR #7 was not merged.
- pre_freshen_main: `cb7232204ccff1c61f8b7104edef02fff75e18c9`
- approved_candidate: `0225efc66501502b32336998d4b48a71bdfece29`
- pull_request: https://github.com/anohi-memories/kabumori/pull/7 (still open; not merged)
- freshen check: latest main now has semantic changes to the same approved app/test area. `src/lib/stock-sections.ts` and `tests/app/stock-sections_test.ts` are absent on main, while `src/app/explore.tsx`, `src/lib/news-presentation.ts`, and `tests/app/news-presentation_test.ts` no longer contain the PR's holdings/watch segmentation and verified-news partition behavior.
- This violates the TASK's rule to stop when any approved implementation/test file has semantic main drift. Auto-resolving would silently choose behavior, so no rebase/merge was performed.
- H2/G1/G2 implementation files were not changed. The unrelated latest-main FRED history rollout was not touched.
- verification after freshen: not rerun because the freshen blocker occurred first.
- production_mutation: 0. No migration, RPC, Edge Function deploy, Cron, secret/Vault, OAuth, X/Push, EAS, or App Store operation.
- next_recommendation: ChatGPT/C1 must decide whether to rebase/reapply PR #7 behavior onto current main or close/re-scope the candidate. Do not merge automatically.

## Latest H1 result — holdings/watch split and Important News detail quality (2026-09-22)

- task_id: `kabumori-mobile-holdings-watch-split-and-news-detail-quality-20260922`
- result: `review_required` — app-only candidate is pushed in PR #7; stop for C1.
- source_base: fresh `origin/main` `e2e5a8afeb8fe0e3513c0a137d75ca7d95bcd076`.
- branch/commit: `codex/kabumori-holdings-watch-news-detail-20260922` / `0225efc66501502b32336998d4b48a71bdfece29`.
- pull_request: https://github.com/anohi-memories/kabumori/pull/7 (open, mergeable).
- production_mutation: 0.

### Changed files

- `src/app/explore.tsx`
- `src/lib/stock-sections.ts`
- `src/lib/news-presentation.ts`
- `tests/app/stock-sections_test.ts`
- `tests/app/news-presentation_test.ts`

### Holdings/watch UX

- Empty-query `/explore` now partitions registered rows into a segmented `保有 | 監視` control with counts; rows are never mixed.
- Default selection is `保有` when any holding exists, otherwise `監視`; the current section is preserved when possible across refreshes.
- Empty states are section-specific: `保有銘柄はまだありません。上の検索から登録できます。` and `監視銘柄はまだありません。上の検索から登録できます。`
- Non-empty stock-master search remains unchanged and independent of the section filter. Existing register/edit/delete flow calls `load()`, so tracking_type changes appear in the correct partition without an app restart.
- Added pure helpers for partition/default/empty-copy behavior and regression tests.

### Evidence-based news diagnosis

A read-only production SELECT of the three reported classes showed the same path:
- AP tanker, UN/Houthi, and North Korea rows had `generation_fact_status = 'passed'`.
- Their Japanese `generated_text` was present and was therefore exposed as `verified_text` by the feed RPC.
- `app_title_ja`, `app_summary_ja`, `app_detail_ja`, and `app_key_points_ja` were NULL for those rows, so Fact-passed app copy was not the selected path.
- `body_summary` contained richer source-backed facts in English (tanker injuries/vessel status; UN attempted strike and displacement; North Korea 450/600km flight and EEZ assessment).
- The shallow detail was therefore a presentation partition problem in the already-available verified Japanese post: event facts were placed in 要点 while the remaining sentence was generic market commentary or a warning-only status. No missing display-time AI call was inferred.

### Detail behavior change

- Added a narrow deterministic classifier for generic market-impact sentences and a verified-sentence partition helper.
- For verified posts, the first two distinct event facts remain 要点; remaining distinct event/status facts become 詳しい内容. Generic `日本株への影響` / `市場の反応` filler is excluded from 詳しい内容 and is not used as replacement prose.
- Concrete status facts such as vessel continuation and “封鎖・供給障害は確認されていない” remain visible.
- Thin sources are not padded. When no additional detail remains, the existing readable notice/source-link path is used; no bare warning-only detail and no display-time AI were added.
- Producer/app-copy source was not changed or deployed; this is an app-only presentation fix.

### Regression fixtures and verification

- Added realistic verified-post fixtures for North Korea missile range/EEZ, UN/Houthi attempted strike/displacement, and Hormuz tanker injuries/vessel status; assertions prove event facts remain in 詳細 and generic market filler does not.
- Added thin-source and helper regressions, plus holdings/watch partition/default/empty-state tests.
- Relevant tests: **50 passed / 0 failed**.
- Kabumori app-scope TypeScript: passed.
- Expo web export: passed; routes include `/`, `/search`, `/explore`, `/portfolio`, `/news`, `/news/[id]`, `/reports`, `/reports/[id]`.
- `git diff --check`: passed.
- No migration, RPC, Edge Function deploy, Cron, secret/Vault, provider credential, X/Push, H2, G1, or G2 change.
- Colors/icons/typography visual polish explicitly deferred to a later task.
- Manual iOS/native QA remains outstanding.
- next_recommendation: C1 review PR #7; do not merge/deploy from this H1 turn.

## H1 merge result — Kabumori UI, stock search, Portfolio V1, and news detail dedup (2026-09-22)

- task_id: `kabumori-mobile-ui-portfolio-news-merge-20260922`
- result: `review_required` — C1-approved PR #6 was freshened onto the latest main, reverified, merged, and read back. Stop for C1.
- pre_freshen_main: `c4f2f83f485bda45e308522c7b6d079b4b606e7c`
- final_feature_head: `38aa1a500f90355e740603464177701b9e0c3bfc`
- merge_commit / resulting_main: `bc4929165cf74e9044f0267299fce7f1132ac60b`
- pull_request: https://github.com/anohi-memories/kabumori/pull/6 (merged and closed)
- production_mutation: 0

### Fresh-main and scope verification

- Rebased PR #6 onto `origin/main` without conflicts. Main-side changes since C1 were limited to control files and H2/social-mobile work; no Kabumori app file overlap or semantic conflict existed.
- The merged PR contains the approved 22 Kabumori app/test files only. Read-back comparison of all approved paths on `origin/main` versus the freshened feature head was empty.
- H2/G1/G2 implementation files, migrations, RPCs, Edge Functions, Cron, secrets, OAuth, X, Push, EAS, and App Store areas were not changed by this merge.

### Preserved feature set

- Shared Kabumori light palette aligns Home, 銘柄, ポート, レポート, 重要ニュース, and the editor.
- Stock search is integrated into `/explore` with empty-query registered list, debounced partial ticker/company search, registered-state display, and existing register/edit/delete flow. Home opens `/explore?focus=search`; `/search` remains a compatibility redirect.
- Portfolio V1 remains the fifth `ポート` tab and Home shortcut. It reads only the latest completed close report's existing `portfolio_snapshot`, shows an explicit basis date and non-realtime disclaimer, totals/holding rows/sector weights, excludes watchlist rows from totals, and has empty/stale handling.
- Important News keeps deterministic normalization and exact/near-duplicate suppression across summary/key points/detail. Verified-post and disclosure fallbacks partition distinct content; no display-time AI call was added, and source/relation links remain.

### Verification after freshen

- Relevant app tests: **45 passed / 0 failed**.
- Kabumori app-scope TypeScript: passed.
- Expo web export: passed; static routes confirmed: `/`, `/explore`, `/portfolio`, `/search`, `/news`, `/news/[id]`, `/reports`, `/reports/[id]`.
- Native/web five-tab navigation, Home-to-search route, Portfolio basis-date/no-realtime copy, and News duplicate-suppression paths were confirmed by source/read-back checks.
- `git diff --check`: passed.
- Manual iOS simulator/development-build QA (safe area, keyboard, modal, numeric input, tab behavior) remains outstanding.
- No production DB write or backend deploy was performed.

Next recommendation: `C1` verify resulting main `bc492916`; no further H1 action is required.

## Latest H1 result — Kabumori UI consistency, integrated stock search, Portfolio V1, and news detail dedup (2026-09-22)

- task_id: `kabumori-mobile-ui-consistency-and-stock-search-integration-20260922`
- result: `review_required` — implementation is pushed in PR #6; stop for C1. No production backend mutation.
- source_base: fresh `origin/main` was fetched before final control-file synchronization.
- branch/commits: `codex/kabumori-mobile-home-dashboard-v1-20260922`; `7fc8299` (UI/search) and `b27c436` (Portfolio/news dedup), final head `b27c4362c3e8a4264d64afd71b451f8f06293a62`.
- pull_request: https://github.com/anohi-memories/kabumori/pull/6 (open, mergeable, not merged).

### Changed files

- `src/app/_layout.tsx`, `src/app/index.tsx`, `src/app/explore.tsx`, `src/app/search.tsx`, `src/app/portfolio.tsx`
- `src/app/news/_layout.tsx`, `src/app/news/index.tsx`, `src/app/news/[id].tsx`
- `src/app/reports/_layout.tsx`, `src/app/reports/index.tsx`
- `src/components/app-tabs.tsx`, `src/components/app-tabs.web.tsx`, `src/components/tracked-stock-editor.tsx`
- `src/constants/kabumori-theme.ts`, `src/constants/theme.ts`
- `src/lib/news-presentation.ts`, `src/lib/personalized-reports.ts`, `src/lib/report-presentation.ts`, `src/lib/stock-search.ts`
- `tests/app/stock-search_test.ts`, `tests/app/news-presentation_test.ts`, `tests/app/portfolio_test.ts`

### UI and search

- Added a shared Kabumori light palette and applied the same background/card/text/border/accent semantics across Home, 銘柄, Reports, Important News, and the editor. Dark mode was not partially extended; the core flow stays consistently light.
- Integrated stock-master search into `/explore`: empty query shows registered stocks; non-empty query uses a 350ms debounce, partial ticker/company matching, a 30-row limit, and registered-state display before using the existing editor.
- Home now opens `/explore?focus=search`; `/search` is a compatibility redirect to the same integrated flow. Registered-stock edit/delete behavior remains on the same page.
- Visible Explore/News/Reports/Portfolio failures use fixed Japanese copy and do not expose raw backend details.

### Portfolio V1

- Added a clear fifth tab `ポート` and a Home shortcut to `/portfolio`.
- Portfolio reads only the existing `personalized_reports.portfolio_snapshot` from the newest completed `close` report; no realtime quote API, new provider, or AI call was added.
- The view shows an explicit closing-price basis date, totals when available, holding rows, stored close/previous-close change, market value, day/unrealized P/L, sector weights, and a clear realtime disclaimer.
- Watchlist rows are excluded from totals. No snapshot shows an empty state with links to 銘柄 registration and reports; older snapshots retain their basis date and are not presented as realtime.

### Important News detail

- Added deterministic normalization (markup/URL removal, NFKC/lowercase, whitespace and punctuation normalization) and exact/near-duplicate suppression.
- Stored app copy keeps summary/key points/detail in separate partitions; verified posts use distinct leading factual sentences for 要点 and remaining sentences for 詳細; disclosure/japanese-body fallbacks apply the same remaining-content rule.
- When no material detail remains, the detail page shows a short Japanese notice and source path instead of repeated prose. No display-time AI call was added.
- Regression coverage includes exact/near duplicate app copy, verified sentence partitioning, short items with no extra detail, and long distinct detail.

### Verification and safety

- Relevant app tests: **45 passed / 0 failed** (including stock search, dashboard, news presentation, report presentation, and Portfolio tests).
- Kabumori app-scope TypeScript check: passed. Repository-wide `npx tsc --noEmit` still reports unrelated pre-existing admin/social-mobile/Edge Function errors.
- Expo web export: passed; static routes included `/`, `/search`, `/explore`, `/portfolio`, `/news`, `/news/[id]`, `/reports`, and `/reports/[id]`.
- `git diff --check`: passed.
- Manual iOS simulator/development-build visual QA was not run in this environment; native keyboard/modal/safe-area checks remain for C1.
- Production mutation = 0. No migration/schema/RPC, Edge Function, Cron, secret/Vault, OAuth, X, Push, EAS, App Store, or production data change. H2/G1/G2 files and workstreams were untouched.
- next_recommendation: C1 review PR #6; do not merge or deploy from this H1 turn.

## H1 merge result — Kabumori Home Dashboard V1 (2026-09-22)

- task_id: `kabumori-mobile-home-dashboard-v1-merge-20260922`
- result: `review_required` — C1-approved PR #5 was freshened onto current main, reverified, and merged. Stop for C1.
- pre_freshen_main: `1b1d53323c9a903954b3852ed168240fdf581303`
- final_feature_head: `d03f08ccbf4598ef838be19128b899d309398ac6`
- merge_commit / resulting_main: `c867ee7e0c4546265be325cc606653e0bf964d9f`
- pull_request: https://github.com/anohi-memories/kabumori/pull/5 (merged and closed)

### Fresh-main and scope verification

- Rebased the approved implementation onto `origin/main` without dragging stale `.agent` history; no conflicts occurred.
- PR diff remained limited to the approved six files:
  - `src/app/index.tsx`
  - `src/app/search.tsx`
  - `src/components/app-tabs.tsx`
  - `src/components/app-tabs.web.tsx`
  - `src/lib/dashboard.ts`
  - `tests/app/dashboard_test.ts`
- H2/social-mobile, G1, G2, migrations, Functions, Cron, secrets, OAuth, X, and Push areas were untouched.

### Verification

- Dashboard helper tests: 4 passed / 0 failed.
- Expo-scope TypeScript check: passed.
- Expo web export: passed.
- Static routes confirmed: `/`, `/search`, `/explore`, `/news`, `/reports`.
- `git diff --check`: passed.
- Home still maps stocks/news/reports failures to fixed Japanese copy and does not render arbitrary backend `Error.message`.
- No realtime price, P&L, market-index, or other unavailable metric was added.
- Read-back of `origin/main` after merge showed no difference from the approved feature head across the six implementation/test files.
- Production mutation: 0. No DB/schema/RPC, Edge Function, Cron, secret/Vault, OAuth, X, Push, or app-store/EAS operation.

Next recommendation: C1 verify the merged main state; follow-up UI work can address native/iOS visual QA and future realtime data separately.

## C1 blocker fix — Kabumori Home Dashboard V1 (2026-09-22)

- task_id: `kabumori-mobile-home-dashboard-v1-20260922`
- result: `review_required` — C1 blocker fixed; Home now uses fixed Japanese error copy and no longer renders arbitrary backend `Error.message` text. Stop for C1.
- fresh_main_before_sync: `b218055bfbe671bdd738d6c91a5c73dd5572f08d`
- branch/commit: `codex/kabumori-mobile-home-dashboard-v1-20260922` / `7ff16dcb16117cd2c530fbfdf0e7da8c4788b5e8`
- pull_request: https://github.com/anohi-memories/kabumori/pull/5 (updated; not merged)

### Blocker resolution

- Stocks failures show `登録銘柄を読み込めませんでした。`
- News failures show `重要ニュースを読み込めませんでした。`
- Report failures show `レポートを読み込めませんでした。`
- Section-level retry and `Promise.allSettled` isolation remain unchanged.
- The Home-facing error mapping is centralized in `src/lib/dashboard.ts`; no raw backend detail is put into visible Home error state or logs.

### Verification

- Dashboard helper tests: 4 passed / 0 failed.
- Expo-scope TypeScript check: passed.
- Expo web export: passed; routes include `/`, `/search`, `/explore`, `/news`, and `/reports`.
- `git diff --check`: passed.
- Production mutation: 0. No DB/schema/RPC, Edge Function, Cron, secret/Vault, OAuth, X, Push, or production data change.
- H2/G1/G2 files and workstreams were not changed.
- iOS simulator/manual QA remains not run in this turn.

### Scope of code delta

- `src/app/index.tsx`
- `src/app/search.tsx`
- `src/components/app-tabs.tsx`
- `src/components/app-tabs.web.tsx`
- `src/lib/dashboard.ts`
- `tests/app/dashboard_test.ts`

Next recommendation: C1 re-review the updated PR; do not merge or deploy from this H1 turn.

## Latest H1 result — Kabumori Home Dashboard V1 (2026-09-22)

- task_id: `kabumori-mobile-home-dashboard-v1-20260922`
- result: `review_required` — Home/Dashboard V1 implemented on a fresh main branch and pushed for C1 review. Production backend remains unchanged.
- source_base: `f8e35a2116f22f4c19885d50be99bfbac033d67e`
- branch/commit: `codex/kabumori-mobile-home-dashboard-v1-20260922` / `8225d47319eda388a82e85a3d3fbe20acf03a004`
- pull_request: https://github.com/anohi-memories/kabumori/pull/5

### Navigation and screens

- Root `/` is now Home/Dashboard V1.
- The existing stock search was preserved at `/search`; it still uses debounce, partial ticker/company search, registration status, and the existing tracked-stock editor.
- Native and web tab labels now show `ホーム`; Search is reached from Home quick actions and is not an additional bottom tab.
- Home includes quick actions, tracked-stock summary, important-news preview, and today's morning/close report preview.

### Data and safety

- Reused only existing client-side reads: `tracked_stocks`, `fetchMyImportantStockNews()`, and `fetchRecentReports()`.
- Each section loads independently via `Promise.allSettled`; a news/report/stocks failure leaves the other sections usable and shows a Japanese retry action.
- Pull-to-refresh is available. Empty tracked-stocks state links directly to Search.
- No current price, valuation, P/L, market index, or other unavailable realtime metric is fabricated.
- No Supabase migration/schema/RPC, Edge Function, Cron, secret/Vault, OAuth, X, Push, or production data change was made.

### Tests and verification

- Dashboard pure helper tests: 3 passed / 0 failed.
- Expo-scope TypeScript check: passed using the clean checkout's app-only verification config; the repository-wide check still contains unrelated admin/social-mobile/Edge Function known errors.
- Expo web export: passed; static routes include `/`, `/search`, `/explore`, `/news`, and `/reports`.
- `git diff --check`: passed.
- iOS simulator/manual QA was not run in this turn; no development build was changed.

### Changed files

- `src/app/index.tsx`
- `src/app/search.tsx`
- `src/components/app-tabs.tsx`
- `src/components/app-tabs.web.tsx`
- `src/lib/dashboard.ts`
- `tests/app/dashboard_test.ts`

### Remaining issues / next recommendation

- The PR is not merged. Review the Home visual hierarchy and native tab behavior in C1, then merge if accepted.
- The current app still has no realtime quote/P&L data source; those metrics remain intentionally absent.
- Exact next recommendation: stop for C1 review.

---

## Latest H1 result — search diagnostics production rollout (2026-09-22)

- task_id: `important-news-phase1-search-diagnostics-production-rollout-20260922`
- result: `review_required` — exact C1-approved diagnostics implementation integrated, exact migration applied, matching Function deployed, and three natural scheduled runs observed. Stop for C1.
- fresh_main_before_integration: `847dae2740a1714437b74c80b0d4c087d0a87b3d`
- integration_merge_commit: `f501fbb02714bd6d08bea2c321e406ed4b4d5e05` (PR #4: https://github.com/anohi-memories/kabumori/pull/4)
- integrated_files: `supabase/functions/important-news-shadow/index.ts`, `search_telemetry.ts`, `search_telemetry_test.ts`, `supabase/migrations/20260921115317_important_news_search_diagnostics.sql`
- validation: 18 Deno tests passed; `deno check` passed for the touched/runtime test files; `git diff --check` passed.

### Production migration

- Preflight proved the exact diagnostics migration was absent and the 16 new columns were absent.
- Applied only `20260921115317_important_news_search_diagnostics.sql` with the migration tool; no `db push`, `--include-all`, history repair, or unrelated migration.
- Postflight recorded migration row `version=20260922003120`, `name=20260921115317_important_news_search_diagnostics`.
- All 8 nullable integer columns exist on both `important_news_shadow_runs` and `ai_usage_events`; all 16 non-negative CHECK constraints exist. Existing RLS/grants/policies were unchanged by read-only comparison.

### Production Function

- Before: `important-news-shadow` ACTIVE v7, `verify_jwt=false`, source hash `c264fcd7da43b25a1a4b827bb72c77ec02063d06775aa4dff32f20645a284dcf`.
- After: ACTIVE v8, `verify_jwt=false`, source hash `559695babe6ddd925ff99df010a1a4798571d41a677e9270cd8e948af2aebe53`.
- Read-back of `index.ts`, `shadow_logic.ts`, `shadow_sources.ts`, and `search_telemetry.ts` matched main byte-for-byte. No other Edge Function version/hash changed.
- Cron job 38 remains active at `*/10 * * * *`; command hash remained `c0a89803846abb2464a1af02934266e1`. No Cron, secret/Vault, provider setting, X, Push, App, or fallback change.

### Natural scheduled observations

No Function was manually invoked; no candidate was injected; no OpenAI replay was performed.

- `2026-09-22 00:40 UTC` — run `b98b6122-12e8-47a2-b751-94178d60dbb0`, completed; conditional search 0; telemetry attempts/success/failure `0/0/0`; output/action buckets all 0; tokens/calls/cost `0/0/$0`.
- `2026-09-22 00:50 UTC` — run `7a3cd37a-9fa8-4e9f-acc2-57856411ec08`, completed; same zero-trigger/zero-telemetry result.
- `2026-09-22 01:00 UTC` — run `5aa3ce0e-31aa-4467-89c2-90ee89c84ec2`, completed; same zero-trigger/zero-telemetry result.

The three rows prove the new telemetry columns are written as non-NULL zeros on natural runs. No conditional search occurred, so no attempt/success/failure or action-type reconciliation is claimed. Existing backlog was not forced into the search path.

### Remaining uncertainty / next recommendation

- Provider billing units are not inferred from output-item counters; no provider billing setting or credential was changed.
- The first three natural runs were quiet and did not exercise a conditional search. Continue passive observation only if needed; do not inject candidates or replay OpenAI.
- Exact next recommendation: stop for C1 review.

---

# Codex Report

## Latest H1 result — conditional-search call accounting audit (2026-09-21)

- task_id: important-news-phase1-conditional-search-call-accounting-audit-20260921
- result: review_required — read-only audit completed; the stored event counts reconcile, but the exact 07:10 candidate headline and raw Responses action anatomy are no longer recoverable. Stop for C1.
- model_used: Luna.
- source_base: fresh `origin/main` `e38e2169d0fa6b7f16bdb4d124920140b1db5498`. The audited `important-news-shadow` source files were unchanged from the initial fresh base `c61e4f441e82eb8beb1647492f8c4d273d0c5158`; SHA-1s: `index.ts` `9e6f006d4fd27adb2d04f57a8185f382a3c2f05f`, `shadow_sources.ts` `39f4b92eaf995451e839b4c003a142d9c3d123b2`, `shadow_logic.ts` `34747f33ed6aed324ed851649365b735c9736ad2`.
- changed_files: control files only — `.agent/CODEX_REPORT.md`, `.agent/tasks/CODEX_TASK.md`, `.agent/CURRENT_STATE.md`, `.agent/ACTIVE_TASK.md`.
- implementation_code_changes: none. No test fixture was added because the Responses payload/action fields required to model the observed distinction are not persisted.
- tests: SELECT-only schema and production-row queries; current source review; official OpenAI docs/pricing review. No Deno test rerun because no runtime code changed.
- production_mutation: 0. No Function invoke/deploy, Cron, DB schema/RPC, secret/Vault, OpenAI replay, fallback policy, X, Push, or app change. Supabase access was read-only.
- commit_hash: none for application/source code; only control/report files were committed.
- push: yes — control/report synchronization only; H1 status-control commit was `9f2b30b1bd53699a5c3ff455c5f9d8465bea36ab` (this report formatting/readback refresh is a separate commit).
- deploy: none.

### A. 07:10 UTC natural run reconstruction

- Run: `fe5624a2-90b2-489b-a289-d9fe3e961742`, scheduled, completed at the 2026-09-20 07:10 UTC slot; 24 free candidates, 0 live matches, `conditional_search_count=1`, input/output tokens `4844/129`, `web_search_calls=2`, `cost_usd=$0.02112360`, `error_summary=[]`.
- `ai_usage_events` row id `71`: feature `news_shadow_search`, model `gpt-5.6-luna`, the same token/call/cost values, and `related_id` equal to the run id. Its read-only schema has separate `input_tokens`, `output_tokens`, `web_search_calls`, and `cost_usd` fields; it does not store the raw response, response id, or per-action types.
- Candidate metadata previously read for this natural trigger was source `jma_eqvol`, topic `disaster:jma`, category `disaster`, reason `new_high_signal_sparse`. The headline could not be revalidated: the current candidate table has zero rows for this run id and zero rows with `conditional_search_used=true`. Source code patches matching candidate rows on later observations, replacing their run id/reason/flag; it is not an immutable per-run history. Therefore the exact headline and response content are explicitly **not recoverable from the current production records**; none is guessed here.
- Surrounding runs: 07:00 UTC id `1a161da8-f187-4dff-8c90-362e6f94ef7d`, completed, 24 free candidates, 0 conditional events/calls/tokens/cost, GDELT source timeout in `source_health`; 07:20 UTC id `fb09d017-9a3b-48ef-b9f8-4ada0be77443`, completed, 24 free candidates, 0 conditional events/calls/tokens/cost. Both had empty run-level `error_summary`; the 07:10 run also had no `TARGETED_SEARCH_FAILED`.

### B. Counter semantics and official Responses API evidence

- In `index.ts`, `countWebSearchCalls` counts every response `output` item whose `type === "web_search_call"`; it does not inspect `item.action.type`. `conditional_search_count` is set to 1 when the run accumulated any positive input-token count or web-search-item count. It is therefore a per-run conditional-search/usage-event flag, **not a count of billable searches**.
- The request sends `max_tool_calls: 1`. OpenAI's current Responses API reference defines this as the maximum total built-in tool calls processed in one response, across built-in tools, with further attempts ignored: [Responses API create reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create).
- OpenAI's Web Search guide describes `web_search_call` output items and the action types `search`, `open_page`, and `find_in_page`; it specifically says search actions incur a tool-call cost: [Web Search guide](https://developers.openai.com/api/docs/guides/tools-web-search). The documentation reviewed does not establish that every counted output item is an independently billable search action, nor explain why this stored output-item count reached 2 with `max_tool_calls=1`.
- The raw response is not persisted (`store:false` and the application stores only aggregated usage). Thus this audit cannot determine the two items' action types, whether both were billable `search` actions, or whether provider-side usage agrees with the application's item count. The apparent 1-vs-2 discrepancy is real in the aggregate rows but is not enough to conclude that the API charged two searches or ignored its documented cap.

### C. Cost accounting and historical scan

- The code estimator is `input_tokens × $0.20/1M + output_tokens × $1.20/1M + counted_items × $0.01`. At 07:10 this is `4844×0.20/1M + 129×1.20/1M + 2×0.01 = $0.02112360`; the persisted run and usage-event estimates match exactly. The current OpenAI pricing page lists standard `gpt-5.6-luna` input/output at $0.20/$1.20 per 1M tokens, and Web Search at $10/1,000 calls plus model-rate search-content tokens: [OpenAI API pricing](https://developers.openai.com/api/docs/pricing). The formula's token rates match the standard schedule; the uncertain part is multiplying every `web_search_call` output item by the per-search fee.
- Across all 149 natural shadow runs from 2026-09-20 02:30 UTC through 2026-09-21 03:30 UTC: 19 had a conditional event and recorded output items; 16 had 2 items, 3 had 1, total 35, maximum observed 2. The 16 multi-item rows are exactly the 16 cases where `conditional_search_count` differs from `web_search_calls`. `ai_usage_events` has 19 corresponding `news_shadow_search` rows, and its aggregate 35 items / $0.37334580 matches the run-table aggregate. No natural run in this cohort recorded `TARGETED_SEARCH_FAILED`.
- Previous `$44.7552/30d` is the scenario `144 runs/day × 30 × ($0.01 + 300 output tokens × $1.20/1M)`, excluding input tokens and assuming exactly one billable search per run. If every one of two observed output items were instead treated as a separately billed search in every slot, the same output-only stress scenario would be `4320 × ($0.02 + $0.00036) = $87.9552/30d`. The latter is a scenario, not an established bound: the action types are missing, and the API docs define a per-response cap of one built-in tool call.
- Also, the source code does **not** implement a strict one-POST-attempt-per-run latch: `paidSearchUsed` is set only after a successful response reports positive input tokens or counted web-search items; a caught `TARGETED_SEARCH_FAILED` leaves it false, so a later eligible candidate can attempt another Responses POST. There were no such failures in the 149-run cohort. Each of 11 configured sources is parsed to at most 8 candidates (88 candidate rows/run at the parser ceiling), but request input length is not explicitly capped. Accordingly, `$44.7552` is not a hard worst-case ceiling; finite total cost cannot be established from current runtime/telemetry. No search-disable or fallback-suppressing cap is proposed.

### D. Next step / stop

- No runtime change or test was justified in this read-only pass. Next: C1 review, then, if authorized as a separate task, add privacy-minimal per-response diagnostics (attempt count, counts by `action.type`, and status category; no prompt/headline/raw response) and compare natural records with the read-only OpenAI organization usage ledger. Preserve the existing search trigger and emergency fallbacks; no hard suppression cap is included.
- remaining_issues: exact 07:10 headline and raw action/billing classification unavailable; request-attempt retries after a failed request are possible; true provider-invoiced cost is not present in Supabase telemetry.
- safety_checks: no secrets or raw model payloads recorded; no production mutation; no other slot's files or production objects changed.
- next_recommendation: STOP for C1.


## Latest H1 result — important-news GDELT timeout diagnosis (2026-09-20)

- task_id: important-news-phase1-gdelt-timeout-diagnosis-and-fallback-candidate-20260920
- result: review_required — read-only observation and bounded endpoint diagnosis completed; production remains unchanged; stop for C1.
- model_used: Luna.
- source_base: fresh `origin/main` 8fff49fbf80c29b700649891680d5a1213e788f9; production `important-news-shadow` ACTIVE v7, `verify_jwt=false`, source SHA-256 `c264fcd7da43b25a1a4b827bb72c77ec02063d06775aa4dff32f20645a284dcf`. Deployed `index.ts`, `shadow_sources.ts`, and `shadow_logic.ts` matched the source files at this base byte-for-byte.
- Cron read-back: job 38 active, `*/10 * * * *`. No Cron/function/config change.
- implementation_code_changes: none. No local candidate or tests were added because external query comparisons were rate-limited and yielded no usable response.
- production_mutation: 0. All database reads were SELECT-only; no manual Function invoke, candidate injection, replay, deploy, migration/schema/RPC, setting, secret/Vault, X, Push, or fallback change.

### A. Natural shadow observation

- Read-only window: 2026-09-20 02:30–07:10 UTC (11:30–16:10 JST), 4h40m. 27 natural scheduled rows: 27 completed, 0 partial, 0 failed. The requested 6h window was not yet available; 6/12/24h remain left-censored.
- GDELT: 5 actual polls failed at 03:00, 04:00, 05:00, 06:00, and 07:00 UTC. Every error was `Signal timed out.` after 15,001–15,002 ms. The other 22 scheduled rows were `skipped_cooldown`; there were 0 successful GDELT polls and 0 stored GDELT candidate rows.
- Other ten sources were healthy in all 27 runs; no other source failure was persisted.
- All 27 shadow runs completed. Stored shadow matches = 0. Across the window there was 1 conditional-search event, 2 Web Search calls, and estimated cost $0.02112360. This natural cost was generated at 07:10 UTC; it was not a manual replay.
- Same-window live high-importance readback: one `important` live row (“North Korea launches unidentified projectile toward the sea”), published 06:31:04 UTC and fetched 07:00:32 UTC; no stored shadow match was recorded through 07:10. The row was fetched after the 07:00 shadow cycle. The shadow store contained an older BBC headline about Houthi missile activity (published 23:49 UTC on Sep 19), not this North Korea event. This is a single observed non-match, not a recall/false-negative rate; source availability and full-window parity are unproven. The current GDELT query does not include North Korea, missile, or projectile terms, so fixing its timeout alone would not make it a targeted route for this event.
- Per-run volume: 11 source checks and 24 candidate observations; 297 source checks and 648 observations total.

### B. Current GDELT request anatomy

- Fixed endpoint: `https://api.gdeltproject.org/api/v2/doc/doc`.
- Query: `(earthquake OR tsunami OR ceasefire OR sanctions OR tariff)`; `mode=artlist`; `maxrecords=25`; `format=json`; `sort=datedesc`; no explicit `timespan`, language, or source restriction.
- GDELT's official DOC API material says the default search period is the latest three months; `timespan` can narrow this to minute/hour/day/week values, and `maxrecords` controls returned article-list rows. [GDELT DOC 2.0 API documentation](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/)
- Headers: `Accept: application/json`; `User-Agent: Kabumori-important-news-shadow/1.0 contact@kabumori.app`.
- Client timeout: `AbortSignal.timeout(15_000)`. Non-2xx responses become `SOURCE_HTTP_<status>`; JSON parsing follows the fetch. There is no explicit streaming/content-length byte cap. The GDELT parser then requires an articles array, HTTPS URL and valid/recent `seendate`, and retains at most 8 candidates. Thus the returned-row cap/parser cap does not bound response bytes before `response.json()`.
- Cooldown: GDELT is polled only when UTC minute is `:00`; the shadow Cron itself runs every ten minutes.

### C. Bounded external probes and diagnosis

- One GET of the current broad query and one GET of the same terms with `timespan=1h&maxrecords=8` were made to the public endpoint; no production Function was invoked.
- Both returned HTTP 429, 444 bytes, after 11.644s and 12.009s. The response said to limit requests to one per five seconds. Neither returned JSON/articles, so item count, relevance yield, payload size under a successful response, or latency improvement from the bounded variant could not be assessed. Further probes were stopped to respect the endpoint response.
- Production persisted errors expose only the timeout and total elapsed latency, not DNS/TLS/connect, time-to-first-byte, HTTP headers/status, body-transfer, response-size, or JSON-parse timings. No platform logs were accessed. The production poll cadence is hourly, far below the endpoint's stated five-second limit; the probe's 429 therefore does not prove the production timeout is rate-limit caused.
- Root-cause confidence: **low**. Evidence is consistent with server/query latency or the broad default three-month search window, while external test egress was independently rate-limited. It does not distinguish query complexity, endpoint instability, production network path, slow body delivery, or whether 15 seconds is simply too short. No timeout increase or query rewrite is justified from these measurements.

### D. Value and fallback semantics

- GDELT added no stored items in five actual polls; its unique-event contribution is unobserved. The prior 19-row replay cohort has no replacement-route `first_seen_at` evidence, so historical GDELT recall or a unique GDELT-only event is not proven.
- The 07:00 row had exactly one degraded source (GDELT), zero conditional searches, zero Web Search calls, and $0. At 07:10, GDELT was `skipped_cooldown` and failed-source count was zero; the JMA candidate independently used `new_high_signal_sparse`, yielding one conditional-search event, two Web Search calls, and $0.02112360 estimated cost.
- Code review confirms `failedSources` counts only `status=failed`. The source-degradation branch requires at least two degraded sources plus a high-signal headline. A single GDELT timeout alone therefore does not trigger that branch. However, the separate “new high-signal + summary shorter than 80 characters” branch can search regardless of degraded-source count. Do not summarize behavior as “one source timeout always means no search.”
- A single source timeout is caught per-source; the other ten sources complete and the shadow run remains completed. The shadow work does not modify or disable the separate legacy paid/live fallback path; all such fallbacks remain enabled.

### E. Code/tests, safety, and exact next proposal

- No code, fixture, or test change was made. Existing implementation/test files were reviewed; no test suite was run because there was no code change and the available environment is a read-only repository mirror.
- No further external requests are proposed now. Exact next proposal: **option 5 — evidence insufficient; continue natural observation only**, preserve the existing hourly cooldown and every paid/live fallback. Reconsider a local-only `timespan=1h/maxrecords=8` optimization only after a permitted successful and repeatable response demonstrates under-15s completion and target-lane utility; no production application is part of this proposal.
- Safety: production mutation 0; no Function invoke/deploy, Cron/config, schema/migration/RPC, secret/Vault, manual OpenAI replay, candidate injection, X/Push/App, or legacy fallback change.
- next_owner: chatgpt; stop for C1.

---



## Latest H1 result — important-news shadow observation + source-rights research (2026-09-20)

- task_id: important-news-phase1-shadow-observation-plus-source-rights-research-20260920
- result: review_required — read-only observation and source-rights/provider research completed to the extent supported by the current sample; C1 review requested.
- source_base: fresh origin/main 2fbb0a11480a79718d8cadfa5e6c65693cf0de33 immediately before the refreshed documentation branch commit. The artifact branch was fast-forwarded to this main and contains no runtime code changes.
- candidate_branch: [codex/important-news-source-rights-research-20260920-c1fix](https://github.com/anohi-memories/kabumori/tree/codex/important-news-source-rights-research-20260920-c1fix)
- candidate_commit: ffb21da81a082288dacb652f82640f5165b965a5 (documentation-only; not merged; refreshed from current main).
- research_document: [SHADOW_RIGHTS_AND_LICENSED_OPTIONS_2026-09-20.md](https://github.com/anohi-memories/kabumori/blob/codex/important-news-source-rights-research-20260920-c1fix/docs/news-coverage/SHADOW_RIGHTS_AND_LICENSED_OPTIONS_2026-09-20.md)
- changed implementation files: none. Artifact branch changes only the research document; main receives H1 control/report/index updates only.

### Natural shadow readback

- Observation rows: 17 natural scheduled runs, 2026-09-20 02:30–05:30 UTC (11:30–14:30 JST); 17/17 completed, 0 partial, 0 failed.
- The 6h, 12h, and 24h queries each returned the same 17 rows because the shadow had activated at 02:30 UTC. This is only about 3 hours of observed history, not complete windows; no 6/12/24-hour trend conclusion is claimed.
- 11 source checks/run (187 checks) and 24 per-run candidate observations/run (408 observations). Deduped table has 41 event keys: Al Jazeera 16, BBC World 9, JMA 16. Latest sighting was at 05:30 UTC.
- Ten non-GDELT sources were healthy in all 17 runs. GDELT: 3 failed attempts at the 15-second timeout, 14 cooldown skips, 0 items. All run-level error_summary arrays were empty; 17 distinct scheduled slots, no duplicate slot rows. Platform logs were not inspected, so this does not rule out non-persisted transient/auth attempts.
- Same-window live important/most_important candidates: 0. Stored live matches: 0. No positive high-importance event occurred in the observation window; 0 matches is not evidence of false negatives or parity.
- Shadow costs: 0 conditional searches, 0 Web Search calls, 0 tokens, $0 estimated cost in this quiet sample. All paid/live fallbacks stay enabled.

### Rights, provider options, and economics

C1 follow-up: corrected the prior ~4x overstatement by keeping per-fetch-cycle cost separate from nominal search-slot counts. The underlying observation sample and all source-rights findings are unchanged.

- JPX TDnet API Index is the most concrete lane-specific route found: official materials say third-party redistribution is allowed, the index API has no API information fee, fixed basic fee is ¥70,000/month before tax, index content is real-time, and the API provides five-year history. Corporate contract, permitted polling, retention/cache, attribution, and exact end-user use still need written confirmation. The test server returns dummy data. The individual J-Quants TDnet add-on at ¥11,000/month is prohibited for corporate/academic use; TDnet on Snowflake Index is ¥100,000/month and disallows external-user distribution.
- Other candidates: AP Media API supports continuous feeds with contract-based item pricing; Lloyd’s List has vessel/risk APIs but no verified incident-alert coverage and quote-only pricing; NewsAPI Business is $449/month (developer tier cannot be production); NewsData.io Basic is $199.99/month but its free tier is delayed 12 hours and paid display rights/coverage are not independently verified; Twelve Data plan details conflict ($499 Venture card / $414 annual, footer “from $149”), and exchange-specific rights require confirmation.
- Official-source terms are mixed: MOD PDL1.0 allows commercial reuse with attribution except excluded/third-party items; NHK general news RSS business rights remain unconfirmed; UKMTO site content references OGL but no authless API was validated and terms are old; PBOC/MOFCOM/State Council terms vary by subsite and are not treated as blanket permission.
- Illustrative legacy cost comparison only: prior observed small-sample mean = $0.056721/fetch cycle. Through Sep 23, 12 fetch cycles/day (48 nominal search slots/day at 4 slots/cycle) equals $0.680652/day, about $20.42/30d. From Sep 24, 24 cycles/day (96 nominal search slots/day) equals $1.361304/day, about $40.84/30d. Search-slot counts are not multiplied by per-cycle cost. These are illustrative calculations from a small sample, not invoices or a spend forecast.
- A/B/C architecture comparison and per-lane fallback status are documented in the research artifact. No architecture is ranked, no source is adopted, and no legacy search is reduced.

### Exact next proposal

Proposal category 3 only: obtain written JPX confirmation for TDnet API Index-only corporate terms and final cost, including eligibility, end-user title/index display, poll/rate guidance, caching/retention, attribution, history, latency/support. No inquiry was sent in this task. No account, key, trial, contract, billing, or adapter was created.

### Tests, safety, and remaining issues

- Supabase validation was SELECT-only. No runtime code changed, so no code test suite was run.
- Production mutation: 0. No Function invoke/deploy, Cron, schema/migration/RPC, secret/Vault, source-polling setting, API account/contract/purchase/trial, fallback reduction, X/Push/App/OAuth, or manual OpenAI replay. Candidate injection: 0.
- Remaining: 6h/12h/24h windows are incomplete; recall parity and lane coverage remain unproven; GDELT remains degraded; source-specific contract, polling, retention and display terms require confirmation before any integration.
- next_owner: chatgpt; stop for C1. No merge requested or authorized.

---
## Latest H1 result — important-news shadow coverage-gap source research (2026-09-20)

- task_id: `important-news-phase1-shadow-coverage-gap-expansion-candidate-20260920`
- result: `review_required` — source/lane research completed; no source met the acceptance bar for a local parser/runtime candidate. C1 review requested.
- source_base: fresh GitHub `main` at `827a0afc0ef625708aae8509a07a7f9ce79d91ce`. Candidate branch was rebased onto this exact main; the intervening commits touched only H2's app/config and control files.
- candidate_branch: [codex/important-news-phase1-shadow-coverage-gap-expansion-20260920](https://github.com/anohi-memories/kabumori/tree/codex/important-news-phase1-shadow-coverage-gap-expansion-20260920)
- candidate_commit: `451d1812aa443522307401e163fb34296e4de772` (documentation-only).
- research_document: [SHADOW_COVERAGE_GAP_RESEARCH_2026-09-20.md](https://github.com/anohi-memories/kabumori/blob/codex/important-news-phase1-shadow-coverage-gap-expansion-20260920/docs/news-coverage/SHADOW_COVERAGE_GAP_RESEARCH_2026-09-20.md)
- changed_files_on_candidate_branch: only `docs/news-coverage/SHADOW_COVERAGE_GAP_RESEARCH_2026-09-20.md`. No source, parser, tests, migration, Function, or production code changed.

### Findings

- TDnet: current live monitor uses the public listing HTML, but its `robots.txt` disallows all crawling; JPX's independent structured TDnet API is paid. Do not copy live rows into shadow and call that independent measurement.
- North Korea/J-Alert: MOD archive direct fetch returned 403; MOD RSS is low cadence and is not a launch-alert feed. NHK international RSS is reachable and has explicit timezone offsets, including a later North Korea missile-related item, but it does not prove the Sep 12 event, the current parser's 8-item cap can omit fresh entries, and business reuse terms are unclear. Research-only; do not poll/deploy pending written permission and event-window validation.
- Shipping: UKMTO's relevant public incident page is not machine-retrievable in the probe (403); no authless public feed/API was validated. China: no current structured official feed with proven cadence/timestamp lineage. Abrupt market moves: current MIC metrics are date-only/daily, insufficient for intraday triggers; realtime market data carries access/licensing constraints.
- Backtest: the 19-row Sep 4–15 replay cohort has no replacement-route `first_seen_at` for any row. Specific source publication times (e.g. AP/Guardian shipping cases) are not collector ingestion evidence. Sep 18 BOJ predates the observed shadow window. No TP/FP/FN or detection-delay score is claimed.
- Shadow readback: 12/12 natural run rows completed through 2026-09-20 04:40 UTC; 0 stored live matches and 0 conditional-search calls in the sampled window. The preceding 48h live high-importance set had 14 rows (13 TDnet, 1 BOJ). Recall parity remains unproven; every paid/live fallback remains enabled.
- Exact production proposal: none. No Web Search reduction, threshold change, fallback substitution, or source polling is recommended.

### Tests and safety

- Existing shadow Deno suite: 14 passed / 0 failed with `--no-check` and read access scoped to the shadow source/migrations. The default checked run is blocked by absent `npm:@types/node` in the clean worktree; dependencies were not installed because runtime code was unchanged.
- `git diff --cached --check`: passed for the documentation commit.
- Production mutation: **0**. SQL was SELECT-only. No manual Function invoke, replay, deployment, Cron/schema/RPC/secret/Vault/MIC/legacy-pipeline change, X/Push/App/OAuth action, or candidate injection occurred.
- remaining_issues: source rights/access and historical ingestion proof are unresolved for every uncovered lane; full reasoning and per-lane matrix are in the research document. Keep fallbacks and request a separately scoped review before any production change.
- next_owner: `chatgpt`; stop for C1.

## Latest H1 result — important-news shadow observation and match audit (2026-09-20)

- task_id: `important-news-phase1-shadow-observation-and-match-audit-20260920`
- result: `review_required` — read-only production audit completed; C1 review requested. No shadow/live recall parity conclusion and no legacy fallback reduction is supported.
- source_base: fresh GitHub `main` at `96d8c3e831de99e53a96a36ee68228033e9716c0` (confirmed by the GitHub branch read immediately before this report sync). Local linked-worktree `git fetch` could not write its shared `FETCH_HEAD`; the remote default branch and files were read directly through GitHub.
- observation_window: 2026-09-20 02:30–04:10 UTC (11:30–13:10 JST); production readback completed at approximately 04:12 UTC.
- production_mutation: 0. SQL access was SELECT-only; no manual Function invoke, OpenAI replay, secret read, deploy, Cron change, schema/data write, X/Push/App action, or legacy fallback change.
- implementation_code_changes: none. Offline evaluation was an ephemeral read-only replay; no repository test or matcher code was changed.
- files_changed_for_handoff: `.agent/tasks/CODEX_TASK.md`, `.agent/CODEX_REPORT.md`, `.agent/CURRENT_STATE.md`, `.agent/ACTIVE_TASK.md` (control-only). No implementation commit.
- push: control-only commit to `main`; no application/runtime code is included. Commit SHA is the main head produced by this report sync.

### Production read-back / safety

- `important-news-shadow`: ACTIVE v6, `verify_jwt=false`, deployed source SHA-256 `c264fcd7da43b25a1a4b827bb72c77ec02063d06775aa4dff32f20645a284dcf`. Read-back files `index.ts`, `shadow_logic.ts`, and `shadow_sources.ts` match the fresh `main` source byte-for-byte.
- Shadow Cron job 38: active, `*/10 * * * *`, command MD5 `c0a89803846abb2464a1af02934266e1` (unchanged). Dedicated custom `X-Cron-Secret` authentication remains as previously approved; secret value was not read or emitted.
- Legacy Cron jobs 2/3/4/8 are unchanged: job 2 `0,20,40 * * * *` / `b9a98c88ada68d0552ac66c9e8e19983`; job 3 `7,27,47 * * * *` / `438fb5cb0d1206bdfc6af7b379c06788`; job 4 `14,34,54 * * * *` / `951233b2a4fe7ae2b82ef83292276565`; job 8 `*/5 * * * *` / `bc7fddb4557c9babecec6af57fede247`.
- `important-news-monitor` remains ACTIVE v60 with source SHA-256 `ce7b4bf79da6fb35f8593c4a692ef125acdbdb0ed26c189a761f15eeb5a4070f`.
- No auth/server failure loop was observed in the persisted sample: 9/9 natural Cron records succeeded, 9/9 shadow records completed, and all run `error_summary` values were empty. GDELT source timeouts are recorded separately below. Function/platform logs were not available through this read-only path, so this does not rule out non-persisted transient attempts between these cycles.

### Natural shadow window / first-seen

- 9 distinct natural slots were present: two prior 30-minute canaries (02:30, 03:00 UTC) plus seven 10-minute runs (03:10–04:10 UTC). All 9/9 run rows are `completed`; all are non-synthetic; no duplicate slot or retry storm was observed.
- Each run reported 11 source checks and 24 free-source item observations (216 observations total). The deduped candidate table held 31 unique events at the latest read: `al_jazeera` 15, `bbc_world` 8, `jma_eqvol` 8. All 31/31 had `first_seen_at`; none was synthetic. `published_at` was present for all, with no future timestamp or item older than 48 hours at first observation.
- `first_seen_at` is collector observation time, not proof of historical source availability. The mean published-to-first-seen intervals were Al Jazeera 129.2m, BBC World 291.4m, and JMA 30.1m; the first two are left-censored by shadow activation at 02:30 UTC and must not be interpreted as steady-state ingestion delay.
- The candidate table upserts repeat observations while retaining `first_seen_at`; per-run candidate membership is not retained. Accordingly, 31 is a unique-event count, not a per-cycle count.

### Source health and quality

| Source | Observed health/items | Assessment |
| --- | --- | --- |
| BOJ | healthy 9/9; 0 items | Primary source; insufficient evidence of freshness/cadence in this window. |
| Fed | healthy 9/9; 0 items | Primary source; insufficient evidence of freshness/cadence in this window. |
| JMA | healthy 9/9; 8 unique events; summaries 88–108 chars | Primary feed with valid recent timestamps; the 8 titles are routine ashfall forecasts, so relevance/noise is limited and needs lane adjudication. |
| USTR | healthy 9/9; 0 items | Primary source; insufficient evidence of freshness/cadence in this window. |
| UN peace/security | healthy 9/9; 0 items | Primary source; insufficient evidence of freshness/cadence in this window. |
| EIA | healthy 9/9; 0 items | Primary source; insufficient evidence of freshness/cadence in this window. |
| BBC World | healthy 9/9; 8 unique events; mean summary 118 chars | Useful secondary source but noisy/limited for market relevance; broad feed includes non-market entertainment/culture and headlines were already published several hours before collector activation. |
| Al Jazeera | healthy 9/9; 15 unique events; mean summary 113 chars | Useful secondary source but noisy/limited for market relevance; broad feed includes sports/music and semantically similar multi-article coverage. |
| ECB | healthy 9/9; 0 items | Primary source; insufficient evidence of freshness/cadence in this window. |
| SEC | healthy 9/9; 0 items | Primary source; insufficient evidence of freshness/cadence in this window. |
| GDELT | 7 `skipped_cooldown`; 2 actual polls failed at the 15s timeout; 0 items | Unhealthy/insufficient evidence. The hourly `:00` poll policy worked as designed, but both observed attempts timed out. |

- The ten non-GDELT sources returned healthy status in all nine cycles. “Healthy” means fetch/parse completed; it does not establish materiality or recall for zero-item feeds. White House remains excluded and was not changed.

### Live comparison / 0-match root cause

- In the 24 hours ending 2026-09-20 04:12 UTC there were 0 live `important` / `most_important` candidates. In the 48-hour live matcher window there were 14: 10 `important` and 4 `most_important`; 13 were TDNET and 1 was a BOJ `breaking_market` item. They were all fetched on Sep 18 between 05:20 and 12:40 UTC, well before the Sep 20 shadow observation window. The full 48-hour pool contained 99 live candidates (85 `no_post`, 14 important/high).
- Stored shadow/live matches: 0/9 runs; no detection-delay value is available.
- Offline current-matcher evaluation on 31 unique shadow rows against the 99 live rows reproduced 0 matches: canonical URL matches 0; 92 pairs passed the category-or-entity/topic prefilter, but none reached the 0.66 token-overlap threshold; predicted matches 0. None of the 14 important/most-important live rows passed the category/entity prefilter.
- Root-cause classification: primarily (1) no live high-importance event in the same observation window and (2) source/category coverage mismatch. The live high-importance set was dominated by Japanese corporate IR, for which shadow has no TDNET source; the shadow set was JMA routine notices and broad BBC/Al Jazeera world items. Exact/canonical URL failure, title normalization, event-key failure, and threshold-caused false negatives are not established by this sample. The current threshold should not be loosened without adjudicated same-event pairs.

### Historical 19-row replay / matcher limits

- The replay CSV contains the 19 historical cohort rows marked `unproven` plus one supplemental row that is outside the denominator. `new_route_first_seen_at_utc` is absent for all 19. The replay dates precede the Sep 20 shadow activation, so no historical replacement-route candidate/first-seen ground truth exists for TP/FP/FN or detection-delay scoring.
- Current matcher contract remains: canonical URL match first; otherwise candidate category equality or `live.entity_key == shadow.topic`, title token overlap >= 0.66, and publication times within 12 hours. No source change was made.
- TP/FP/FN are therefore unscorable for the 19-row historical cohort and the current 31 shadow items; unmatched rows are not labelled false positives or false negatives. The previous Deno suite result (14 passed) belongs to the rollout task; no Deno suite was rerun because this audit changed no code. This turn’s one-shot offline evaluation is not a committed regression test.
- Recall parity: NOT PROVEN. Keep all legacy paid-search fallback lanes enabled.

### Conditional search / cost

- Across 9 natural runs: `conditional_search_count=0`, `web_search_calls=0`, input/output tokens `0/0`, run-estimated cost `$0`. `ai_usage_events` had 0 `news_shadow_search` rows in the same window.
- The seven 10-minute runs alone also had 0 paid searches and `$0`. Under this observed quiet-window condition only, projected shadow cost is `$0/day` / `$0 per 30 days`; this is not a forecast for future trigger events.
- Trigger audit: every observed candidate summary was at least 85 characters (the sparse rule is `<80`); at most one source was degraded per run, below the fallback trigger’s `>=2`; bootstrap baseline suppresses backlog search; and duplicate/topic cooldown suppresses repeats. These explain why a degraded GDELT poll did not cause a search.
- The code enforces at most one Web Search call per run. At `*/10`, the schedule permits at most 144 runs/searches per day if every run has a new eligible event. The code’s estimator is `$0.01/search + $0.20 per 1M input tokens + $1.20 per 1M output tokens`; output is capped at 300 tokens and tool calls at 1, so the estimated maximum excluding input is `$1.49184/day` (`$44.7552/30 days`) if every slot triggers. Input length has no explicit token cap, so this is not a finite total-cost ceiling or an actual bill. No hard cap that could suppress an emergency fallback is proposed.
- Legacy baseline remains 48 nominal searches/day through Sep 23 and 96/day from Sep 24. Shadow cost is additional; this audit made no legacy reduction.

### Lane evidence / fallback matrix

| Lane | Evidence in this window | Lane-safe? / fallback |
| --- | --- | --- |
| War / geopolitics | BBC/Al Jazeera items; no same-window live high-importance pair; broad-feed noise | No; keep paid fallback. |
| North Korea / J-Alert | No dedicated source or representative event | No; keep paid fallback. |
| Tariffs / trade / sanctions | USTR healthy but empty; broad secondary coverage only | No; keep paid fallback. |
| FX / central bank | BOJ/Fed/ECB healthy but empty; old BOJ live event outside the comparison window | No; keep paid fallback. |
| Disaster / infrastructure | JMA fresh routine notices; no live important match | No; keep paid fallback. |
| Energy / oil | EIA healthy but empty | No; keep paid fallback. |
| Shipping / chokepoints | No dedicated feed and no adjudicated match | No; keep paid fallback. |
| Financial system | SEC healthy but empty; no representative event | No; keep paid fallback. |
| China | No China-specific source/event pair in sample | No; keep paid fallback. |
| Semiconductor / AI / export controls | USTR healthy but empty; no representative lane event | No; keep paid fallback. |
| Overseas major earnings | SEC healthy but empty; no demonstrated earnings coverage | No; keep paid fallback. |
| Japan corporate IR | No TDNET shadow collector; 13 of 14 prior-window important live rows were TDNET | No; keep paid fallback. |
| Japan/US abrupt market moves | No market price/time-series or adjudicated abrupt-move pair in shadow set | No; keep paid fallback. |

### Recall gate / next recommendation

- Preserve the existing 14-calendar-day natural observation recommendation. A conservative lane-safe gate is at least 59 independently adjudicated positive events for each severity (`important` and `most_important`) per lane with zero misses; 59/59 gives a one-sided 95% exact lower recall bound just above 95%. Any missing severity sample remains insufficient, particularly if no `most_important` examples occur.
- For observed positives, require median detection delay <=10m and p95 <=20m; every `most_important` must be matched with delay <=20m. Use independently evidenced event/source timestamps, not legacy `fetched_at` alone. Any source unhealthy, stale, timestamp-invalid, or absent for that lane keeps legacy fallback enabled.
- Continue natural shadow only. C1 should review the data window, matcher classification, 19-row evidence limit, cost formula, and lane gate. Do not deploy, change Cron/schema, loosen the matcher, or reduce legacy paid search under this task.

### Safety / verification

- Production state mutations: 0. No Function invocation, manual candidate, OpenAI replay, source setting, secret/Vault, Cron, migration/schema/RPC, live pipeline, X/Push/App, OAuth/social-mobile, market-report, or other slot changes.
- Supabase procedure skill file was not present at its configured filesystem path in this runtime; production work was kept to read-only SELECT and read-back operations.
- Preflight found the shared H2 index displayed `ready` while `.agent/tasks/CODEX_TASK_2.md` was `review_required`. H1 updated only its own control/index entries and did not change slot 2.

---
## Latest H1 result — important-news live shadow rollout (2026-09-20)

- task_id: `important-news-phase1-live-shadow-rollout-20260920`
- result: `review_required`; two natural 30-minute canaries completed, the shadow Cron moved to 10 minutes, and one natural 10-minute run completed. C1 review is required; no auto-merge.
- fresh origin/main before final control sync: `ea94305d4a16308fe5f8ea7291484c36107b35c0` (`Record Phase 11 OAuth manual QA gate`).
- implementation branch: `codex/important-news-live-shadow-20260920`; PR head at creation `e4edb6f66f40ec06bab9196dbcfe9aabd4a16159`.
- PR: [#1 — Add isolated important-news live shadow](https://github.com/anohi-memories/kabumori/pull/1), open, not merged, auto-merge not enabled. This follow-up Report metadata commit updates the PR branch with the final PR URL.
- exact migration: `supabase/migrations/20260919195155_important_news_shadow_phase1.sql`; SHA-256 `e600f2cf5f16eb29d4297cef9d7c110a422806436000e1ae2f39c01550ddf8b2`.
- production Function: `important-news-shadow` v6 ACTIVE, `verify_jwt=false` with fail-closed in-code `X-Cron-Secret` auth; source SHA-256 `c264fcd7da43b25a1a4b827bb72c77ec02063d06775aa4dff32f20645a284dcf`. v6 retains a GDELT poll only at UTC minute `:00`, independent of the 10-minute Cron cadence.
- secret proof: new dedicated `important_news_shadow_cron_secret` is configured in the Function environment and Vault; no value was read back or emitted. Natural Cron runs reached completed shadow records, confirming the Vault-backed header path. Cron/readback evidence contains only the secret reference/header name and command hash, never plaintext.
- shadow Cron: jobid `38`, name `important-news-shadow`, active `true`, schedule `*/10 * * * *`, command MD5 `c0a89803846abb2464a1af02934266e1` (unchanged from 30m canary). Only this job's schedule changed from `*/30` to `*/10`.

### Natural execution evidence

| UTC | Cron run | Shadow run | Result |
| --- | --- | --- | --- |
| 2026-09-20 02:30 | `54292` succeeded | completed 02:30:02.882–02:30:05.033 | 11 sources, 24 free candidates, 0 live matches, 0 paid searches, $0; GDELT skipped by cooldown |
| 2026-09-20 03:00 | `54364` succeeded | completed 03:00:17.298–03:00:19.299 | 11 sources, 24 free candidates, 0 live matches, 0 paid searches, $0; GDELT timed out at 15s, other 10 sources healthy |
| 2026-09-20 03:10 | `54388` succeeded | completed 03:10:02.834–03:10:05.607 | 11 sources, 24 free candidates, 0 live matches, 0 paid searches, $0; 10 sources healthy, GDELT skipped by cooldown |

- 24 candidate observations were recorded from BBC World, Al Jazeera, and JMA earthquake/volcano sources; all 24 had `first_seen_at` values when read back. These are collector-observation times, not proof of historical source availability. No shadow candidate matched a live candidate in these runs, so recall parity and detection delay remain unproven.
- GDELT's 03:00 timeout was isolated; the other sources remained healthy. The pre-cutover cadence audit found the old half-hour cooldown would otherwise allow three GDELT calls/hour under a 10m Cron. The same shadow Function was therefore updated/tested to poll only at UTC `:00`, redeployed as v6, and the 03:10 natural run confirmed `skipped_cooldown`.
- Source set: BOJ, Fed, JMA, USTR, UN peace/security, EIA, BBC World, Al Jazeera, ECB, SEC, GDELT. White House feed remains excluded after preflight HTTP 404. GDELT had a prior preflight timeout and is rate-limited to hourly polling.
- Conditional search/tokens/web search/cost: `0 / 0 / 0 / $0` across the three observed runs. This is the observed quiet-window cost only; future conditional-trigger cost is variable and not proven zero.

### Safety, validation, and remaining work

- Legacy Cron job ids `2/3/4/8` retain schedules and command MD5s: fetch `0,20,40` / `b9a98c88ada68d0552ac66c9e8e19983`; judgement `7,27,47` / `438fb5cb0d1206bdfc6af7b379c06788`; generation `14,34,54` / `951233b2a4fe7ae2b82ef83292276565`; publish-ready `*/5` / `bc7fddb4557c9babecec6af57fede247`.
- `important-news-monitor` remains v60, source hash `ce7b4bf79da6fb35f8593c4a692ef125acdbdb0ed26c189a761f15eeb5a4070f`.
- The project-level addition of the dedicated secret incremented platform Function version counters for unrelated Functions; read-only comparison showed their source hashes and `updated_at` values unchanged. No unrelated Function source was deployed and no existing secret was modified.
- Shadow tables have RLS enabled, zero client policies, no `anon`/`authenticated` SELECT privileges, and `service_role` SELECT. Shadow code has no X/Push/App/publish write surface; static boundary test passes. No manual Function invocation, candidate injection, X post, Push, or App write was performed.
- Tests: Deno suite `14 passed / 0 failed`; `deno check` on `important-news-shadow/index.ts` passed; `git diff --check` passed.
- Rollback remains disabling only Cron job 38; keep shadow audit rows. No live legacy rollback is needed.
- Candidate rows are deduped to one row per event key; later sightings update the latest `shadow_run_id`/`last_seen_at` while preserving `first_seen_at`. Historical run-to-candidate links are not retained; per-run aggregate counts and source health remain in `important_news_shadow_runs`.
- Remaining: only two 30m runs plus one 10m run are observed; 0 live matches means no recall/delay conclusion. Continue shadow observation (recommended 14 days); do not reduce legacy paid fallback or cut over. Review this H1 in C1 before merge; PR must remain unmerged.

## Latest H1 result — Phase 1 recall replay continuation (2026-09-19)

- task_id: `important-news-cost-phase1-recall-safe-shadow-handoff-20260919`
- result: `review_required`; C1 review requested. Recall gate remains NOT PASS; do not start production shadow rollout.
- fresh origin/main immediately before control sync: `aa2694c43f28612548ebbce3e10bc6c043b43c02`.
- replay artifact branch: [codex/important-news-phase1-replay-followup-20260919](https://github.com/anohi-memories/kabumori/tree/codex/important-news-phase1-replay-followup-20260919), latest commit `b7f14ef3455339b7857aa7f155aa591c494ad903` (artifact branch began at the fresh main available before an unrelated C2 control-only main update).
- prior isolated code/design branch retained, not merged or deployed: `codex/important-news-phase1-recall-safe-20260919` @ `8fd612471b04d09bd379a7ed74ed99e84647a72b`.

### Replay artifact and result

- Files: `docs/news-cost-optimization/replay/phase1-recall-reconstruction-2026-09-04-to-18.md` and matching `.csv` on the replay branch.
- Cohort: 19 high-importance `breaking_market` candidates fetched Sep 4–15, reconstructed as an explicit equivalent set; stable UUID, entity key, topic/category, importance, source URL, production `published_at` and `fetched_at`, and independently calculated legacy fetch lag are recorded. Sep 18 BOJ is supplemental, not in the 19 denominator.
- The production schema does not identify discovery provider per `breaking_market` candidate. Thus the exact prior 19 Web-Search-derived set and five unverified case identities remain unrecovered; no claim is made that this equivalent set is identical.
- Replacement collector historical `first_seen_at` is missing for all 19. The proposed source aliases are marked as replay terms only, not executed queries. GDELT historical API results/collector logs were unavailable. Therefore 19/19 replacement recall and relative detection delay are unproven; **all represented lanes keep paid fallback**. The inherited 12 timely / 2 delayed / 5 unverified split is not revalidated.
- Israel–Hezbollah: AP published 06:35:26Z; legacy fetched 07:00:23Z (24m57s). The Al Jazeera item is date-only (Sep 5), with no source collector first-seen; inherited +45m cannot be independently recomputed.
- Mayun/Perim: AP published 11:29:23Z; legacy fetched 14:20:20Z (2h50m57s). Guardian says first published 08:00 EDT = 12:00Z, i.e. 30m37s after AP publication and 2h20m20s before legacy fetch. This is source-publication timing only, not GDELT/collector ingestion. The inherited +7h cannot be independently recomputed.
- Fallback lanes: Japan/FX and US macro, war/geopolitics, tariffs/trade, shipping chokepoints/oil, energy/infrastructure. Lanes overlap; no lane qualifies for replacement.

### Read-only production snapshot (2026-09-19)

- Cron: `important-news-fetch` job 2 remains active at `0,20,40 * * * *`, command length 845, MD5 `b9a98c88ada68d0552ac66c9e8e19983`. Judgement job 3 `7,27,47` MD5 `438fb5cb0d1206bdfc6af7b379c06788`; generation job 4 `14,34,54` MD5 `951233b2a4fe7ae2b82ef83292276565`; publish-ready job 8 `*/5` MD5 `bc7fddb4557c9babecec6af57fede247`.
- `important-news-monitor`: ACTIVE v58, `verify_jwt=false`, source SHA256 `ce7b4bf79da6fb35f8593c4a692ef125acdbdb0ed26c189a761f15eeb5a4070f`.
- Last 24h read-only aggregation: 35 scheduled runs, 2,896 fetched, 9 new candidates; latest run 2026-09-19 13:00:02Z. AI usage rows total 18 actual web_search calls / 16 events / $0.226885. No manual invoke/OpenAI replay.
- Previously checked seven-day source-health diagnostics remain the current evidence: 429 rates 22.4% for critical market, disaster/infrastructure and Japan security; 26.7% shipping chokepoints; 25.9% bank/China. They were not recomputed in this continuation; one attempted diagnostic query used a nonexistent `ai_usage_events.diagnostics` column and returned no data.
- Production mutation: **0**. No DB write/migration, Edge Function deploy, Cron change, candidate injection, X/Push/App behavior change, MIC/G1, H2/G2, OAuth/Vault, or secret access.

### Previously accepted H1 design/economics retained

- Correct nominal baseline remains 48 queries/day through Sep 23 and 96/day from Sep 24; measured $0.051510 / four actual searches per fetch cycle. Four-run sample mean was $0.056721/cycle; conditional search scenarios were illustrative only.
- BOJ official-title/body-missing enrichment remains isolated and unintegrated; prior candidate tests were 14/14 and Deno check passed. No new code/test changes in this continuation.
- Shadow architecture remains isolated tables/function plus disabled-by-default schedule after separate approval; never reuse live candidate/run tables or suppress legacy paid search. No 10-minute/high-cost cadence or 70% reduction is authorized by this replay evidence.

### Remaining blocker / next step

The durable artifact is now available for C1, but it does not prove replacement-route parity. Before any production shadow request, recover auditable historical source-ingestion times or run a separately approved shadow comparison with the legacy fallback intact. Any absent/late source keeps that lane on paid fallback. Production Phase 1 mutation remains unapproved.

## Latest H1 result — important-news hourly cadence simplification (2026-09-19)

- task_id: `important-news-hourly-cadence-simplify-20260919`
- result: `review_required` — production cadence gate simplified on exactly one existing Cron job; stop for C1 review.
- production project: `wsmznyzcvmuitkglfeuj`
- exact production mutation: **one command-only change** to pg_cron job `jobid=2`, `important-news-fetch`. No schedule, Edge Function, schema, other Cron, secret, OAuth, Vault, X, Push, or manual OpenAI action was changed.

### Before / after

- Before: schedule `0,20,40 * * * *`, active `true`, command length `1185`, MD5 `c85fd56fe33bcea58d7414768cf5c9f5`.
- After: same schedule and active flag, command length `845`, MD5 `b9a98c88ada68d0552ac66c9e8e19983`.
- Change used `cron.alter_job` only, guarded by exact job id/name, schedule, active state, and before-command MD5. No direct `cron.job` UPDATE was used.
- All **33 other Cron jobs** were inventoried before and after; every job’s name, schedule, active flag, command length, and MD5 remained unchanged.
- Command output was not exposed; endpoint/key material was not read into the report.

### JST gate proof

- 2026-09-19 through 2026-09-23 inclusive: only even JST hours at minute `00` pass (12/day).
- 2026-09-24 onward: only minute `00` each JST hour passes (24/day); the former `:20`/`:40` dense-window calls are removed.
- Representative SQL proof: **14/14 PASS, 0 mismatches**, including each required 9/19 and 9/24 run/skip boundary sample.
- No manual function invocation, OpenAI request, retry, or backfill was performed. This verifies the gate expression; it is not a claim of an observed natural run after the change.

### Cost effect and rollback

- 9/24 onward: maximum 24 fetch HTTP calls/day versus the former 72/day, a **66.7% reduction**.
- Holiday cadence remains 12/day.
- Exact rollback was reconstructed read-only from the unchanged command prefix plus the previous 36/day gate and verified to match the pre-change command exactly: length `1185`, MD5 `c85fd56fe33bcea58d7414768cf5c9f5`. Rollback is available through `cron.alter_job`; it was not executed.

### Next step

C1 should review the production read-back and 14-case JST proof. H1 stops here; no other production work is authorized by this task.


## Latest H1 result — important-news Web Search cost throttle (2026-09-19)

- task_id: `important-news-web-search-cost-throttle-20260919`
- result: `review_required` — production cadence gate applied to **only** `important-news-fetch`; stop for C1 review.
- production project: `wsmznyzcvmuitkglfeuj`
- exact production mutation: **one pg_cron job command change** (`jobid=2`, `jobname=important-news-fetch`). No schedule row, Edge Function, DB schema, other Cron, secret, OAuth, Vault, X, push, or manual OpenAI action changed.

### Before / after

- Before: schedule `0,20,40 * * * *`, active `true`, command length `370`, command MD5 `be610dd0acc29a5582bfb699ac857d22`.
- After: schedule remains `0,20,40 * * * *`, active `true`, command length `1185`, command MD5 `c85fd56fe33bcea58d7414768cf5c9f5`. The command still posts only the existing `{"trigger":"scheduled","fetchSources":true}` body to the existing function URL; the new gate suppresses the HTTP call by making the settings SELECT return no rows outside the allowed JST times.
- Change method: `cron.alter_job(job_id := 2, command := ...)`, guarded by the before schedule/job name/hash. Direct `cron.job` UPDATE was not used (permission denied); no unrelated job could match the guard.

### JST gate semantics

- 2026-09-19 through 2026-09-23 inclusive: run only at JST minute `00` on even hours (12 potential HTTP calls/day); all `:20`/`:40` and odd hours are skipped.
- 2026-09-24 onward: run at every JST `:00`, plus `:20`/`:40` only in 07:00–09:00 and 16:00–18:00 JST. The gate uses `timezone('Asia/Tokyo', clock_timestamp())`, not UTC hour literals.

### Proof / unchanged scope

- SQL representative-time proof: **12/12 PASS, 0 failures** — included 9/19 08:00 run, 08:20 skip, 09:00 skip; 9/24 06:20 skip, 07:00/07:20/08:40/10:00/16:40/18:40 run, 10:20/19:20 skip.
- Read-back confirmed `important-news-judgement`, `important-news-generation`, `important-news-publish-ready`, all market-report jobs, and all MIC jobs unchanged: **25 checked / 0 mismatches** for schedule, active flag, and command MD5.
- The command was read back with URL/key material redacted; no secret or API key was returned or recorded.

### Expected cost effect / rollback

- 9/19–9/23: 72 trigger opportunities/day remain, but only 12 can issue the OpenAI-fetch HTTP request — **83.3% fewer fetch calls** before query-count differences.
- 9/24 onward: 24 baseline `:00` calls + 12 dense-window additions = 36/day — **50% fewer fetch calls** than the former 72/day.
- Rollback is ready: restore schedule `0,20,40 * * * *` and the exact pre-change command (MD5 `be610dd0acc29a5582bfb699ac857d22`) via `cron.alter_job`; rollback was not executed.
- No manual OpenAI request, X post, push, retry/backfill, judgement/generation/publish change, market-report/MIC change, or other production mutation occurred.

### Next step

C1 should review the gate timing and cost calculation. This H1 stops here; no Edge Function or consumer behavior was changed.

## Latest H1 result — AI Lab daily content plan production rollout (2026-09-18)

- task_id: `ai-lab-daily-content-plan-production-rollout-20260918`
- result: `review_required` — the C1-approved Phase1/Phase2 schema and writer RPC were applied to production and read back successfully. Consumer deploy remains intentionally out of scope.
- production project: `wsmznyzcvmuitkglfeuj`
- production database: PostgreSQL **17.6**
- production migration/RPC change: **exactly the two approved migrations below; no other migration was applied**.

### Exact production apply

1. `supabase/migrations/20260917143302_ai_lab_daily_content_plans_phase1.sql`
2. `supabase/migrations/20260917211919_ai_lab_daily_content_plan_writer_phase2.sql`

The Supabase migration tool returned success for each exact SQL payload. No `supabase db push`, `--include-all`, history repair/reconcile, unrelated migration, Edge Function deploy, Cron change, or consumer source change was used. The production migration-history table did not contain these timestamps before or after the direct exact apply; object-level preflight/postflight is the authoritative verification for this known-drift project.

### Preflight

- `public.daily_content_plans` and `public.write_daily_content_plan(text,date,text,jsonb,boolean,text)` were absent.
- No same-name indexes were present; `ai_salaryman_lab` existed in `public.brands`.
- Production had no object-level Phase1/Phase2 migration entries, and H2 was not in a production-write state. G1 objects are separate.

### Postflight

- `daily_content_plans` exists with the approved Phase1 columns, FK to `brands`, version/source/status/plan checks, primary key, lookup index, and one-active-per-brand/date partial unique index.
- RLS is enabled. `service_role` has SELECT; `anon`/`authenticated` have no SELECT/INSERT/UPDATE/DELETE privileges and there are no client policies.
- Phase2 columns `request_key`, `activation_requested default false`, and `activated_at` exist; `daily_content_plans_request_key_idx` is a unique partial index on `(brand_id,target_date,request_key)`.
- RPC signature is exactly `public.write_daily_content_plan(text,date,text,jsonb,boolean,text)`, owner `postgres`, `SECURITY DEFINER=true`, `search_path=""`, return shape `TABLE(id uuid, version integer, status text, target_date date, brand_id text)`.
- Function EXECUTE is `public=false`, `anon=false`, `authenticated=false`, `service_role=true`.
- Post-apply table row count is **0**; no permanent smoke data remains.

### Bounded writer smoke (rolled back)

Inside one transaction, the production RPC created a future-date active plan, repeated the same request key (same result/idempotency), rejected a changed payload with `DAILY_CONTENT_PLAN_REQUEST_KEY_CONFLICT`, and then rolled back. Postflight reports `h1-prod-smoke-20260918` rows **0** and total `daily_content_plans` rows **0**. The smoke used the controlled SQL admin session (`current_user=session_user=postgres`) and no secret/token; PostgREST JWT transport was not invoked.

### Advisors / safety

- Supabase security/performance advisors returned existing project-wide findings plus the expected `daily_content_plans` “RLS enabled, no policy” informational finding and its unused lookup-index informational finding. The new writer RPC was not flagged because its public/anon/authenticated EXECUTE grants are revoked.
- No `x-test-post` deploy or modification, AI Lab consumer cutover, manual/synthetic X post, scheduled retry/backfill, Cron/window change, OAuth reauthorization, Vault/token/secret change, Kabumori/Mio change, market-report change, or social-mobile membership/RLS change occurred.
- Rollback is prepared but not executed: stop writer use, revoke `service_role` EXECUTE, drop the writer function, then remove Phase2 metadata/index in a separately reviewed migration. Phase1 table rollback requires a separate data-presence review; do not drop it blindly.

### Next step

C1 should review the production object/grant evidence. A separate approval/task is required before any `x-test-post` consumer deploy or plan-driven posting. This H1 stops here.

## Latest H1 result — AI Lab daily content plan writer real PostgreSQL proof (2026-09-18)

- task_id: `ai-lab-daily-content-plan-writer-postgres-proof-20260918`
- result: `review_required` — the C1 blocker was closed with a real disposable PostgreSQL proof. Production migration/RPC/deploy/configuration changes: **0**.
- source candidate under proof: `3ce866e7e424c4e4b675269122285dab7ca39a6b` on `codex/ai-lab-daily-content-plan-writer-phase2-20260918`; no source code or migration candidate was changed in this focused proof.
- proof environment: disposable local Podman container `public.ecr.aws/supabase/postgres:17.6.1.165` (PostgreSQL 17.6), container-only database `proof`. A minimal disposable `public.brands` stub and `ai_salaryman_lab` row were created solely to satisfy the Phase 1 foreign key.

### Applied candidates (disposable only)

- `supabase/migrations/20260917143302_ai_lab_daily_content_plans_phase1.sql`
- `supabase/migrations/20260917211919_ai_lab_daily_content_plan_writer_phase2.sql`

Both migrations applied successfully as the disposable `supabase_admin` role. No Supabase production project, migration history, or `supabase db push` was used.

### Real PostgreSQL results

- RPC exists with exact signature `write_daily_content_plan(text,date,text,jsonb,boolean,text)`, owner `supabase_admin`, `SECURITY DEFINER=true`, `search_path=""`, and return shape `TABLE(id uuid, version integer, status text, target_date date, brand_id text)`.
- `has_function_privilege`: `anon=false`, `authenticated=false`, `service_role=true`. Direct TCP psql sessions as `anon` and `authenticated` received `permission denied for function` and left row count at **0**. A direct `service_role` session successfully created the first active row and received only the five declared output columns. This proves the database role/grant boundary; a PostgREST JWT claim was not simulated, so that transport-specific mapping remains a deployment preflight item.
- First active create: version `1`, status `active`. Second active create: version `2`, prior row `archived`, active count exactly `1`.
- Draft create with an omitted slot preserved the active row; explicit `slot_no=2` and `slot_no=null` were accepted.
- Identical `request_key` retry returned the same id/version with no new row. A changed plan under the same key raised `DAILY_CONTENT_PLAN_REQUEST_KEY_CONFLICT`; total row count remained unchanged.
- Duplicate item id raised `DAILY_CONTENT_PLAN_DUPLICATE_ITEM_ID`; a 70,000-character payload raised `DAILY_CONTENT_PLAN_PAYLOAD_TOO_LARGE`; neither added a row.
- Consumer-shaped query (`brand_id`, exact `target_date`, `status='active'`, `version desc`) returned the newest active plan and item id. `anon` read returned zero rows under the existing no-policy/RLS boundary.

### Concurrent activation proof

Two independent `service_role` PostgreSQL transactions wrote `ai_salaryman_lab` / `2026-09-20` with different request keys. Transaction A held the transaction open for three seconds after the writer call; transaction B started while A held the `pg_advisory_xact_lock` and completed after roughly three seconds. Final state was version `1 archived` + version `2 active`, with active count exactly `1`; no unique-violation or partial state occurred.

### Preflight / rollback proof and safety

- Preflight read-only checks found the table, request-key index, and RPC signature.
- A transaction-only rollback dry-run successfully executed `DROP FUNCTION`, `DROP INDEX`, and the three metadata-column drops, then `ROLLBACK`; postflight confirmed the RPC/index/columns remained present.
- No production migration apply, RPC/grant/RLS change, Edge Function deploy, Cron/window change, X post, retry/backfill, OAuth/Vault/token/secret operation, or other external mutation occurred. Production mutation: **0**.
- No new source commit was required for this proof. C1 should now review the real PostgreSQL evidence before any separate production migration/RPC approval.

## Latest H1 result — AI Lab daily content plan writer Phase 2 (2026-09-18)

- task_id: `ai-lab-daily-content-plan-writer-phase2-20260918`
- result: `review_required` — service-side writer candidate completed; stop for C1 review. Production mutation/deploy/configuration changes: **0**.
- candidate branch: `codex/ai-lab-daily-content-plan-writer-phase2-20260918`
- candidate commit: `3ce866e` (`feat(ai-lab): add daily content plan writer phase2`, rebased onto latest GitHub `main` `db5823a1d4d531108df58a55ae2ce3ede1f2042b`)
- Phase 1 C1-approved source is included as the candidate dependency; this Phase 2 diff itself does not modify `supabase/functions/x-test-post/index.ts`.

### Writer contract

- New migration candidate: `supabase/migrations/20260917211919_ai_lab_daily_content_plan_writer_phase2.sql` (created, **not applied**).
- Adds `request_key`, `activation_requested`, and `activated_at` metadata to `public.daily_content_plans`, plus a partial unique request-key index for `(brand_id, target_date, request_key)`.
- Defines `public.write_daily_content_plan(text, date, text, jsonb, boolean, text)` as `SECURITY DEFINER`, `set search_path = ''`. It returns only `id`, `version`, `status`, `target_date`, and `brand_id`.
- Execution is denied unless the JWT role is `service_role` or the controlled `postgres`/`supabase_admin`/`service_role` maintenance session. `EXECUTE` is revoked from `public`, `anon`, and `authenticated`, and granted only to `service_role`. No client-facing policy or service key is added.
- The writer does not read OAuth/Vault/token data and does not invoke X, Cron, posting-window, retry, or completion paths.

### Validation and state semantics

- Validates non-empty brand/date/source/request key, object plan, 1–32 items, 65,536-byte JSON payload ceiling, item object/id/topic, duplicate ids, optional/null positive-integer `slot_no`, finite numeric `priority`, string `context`/`tone_override`, and string arrays for `key_points`/`must_include`/`must_avoid`.
- Explicit slot validation is intentionally brand-neutral (positive integer only); the existing scheduled-slot consumer remains responsible for the active AI Lab posting-window range rather than hardcoding a brand-specific maximum in shared storage.
- Per brand/date writes take a transaction advisory lock. A new version increments from the maximum existing version. `activate=true` archives the previous active row and inserts exactly one active row in the same transaction; `activate=false` inserts a draft.
- A repeated `(brand_id, target_date, request_key)` with identical source/plan/activation returns the original row without creating a new version. A changed payload under the same key raises `DAILY_CONTENT_PLAN_REQUEST_KEY_CONFLICT`.

### Canonical ChatGPT payload (example only)

```json
{
  "brand_id": "ai_salaryman_lab",
  "target_date": "YYYY-MM-DD",
  "source": "chatgpt",
  "request_key": "chatgpt-YYYY-MM-DD-v1",
  "activate": true,
  "plan": {
    "day_theme": "小さく作って記録する",
    "narrative_arc": "試す→詰まる→次の一手を残す",
    "items": [{
      "id": "slot-1",
      "slot_no": null,
      "priority": 10,
      "topic": "個人開発で詰まった点",
      "context": "会社員の平日夜",
      "key_points": ["詰まりを一つ記録"],
      "must_include": ["次の一手"],
      "must_avoid": ["万能論"]
    }]
  }
}
```

会話本文や秘密値をそのまま保存せず、ちゃがstructured planへ変換してwriterを呼ぶ運用を想定する。RPC引数へ渡す際は上記の各値を `p_brand_id` / `p_target_date` / `p_source` / `p_plan` / `p_activate` / `p_request_key` に対応させる。

### Disposable proof / verification

- `supabase/functions/_shared/brand/daily_content_plan_writer.ts` provides the backend-side validation contract without exposing a client API.
- `supabase/functions/_shared/brand/daily_content_plan_writer_test.ts` uses an in-memory disposable SQLite model for first active creation, second active version/archive, exactly-one-active invariant, draft preservation, and request-key idempotency; it also statically verifies the migration's security boundary and advisory lock.
- Focused writer + Phase 1 plan suites: **10 passed / 0 failed**.
- Full `supabase/functions/x-test-post` + `_shared/brand` regression: **473 passed / 0 failed**.
- Candidate `deno check --no-config`, `deno fmt --check`, and `git diff --check`: passed.
- No production Supabase SQL, migration apply, RPC/grant/RLS change, Edge Function deploy, Cron change, manual/synthetic X post, retry/backfill, refresh, OAuth, Vault, or secret/token read/write was performed. Production mutation: **0**.

### Rollout / rollback boundary

- Future rollout order: base `daily_content_plans` migration → writer migration/RPC → read-back and security preflight → consumer deploy. Consumer deploy remains a separate approval after the G1 conflict is resolved.
- This candidate is not applied. If separately approved later, rollback is to stop calling the RPC/revoke its `EXECUTE` grant and revert the writer migration/metadata; no consumer or posting rollback is implied by this Phase 2 candidate.
- C1 review is required before any production migration/RPC apply or consumer deploy.

## Latest H1 result — AI Lab daily content plan selection focused fix (2026-09-18)

- task_id: `ai-lab-daily-content-plan-selection-fix-20260918`
- result: `review_required` — C1 blocker fixed in a source-only candidate; stop for C1 review. Production migration/deploy/configuration changes: **0**.
- source candidate: branch `codex/ai-lab-daily-content-plan-selection-fix-20260918`, commit `cdebdc861d9b6fb38645b640c3d48396ec72aee3` (rebased onto fresh GitHub `main` `ac158af65f385448c68e11b8336c51d52c20a7ed`).
- migration candidate remains `supabase/migrations/20260917143302_ai_lab_daily_content_plans_phase1.sql`; it was not applied. No `supabase db push`, production RLS/grant/RPC/schema change, Cron change, or `x-test-post` deploy was performed.

### Focused fix

- `slot_no` is now optional/null in the structured plan item parser.
- Selection order is deterministic: exact explicit slot item first (priority, then id), then slot-less items assigned to the remaining scheduled slots in stable priority/id order. No consumed-state write is used; the same plan/date/slot resolves to the same item on retry.
- If an active plan has no safe item for a slot, the loader returns the normal fallback signal instead of stopping the scheduled post or inventing a topic from `day_theme` alone. The generator fallback is hardened toward a company-worker personal-development/side-business/AI-trial diary and explicitly rejects generic AI convenience tips, textbook how-to content, and fabricated progress/experience.
- Plan absence keeps the same hardened persona fallback. Explicit item generation, AI Lab-only wiring, target-date filtering, active-only filtering, and all OAuth/Vault/refresh/X publish/dedupe/completion boundaries remain unchanged. Kabumori, Mio, and market-report consumers remain untouched.

### Validation

- Focused plan/dispatcher/generator suites: **30 passed / 0 failed**.
- Full `supabase/functions/x-test-post` + `_shared/brand` regression: **469 passed / 0 failed**.
- Candidate helper modules `deno check --no-config`: passed.
- Candidate helper `deno fmt --check` and `git diff --check`: passed.
- The known unrelated full Edge `index.ts` type diagnostics remain outside this focused change; no new helper type error was introduced.

### Safety / next step

- Production DB/Vault/X/OAuth/Cron writes: **0**; no secrets/token values, manual/synthetic X post, retry/backfill, refresh, or OAuth action was performed.
- C1 should review the selection algorithm and the explicit safe fallback rule before any separate migration/deploy approval. No rollout is implied by this candidate.

## Latest H1 result — AI Lab daily content plan generation control Phase 1 (2026-09-17)

- task_id: `ai-lab-daily-content-plan-generation-control-phase1-20260917`
- result: `review_required` — source-only candidate completed; stop for C1 review. Production migration/deploy/configuration changes: **0**.
- source candidate: branch `codex/ai-lab-daily-content-plan-phase1-20260917`, commit `0a6f20c86603c5834876208e4c05ef711d036be4` (rebased onto fresh GitHub `main` `dacdb2f303e50eccbaced6273f8ebaa899b6f419`).
- migration candidate: `supabase/migrations/20260917143302_ai_lab_daily_content_plans_phase1.sql`; created but **not applied**. No `supabase db push`, production RLS/grant/RPC/schema change, Cron change, or `x-test-post` deploy was performed.

### Implemented candidate

- Added brand-neutral `daily_content_plans` schema candidate with `brand_id`, JST `target_date`, version, `source`, draft/active/archived status, JSON plan payload, one-active-per-brand/date partial uniqueness, lookup index, RLS enabled, and service-role read grant only.
- Added structured plan parsing/selection for `day_theme`, `narrative_arc`, slot item `topic`, `context`, `tone_override`, `key_points`, `must_include`, `must_avoid`, `priority`. Active plans are queried for exact `ai_salaryman_lab` + target date + slot. Selection is deterministic by priority then item id; a missing slot fails closed. Retry does not consume/write plan state, so the same scheduled slot resolves to the same item.
- Wired only the AI Lab scheduled `brand_post` route to the plan loader. Plan present: generation prompt/input is constrained to the authored plan and explicitly rejects new themes, invented progress/emotion/results, and unrelated AI tips; persona is used only for expression. Plan absent: existing generator fallback remains unchanged. Kabumori, Mio, report consumers, OAuth/Vault/refresh, X publish, dedupe, completion, and retry boundaries were not changed.

### Changed source files

- `supabase/migrations/20260917143302_ai_lab_daily_content_plans_phase1.sql` (candidate only)
- `supabase/functions/_shared/brand/daily_content_plan.ts`
- `supabase/functions/_shared/brand/ai_lab_daily_content_plan_source.ts`
- `supabase/functions/_shared/brand/brand_post_generator.ts`
- `supabase/functions/_shared/brand/ai_lab_scheduled_brand_post.ts`
- `supabase/functions/x-test-post/index.ts` (AI Lab-only loader wiring and schedule_date typing)
- matching plan/generator/dispatcher tests

### Validation

- Focused plan/generator/dispatcher suites: **27 passed / 0 failed**.
- Full `supabase/functions/x-test-post` + `_shared/brand` regression: **466 passed / 0 failed**.
- Candidate helper modules `deno check --no-config`: passed.
- `git diff --check`: passed. `x-test-post/index.ts` retains pre-existing formatter drift; it was not globally reformatted.
- Full `x-test-post/index.ts` type check still reports the repository's unrelated existing six diagnostics (AES-GCM/Blob `BufferSource` typing, morning greeting result typing, and lane timestamp precision typing); no new candidate helper type error was reported.

### Safety / next step

- Production DB/Vault/X/OAuth/Cron writes by this task: **0**; no secrets or token values were read or recorded; no manual/synthetic X post, retry, backfill, or refresh was run.
- C1 should review the candidate schema/selection rules and decide separately whether to apply the migration and deploy the AI Lab-only wiring. Phase 2 should add the approved plan-writer/UI path and production migration/rollout gates; no automatic rollout is implied by this candidate.

## Latest H1 result — AI Lab Vault refresh production deploy (2026-09-17)

- task_id: `x-ai-lab-vault-token-refresh-production-deploy-20260917`
- result: `review_required` — the exact C1-approved candidate was deployed to **`x-test-post` only**. No other Function, DB/schema/RPC/grant, secret, OAuth, Cron, posting setting, or manual X action was changed.
- deploy source: approved candidate commit `a7ffba4930a9eff3885ab29254f9858b80e71170` from `codex/x-ai-lab-vault-token-refresh-integration-candidate-20260917`.

### Deployment read-back

- Pre-deploy `x-test-post`: ACTIVE v112, `verify_jwt=false`, hash `ba0e7c78bd8cec62b4c8c2fe50bd1de80c7f3ecbaa1a1206c4e668f70012ab60`.
- Post-deploy `x-test-post`: ACTIVE **v113**, `verify_jwt=false`, hash `f15bc31519a31181bb739504f9a24be895e7f5a95f01725bca15349db38349c4`.
- Runtime source read-back reported 43 files and contained the approved AI Lab markers: `publishAiLabWithRefresh`, `ai_lab_vault_token_persistence`, fixed `ai_salaryman_lab` / `ai_salaryman_lab_x` refs, `expectedRefreshToken`, and `AI_LAB_TOKEN_PERSIST_FAILED`. No candidate secret/token/Vault value was returned or recorded.
- All other Function versions, hashes, and timestamps matched the pre-deploy inventory (including `x-oauth-connect` v20); only `x-test-post` changed.

### Verification

- Focused AI Lab suites: **30 passed / 0 failed**.
- Full `x-test-post` + `_shared/brand` regression: **474 passed / 0 failed**.
- Candidate helper modules type-check. The remaining `x_oauth2_post.ts` AES-GCM `BufferSource` diagnostic is the existing baseline diagnostic; no candidate-specific type error was introduced.
- `deno fmt --check` passed for the 7 candidate helper/source files and `git diff --check` passed. `x-test-post/index.ts` remains not formatter-clean in both latest main and candidate (pre-existing formatting drift); it was not reformatted to avoid unrelated source changes.

### Natural-slot observation

- The latest AI Lab slot visible immediately after deploy was slot 10, scheduled `2026-09-17 13:22:09+00` and completed before deploy at `13:23:04+00` with the prior runtime's `X_REQUEST_FAILED:401`, `attempt_count=1`, no X post id, and no retry.
- At post-deploy read time there was no future AI Lab `brand_post` row available. No manual invocation, retry, backfill, synthetic post, manual refresh, or OAuth reauthorization was performed. Therefore a post-deploy natural success/refresh outcome is still pending and must be observed through the existing Cron path.
- No rollback was performed. If a confirmed runtime regression occurs, rollback is limited to `x-test-post` using the pre-deploy v112/hash above; no token/Vault rollback is authorized.

### Safety boundary

- DB write: 0; Vault write: 0; manual refresh: 0; OAuth action: 0; X post initiated by this task: 0; secret/token/Vault value output: 0. The deployed runtime may refresh only as part of the approved natural AI Lab path.


## Latest H1 result — AI Lab Vault refresh runtime preflight (2026-09-17)

- task_id: `x-ai-lab-vault-token-refresh-runtime-preflight-20260917`
- result: `review_required` — the isolated no-write Edge runtime gate passed. The refresh integration candidate remains undeployed; a separate production deployment approval is still required.
- temporary probe: `ai-lab-db-preflight`, version **1**, `verify_jwt=true`, source read-back hash `061228a5993b3ab180b6a09889883c3ca3b142e1170ad8ba5b33610d1ed30a65`. The source read-back matched the local probe source. It was deleted immediately after the single successful GET probe, so no temporary Function remains in production.

### Runtime result

- Direct connection: **success** from the deployed Edge runtime using the existing `SUPABASE_DB_URL`; the response only reported non-secret metadata.
- `db_url_present`: `true` (the URL value was never logged, returned, or recorded).
- Effective `current_user`: `postgres`.
- `has_function_privilege(current_user, 'vault.update_secret(uuid,text,text,text,uuid)', 'EXECUTE')`: **true**.
- `server_version`: PostgreSQL **17.6**. The probe used one short-lived client (`max=1`, 5-second connect/idle timeouts, 10-second max lifetime); the connection completed without timeout. The earlier read-only DB metadata showed `max_connections=60`. IPv4/IPv6 was not separately forced, but the production endpoint was reachable through the runtime path.

### Scope and safety verification

- The probe executed only `current_user`, `has_function_privilege`, and `current_setting('server_version')`. It did not call `vault.update_secret`, read `vault.decrypted_secrets`, or read any token/ref/value.
- Existing production Function versions, hashes, and timestamps were unchanged before/after the probe. After cleanup, `ai-lab-db-preflight` is absent from the Function inventory.
- Production changes other than the temporary probe deploy/delete: **0**. DB write: 0; Vault write: 0; X write: 0; OAuth action: 0; secret/token/Vault value output: **0**.
- `x-test-post` candidate commit `a7ffba4930a9eff3885ab29254f9858b80e71170` was not deployed. No source commit or production configuration change was made for the probe.

### Decision / remaining approval

- The direct-DB gate is now evidenced: the existing Edge runtime secret is usable, the effective role is `postgres`, and it can execute the Vault writer function according to metadata without invoking it. No immediate connection/pooling blocker was observed in this bounded probe.
- This does **not** authorize candidate deployment. C1 should separately review/approve deploying only `x-test-post` from the exact candidate commit; `x-oauth-connect`, DB/schema/RPC/grants, secrets, Cron, Kabumori, Mio, scopes, and posting behavior remain out of scope.


## Latest H1 result — AI Lab Vault refresh production preflight (2026-09-17)

- task_id: `x-ai-lab-vault-token-refresh-production-preflight-20260917`
- result: `review_required` — read-only production preflight completed. The candidate remains source-only; no production deploy, Vault/token mutation, refresh request, OAuth reauthorization, post, schema/RPC/grant, Cron, or secret-value read occurred.
- candidate: `a7ffba4930a9eff3885ab29254f9858b80e71170` on `codex/x-ai-lab-vault-token-refresh-integration-candidate-20260917`.

### Confirmed production facts (values intentionally omitted)

- Supabase secret metadata lists `SUPABASE_DB_URL`, `X_CLIENT_ID`, and `X_CLIENT_SECRET` as present. No secret value was retrieved, logged, or written to this report. No additional environment name is required by the candidate beyond these existing names.
- `x-test-post` is still the pre-candidate production runtime: ACTIVE, `verify_jwt=false`, Supabase version **112**, aggregate hash `ba0e7c78bd8cec62b4c8c2fe50bd1de80c7f3ecbaa1a1206c4e668f70012ab60`. A source read-back contains no `ai_lab_token_refresh` / `ai_lab_vault_token_persistence` wiring, proving the candidate was not deployed.
- `x-oauth-connect` is ACTIVE version **20**. Its deployed token-exchange source uses confidential-client HTTP Basic authentication and `grant_type=refresh_token` (with the client id in the form body), matching the candidate refresh request and the AI Lab OAuth configuration. No scope or OAuth setting was changed.
- Production DB is ACTIVE in `ap-northeast-1`, PostgreSQL 17.6. The read-only SQL preflight returned `max_connections=60`.
- `vault.update_secret(secret_id uuid, new_secret text, new_name text, new_description text, new_key_id uuid)` exists as `SECURITY DEFINER`, owner `supabase_admin`, with `search_path=''`. `has_function_privilege('service_role', ..., 'EXECUTE')` is true; `authenticated` and `anon` are false. No writer RPC or grant was added. The query only inspected metadata and did not call the function.

### Remaining gate / decision

- The SQL MCP path proves production DB reachability and the service-role privilege metadata, but it does **not** prove that the deployed Edge runtime can open the direct `SUPABASE_DB_URL` connection with the required effective role, nor does it establish production pooling/IPv4/IPv6/connection-count suitability for `npm:postgres`.
- Because retrieving or testing the secret value through an ad-hoc client would expose or risk using a production credential, this task did not perform that test. Therefore deployability is **not yet proven**. A safe next gate is a separately authorized, no-write runtime preflight that opens the existing connection without logging the URL/token and executes only metadata checks such as `current_user` and `has_function_privilege`; otherwise the adapter must be redesigned to use an already-approved server-side writer (which would require separate schema/grant review).
- Blast radius is limited: the candidate branch is unchanged and production remains on the current runtime, so AI Lab behavior is unchanged (including the known refresh gap); Kabumori/Mio and all other Functions are unaffected.

### Deploy / rollback plan (not executed)

- After the direct-connection gate and a separate deployment approval, deploy only `x-test-post` from candidate commit `a7ffba4930a9eff3885ab29254f9858b80e71170`; do not deploy `x-oauth-connect` or change DB/schema/secrets. Read back the Function version/source hash and verify no other Function changed.
- If rollback is required, restore the previously observed `x-test-post` v112 bundle/hash above (or the exact approved source that produced it), then read back the version/hash. No Vault/token rollback is implied because this preflight performed no mutation.

### Safety checks

- No `supabase functions deploy`, `supabase db push`, migration/RPC/RLS/grant change, Vault read/write, refresh-token call, OAuth authorization, manual/synthetic post, retry/backfill, Cron/window change, or secret-value output was performed.


## Latest H1 result — AI Lab Vault refresh integration candidate (2026-09-17)

- task_id: `x-ai-lab-vault-token-refresh-integration-candidate-20260917`
- result: `review_required` — integrated the C1-approved AI Lab refresh helper into the candidate `x-test-post` path, added a transaction-guarded Vault persistence adapter, and preserved the existing AI Lab completion/idempotency boundary. This is source-only; production was not deployed or mutated.
- candidate_branch: `codex/x-ai-lab-vault-token-refresh-integration-candidate-20260917`
- candidate_head: `a7ffba4930a9eff3885ab29254f9858b80e71170`
- base_helper_commit: `5d3128d` (rebased equivalent of the approved refresh helper)
- focused_fix_commit: `b8712a9` (rebased fail-closed non-2xx fix)

### Changed files and call graph

- `supabase/functions/x-test-post/index.ts`
  - AI Lab `brand_post` loads the fixed `ai_salaryman_lab_x` Vault bundle and X OAuth client credentials, then attaches the AI Lab-only refresh boundary to `postToX`.
  - `postToX` selects `publishAiLabWithRefresh` before the legacy path only when the fixed AI Lab context is present. Kabumori/Mio and the legacy `oauth_token_store` path are unchanged.
  - The existing `dispatchAiLabScheduledBrandPost` generation, dedupe, length, X-call, and terminal completion guard remains the outer boundary. A confirmed X write followed by uncertain completion still cannot be resent.
- `supabase/functions/_shared/brand/ai_lab_vault_token_source.ts`
  - Returns opaque fixed access/refresh references together with the loaded token pair; the legacy wrapper remains compatible for existing callers.
- `supabase/functions/_shared/brand/ai_lab_vault_token_persistence.ts`
  - Uses the Edge runtime `SUPABASE_DB_URL` with a short-lived Postgres client and `vault.update_secret` inside one transaction.
  - Holds a database advisory transaction lock, re-reads the fixed refresh secret, and rejects a stale expected token before either ref is written. Access is always updated; refresh is updated only when X rotated it.
  - SQL/provider/secret failures are sanitized to stable error codes; token values, DB URL, Vault IDs, and provider bodies are not logged or returned.
- `supabase/functions/_shared/brand/ai_lab_token_refresh.ts`
  - Passes `expectedRefreshToken` to persistence and preserves the stale-write code while keeping the one-refresh/one-retry upper bound.
- Tests cover the helper, writer, source bundle, and static x-test-post wiring.

### Verification

- Focused AI Lab suites: **30 passed / 0 failed** (13 refresh, 4 persistence/concurrency, 5 Vault source, 8 scheduled-dispatch).
- Existing `x-test-post` + `_shared/brand` regression: **474 passed / 0 failed**.
- `deno check --no-config`: candidate modules pass; x-test-post reports the same six pre-existing diagnostics (AES-GCM BufferSource, image Blob/BodyInit, `retry_count`, timestamp precision), with no new candidate diagnostic.
- Focused `deno fmt` and `git diff --check`: pass.

### Production boundary and remaining review items

- Read-only production SQL confirmed `vault.update_secret(uuid,text,...)` exists and is service-role-only; no secret values were read. No public Vault writer RPC, migration, grant, schema, RLS, or RPC definition was added.
- No Edge Function deploy, Vault/token mutation, refresh-token call, OAuth reauthorization, manual/synthetic post, failed-row retry/backfill, Cron/window change, or Kabumori/Mio change occurred.
- C1 should review whether the production Edge runtime exposes `SUPABASE_DB_URL` with the required direct-Postgres connectivity and whether the service-role database role may call `vault.update_secret`; deploy/token mutation remains separately unauthorized.

## Latest H1 result — AI Lab refresh candidate focused fail-closed fix (2026-09-17)

- task_id: `x-ai-lab-vault-token-refresh-candidate-20260917`
- result: `review_required` — addressed the C1 blocker in the candidate branch only. Initial publish now succeeds only for 2xx, refreshes only for 401, and fails immediately for every other non-2xx status. No production deploy or token/Vault mutation was performed.
- focused_fix_commit: `09a199a` (`Fail closed on initial AI Lab publish errors`, rebased candidate branch)

### Fix and tests

- `publishAiLabWithRefresh()` now classifies the first result in this order: 2xx → success; 401 → one refresh/persist and one retry; any other non-2xx → `AI_LAB_PUBLISH_FAILED:<status>` with no refresh and no retry; thrown publish → `AI_LAB_PUBLISH_UNCERTAIN`.
- Added mocked regression coverage for initial 400, 403, 429, and 500 responses, asserting exactly one publish and zero refresh requests for each.
- Focused candidate suite: **13 passed / 0 failed**.
- Existing `x-test-post` + `_shared/brand` regression suite: **469 passed / 0 failed**.
- `deno check --no-config`, `deno fmt --check`, and `git diff --check`: pass.

### Safety boundary

- Only `supabase/functions/_shared/brand/ai_lab_token_refresh.ts` and its test changed in this focused fix. The live AI Lab branch remains `allowRefresh=false`; no source wiring, deploy, Vault write, OAuth reauthorization, DB/RPC/schema/migration, Cron, post, retry/backfill, or secret read occurred.
- The full candidate remains on `codex/x-ai-lab-vault-token-refresh-candidate-20260917` for C1 review. Production integration still requires separate review of the Vault writer, rotation concurrency, and outer completion/idempotency guard.


## Latest H1 result — AI Lab Vault refresh/rotation candidate (2026-09-17)

- task_id: `x-ai-lab-vault-token-refresh-candidate-20260917`
- result: `review_required` — an AI Lab-only refresh/retry candidate and mocked tests were implemented and committed. Production `x-test-post` was not changed or deployed; no production token/Vault/OAuth/DB/Cron action was performed.
- implementation_commit: `f22e2ca` (`Add AI Lab Vault token refresh candidate`, rebased candidate branch)

### Changed files and call graph

- `supabase/functions/_shared/brand/ai_lab_token_refresh.ts`
  - `publishAiLabWithRefresh()` is the decision boundary: one initial publish, refresh only on the first HTTP 401, then one retry of the same publish. It throws on an uncertain publish, persistence failure, or a second non-2xx response; no third publish or second refresh is possible.
  - `refreshAiLabTokens()` is scoped to the fixed `ai_salaryman_lab` / `ai_salaryman_lab_x` / `kaishain_ai_lab` context and validates both opaque Vault reference shapes before calling `POST /2/oauth2/token`.
  - The refresh request uses the confidential-client Basic header and `grant_type=refresh_token`. A rotated refresh token replaces the old one; if X omits a new refresh token, the existing refresh token is preserved.
  - Persistence is an injected `PersistAiLabTokens` callback receiving the same AI Lab Vault reference pair. It runs before the X retry; any writer error is sanitized to `AI_LAB_TOKEN_PERSIST_FAILED` and blocks retry.
  - Errors contain only stable codes/statuses; token values, client secrets, Vault IDs, response bodies, and provider error text are never copied into thrown errors.
- `supabase/functions/_shared/brand/ai_lab_token_refresh_test.ts`
  - 9 mocked tests cover valid-token/no-refresh, 401→one-refresh→one-retry, rotated refresh persistence, non-rotated refresh preservation, refresh failure, Vault persistence failure, second 401/no third publish, uncertain completion/no refresh, wrong brand/account rejection, and secret-safe errors.

### Verification

- Focused candidate suite: **9 passed / 0 failed**.
- Existing `x-test-post` + `_shared/brand` regression suite after the candidate: **465 passed / 0 failed**.
- `deno check --no-config supabase/functions/_shared/brand/ai_lab_token_refresh.ts`: pass.
- `deno fmt --check` on both changed files: pass.
- `git diff --check`: pass.

### Production boundary and remaining risks

- The live AI Lab branch remains unchanged with `allowRefresh=false`; this candidate is not wired into the deployed runtime yet. That is intentional: production currently has no approved Vault write adapter for updating the two existing secret destinations, and this task prohibits production token mutation.
- No Edge Function deploy, OAuth reauthorization, refresh-token call, Vault read/write, DB/RPC/schema/migration, Cron/window, manual post, failed-row retry, or backfill was performed.
- Before any production use, C1 must review the persistence adapter, Vault update mechanism, concurrency/rotation behavior, and whether the existing completion/idempotency guard remains the outermost boundary. A subsequent deploy/token mutation requires separate authorization.


## Latest H1 result — AI Lab recurring 401 read-only investigation (2026-09-17)

- task_id: `x-ai-lab-oauth-401-recovery-20260917`
- result: `review_required` — the recurring-401 cause was narrowed to an invalid/expired/revoked AI Lab access token that the current runtime intentionally does not refresh. No source, Function, database, Vault, OAuth, Cron, schedule, token, or posting mutation was performed.

### Fresh control and runtime evidence

- Fresh `origin/main` was fetched and used as the control base. At the final pre-report check it contained this task in `status: ready`; H2/G1/G2 have no OAuth/Vault/x-oauth-connect overlap.
- Production Edge Function inventory is unchanged for the relevant path: `x-test-post` is ACTIVE with the previously verified v110 bundle/hash (Supabase version counter currently reports 112), `verify_jwt=false`; `x-oauth-connect` is ACTIVE v20 with the previously verified v18 bundle/hash. No deploy occurred in this investigation.
- Read-back of the deployed `x-test-post` source shows the AI Lab branch loads only the fixed `ai_salaryman_lab_x` / `ai_salaryman_lab` / `kaishain_ai_lab` account, requires `identity_verified` and `publish_enabled=true`, reads both Vault references through `read_ai_salaryman_lab_x_vault_token`, and passes the loaded access token to the normal `POST /2/tweets` Bearer path.
- The AI Lab branch sets empty client credentials and `allowRefresh=false`; on a 401 it fails immediately as `X_REQUEST_FAILED:401`. It never falls back to `oauth_token_store`, and it never writes refreshed tokens.

### Success-versus-failure comparison

- Natural slot 6 (`2026-09-17 16:23 JST`) and slot 7 (`17:34 JST`) are the same AI Lab `brand_post` route. Each was claimed once (`attempt_count=1`) with one started log. Slot 6 has one succeeded log, one X post id, and one fingerprint; slot 7 has one failed log with `X_REQUEST_FAILED:401`, no HTTP status column value, no X post id, and no fingerprint. No retry/backfill occurred.
- At read time the non-secret account state was unchanged: brand `ai_salaryman_lab` is active/live; account `ai_salaryman_lab_x` is `identity_verified`, handle `kaishain_ai_lab`, `publish_enabled=true`, with both Vault refs present. The latest OAuth callback set the account and both named Vault secrets at `2026-09-17 05:47:20 UTC`; there is no later OAuth state or account mutation in the observed period.
- The only legacy `oauth_token_store` row is unrelated to the AI Lab path (it has no brand/account columns). Its presence does not affect AI Lab because the deployed dispatcher selects the Vault resolver before any legacy resolver.
- The Vault reader is a `SECURITY DEFINER` function with `search_path=''`; `information_schema.routine_privileges` shows EXECUTE only for `service_role` (and owner `postgres`), not `anon`/`authenticated`/PUBLIC. Function definition was read-only; no secret value or Vault id was read.

### Root-cause conclusion and remaining uncertainty

- Proven: this is not a slot-routing, duplicate, wrong-account, missing-ref, scope-string, or legacy-token selection problem. The same fixed Vault-backed account/ref path produced one success and then an X 401, while the application deliberately has no refresh path for AI Lab.
- Most likely cause: the access token stored by the OAuth callback became invalid/expired/revoked between the successful and failed calls. X’s OAuth 2.0 PKCE documentation states that `offline.access` supplies a refresh token and that a refresh request is the supported way to obtain a new access token; X’s error guidance describes invalid/expired credentials as an authorization failure. The runtime currently does neither refresh-on-401 nor expiry tracking for the Vault-backed AI Lab token.
- Not proven read-only: whether X expired the access token unusually early, revoked it, or rejected the token for an account/app permission condition. Production logs retain only `X_REQUEST_FAILED:401`; response headers/body are not persisted, so the specific X error subtype cannot be recovered from DB metadata.

### Required next fix / blast radius

- The next implementation must be separately reviewed by C1 before any mutation. It is limited to the AI Lab token lifecycle: refresh the Vault-backed refresh token on access-token expiry/401, persist any rotated access/refresh pair back to the same AI Lab Vault refs, and preserve fixed identity/account checks. It must not touch Kabumori/Mio, legacy `oauth_token_store`, scopes, schedules, Cron, schema/RPC definitions, or posting behavior.
- No future AI Lab slot was manually invoked, no failed row was retried, and no token refresh/re-authentication was attempted during this investigation.


## Latest H1 result — AI Lab OAuth 401 recovery (2026-09-17)

- task_id: `x-ai-lab-oauth-401-recovery-20260917`
- result: `review_required` — OAuth reauthorization succeeded for AI Lab only, the first natural post after restoration succeeded once, and the following natural slot returned 401 again. No retry, backfill, manual post, or media operation was performed.

### OAuth and account state

- User completed the X authorization in Safari. The first attempt returned `OAUTH_STATE_UNKNOWN`; a fresh state/PKCE authorization was generated through the existing `x-oauth-connect` start path and the second callback returned `success=true`, `connection_status=identity_verified`.
- Requested scopes were exactly `tweet.read users.read tweet.write offline.access`; no `media.write`, `like.write`, or `follows.write` was requested.
- Callback identity verification matched the exact expected username `kaishain_ai_lab` before credentials were accepted. Access/refresh Vault reference presence is true; token values and Vault IDs were never read or recorded.
- Non-secret post-callback state: `ai_salaryman_lab` is active/live, `ai_salaryman_lab_x` is `identity_verified`, handle `kaishain_ai_lab`, and `publish_enabled=true`. `enabled_post_types` remains `["brand_post"]`; all 10 AI Lab brand-post windows remain active.
- The OAuth begin/complete RPC temporarily forced AI Lab into dry-run/disabled mode. After explicit user approval, only AI Lab was restored to live/enabled with a guarded data update. Kabumori remains live/enabled with handle `yume_daka`; Mio was not touched.

### Natural-slot observation

- Slot 6, scheduled for 16:22:20 JST, was claimed once at 16:23:00 and completed at 16:23:05 with status `succeeded`. Terminal message: `AI Lab post completed; fingerprint persisted`; X post id `2100485677238677509`.
- Read-only fingerprint check shows exactly one AI Lab `brand_post` fingerprint and one distinct X post id for 2026-09-17.
- Slot 7, scheduled for 17:33:31 JST, was claimed once at 17:34:00 and failed at 17:34:05 with `X_REQUEST_FAILED:401`; no X post id and no second fingerprint were created. Future slots 8–10 remain pending.
- Earlier same-day rows remain historical evidence: slot 1 failed `UNSUPPORTED_POST_TYPE` before the dispatcher hotfix, and slots 2–5 failed 401 before OAuth restoration. No failed row was retried or backfilled.

### Safety and remaining issue

- No source or Edge Function deploy, schema/migration/RPC definition change, Cron/window change, OAuth scope expansion, Kabumori/Mio change, manual X post, candidate injection, OpenAI/X manual invocation, or media upload was performed in this recovery.
- The OAuth replacement is proven to permit one successful natural text post, but the next natural slot still returned 401. This indicates the 401 issue is not fully resolved; do not widen scope or add token refresh/fallback automatically. C1 should review the one-success/one-401 evidence and decide the next separately authorized investigation.

## Latest H1 result — AI Lab normal brand_post production hotfix (2026-09-17)

- task_id: `x-ai-lab-brand-post-production-hotfix-20260916`
- result: `review_required` — the missing normal `brand_post` route and Kabumori Admin brand-boundary leak are fixed and deployed/synced. The first post-fix natural slot reached the restored AI Lab X dispatch instead of `UNSUPPORTED_POST_TYPE`, but X rejected the current Vault-backed access token with HTTP 401. The row failed once without an X post or retry. OAuth/token changes were outside this task and were not attempted.

### Exact root cause and path difference

- The successful controlled `slot_no=0` post ran on production `x-test-post` v108, whose 39-file runtime included the AI Lab brand context, fixed Vault-token route, generator, dedupe, length guard, completion adapter, and canonical `dispatchAiLabScheduledBrandPost` branch.
- A later v109 deployment replaced that runtime with the then-current 27-file main source. Its index had no `brand_post` branch and no AI Lab brand modules, so normal slot 8/9/10/1 rows were claimed and fell through to `UNSUPPORTED_POST_TYPE:brand_post` before OpenAI/X.
- The hotfix reconciled the reviewed AI Lab runtime delta onto current main instead of replacing unrelated current code. All slot numbers, including controlled slot 0 and normal slots 1–10, now enter the same `dispatchAiLabScheduledBrandPost` implementation; there is no slot-0 special posting engine.

### Changed files

- `supabase/functions/x-test-post/index.ts`: restored brand-aware scheduled routing, fixed AI Lab Vault token source, no legacy Kabumori fallback/no refresh, canonical `brand_post` dispatcher, and completion-uncertainty no-retry guard.
- `supabase/functions/_shared/brand/`: restored 12 runtime helpers and their focused tests for brand/account gates, generation, <=280 code points, dedupe/fingerprints, Vault routing, and terminal completion safety.
- `supabase/functions/x-test-post/morning_greeting_payload_logic_test.ts` and `morning_greeting_publish_logic_test.ts`: updated assertions for deferred token loading after claim/brand resolution.
- `apps/admin/src/lib/brand-boundary.ts` plus `today-scheduled-posts.ts`, `post-history.ts`, `recent-failures.ts`, and `system-status.ts`: added server-side `brand_id='kabumori'` predicates to every touched `scheduled_posts`, `post_execution_logs`, and `posting_windows` query.
- `apps/admin/src/lib/brand-boundary.test.ts`: regression coverage for all touched Admin brand boundaries.

### Tests and source verification

- `deno test --no-check --allow-read=. supabase/functions/x-test-post supabase/functions/_shared/brand`: **450 passed / 0 failed**. Coverage includes normal/reserved slot canonical routing, wrong-brand/account rejection, Kabumori isolation, 281-code-point pre-X rejection, duplicate blocking, confirmed completion once, uncertain completion no resend, unknown post type fail-closed, and the existing full x-test-post regression.
- `deno test --no-check --allow-read=. apps/admin/src/lib/brand-boundary.test.ts`: **5 passed / 0 failed**.
- Admin `npm run lint`: pass. Admin `npm run build`: pass, including TypeScript.
- `deno check --no-config supabase/functions/x-test-post/index.ts`: six diagnostics, exactly the same six as a clean latest-main comparison worktree (AES-GCM BufferSource, image BlobPart/BodyInit, `retry_count`, timestamp precision); no new hotfix diagnostic.
- `git diff --check`: pass.
- implementation commit/main source: `bed1cd513940fc7be03dd077d7fc5a9d2b998b34`. Push read-back matched `origin/main` before later non-overlapping slot commits advanced main.

### Production deploy/read-back

- Deployed **only** `x-test-post`; no DB/schema/migration/RPC/RLS, Cron/window, OAuth/token, Kabumori/Mio, media, or other Function change.
- Immediately after deploy: ACTIVE v110, `verify_jwt=false`, aggregate runtime hash `ba0e7c78bd8cec62b4c8c2fe50bd1de80c7f3ecbaa1a1206c4e668f70012ab60`.
- Download/read-back contained exactly 39 runtime files. Byte comparison against the fixed candidate passed **39/39**, no mismatch; deterministic per-file aggregate SHA-256 `50f3f60eddf952cf41abe1b86a7e714f944d7a9f23fc9dd3b1607f563d5f5ca2`.
- Immediate pre/post Function inventory showed only `x-test-post` advancing (v109 -> v110); all other observed Function versions and timestamps were unchanged.
- At the later natural observation, Supabase's listing reported version counter 112, while `updated_at`, bundle hash, entrypoint path (v110 bundle), 39-file set, and restored dispatcher content remained unchanged. No different runtime source was observed.
- Admin source was pushed through the existing main-linked path; hosting/project settings were not changed. Local production build passed. A separate hosting deployment read-back was not available in this task.

### Natural Cron observation and safety stop

- No manual Function invocation, candidate injection, backfill, failed-row retry, OpenAI/X/Push call, or manual X post was made.
- Natural slot 2 (`scheduled_posts.id=45ee2e6f-ae78-4d9e-92dd-5595cb675177`, scheduled 09:48:36 JST) was claimed by the existing Cron at 09:49:00 JST and finished at 09:49:04 JST.
- Result: `failed`, `attempt_count=1`, terminal message `X_REQUEST_FAILED:401`. Crucially, `UNSUPPORTED_POST_TYPE:brand_post` did **not** recur, proving the normal scheduled row reached the restored AI Lab route and X dispatch boundary.
- Logs are exactly one `started` plus one `failed` record for the row; succeeded logs=0, logs with `x_post_id`=0, and unsupported-post-type logs=0. Fingerprints created since the attempt=0. The canonical dispatcher made one X API attempt, which received 401; confirmed X posts=0, media writes=0, duplicate sends=0, and automatic retries=0.
- Read-only account state remains fixed to `ai_salaryman_lab_x` / `kaishain_ai_lab`, `identity_verified`, publish enabled, with both Vault references present; brand remains active/live. No secret, token, or Vault reference value was read.

### Remaining blocker / C1 decision

- The dispatcher regression is repaired, but ordinary publishing remains blocked by the current AI Lab access token returning 401. Refresh is intentionally disabled on the AI Lab path to prevent legacy-token fallback or unapproved token mutation.
- Do not retry failed rows. A separately authorized AI Lab OAuth reauthorization/token replacement is required before a later natural slot can confirm successful X delivery. This task made no OAuth/token change and stops for C1.

## Latest H1 result — Phase 3K AI Lab first live rollout (2026-09-16)

- task_id: `x-multibrand-phase3k-ai-lab-first-live-test-20260916`
- result: `review_required` — Phase A/B/C completed. AI Lab write OAuth was deployed and reauthorized, one controlled text-only post succeeded once, and the existing ten posting windows were activated only after that success.
- authorization boundaries: only AI Lab was changed. No media scope/upload, Kabumori/Mio change, Cron change, schema/RPC/migration change, `supabase db push`, token refresh, or unrelated Function deploy was performed.

### Phase A — deploy and OAuth

- deployed only `x-oauth-connect` from exact approved commit `a469dcc50acc443efd65ebb933d527d3b21f5dca`.
- production read-back: ACTIVE v18, `verify_jwt=false`, 12/12 runtime files byte-identical to the approved candidate, no missing/extra files; aggregate source hash `96a5d3ea5a938a1f972e1a74aa6013f6a18934926ffcd30c2b4fb0f1746b7f98`.
- exact requested OAuth scopes: `tweet.read users.read tweet.write offline.access`; `media.write`, `like.write`, and `follows.write` were absent.
- user completed X authorization while signed in as `@kaishain_ai_lab`. Callback consumed the fresh state and completed identity verification at 2026-09-16 18:48:19 JST.
- `/2/users/me` verified username: `kaishain_ai_lab`. Only after this check were Vault-backed access/refresh references accepted. No token/secret/ref value was read or recorded.
- after callback: `ai_salaryman_lab_x` remained `identity_verified`, fixed handle `kaishain_ai_lab`, with both Vault references present; publishing was still disabled until Phase B.

### Phase B — controlled first real post

- preconditions: all ten existing AI Lab `brand_post` windows remained inactive; no same-day/future AI Lab `brand_post` schedule, fingerprint, or execution log existed.
- atomically changed AI Lab only: `publish_mode=dry_run → live`, `publish_enabled=false → true`, and `enabled_post_types=[] → [\"brand_post\"]`; inserted one controlled same-day row using reserved test `slot_no=0`, scheduled three minutes ahead. No window was activated at this point.
- execution: the existing every-minute natural Cron claimed the row at 18:58:00 JST and completed at 18:58:05 JST. Status `succeeded`, `attempt_count=1`, no error, no retry.
- first real post: X post id `2100162295930511602`, published 2026-09-16 18:58:05 JST, 115 Unicode code points, text only. It was visually confirmed on `@kaishain_ai_lab` at the matching status URL.
- completion safety: one succeeded execution log and one matching `published_content_fingerprints` row were persisted at the terminal completion timestamp. Observed AI Lab X text writes=1; media writes/uploads=0.

### Phase C — prospective ten-slot activation

- after explicit user confirmation of the recurring-production blast radius, exactly the existing ten AI Lab `brand_post` rows were changed from inactive to active in one guarded transaction.
- read-back matched all approved values unchanged: slots 1–10, `Asia/Tokyo`, daily probability 1.0, and the original windows 07:30–08:30 through 22:00–23:00. Active count changed 0 → 10; no time, slot, probability, or Cron cadence was changed.
- production `plan_daily_posts` definition was read before activation. For the current JST date it skips windows whose end time has passed and, for an in-progress window, starts no earlier than current time +1 minute.
- natural Cron at 19:14 JST produced only the prospective remaining rows: slot 8 at 19:52:05, slot 9 at 21:09:06, and slot 10 at 22:57:39 JST, all pending with `attempt_count=0`. Backfill count for expired slots 1–7 was 0.
- naturally executed rows observed during this rollout: the controlled slot 0 row completed once; the newly planned slots 8–10 were future pending at final read-back and were not manually invoked.

### Final state and isolation

- AI Lab: brand active/live; account identity verified and publish enabled; enabled post type `[\"brand_post\"]`; ten windows active; one succeeded controlled row and three future pending rows.
- Kabumori final read-back: brand active/live; `kabumori_x` handle `yume_daka`, identity verified, publish enabled; its brand/account timestamps and seven existing posting-window active states were not modified by this work.
- Mio final read-back: brand inactive/disabled and no social-account/window row observed; unchanged by this work.
- Function isolation: `x-test-post` remained v108 with its previously verified source hash. Only `x-oauth-connect` was deployed by H1. The independently updated `important-news-monitor` belongs to another slot and was not touched here.
- automatic stop conditions observed: none. No wrong account, duplicate, over-280 dispatch, token routing/refresh anomaly, uncertain completion, generation loop, media call, multi-post per slot, or scheduler/backfill anomaly occurred.
- source/tests: no new application source was edited in this continuation. The deployed candidate retained its prior 25/25 tests, changed-file type checks, format checks, and `git diff --check` evidence from C1.
- remaining observation: slot 8–10 are scheduled for later natural execution. Their delivery outcome is not claimed here; no manual execution or backfill was used.

## Latest H1 result — Phase 3K AI Lab text-write OAuth candidate (2026-09-16)

- task_id: `x-multibrand-phase3k-ai-lab-first-live-test-20260916`
- result: `review_required` — production `x-oauth-connect` needs a source change before AI Lab can request `tweet.write`, so the task stopped at the mandatory C1 gate before deploy or reauthorization.
- user approval: after the write-capable-token risk was stated explicitly, the user approved the code-only scope change, tests, candidate push, and C1 report. This approval did not execute a production deployment or OAuth flow.
- production baseline: `x-oauth-connect` ACTIVE v17 / `verify_jwt=false`. Its 12 runtime files were read back and matched commit `13cb948684785cdd189882b7434b981fabf96385` byte-for-byte (12/12), so that exact commit was used as the implementation base rather than the unrelated current `origin/main` source state.
- candidate: branch `codex/ai-lab-write-scope-20260916`, commit `a469dcc50acc443efd65ebb933d527d3b21f5dca` (`Add AI Lab text-write OAuth scope`).
- source change: AI Lab only changes from `tweet.read users.read offline.access` to `tweet.read users.read tweet.write offline.access`. `media.write`, `like.write`, and `follows.write` remain absent. Kabumori's existing scope string is unchanged.
- safety retained: fixed `ai_salaryman_lab_x` / `kaishain_ai_lab` routing, Vault destination, callback `/2/users/me` identity verification before token completion, `publish_mode=dry_run`, and `publish_enabled=false` are unchanged. The runtime still contains no X post or media-upload endpoint.
- changed files:
  - `supabase/functions/x-oauth-connect/account_config.ts`
  - `supabase/functions/x-oauth-connect/account_config_test.ts`
  - `supabase/functions/x-oauth-connect/rpc_test.ts`
  - `supabase/functions/_shared/brand/oauth_connection_test.ts`
- tests: `deno test --no-check --allow-read=. supabase/functions/x-oauth-connect supabase/functions/_shared/brand` passed 25/25. `deno check --no-config` on all four changed files passed. `deno fmt --check` passed on the three already-formatted x-oauth-connect files; the shared test has pre-existing whole-file formatting drift and was not reformatted beyond the touched assertions. `git diff --check` passed.
- production fresh-check before implementation: AI Lab brand remained active in `dry_run`; account `ai_salaryman_lab_x` / `kaishain_ai_lab` remained `identity_verified` with `publish_enabled=false` and Vault refs present; all ten AI Lab `brand_post` windows remained inactive; no unexpected scheduled AI Lab `brand_post` or published fingerprint was observed. No secret/ref value was read.
- production changes: 0. No Function deploy, OAuth start/callback, reauthorization, token save/refresh, DB/schema/RPC/migration/Cron/window/flag change, planner invocation, X post, or media upload occurred. Text-write calls=0; media-write calls=0. Kabumori and Mio were not changed.
- next gate: C1 must review exact commit `a469dcc50acc443efd65ebb933d527d3b21f5dca`. Only after a separate approved deployment may the AI Lab OAuth reauthorization be started; the callback must verify `/2/users/me` username exactly `kaishain_ai_lab` before any new Vault-backed token refs are accepted. Phase B/C were not entered.

## Latest H1 result — Phase 3J AI Lab posting schedule (2026-09-14)

- task_id: `x-multibrand-phase3j-ai-lab-posting-schedule-20260914`
- result: `review_required` — the approved schedule values are stored for AI Lab only, with all ten rows inactive. Publishing remains disabled and in dry-run mode.
- production writes: exactly 10 `INSERT` rows in `public.posting_windows`; no updates/deletes, schema/migration/RPC changes, or source changes.
- schedule rows read back exactly:

| Slot | JST window | Probability | Active |
|---:|:---|---:|:---:|
| 1 | 07:30–08:30 | 1.0 | No |
| 2 | 09:00–10:00 | 1.0 | No |
| 3 | 10:30–11:30 | 1.0 | No |
| 4 | 12:00–13:00 | 1.0 | No |
| 5 | 13:30–14:30 | 1.0 | No |
| 6 | 15:30–16:30 | 1.0 | No |
| 7 | 17:30–18:30 | 1.0 | No |
| 8 | 19:00–20:00 | 1.0 | No |
| 9 | 20:30–21:30 | 1.0 | No |
| 10 | 22:00–23:00 | 1.0 | No |

- every row is `brand_id='ai_salaryman_lab'`, `post_type='brand_post'`, `timezone='Asia/Tokyo'`, `daily_probability=1.0`, `is_active=false`.
- planner semantics read from production `public.plan_daily_posts(date)`: it ignores rows unless the window is active, the brand is active, and `publish_mode` is dry_run/live. Probability 1.0 passes the deterministic per-date gate; execution time is randomized within each window using the row timezone. No planner invocation was made by this task.
- safety preflight: before insert, no `brand_post` posting windows existed for any brand and no `brand_post` scheduled rows existed for the next ten days. `posting_windows` has no triggers. After insert, exact read-back showed ten inactive AI Lab rows; all existing non-AI-Lab rows were unchanged (the nine existing rows belong to Kabumori; no Mio row existed); upcoming `brand_post` scheduled-post count remains 0.
- constraints caveat: both `posting_windows` and `scheduled_posts` also have brand-agnostic uniqueness (`(post_type, slot_no)` and `(schedule_date, post_type, slot_no)`). No current competing `brand_post` row exists, so these ten inactive settings fit safely; future same-type/same-slot scheduling for another brand needs separate schema/planner review.
- runtime state after read-back: AI Lab brand `is_active=true`, `publish_mode='dry_run'`; account `ai_salaryman_lab_x` / `kaishain_ai_lab` remains `identity_verified`, `publish_enabled=false`.
- unchanged systems: existing `dispatch-scheduled-posts` Cron remains active every minute and was not edited; no OAuth, scope, token, publish flag, Function, migration, or schema operation was performed. No planner or `x-test-post` invocation was triggered manually for this task; this task made no direct X API or media-write call. No real/test post was attempted.
- tests/verification: production catalog/schema and planner definition inspected read-only; SQL INSERT RETURNING and subsequent full row read-back matched the ten requested slots. Upcoming scheduled-post side effect count=0. No application source code changed, so no code test suite was run.
- commit/push: control/report metadata only. Implementation-code commit/deploy: none.
- next gate: keep rows inactive. OAuth write-scope readiness and any later activation/live publishing require separate task/authorization; this result does not authorize a first post.

## Latest H1 result — Phase 3I deployment gate (2026-09-14)

- task_id: `x-multibrand-phase3i-runtime-reconciliation-deploy-20260914`
- result: `review_required` — exact approved candidate deployed, byte-verified, and non-posting smoke check completed. No first/live post was authorized or attempted.
- authorization: user directly approved only deployment of `x-test-post` from exact commit `c4eb2855f2adc66e5518feaa51eef63bbf139e4d`, retaining `verify_jwt=false`, followed by source read-back/byte verification and non-posting dry-run verification.
- candidate: branch `codex/x-multibrand-phase3i-runtime-reconciliation-20260914`, exact deployed commit `c4eb2855f2adc66e5518feaa51eef63bbf139e4d`.
- deployment: production `x-test-post` ACTIVE v108, `verify_jwt=false`. Read-back contained 39 runtime files, aggregate SHA-256 `5d26b55b0d9474807b152e59461866b52d146fe26a4284dd2f1657abe61f4fef`; byte comparison against the exact candidate passed 39/39, with no missing, mismatched, or extra files.
- function isolation: pre/post version comparison showed only `x-test-post` changed (v107 → v108). Other observed Functions remained at their pre-deploy versions.
- non-posting smoke: one explicit synthetic voice-preview call returned HTTP 200, `mode=dry_run`, `published=false`. It took the synthetic Kabumori preview branch and returned `voiceEvaluation.passed=false`; no DB claim, token, X POST, or media-upload path was reached. This was not an AI Lab scheduled-brand invocation.
- AI Lab state: immediately-after read-only check remained brand `is_active=true`, `publish_mode=dry_run`; account `ai_salaryman_lab_x`, handle `kaishain_ai_lab`, `connection_status=identity_verified`, `publish_enabled=false`. Fingerprint count was 0 before and 0 after the smoke call. No token value was read.
- runtime safeguards: exact deployed source is the C1-reviewed candidate, whose 448/448 relevant tests passed. It retains the AI Lab 280-code-point pre-dispatch guard, fixed Vault-backed account routing, no Kabumori legacy-token fallback, and refresh disabled. This turn did not separately exercise the AI Lab route in production.
- mutations excluded: no migration/DB write, other Function deploy, OAuth/scope/token change, Cron/posting-window change, publish flag change, real X post, or media upload. X POST calls=0; media-upload calls=0.
- cleanup: temporary candidate `supabase/config.toml` and CLI version marker were removed. No implementation source changed during deployment.
- next_owner: ChatGPT review. Remaining before any first live AI Lab post: separately authorize scope changes if needed, verify exact posting-window requirements, and obtain distinct approval for publish enablement and the first real post. No such action is covered here.

- task_id: `x-multibrand-phase3i-runtime-reconciliation-20260914`
- result: `review_required` — source reconciliation passed local tests and was pushed for C1 review. Production remains on `x-test-post` v107; no deploy or new DB operation was performed.
- model_used: GPT-5.6 Sol
- production_source_base: `25998fc8927d8bd45a89478b1fec8b4bc5ba782b` (recorded v107 source, independently proven below)
- control_base: fresh `origin/main` `97c624267ab9d2ecb0b03487d5c5cdacdc5ab8dd`
- reviewed_source: Phase 3H commits `6ce4ad8ea983dd617c6227dd6f628e3e3b4f945b` and `406b53c2a2838a5ac2a446fffb6e6feef954eb7a`
- candidate_branch: `codex/x-multibrand-phase3i-runtime-reconciliation-20260914`
- candidate_commit: `c4eb2855f2adc66e5518feaa51eef63bbf139e4d`
- push: candidate branch pushed to `origin` for C1 review; no force push.
- production_project: `wsmznyzcvmuitkglfeuj` (`stock-x-autopost`), ACTIVE_HEALTHY, Postgres 17.6, `ap-northeast-1`.

## Latest H1 result — Phase 3I runtime reconciliation

### Proven v107 baseline

- `supabase_get_edge_function(x-test-post)` returned ACTIVE version 107, `verify_jwt=false`, 27 runtime files, aggregate SHA-256 `54e8dae698415305185bb6e59f0cf4b1d12c0ca1df9750d44ff6d9772364fc71`.
- Each of the 27 API-returned file contents was compared directly with commit `25998fc8927d8bd45a89478b1fec8b4bc5ba782b`; all 27/27 were byte-identical. The deployed API entrypoint also pointed to this recorded source checkout.
- A second read-only function read after the candidate push still returned version 107 and the same aggregate hash; all 27/27 files matched the pre-work read exactly.
- v107 runtime file list:
  - `supabase/functions/x-test-post/index.ts`
  - `supabase/functions/x-test-post/morning_report_logic.ts`
  - `supabase/functions/x-test-post/us_session_date_logic.ts`
  - `supabase/functions/x-test-post/close_report_logic.ts`
  - `supabase/functions/x-test-post/fixed_hashtags_logic.ts`
  - `supabase/functions/x-test-post/voice_retry_logic.ts`
  - `supabase/functions/x-test-post/close_report_data_logic.ts`
  - `supabase/functions/x-test-post/report_voice_rewrite_logic.ts`
  - `supabase/functions/x-test-post/us_premarket_logic.ts`
  - `supabase/functions/x-test-post/interaction_quality_logic.ts`
  - `supabase/functions/x-test-post/tip_voice_logic.ts`
  - `supabase/functions/_shared/kabumori_voice.ts`
  - `supabase/functions/x-test-post/voice_evaluation_logic.ts`
  - `supabase/functions/x-test-post/report_material_logic.ts`
  - `supabase/functions/x-test-post/morning_candidate_logic.ts`
  - `supabase/functions/x-test-post/morning_lane_response_logic.ts`
  - `supabase/functions/x-test-post/morning_report_retry_logic.ts`
  - `supabase/functions/x-test-post/admin_auth_logic.ts`
  - `supabase/functions/x-test-post/morning_greeting_image_logic.ts`
  - `supabase/functions/x-test-post/yume_reference_logic.ts`
  - `supabase/functions/x-test-post/morning_greeting_payload_logic.ts`
  - `supabase/functions/x-test-post/morning_greeting_logic.ts`
  - `supabase/functions/x-test-post/morning_greeting_scene_logic.ts`
  - `supabase/functions/x-test-post/morning_greeting_publish_logic.ts`
  - `supabase/functions/x-test-post/publish_claim_logic.ts`
  - `supabase/functions/_shared/x_oauth2_post.ts`
  - `supabase/functions/x-test-post/useful_tip_generation_logic.ts`

### Reconciliation and three-way diff

- v107 → candidate: only `x-test-post/index.ts` changes among the 27 existing runtime files; the other 26 remain byte-identical. Twelve imported brand runtime modules were added for brand context, guarded token routing, AI Lab generation/dispatch, length enforcement, fingerprints, and dedupe.
- Phase 3H `406b53c` → candidate: the three unrelated files `close_report_data_logic.ts`, `close_report_logic.ts`, and `fixed_hashtags_logic.ts` remain at the proven v107 bytes. The unrelated TOPIX/report prompt and live-close selection hunks in `index.ts` were also restored to v107. The approved AI Lab Vault-backed dispatch and completion safeguards remain.
- Non-imported brand context dry-run routing and unrelated standalone OAuth/Vault metadata helper modules/tests from `406b53c` were not carried into this deploy candidate. This keeps the runtime candidate limited to modules imported by the reconciled `x-test-post` path. The two migration files are included unchanged from `406b53c` for source traceability/static security testing; they were not executed in this task.
- Existing-file edits are limited to `x-test-post/index.ts` and two tests whose ordering assertions now match deferred X-auth construction after scheduled-row brand selection. The close-report and hashtag source files and tests are unchanged from v107.

### Changed files

- Runtime entry: `supabase/functions/x-test-post/index.ts`.
- New runtime modules under `supabase/functions/_shared/brand/`: `ai_lab_brand_post_store.ts`, `ai_lab_scheduled_brand_post.ts`, `ai_lab_vault_token_source.ts`, `brand_context.ts`, `brand_post_dispatch_guard.ts`, `brand_post_generator.ts`, `brand_profiles.ts`, `cross_brand_dedupe.ts`, `kabumori_recent_fingerprints.ts`, `post_length_policy.ts`, `publish_guard.ts`, `token_loader.ts`.
- New/updated tests under the same directory: `ai_lab_brand_post_store_test.ts`, `ai_lab_scheduled_brand_post_test.ts`, `ai_lab_vault_token_source_test.ts`, `brand_context_test.ts`, `brand_post_dispatch_guard_test.ts`, `brand_post_generator_test.ts`, `brand_profiles_test.ts`, `cross_brand_dedupe_test.ts`, `dispatch_gate_test.ts`, `kabumori_recent_fingerprints_test.ts`, `post_length_policy_test.ts`, `publish_guard_test.ts`, `token_loader_test.ts`.
- Updated tests in `supabase/functions/x-test-post/`: `morning_greeting_payload_logic_test.ts`, `morning_greeting_publish_logic_test.ts`.
- Included exact, unchanged source files for the migrations already applied in the prior authorized task: `supabase/migrations/20260913123509_ai_lab_prelive_safeguards.sql`, `supabase/migrations/20260913151428_read_ai_lab_x_vault_token.sql`.

### Tests and safety

- `deno test --no-check --allow-read=. supabase/functions/x-test-post supabase/functions/_shared/brand`: 448 passed / 0 failed. Includes 279/280 pass, 281 blocked, dry-run no X callback, fixed AI Lab Vault routing/no legacy fallback/no refresh, duplicate blocking, confirmed-success completion and uncertain-completion duplicate-resend protection, plus Kabumori, close-report, TOPIX-source, and fixed-hashtag regressions.
- `deno check --no-config supabase/functions/x-test-post/index.ts`: six diagnostics, exactly the same six as clean v107 baseline `25998fc` (AES-GCM `Uint8Array/BufferSource`, image `BlobPart/BodyInit`, `retry_count`, timestamp precision). No new diagnostic from reconciliation.
- `deno fmt --check` on the ten core Phase 3H helper/test files: pass. A broader check of the curated 25-file brand directory still reports 10 files from the reviewed source as unformatted; no formatting-only edits were made.
- `git diff --check`: pass.
- Production read-back after work: `x-test-post` still ACTIVE v107, `verify_jwt=false`, same 27 files/hash. No Function deploy, runtime invocation, SQL/migration execution, DB write, migration history edit, Cron/settings/OAuth/token change, X post, or media upload. X/media writes: 0.

### Remaining gate

Candidate awaits C1 review. Stop before any Edge Function deploy; a separate explicit deploy authorization is required after C1. The two pre-existing Phase 3I migrations remain applied and must not be reapplied or replaced.

## Previous task metadata — Phase 3I pre-live rollout

- task_id: `x-multibrand-phase3i-ai-lab-production-prelive-rollout-20260914`
- result: `review_required` — both explicitly authorized migrations were applied and read back successfully. Stopped before Function deploy after discovering material differences between current production `x-test-post` and the exact reviewed commit that would replace non-Phase-3H code.
- model_used: GPT-5.6 Sol
- source_commit: `406b53c2a2838a5ac2a446fffb6e6feef954eb7a`; fresh fetch of `origin/codex/ai-lab-prelive-safeguards-20260913` confirmed the exact remote HEAD. Both reviewed migration files exist in that commit; SHA-256: `342119d0ae523f0eb93a5d6b233395e9f326d7ce79c172f2e61b518e6f205ce6` (`20260913123509_ai_lab_prelive_safeguards.sql`), `88316c9e57f69c719db503fe184ab8cc806d04ebce1c08a70b04f8d544d34317` (`20260913151428_read_ai_lab_x_vault_token.sql`).
- control_base: `6c4a05a9e6aa583d5a7336aac7e41b3ca7af54fb`.
- production_project: `wsmznyzcvmuitkglfeuj` (`stock-x-autopost`), ACTIVE_HEALTHY, Postgres 17.6, `ap-northeast-1`.

## Previous Phase 3I preflight and rollout results

- migrations_applied: only `20260913123509_ai_lab_prelive_safeguards.sql` and `20260913151428_read_ai_lab_x_vault_token.sql`, both read from exact commit `406b53c2...`. Supabase recorded `20260913230852` / `ai_lab_prelive_safeguards` and `20260913231013` / `read_ai_lab_x_vault_token`. No other SQL/migration applied.
- migration_readback: `complete_ai_salaryman_lab_brand_post(uuid,text,text)` and `read_ai_salaryman_lab_x_vault_token(uuid)` are present, both `SECURITY DEFINER`, empty `search_path`, service_role EXECUTE true and anon/authenticated false. Function bodies match the reviewed fixed brand/account/type/handle/identity/ref guards; completion marks only a matching running AI Lab `brand_post` row succeeded after confirmed success and handles fingerprint/log failure without repost eligibility. Partial unique `(social_account_id,x_post_id) WHERE x_post_id IS NOT NULL` index exists. Vault reader was not invoked.
- grants_and_policies: RLS is enabled but not forced on the five checked tables. There are no listed policies on `brands`, `social_accounts`, or `published_content_fingerprints`; `scheduled_posts` and `post_execution_logs` each have an authenticated SELECT policy. Catalog grants also show existing `anon`/`authenticated` REFERENCES, TRIGGER, and TRUNCATE privileges on `scheduled_posts` / `post_execution_logs`, plus authenticated SELECT; this task did not change them. These existing grants need owner review and are not treated as authorization to broaden or repair production permissions here.
- preflight: AI Lab brand is active and `dry_run`; account is `ai_salaryman_lab_x`, handle `kaishain_ai_lab`, `identity_verified`; `publish_enabled=false`. Vault reference presence was checked only as booleans; no reference identifiers or token values were read. `x-test-post` remains v107 ACTIVE / `verify_jwt=false`.
- x_test_post_deploy: none. Production remains v107 ACTIVE / `verify_jwt=false`.
- deployed_source_verification: before deployment, downloaded v107 runtime comparison showed 27 production files vs 40 source-commit modules; 23 were byte-identical, 13 target brand helpers are new, and four existing files differ. `close_report_data_logic.ts`, `close_report_logic.ts`, and `fixed_hashtags_logic.ts` are unchanged by Phase 3H but differ from current production; `index.ts` also differs. Deploying the exact reviewed commit would replace the three non-Phase-3H files, so deployment was stopped to avoid a potential regression of other post types.
- non_posting_runtime_verification: no runtime invocation; X POST/media calls: 0.
- ai_lab_length_guard_result: production runtime not exercised. Reviewed source test suite passed 460/460.
- vault_route_result: fixed AI Lab account metadata still matches `ai_salaryman_lab_x` / `kaishain_ai_lab` / `identity_verified`, publish disabled, both ref columns present; reader ACL/body verified. No token/ref value was read and no token was refreshed.
- fingerprint_dry_run_result: dry-run not invoked; unique index exists; no fingerprint rows were inserted by this task.
- posting_window_status: no AI Lab posting window was present in the prior read-only state; none was created or changed. Exact schedule values remain unsupplied.
- write_scope_status: no OAuth scope change; AI Lab remains read-only (`tweet.read users.read offline.access`).
- tests: `deno test --no-check --allow-read=. supabase/functions/x-test-post supabase/functions/_shared/brand`: 460/460 pass. Changed-file `deno check --no-config` returns six diagnostics; running the same check at clean base `341e5dc` produces the same six (Uint8Array/BufferSource, Blob/BodyInit, `retry_count`, timestamp precision), so no new type diagnostic. `git diff --check` on reviewed source: pass. Supabase security advisor returned no findings for the two new RPCs; unrelated existing warnings remain.
- production_changes: exactly the two approved migrations (recorded versions above). No Edge Function deploy, runtime invocation, X/media call, Cron/posting-window, OAuth, token, publish flag, or unrelated service change.
- unchanged_components: `important-news-monitor`, other Edge Functions, Cron, OAuth scopes/secrets, Kabumori, Mio, publish flags, and X posting.
- blocker: current production `x-test-post` contains existing code absent from the exact reviewed source commit. The migration layer is complete, but deploy is paused because replacing three unchanged-by-Phase-3H files could regress other post types.
- exact_steps_before_first_live_post: reconcile the production-source drift with a fresh reviewed commit or an explicit decision that the identified existing runtime files may be replaced; deploy/read-back only after that gate; separately supply posting-window values; separately authorize `tweet.write` reauthorization and verify `/2/users/me`; separately approve any publish enablement and first real post. No live/posting step is authorized here.
- safety_checks: only the two explicitly approved migration files changed production schema. No secrets/token values or Vault identifiers were read or recorded; no data rows, Edge Function runtime, publish flags, OAuth scopes, Cron, X post, or media upload were changed.
- next_recommendation: keep v107 deployed until the user resolves the exact-source regression risk; then re-review/deploy only the chosen `x-test-post` source. Do not reapply the two migrations.

---

## Phase 3H implementation details (previous report, carried forward)

## Length policy

- length_policy_design: shared discriminated union: finite `{mode: "limited", maxChars: positive integer}` or explicit `{mode: "unlimited", maxChars: null}`. Suitable for future app settings; no magic large maximum.
- Character counting uses JavaScript Unicode code points (`Array.from(text).length`): Japanese code points count one each and a surrogate-pair emoji such as 😀 counts one. This is not claimed to match X weighted-length rules.
- ai_lab_280_char_result: AI Lab profile sets 280. The generation prompt requests the limit; post-generation validation fails closed above 280 without truncation or retry. Tests cover 279/280 pass and 281 rejection, including Japanese and surrogate-pair emoji cases.
- unlimited_mode_design: tested explicitly; removes only the finite count limit. Brand, post type, and publish gates remain separate.
- Kabumori regression: its profile remains without a finite policy and retains the previous 200–400-character prompt; no live Kabumori dispatch code changed.
- dispatch_length_guard_result: wired into the AI Lab scheduled `brand_post` path and independently rejects over-limit text immediately before X dispatch. Wrong brand/type fails closed. No live post was made.

## Fingerprints / dispatch

- fingerprint_persistence_result: after a confirmed X success, `x-test-post` calls `complete_ai_salaryman_lab_brand_post`, which inserts the normalized-content fingerprint under a unique `(social_account_id, x_post_id)` key and marks the scheduled row terminal. Fingerprint insert failure is reported while terminal completion prevents automatic repost. If completion confirmation itself is uncertain after X success, a dedicated error path skips generic scheduled-post failure/retry handling to avoid duplicate resend. Dry-run does not call this live completion path; regression-tested.
- vault_dispatch_routing_result: AI Lab scheduled `brand_post` routes only through the fixed `ai_salaryman_lab_x` account, expected handle `kaishain_ai_lab`, `identity_verified` state, and that row's Vault token reference. A new local SQL RPC returns only the referenced token for that fixed account and is executable by `service_role` only. AI Lab has no fallback to Kabumori `oauth_token_store`; refresh is disabled. No token value was read or logged.
- posting_window_status: no AI Lab/`brand_post` posting-window row was present in the prior read-only check; none was added. Exact source-of-truth values still needed: post type confirmation, local start/end time(s), timezone, slot count/slot numbers, and `daily_probability` per slot.
- write_scope_readiness: no OAuth scope change or reauthorization. Existing AI Lab scopes remain read-only (`tweet.read users.read offline.access`); text posting requires separately approved `tweet.write`. `media.write` is only needed for a future media-upload flow. Before enabling publishing, separately reauthorize and verify `/2/users/me` still returns `kaishain_ai_lab`. No scope is authorized by this task.

## Files and database code

- changed_files:
  - `supabase/functions/_shared/brand/ai_lab_scheduled_brand_post.ts` / `_test.ts`
  - `supabase/functions/_shared/brand/ai_lab_vault_token_source.ts` / `_test.ts`
  - `supabase/functions/_shared/brand/post_length_policy.ts` / `_test.ts`
  - `supabase/functions/_shared/brand/brand_profiles.ts`
  - `supabase/functions/_shared/brand/brand_post_generator.ts` / `_test.ts`
  - `supabase/functions/_shared/brand/brand_post_dispatch_guard.ts` / `_test.ts`
  - `supabase/functions/_shared/brand/brand_post_dry_run_test.ts`
  - `supabase/functions/_shared/brand/kabumori_recent_fingerprints.ts` / `_test.ts` (optional strict failure mode for future live dedupe; existing default fail-safe behavior unchanged)
  - `supabase/functions/_shared/brand/ai_lab_brand_post_store.ts` / `_test.ts`
  - `supabase/functions/x-test-post/index.ts`
  - `supabase/migrations/20260913123509_ai_lab_prelive_safeguards.sql`
  - `supabase/migrations/20260913151428_read_ai_lab_x_vault_token.sql`
- migrations/rpcs/functions_changed: two **local, unapplied** migrations. The first adds fingerprint idempotency and `complete_ai_salaryman_lab_brand_post`; the second adds fixed-account `read_ai_salaryman_lab_x_vault_token` (`SECURITY DEFINER`, empty `search_path`, `service_role` EXECUTE only). `x-test-post` is the only Edge Function source changed; it is not deployed.

## Tests

- `deno test --no-check --allow-read=. supabase/functions/x-test-post supabase/functions/_shared/brand`: 460 passed / 0 failed, including AI Lab routing/guard/completion and Kabumori regression tests.
- `deno check --no-config` for the changed helpers and `x-test-post/index.ts` reports the same six pre-existing diagnostics as a clean source-base checkout. They concern AES-GCM `Uint8Array`/`BufferSource`, `Uint8Array` Blob/body typing, missing `retry_count`, and unknown timestamp precision. No new type issue was identified versus baseline.
- `deno fmt --check` on the five new helper/test/migration files: pass. `git diff --check`: pass. The existing ~4.5k-line `x-test-post/index.ts` was not reformatted wholesale.
- Test files ran with `--no-check` because this worktree has no installed `npm:@types/node`; changed non-test modules were separately type-checked. SQL was not applied or executed in a local Postgres instance; `psql`/Docker were unavailable.

## Production, blocker, and next steps

- production_changes: 0. This code-only continuation did not access production. The prior read-only state remains the last verified state: AI Lab `publish_mode=dry_run`, `publish_enabled=false`; no token values were read. No production DDL/data/RPC write occurred.
- deploy_status: none; no Edge Function deployed. X POST/media calls: 0. Cron, OAuth scopes, secrets, account settings, Kabumori, and Mio were not changed.
- remaining_issues: C1 review. Separately, static/review and exact approval are needed before applying either local migration; production deploy/read-back; confirmed schedule data; separately approved `tweet.write` reauthorization and identity check; separate approval before changing live flags or sending a first post. iOS is not relevant to this Edge Function task.
- exact steps before first AI Lab live post: (1) C1 review this code and both migrations; (2) obtain separate exact approval before applying the two migrations, then read back function definition/ACL and verify the fixed account/token reference guard; (3) obtain separate approval before deploying only `x-test-post`, then verify deployed source/version; (4) confirm exact AI Lab posting-window values from its source of truth (do not invent or change Cron); (5) separately approve OAuth reauthorization adding `tweet.write` while retaining current read scopes, then use read-only `/2/users/me` to verify `kaishain_ai_lab`; (6) only after separate explicit approval may publishing flags be changed and a first real X text post be sent. No step beyond local implementation/testing is authorized here.
- safety_checks: no live mode/publish enablement, DB change, deploy, X post, media upload, token refresh, OAuth scope change, Cron/posting-window change, Kabumori token/path change, or Mio change. AI Lab routing has no legacy fallback and does not refresh. Secret/token values were not emitted to logs, responses, Git, or this report.
- next_recommendation: C1 review the pushed branch/diff and commit integrity. Stop here; do not apply migrations, deploy, change OAuth scopes or publishing flags, or send an X post without their separate explicit approvals.

---

## Previous Codex report — broad-news-display-and-notification-presets-phase3-20260913

- task_id: `broad-news-display-and-notification-presets-phase3-20260913`
- result: `review_required` — Phase 3のアプリ表示・通知プリセットをローカル実装し、回帰テストまで完了。本番変更は0件
- model_used: GPT-5.6 Sol
- source_base: `origin/main` `2c7e3745885d659af0b67af1261587af3ed39eff`
- implementation_branch: `codex/broad-news-presets-phase3-20260913`
- commit_hash: `f7c17b915c551ba81b1dfc62a0731fd3eba6f008`
- next_owner: chatgpt

## App visibility

- current_app_visibility: 本番RPCは、登録銘柄の既存companyニュースと、登録銘柄の業種に関連するmarket-wide critical/highを表示する。market mediumは対象外で、登録銘柄0件ならアプリ側がRPCを呼ばず空表示だった。
- new_app_visibility: companyは既存の保有/監視紐付けを維持してmedium以上を表示。market-wideは関連業種があるmedium/high/criticalを表示し、emergencyは登録銘柄・業種一致なしでも表示。lowは収集・分類に残すが一覧には出さない。登録銘柄0件でもRPCを呼ぶ。表示用app copyはFact-passedだけを返し、emergencyは元見出しが日本語でも独立したFact check済みcopyを要求する。
- category_labels: list/detailの両方に16カテゴリの日本語チップを追加（地政学、災害、金融政策、為替、金利、原油・エネルギー、コモディティ、海運・物流、半導体、AI・テック、米国市場、日本市場、政策・規制、企業、決算、金融システム）。
- severity_labels: `emergency=緊急`, `critical=最重要`, `high=重要`, `medium=注目`。

## Notification policy

- current_notification_logic: companyはX publish後の個別producer、market criticalは既存market producerが対象判定し、dispatcher/claim RPCが配信直前に `push_enabled` / `important_news` / `market_critical_news` を再確認する。
- proposed_or_implemented_presets:
  - `quiet / 静かめ`: company critical以上、market emergencyのみ。
  - `standard / 標準`: company high以上、market critical以上。
  - `many / 多め`: company medium以上、market high以上。
  - `all_useful / かなり多め`: company/marketともmedium以上。
  - lowは全プリセットでPushしない。
- legacy_settings_compatibility: 既存行はmigration時に新2列をNULLのまま残す。producer上のNULL presetは既存company相当のstandard、NULL emergencyはOFF。既存 `market_critical_news` はdispatcher互換ゲートとして維持し、保存RPCが同一トランザクションで同期する。UIは既存rowのmarket=trueをstandard、falseをquietとして表示する。既存false rowは保存するまでcompany thresholdが従来どおりstandardで、保存後に明示したquietへ移行する。新規rowだけstandard/emergency ONがdefault。
- emergency_behavior: Fact-passed日本語copy、freshness、exact/cross-source event dedupe、push_enabled、important_news、emergency_alertsを必須化。market emergencyはtracked stock/sector一致不要で、通知行の `tracked_stock_id` もNULL。
- category_setting_behavior: `alert_category_settings(user_id, category, enabled)` の行形式。RLSは本人のみ。設定行なし・候補カテゴリなしは有効扱い。複数カテゴリ候補は1つでもONなら対象。

## Database / producer

- schema_changes: `alert_settings.notification_preset` / `emergency_alerts` を既存行safeなnullable追加（新規rowのみdefault）。owner-only RLS付き `alert_category_settings`、atomic保存RPC、NULL-stock market通知のpartial unique index、更新版app-copy selector/feed RPC、service-role専用統一producer RPCを追加するmigrationを作成。
- producer_changes: `important-news-monitor` の実runでapp copy完了後、およびpublish成功後に統一producer RPCを呼ぶ。eligibilityはSQL producerが決定し、既存notifications queueへだけenqueue。dry-runでは呼ばない。
- dispatcher_changes: none。`send-push-notifications` と `claim_pending_push_notifications` は変更なし。

## Read-only production estimate (2026-09-13 JST)

- 7day_notification_volume_estimate:
  - 母数: profiles 1、alert_settings 1、Push/important_news有効1、market_critical_news有効1、tracked user 1、Push token user 1。
  - 現在の実ユーザー・実候補へFact-passed日本語/対象条件を当てた見込み: quiet 0、standard 1、many 3、all_useful 3。
  - 7日窓ではcompany対象0、market対象はstandard 1 / many 3 / all_useful 3。
  - 実送信、candidate注入、settings変更はしていない。
- medium_feed_volume_estimate: effective severityはemergency 0、critical 1、high 7、medium 8、low 40。現行critical/high相当8件からmedium以上16件へ最大+8件の見込み。
- emergency_false_positive_review: 7日窓のemergency候補0件。誤検出0件で誤検出クラスなし。ただし実例母数0のため自然データ監視が必要。

## Tests

- important-news-monitor全runtime suite: 395 passed / 0 failed。
- dispatcher + personalized report regression: 48 passed / 0 failed。
- app presentation/label tests: 27 passed / 0 failed。
- 変更Expoアプリファイル限定TypeScript strict check: pass。
- iOS Expo export: pass（1,638 modules、Hermes bundle 4.3 MB）。
- `git diff --check`: pass。
- `deno check supabase/functions/important-news-monitor/index.ts`: 変更外の既知エラー `supabase/functions/_shared/x_oauth2_post.ts:66`（Uint8Array/BufferSource型差）で停止。変更ファイル由来の新規エラーは検出されていない。
- migrationはC1前の本番適用禁止を守り、PostgreSQL実行パーサでは未実行。静的契約テストとproduction schema read-only監査まで。

## Production / deployment

- production_changes: 0件。DB row/schema/RPC/user settings、Push、candidate、Cron、X、secretを変更していない。
- deploy_status: 未deploy。C1承認待ち。
- production_read_only_audit: schema/RLS/grants/RPC、migration履歴乖離、直近7日候補と現在audienceだけをread-only確認。通常の `supabase db push` / `--include-all` は未使用。

## Changed files

- `docs/news-coverage/REDESIGN.md`
- `src/app/news/[id].tsx`
- `src/app/news/index.tsx`
- `src/components/important-news-alert-settings.tsx`
- `src/lib/alert-settings.ts`
- `src/lib/important-news.ts`
- `src/lib/news-labels.ts`
- `supabase/functions/important-news-monitor/app_copy_logic.ts`
- `supabase/functions/important-news-monitor/app_copy_logic_test.ts`
- `supabase/functions/important-news-monitor/index.ts`
- `supabase/functions/important-news-monitor/market_critical_sql_static_test.ts`
- `supabase/functions/important-news-monitor/news_coverage_logic.ts`
- `supabase/functions/important-news-monitor/news_coverage_logic_test.ts`
- `supabase/functions/important-news-monitor/news_coverage_wiring_test.ts`
- `supabase/functions/important-news-monitor/notification_presets_sql_static_test.ts`
- `supabase/migrations/20260913140000_broad_news_visibility_notification_presets.sql`
- `tests/app/news-labels_test.ts`

## Remaining issues

- iOS simulator/Development Buildの実画面操作は未実施。未適用schema/RPCへ接続すると設定画面が失敗するため、C1後にexact migration適用とFunction deployを行ってから確認する。
- 新migrationの本番SQL実行、Function deploy、自然Cronでのenqueue/Push到達は未実施。
- 7日窓にemergency実例がなく、false-positive評価は自然候補で継続が必要。
- repository全体のtyped Deno suiteには上記の変更外型エラーがある。runtime suiteは全通過。

## Safety checks

- isolated clean worktreeを使用し、元worktreeの未コミット変更へ未接触。
- 最新 `origin/main` へrebase済み。競合なし。
- dispatcher/claim RPC、他Edge Function、他migration、Cron、X投稿、secrets、OAuth、他post_typeは変更なし。
- service roleはproducer RPCだけ。アプリはauthenticated/RLS経路だけを使用。
- synthetic/manual Push 0、synthetic candidate 0、production write 0。

## Push

- push: implementation commit `f7c17b915c551ba81b1dfc62a0731fd3eba6f008` と本completion control情報を `origin/main` / `origin/codex/broad-news-presets-phase3-20260913` へfast-forward同期済み。

## Next recommendation

`C1` でmigration SQL、legacy互換、通知量試算、app UI、producer境界をレビューする。承認後も一括db pushは使わず、exact migration適用 → 関数/ACL/RLS read-back → `important-news-monitor` のみdeploy → iOS Simulator/Development Build → 自然Cron監視の順で進める。

---

## Previous report — kabumori-x-oauth-recovery-20260913

- task_id: kabumori-x-oauth-recovery-20260913
- result: review_required — Kabumori本人OAuth再認証、暗号化token置換、refresh-only proof、本番read-backまで完了
- next_owner: chatgpt
- implementation_branch: `codex/kabumori-x-oauth-recovery-20260913`
- commit_hashes: `ed4c8c038e88274e59460997fa75e3f4721dfbf7`, `13cb948`
- push: `origin/codex/kabumori-x-oauth-recovery-20260913` へpush済み
- production_deploy: `x-oauth-connect` v13 ACTIVE / `verify_jwt=false`; 12 runtime filesをdeploy後にread-backし完全一致
- production_migrations:
  - repo `20260912232914_add_kabumori_oauth_recovery_rpc.sql` / production history `20260912235802`
  - repo `20260913000926_correct_kabumori_x_handle.sql` / production history `20260913010947`

## Root cause

- 2026-09-13 `morning_greeting` は既存refresh tokenでX token endpointがHTTP 400を返し、`X_TOKEN_REFRESH_FAILED:400` で失敗した。
- 本番開始probeでlegacy token storeは現行 `X_CLIENT_SECRET` 由来鍵により復号可能だった。このため「client secret変更 → legacy復号失敗 → server-secret fallback」の第一仮説は否定された。
- 旧refresh失敗のX response bodyは既存実装が保存していないため、`invalid_grant` 等の厳密なsubtypeは未確定。事実として確認できる範囲では、保存済みrefresh tokenがX側で無効だった。
- 初回再認証ではDBの誤登録handle `kabumori` と実アカウントが一致せず、token保存前に `X_IDENTITY_HANDLE_MISMATCH` で安全停止した。ユーザー確認で実X handleは `yume_daka` と判明し、固定allowlist・DB row・Kabumori専用RPCを訂正した。

## Changed files

- `supabase/functions/x-oauth-connect/index.ts`
- `supabase/functions/x-oauth-connect/start_logic.ts`
- `supabase/functions/x-oauth-connect/account_config.ts`
- `supabase/functions/x-oauth-connect/legacy_token_store.ts`
- `supabase/functions/x-oauth-connect/kabumori_recovery.ts`
- `supabase/functions/x-oauth-connect/rpc_test.ts`
- `supabase/functions/x-oauth-connect/account_config_test.ts`
- `supabase/functions/x-oauth-connect/kabumori_recovery_test.ts`
- `supabase/functions/_shared/brand/oauth_connection_test.ts`
- `supabase/migrations/20260912232914_add_kabumori_oauth_recovery_rpc.sql`
- `supabase/migrations/20260913000926_correct_kabumori_x_handle.sql`

## Implementation

- OAuth開始は既存admin JWTまたはDashboard secret-keyのPOST開始専用経路のみ。
- Kabumori/AI Labを固定allowlistで分離。AI Labは既存read-only scope、dry_run、Vault保存を維持。
- KabumoriはPKCE、random state、expiry、一回限りconsume、`GET /2/users/me` のhandle照合を通過してからlegacy token storeへAES-GCM暗号化保存。
- fresh refresh tokenを即時に一度rotateし、同じ保存先から再読込・復号後に `GET /2/users/me` で同一本人を再確認。
- Kabumori専用RPC 3件は `SECURITY DEFINER`、空の `search_path`、service roleのみEXECUTE。brand/account/handleを固定し、publish設定を変更しない。
- OAuth Function runtimeにはX投稿・media upload endpointを実装していない。

## Tests

- 対象テスト: 15 passed / 0 failed。
- Supabase Edge Function全テスト: 705 passed / 0 failed。
- `deno check --config supabase/functions/x-oauth-connect/deno.json supabase/functions/x-oauth-connect/index.ts`: pass。
- `git diff --check`: pass。
- 2つのmigrationをローカルPostgresのBEGIN/ROLLBACK内で検証。handle guard、state consume、本人完了、RPC ACL、空search_pathを確認し、永続テストデータ0件。
- Supabase advisors: 今回追加した3関数はmutable search_path / anon / authenticated SECURITY DEFINER警告の対象外。既存の別オブジェクトに関する警告は本タスクで変更していない。

## Production proof

- callback: success / `connection_status=identity_verified`。
- refresh-only proof:
  - X token endpoint 2xx
  - rotated tokenを暗号化保存
  - 同じruntimeで再読込・復号成功
  - `GET /2/users/me` で `yume_daka` 本人を再確認
  - X post API 0 call
  - media upload API 0 call
- `oauth_token_store` は2026-09-13 10:15 JST頃に更新され、有効期限は同日12:15 JST頃。暗号文と16文字base64 IVのみ保存されていることをread-only確認。
- `kabumori_x`: handle=`yume_daka`、`identity_verified`、platform user id設定済み、既存publish_enabled=trueを維持、Vault token refsなし。
- OAuth stateは2回ともconsume済み、unconsumed 0。初回handle mismatchではtoken metadata不変。
- publish claimsは開始前後ともtotal 11 / published 4。最新の9/13 morning_greeting claimは従来のfailedのままで、人工retryや新規投稿は行っていない。
- `ai_salaryman_lab_x` のidentity、Vault refs、`publish_enabled=false`、brand `dry_run` は開始前後で不変。
- Cron、scheduler、`x-test-post`、他Edge Function、他ブランド、Push領域は変更なし。

## Remaining issues

- 旧refresh tokenがX側で無効になった厳密な理由は、旧400 response bodyが記録されていないため確定不能。
- 自然Cron経路での次回投稿到達はまだ発生していない。手動投稿は禁止のため実施していないが、同じrefresh・保存・復号経路はrefresh-only proofで検証済み。

## Safety checks

- 手動X投稿0件、手動candidate/scheduled row注入0件、Cron変更0件。
- AI Lab token/Vault row変更0件、live化0件、publish有効化0件。
- secret/token/code/verifier値はGit・Report・DB平文列・Function responseへ記録していない。Dashboard secret keyはPOST開始専用の組み込み操作だけで使用。
- 本番DDLは上記2migrationのみ。通常の一括db push、`--include-all`、migration history修復は未実施。

## Next recommendation

`C1` で本報告と実装branchをレビューする。次回の自然投稿でpublish到達を確認し、旧9/13 failed rowは人工再実行しない。
## Latest H1 result — Important News producer V2 + Portfolio freshness candidate (2026-09-22)

- task_id: `kabumori-important-news-producer-detail-and-portfolio-freshness-diagnosis-20260922`
- result: `review_required` — implementation candidate pushed; stop for C1. Production mutation = 0.
- source base: fresh `origin/main` `cb2536840105f1dc44bbb2e3f7757aa26b7fb8a6` (controls were synced from fresh `origin/main` `420dcb5` after the concurrent main update).
- branch/commit: `codex/kabumori-important-news-producer-detail-portfolio-20260922` / `bc5082c`; review branch: https://github.com/anohi-memories/kabumori/tree/codex/kabumori-important-news-producer-detail-portfolio-20260922

### Important News producer path and root cause

- Current path is `generate_ready` in `supabase/functions/important-news-monitor/index.ts` → service-role `important_news_app_copy_targets` → candidate row select/claim → `needsAppCopy` → one `generateAppCopy` draft call → local checks → one Fact call → `appCopyUpdate` (app_* columns only). No display-time AI, X text, publish, or push fields are written by this path.
- Read-only production evidence: North Korea `09f609d1-f0f0-48e1-9873-eadcb6d3e5e3` and UN/Houthi `e5469402-ea43-4bae-b803-1df328dcfc4c` are published with `generation_fact_status=passed`, body summaries of 283/234 characters, and all app_* fields NULL. Hormuz tanker `1cbcb1ce-0dd8-43a8-a537-3c3fc5e22887` has a 244-character source, `generation_fact_status=passed`, `status=generation_failed`, and app_* NULL.
- Shallow detail root cause is producer selection, not missing UI AI: the original selector excluded rows with Fact-passed `generated_text`, and `needsAppCopy` skipped them again. Consequently richer English `body_summary` facts never reached the app-copy producer.

### Candidate changes

- `app_copy_logic.ts`: explicit `sourceBackedCopy` exception for English-title rows, 1–2 sentence lead, 2–4 distinct key points when supported, additional source-backed detail paragraphs, and a separate market-relevance boundary. A one-item key-point payload now fails closed.
- `index.ts`: only opts into the exception when cleaned stored source text is at least 160 characters; thin sources stay on the verified-post path and are not padded.
- `20260922110000_important_news_app_copy_v2_source_backed_candidates.sql`: review-only `important_news_app_copy_targets` replacement after the Phase 5 wrapper. It adds company/market/all_useful source candidates without removing feed Fact guards and keeps service-role execution only. It is not applied.
- Fixtures cover Hormuz (two injuries, vessel continued, no closure), North Korea (450–600km and EEZ assessment), UN/Houthi (Riyadh attempt and displacement over 130,000), and a genuinely thin source. All source-backed fixtures passed and retained the additional facts in `detail_ja`; thin source failed closed with `APP_COPY_INSUFFICIENT_INFORMATION`.

### Portfolio freshness validator

- The validator is `supabase/functions/personalized-reports/report_logic.ts::latinWords`. Its original `/[A-Za-zＡ-Ｚａ-ｚ]{3,}/g` intentionally includes full-width Latin, so `ＵＦＪ` became `CONTAINS_LATIN_WORD:ＵＦＪ`.
- Production read-only row `b23f00d1-b735-4077-b1df-ee975d2fa470` (2026-09-18 close) has valid `price_basis_date=2026-09-18` but `status=failed`, `fact_status=pending`, and that local-check issue. The 2026-09-17 close is completed and Fact-passed, explaining the stale app display.
- Candidate fix allows only full-width Latin runs adjacent to Japanese script (e.g. `三菱ＵＦＪフィナンシャル・グループ`); ASCII acronyms are not added to the whitelist. Tests prove the Japanese proper name passes, ordinary English prose fails, and `UFJ銀行` remains blocked.

### 9/18 handling and architecture

- No manual regeneration/backfill was performed. After the validator fix is approved/deployed, the 9/18 close would require a one-time safe regeneration to produce a completed narrative; the valid snapshot itself is already present.
- Snapshot/narrative decoupling is not recommended in this H1. A separate freshness presentation would require product/RPC/schema semantics and may overlap G1 market-report ownership; it is documented for C1 rather than changed.

### Verification

- Targeted app-copy/report tests: **37 passed / 0 failed**.
- Important-news static suite: **19 passed / 0 failed**; full `important-news-monitor/*_test.ts`: **420 passed / 1 failed**. The sole failure is the existing cost audit fixed expectation (`expected 27377`, observed `27600`), unrelated to changed files.
- `deno check` passed for `app_copy_logic.ts` and `personalized-reports/report_logic.ts`. Full `index.ts` check is blocked by the pre-existing `_shared/x_oauth2_post.ts` `Uint8Array<ArrayBufferLike>` vs `BufferSource` error; no new changed-file error was observed.
- `git diff --check` passed. No Expo/app presentation files were touched, so no app TypeScript test was required.
- No migration apply, production DB write, RPC/RLS change, Edge deploy, Cron, secret/Vault/provider change, X/Push action, or report regeneration occurred.
## Latest H1 result — source freshen/merge attempt (2026-09-22)

- task_id: `kabumori-news-producer-portfolio-freshness-source-merge-20260922`
- pre-freshen main: `3de9881` (latest main at startup); main advanced to `3346de4` with an unrelated H2 index update before control synchronization.
- freshened feature head: `f5978b1` (candidate `bc5082c` cherry-picked onto the latest main used for the merge attempt).
- approved files: exactly the seven files listed in the TASK; no H2/G1/G2 files changed.
- verification: targeted app-copy/report/static tests **46 passed / 0 failed**; changed-file Deno checks passed; full Important News suite **420 passed / 1 unrelated fixed-expectation failure** (`cost_path_audit_test.ts`, observed 27600 vs expected 27377); `git diff --check` passed.
- PR: [#8](https://github.com/anohi-memories/kabumori/pull/8), open and mergeable at creation.
- merge result: not merged. Required Vercel check failed because the deployment is rate-limited for 24 hours. Admin/branch-protection bypass was not attempted; normal merge was blocked by the failing required check.
- Important News producer V2 and Portfolio validator candidate remain intact on the freshen branch. No production migration, Function deploy, report regeneration/backfill, or other production mutation occurred.
- next action: after the required check becomes available, re-run the PR check and merge PR #8, then read back the resulting main SHA and the seven approved files. Production rollout remains a later Sol checkpoint: exact migration apply, `important-news-monitor` deploy, `personalized-reports` deploy, and a safe one-time 9/18 close regeneration/backfill decision are still required and were not performed here.
