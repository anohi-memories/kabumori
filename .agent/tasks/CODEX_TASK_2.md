# Codex Task 2

- task_id: x-news-generation-failure-hardening-20260916
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Luna first; switch to Sol High only if the cost-path or safety design becomes ambiguous
- purpose: Complete the C2 follow-up for important-news API cost reduction without weakening Fact/Voice safety or narrowing broad collection.

## C2 review state — 2026-09-16

Implementation commit `44ffe59d29e666ce158efc3445efbf7b4b2985c5` is real, pushed, and locally well-tested. It safely reduces payload sent to Voice and adds a draft constraint against unsupported market forecasts. The current report sync is fixed.

C2 is not yet PASS because the cost-reduction requirement was measured only on the X post-generation path (`draft -> fact -> voice`). The production audit that motivated this task showed `important_news_candidates` consumed roughly 3.16M input tokens over 14 days, and the original TASK required auditing the broader important-news AI call path: importance judgement, coverage/severity/category classification, app/Japanese copy, X generation, Fact/Voice/retries, and any web-search-enabled model calls.

The reported 32.7% reduction is valid for the synthetic large-body X-generation fixture, but it is not yet evidence of a 30% reduction for the overall important-news workload or actual billing driver. Do not describe the whole important-news system as 32.7% cheaper yet.

## Required follow-up

1. Fresh-check `origin/main`, ORCHESTRATION, CURRENT_STATE, H1 boundaries, this TASK, and current `CODEX_REPORT_2.md`.
2. Do not redo or revert implementation commit `44ffe59d29e666ce158efc3445efbf7b4b2985c5` unless a concrete regression is found.
3. Audit the full important-news AI path in code and report, at minimum:
   - candidate importance/judgement
   - coverage/severity/category classification
   - app/Japanese copy generation and Fact check
   - X draft / Fact / Voice / correction retries
   - web-search-enabled OpenAI stages, if any
4. For each stage record: model, eligibility frequency, approximate call count per candidate/event, major input fields, retry conditions, and whether the same article body/metadata is resent.
5. Using local fixtures/mocks only, estimate before/after token or serialized-input cost on a representative mixed workload, not only a 4,000-repeat stress body. Use several realistic body sizes/source types if possible. Report separately:
   - X-generation reduction
   - estimated whole important-news-path reduction
   - which stages dominate remaining cost
6. If a clearly safe additional reduction exists inside `important-news-monitor` (duplicate payload removal, stage-specific packets, deterministic prefilter after collection, or unnecessary AI call avoidance), implement the minimum scoped change and test it. Do not narrow collection or weaken coverage/emergency/app visibility/notification semantics.
7. Preserve Fact/Voice fail-closed behavior. Do not remove final independent checks merely to save tokens.
8. If the full audit shows the largest remaining cost is outside the X-generation code changed here, report that plainly rather than forcing a risky 30% target.

## Required verification

- Existing important-news generation/fact/voice regression tests
- Coverage/category/emergency/dedupe/app-copy/notification eligibility regressions relevant to any changed path
- New cost-path fixture(s) for representative mixed workloads
- `deno check` for changed modules
- `git diff --check`

## Production boundary

Still prohibited in this follow-up:
- production deploy
- production DB/schema/RPC/migration/settings/Cron writes
- manual/synthetic X post or Push
- paid/manual OpenAI execution
- `x-test-post`, AI Lab/OAuth/Vault, `personalized-reports`, morning-greeting workflow/script changes
- `supabase db push`

Production read-only audit is allowed. Do not expose secrets or raw private data.

## Completion

When complete:
- push implementation/report safely after fresh-check
- place the current task report at the top of `.agent/CODEX_REPORT_2.md`
- include implementation commit(s), tests, no-deploy statement, full AI call-path audit, representative before/after measurements, whole-path estimated reduction, safety checks, and remaining issues
- set this TASK to `review_required`, `next_owner: chatgpt`
- read back origin/main and confirm the report/task are visible before stopping for C2
