# Codex Task

- task_id: kabumori-news-producer-portfolio-freshness-source-merge-20260922
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: high
- recommended_model: Luna
- purpose: C1 PASS済みの Important News producer V2 + Portfolio validator source candidate をlatest mainへfreshenし、再検証後mainへmergeする。production deploy/migration/backfillは行わない。

## Approved candidate

Branch:
- `codex/kabumori-important-news-producer-detail-portfolio-20260922`
- candidate commit: `bc5082c`

Approved changed files:
- `supabase/functions/important-news-monitor/app_copy_logic.ts`
- `supabase/functions/important-news-monitor/app_copy_logic_test.ts`
- `supabase/functions/important-news-monitor/app_copy_v2_migration_static_test.ts`
- `supabase/functions/important-news-monitor/index.ts`
- `supabase/functions/personalized-reports/report_logic.ts`
- `supabase/functions/personalized-reports/report_logic_test.ts`
- `supabase/migrations/20260922110000_important_news_app_copy_v2_source_backed_candidates.sql`

## Accepted behavior

### Important News
- Rich source-backed English-title rows may receive independent Fact-checked app copy even when a short Fact-passed generated post exists.
- Thin source rows remain on the existing path and are not padded.
- app copy semantic roles:
  - title = concise headline
  - summary = short lead
  - key points = 2–4 distinct facts when supported
  - detail = additional source-backed event facts/context
  - generic market-impact filler excluded from detail
- No display-time AI.
- No X/push publish behavior change in this source merge.

### Portfolio report validator
- Full-width Latin runs embedded in Japanese company/proper-name context are not treated as untranslated English.
- `三菱ＵＦＪフィナンシャル・グループ` passes.
- ASCII `UFJ銀行` remains blocked.
- ordinary English prose remains blocked.
- Existing explicit allowed Latin terms remain unchanged.

## Mandatory startup

1. Read `.agent/ORCHESTRATION.md`
2. Read `.agent/CURRENT_STATE.md`
3. Read this TASK
4. Read `.agent/CODEX_REPORT.md`
5. Fresh fetch `origin/main`
6. Compare candidate base/current main for overlap in the seven approved files.
7. Confirm no active H2/G1/G2 ownership conflict.

## Freshen rules

- Rebase/freshen the approved branch onto latest `origin/main`.
- Do not drag stale `.agent` history.
- At C1, candidate base -> current main had no overlap in the seven approved files.
- If a genuinely new semantic edit appears in any approved file after this task was written, STOP for C1.

## Verification

Minimum:
- targeted app-copy/report tests PASS
- important-news static tests PASS
- full important-news suite; unrelated existing fixed-expectation failure may remain only if unchanged and proven unrelated
- changed-file Deno checks PASS
- `git diff --check` PASS
- verify migration is still not applied
- verify no Edge Function deploy
- verify no report regeneration/backfill
- production mutation = 0
- H2/G1/G2 untouched

## Merge

If checks pass:
- create/update PR if needed
- merge source candidate to `main`
- read back resulting main SHA
- verify merged/closed state
- verify the seven approved files on main match the freshened candidate
- do NOT apply migration or deploy either Function
- do NOT regenerate 9/18 report

## Handoff

Update `.agent/CODEX_REPORT.md` with:
1. pre-freshen main SHA
2. final feature head
3. verification results
4. PR + merge/resulting main SHA
5. Important News producer V2 preserved
6. Portfolio validator fix preserved
7. production mutation 0
8. explicit next production requirements:
   - exact migration apply
   - `important-news-monitor` deploy
   - `personalized-reports` deploy
   - safe one-time 9/18 close regeneration/backfill decision
9. note that production rollout is a later Sol checkpoint

On completion:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for C1

**推奨モデル：Luna。**
