# Codex Task

- task_id: important-news-phase1-search-diagnostics-production-rollout-20260922
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: high
- recommended_model: Luna
- purpose: C1 PASS済みのprivacy-minimal search diagnosticsをfresh mainへ統合し、exact migrationとmatching important-news-shadow Functionを本番へ安全に適用する。その後はmanual replayなしで自然scheduled runだけを観測し、telemetryが正しく記録されることを確認する。

## Approved basis

Final C1 PASS:
- approved candidate branch: `codex/h1-search-diagnostics-aggregate-r2-20260921`
- fresh-base at review: `4a73c18b8e85856ec37eb029fdc5da04af9cbfa5`
- code candidate commit: `3dc14f454d4298cafed9ec7ad62a171868afd883`
- candidate was behind main 0 at C1.
- prior aggregate-usage blocker resolved.
- 18 Deno tests + type checks passed.
- migration is additive/nullable; RLS/grants unchanged.
- privacy boundary accepted.
- production mutation so far = 0.

## User approval

2026-09-22「おk すすめて」。

This authorizes this scoped production rollout only.

## Model policy

- **Lunaで開始・継続。**
- fresh-main integration、tests、exact migration apply、matching Function deploy、read-back、natural observationはLuna。
- Solへ上げるのは、migration/schema ownership/security/auth conflict、unexpected production drift、rollback ambiguityが実際に出た場合だけ。
- 問題が出たら勝手にrepairせずSTOP。

## Mandatory startup

1. .agent/ORCHESTRATION.md
2. .agent/CURRENT_STATE.md
3. this TASK
4. .agent/CODEX_REPORT.md
5. other 3 slot TASKs
6. fresh `origin/main`
7. approved candidate branch/commit
8. production schema read-back for:
   - public.important_news_shadow_runs
   - public.ai_usage_events
9. production important-news-shadow Function version/source hash
10. shadow Cron job 38 schedule/active/command hash
11. current migration history relevant to exact new migration

## Parallel safety

- H2/G1/G2 files/functions/tasks are out of scope.
- Do not touch social-mobile Function, market-report Function, x-test-post, personalized-reports, OAuth, X/Push/App.
- If another slot is actively mutating the **same Function/schema/migration/Cron** object, STOP.
- Existing unrelated uncommitted work must not be touched.
- Fresh-check `origin/main` immediately before push and immediately before production mutation.

## Scope A — fresh-main integration

Create a fresh H1 branch from current `origin/main`.

Integrate only the approved implementation:
- `supabase/functions/important-news-shadow/index.ts`
- `supabase/functions/important-news-shadow/search_telemetry.ts`
- `supabase/functions/important-news-shadow/search_telemetry_test.ts`
- `supabase/migrations/20260921115317_important_news_search_diagnostics.sql`

Do not blindly merge stale control-file history from the candidate branch.

Preserve exactly:
- per-run aggregate input/output tokens
- aggregate legacy `web_search_calls`
- aggregate estimated cost
- current-response-based `paidSearchUsed` latch semantics
- attempt/success/failure telemetry
- action buckets: search/open_page/find_in_page/unknown
- no raw prompt/headline/query/URL/tool-output/provider-id telemetry

Run:
- Deno tests
- deno check
- git diff --check
- verify only H1-owned implementation files + required control/report files changed

If fresh main has conflicting edits to important-news-shadow or the exact migration name/object, STOP for C1 rather than auto-resolving semantics.

## Scope B — exact migration apply

Apply **only**:
`supabase/migrations/20260921115317_important_news_search_diagnostics.sql`

Hard rules:
- **DO NOT use `supabase db push`.**
- No migration history repair/reconcile.
- No unrelated pending migration.
- No schema rewrite.
- No RLS/policy/grant change.

Preflight must prove the new columns do not already exist in an incompatible form.

After apply, read back:
- all 8 new columns on both tables
- integer type
- nullable
- non-negative CHECK constraints
- existing RLS/policies/grants unchanged from preflight

If partially present or incompatible, STOP. Do not repair automatically.

## Scope C — matching Function deploy

Only after migration read-back passes:

Deploy only `important-news-shadow` from the exact integrated source.

Preserve:
- existing verify_jwt setting
- existing X-Cron-Secret auth
- current Cron schedule
- source set
- trigger thresholds
- matcher
- MODEL
- timeout
- max_tool_calls
- search/retry behavior
- legacy fallback

No manual Function invoke is required or allowed for this rollout.

Read back:
- ACTIVE version
- source hash
- verify_jwt
- no unrelated Function source hash/update changed

## Scope D — natural scheduled observation

Use **natural Cron runs only** after deploy.

Minimum gate:
- wait for at least 3 natural scheduled shadow runs after deployment
- at least one run must prove the new telemetry columns are being written as non-NULL for an instrumented run, even if all counters are zero
- if a natural conditional search happens, verify attempt/success/failure, action counts, tokens/calls/cost consistency
- if no conditional search happens in the first 3 runs, do not force one; report zero-trigger observation and keep telemetry validation to schema/non-NULL run values

Do not inject a candidate.
Do not call OpenAI manually.
Do not alter Cron to provoke a run.

## Scope E — safety read-back

Confirm after rollout:
- Cron job 38 unchanged
- legacy important-news jobs unchanged
- important-news-monitor unchanged
- no X/Push/App action
- no candidate injection
- no fallback reduction
- no provider setting/key change
- no H2/G1/G2 production object changed

## Scope F — rollback

If Function deploy causes repeated run failure or telemetry persistence failure:
- rollback Function source to previous known-good version/source
- do **not** drop the additive nullable columns unless there is a concrete schema safety reason
- keep audit rows
- preserve Cron/fallback
- report exact reason

Do not perform rollback merely because there are no conditional searches.

## Scope G — provider reconciliation

Do not block rollout on provider billing UI access.

If a read-only provider usage path is available without new credentials/settings:
- compare only aggregated time/model buckets
- do not assume output-item count equals billable units
- do not mutate billing settings

If unavailable, record as future follow-up.

## Production mutation authorization

Approved **only**:
1. exact H1 implementation merge/integration to main
2. exact migration `20260921115317_important_news_search_diagnostics.sql`
3. matching `important-news-shadow` deploy

Not approved:
- Cron changes
- secret/Vault changes
- search trigger/policy changes
- retry-policy changes
- fallback reduction
- legacy pipeline changes
- other Functions
- X/Push/App
- MIC
- OAuth/social-mobile
- manual OpenAI replay

## Deliverables / C1

Update `.agent/CODEX_REPORT.md` with:
1. fresh main SHA and integration commit
2. exact changed files
3. tests/typecheck/diff-check
4. migration preflight/apply/postflight
5. Function old/new version + source hash
6. Cron/legacy read-back
7. 3+ natural scheduled run evidence
8. telemetry values
9. production mutations exact list
10. rollback status
11. remaining uncertainty on provider billing units
12. exact next recommendation

On completion:
- task status -> `review_required`
- next_owner -> `chatgpt`
- STOP for C1

**推奨モデル：Luna。Solは具体的なmigration/security conflictが出た時だけ。**
