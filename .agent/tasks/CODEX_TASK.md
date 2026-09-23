# Codex Task

- task_id: kabumori-important-news-full-gpt6-model-unification-20260923
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Luna
- purpose: PR #8 merge後のImportant News monitoring pipelineに残るGPT-5.6 model参照を公式GPT-6系へ統一するsource candidateを作る。production deployは行わない。

## H1 stop report — schema constraint blocker (2026-09-23)

- result: `review_required`; stopped exactly at the task's migration-required checkpoint.
- blocker: two existing source migrations restrict persisted model metadata to GPT-5.6 IDs. `supabase/migrations/20260830120000_add_important_news_ai_judgement.sql:19-20` limits `judgement_model` to `gpt-5.6-luna` / `gpt-5.6-sol`; `supabase/migrations/20260830130000_add_important_news_post_generation.sql:12-14` applies the same restriction to `generation_model`. The live source writes `final.model` and `generated.model` to these columns (`index.ts:710,892`), so GPT-6 runtime IDs would violate the CHECK constraints. Per this TASK, no migration was created and work stopped for C1.
- official docs verified: `gpt-6-luna` and `gpt-6-sol`; standard short-context rates are Luna `$0.10` input / `$0.50` output and Sol `$2` / `$10` per 1M tokens. [GPT-6 model catalog](https://developers.openai.com/api/docs/models) and [API pricing](https://developers.openai.com/api/docs/pricing). These match expected values.
- fresh base: `origin/main` `e7a5e3c09e8a51a5e99ecdb902d6a20754f8274d`.
- local-only prototype: isolated worktree `/private/tmp/kabumori-important-news-gpt6-unification`, branch `codex/kabumori-important-news-gpt6-unification-20260923`, uncommitted and not pushed; no PR/commit. It is not production-ready until the model CHECK constraints are resolved in an approved separate schema step.
- changed locally: `supabase/functions/important-news-monitor/importance_judgement_logic.ts`, `importance_judgement_logic_test.ts`, `breaking_market_source_fetchers.ts`, `post_generation_logic.ts`, `post_generation_logic_test.ts`, `generation_dispatch_logic_test.ts`, `usage_ledger.ts`, `usage_ledger_test.ts`, `cost_path_audit_test.ts`, `index.ts`.
- pre-inventory: active judgement used GPT-5.6 Luna and escalation GPT-5.6 Sol; breaking-market search used GPT-5.6 Luna; post-generation draft/Fact/Voice used GPT-5.6 Luna; `index.ts` failure metadata named GPT-5.6 Luna. Judgement and ledger cost tables were Luna `$0.20/$1.20`, Sol `$4/$20` per 1M; unknown usage models fell back to GPT-5.6 Luna rates.
- local prototype routing: judgement GPT-6 Luna, unchanged escalation criteria to GPT-6 Sol; breaking search GPT-6 Luna; generation GPT-6 Luna. Reasoning effort, thresholds, search/source validation, query cadence, generation order/retry/publish gates were unchanged. All active monitor runtime entrypoints contain no GPT-5.6 selection.
- local prototype accounting: GPT-6 Luna `$0.10/$0.50`; GPT-6 Sol `$2/$10`; unknown model fallback GPT-6 Luna. GPT-5.6 rate entries and related old-model test fixtures remain only for recomputing/forwarding historical `ai_usage_events` rows and are not selected by active runtime paths.
- tests on prototype: targeted changed-path tests **172 passed / 0 failed**; full Important News suite **423 passed / 0 failed** with `--no-check`; `deno check --no-config --no-lock` passed for the changed logic and test modules. Checking `index.ts` reaches a pre-existing TS2322 `ArrayBufferLike`/`BufferSource` error in unchanged `supabase/functions/_shared/x_oauth2_post.ts:66`. `git diff --check` passed.
- fresh inventory after prototype: `rg` shows GPT-5.6 literals only in `usage_ledger.ts` historical rates and `usage_ledger_test.ts` historical-rate/row fixtures; no active runtime selector remains. Production tree was not changed by the prototype.
- production mutation: **0**. No DB read/write, migration, Function deploy, Cron/config/secret change, report regeneration, or X/Push action.
- next decision for C1: determine whether to schedule a narrowly scoped migration to permit GPT-6 metadata IDs in both CHECK constraints, then resume/recreate the source candidate. Do not deploy this prototype as-is.

## Prior C1 decision

Previous task `kabumori-pr8-gpt6-news-portfolio-final-merge-20260923` is **PASS**.

Verified:
- PR #8 is merged and closed.
- resulting main: `cd7ad8994d6e20c752735a52b0d933e1c2bb0a16`
- Vercel status on resulting main: success.
- all 11 approved files on main match final feature head `ab593c74fe6825ffbf9ba8ef2bed004a5b92b731`.
- Important News app-copy V2, Portfolio validator fix, GPT-6 Luna app-copy, and GPT-6 Luna Personalized Reports are on main.
- Supabase production migration/deploy/backfill remains unperformed.
- production mutation = 0.

## User-requested next goal

The remaining Important News monitoring AI paths still use GPT-5.6 models. Unify the **Important News monitoring pipeline** to GPT-6 series before production rollout.

Confirmed remaining main references at the C1 baseline include:
- `importance_judgement_logic.ts`
  - `gpt-5.6-luna`
  - `gpt-5.6-sol`
- `breaking_market_source_fetchers.ts`
  - `gpt-5.6-luna`
- `post_generation_logic.ts`
  - `gpt-5.6-luna`
- `usage_ledger.ts`
  - legacy GPT-5.6 rate entries/default fallback still exist because these remaining paths still depend on them.

The already-merged app-copy and Personalized Reports paths use `gpt-6-luna` and must remain so.

## Mandatory startup

1. Read `.agent/ORCHESTRATION.md`
2. Read `.agent/CURRENT_STATE.md`
3. Read this TASK
4. Read `.agent/CODEX_REPORT.md`
5. Fresh fetch `origin/main`
6. Confirm no H2/G1/G2 file/object ownership conflict
7. Inventory **all** `gpt-5.6-luna` and `gpt-5.6-sol` references under `supabase/functions/important-news-monitor/` and classify each before editing.

## Official model/pricing verification

Before edits, verify current official OpenAI API docs for:
- GPT-6 Luna exact model ID
- GPT-6 Sol exact model ID
- current standard short-context input/output pricing for each

Expected from prior review, but must re-verify:
- Luna model: `gpt-6-luna`
- Sol model: `gpt-6-sol`
- Luna pricing: $0.10 input / $0.50 output per 1M tokens
- Sol pricing: expected $2 input / $10 output per 1M tokens

If official IDs or pricing differ, STOP for C1 instead of guessing.

## Required source changes

### A. Importance judgement
Update the monitoring judgement path:
- first-pass judgement: GPT-5.6 Luna -> GPT-6 Luna
- escalation path: GPT-5.6 Sol -> GPT-6 Sol
- preserve existing escalation policy/thresholds
- preserve reasoning effort semantics unless the official model API requires a documented compatibility adjustment
- no new Sol fallback conditions

### B. Breaking-market AI search
Update the model used by `breaking_market_source_fetchers.ts`:
- GPT-5.6 Luna -> GPT-6 Luna
- preserve web-search/source-validation behavior
- do not loosen URL/source validation
- do not change query cadence or Cron

### C. Important News post generation
Update the monitoring/X-copy generation model under `post_generation_logic.ts`:
- GPT-5.6 Luna -> GPT-6 Luna
- preserve draft/fact/voice sequence and retry behavior
- do not change publish/auto-publish gates
- no manual X post

### D. Cost accounting
Update model types/rates/defaults so:
- GPT-6 Luna calls use official GPT-6 Luna rates
- GPT-6 Sol calls use official GPT-6 Sol rates
- no active Important News path silently falls back to GPT-5.6 Luna pricing
- retain legacy 5.6 entries only if historical ledger decoding/tests genuinely require them; document why
- new active fallback/default should reflect the active GPT-6 path, not 5.6

### E. Tests
Update/add tests covering:
- judgement first pass uses GPT-6 Luna
- escalation uses GPT-6 Sol
- breaking-market search uses GPT-6 Luna
- post generation uses GPT-6 Luna
- cost estimator uses correct GPT-6 Luna/Sol rates
- no active Important News runtime path still selects GPT-5.6 models
- escalation behavior remains unchanged except model IDs

## Scope boundaries

Do not touch:
- Personalized Reports architecture beyond shared test assertions strictly required by model accounting
- app UI
- Portfolio behavior
- DB schema/migrations unless strictly required for static metadata compatibility; if a migration seems necessary, STOP for C1
- H2/G1/G2 files
- X OAuth/token handling
- Cron scheduling
- provider/source allowlists
- search query strategy
- notification policy

## Production restrictions

Forbidden in this H1:
- Supabase migration apply
- Edge Function deploy
- production DB write
- report regeneration/backfill
- Cron change
- secret/Vault/provider setting change
- manual/synthetic X post
- manual Push
- branch-protection bypass

Production mutation must remain 0.

## Verification

At minimum:
- targeted importance judgement tests PASS
- breaking-market source-fetcher tests PASS
- post-generation tests PASS
- usage-ledger/cost tests PASS
- full Important News test suite PASS, or any unrelated pre-existing failure explicitly proven unchanged
- changed-file Deno checks PASS
- `git diff --check` PASS
- fresh grep/inventory proves no active Important News runtime path still chooses `gpt-5.6-luna` or `gpt-5.6-sol`
- existing GPT-6 app-copy V2 remains intact
- production mutation = 0

## Deliverables / C1

Update `.agent/CODEX_REPORT.md` with:
1. official GPT-6 Luna/Sol IDs and pricing source checked
2. complete pre/post inventory of 5.6 references in Important News monitor
3. exact changed files
4. model routing before/after
5. cost constants before/after
6. test/check results
7. any intentionally retained legacy 5.6 constants and why
8. candidate branch/commit/PR if created
9. production mutation = 0
10. explicit note that Supabase production rollout remains a later separate checkpoint

On completion:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for C1

**推奨モデル：Luna。**
