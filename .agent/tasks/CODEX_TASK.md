# Codex Task

- task_id: kabumori-important-news-gpt6-schema-and-source-candidate-20260923
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Luna
- purpose: C1で確認したGPT-5.6-only CHECK constraint blockerを解消するため、GPT-6 model metadataを許可する狭いmigration candidateを追加し、停止していたImportant News GPT-6 source unification candidateをmain最新上で再構築する。production apply/deployは禁止。

## C1 decision

Previous task `kabumori-important-news-full-gpt6-model-unification-20260923` is **PASS on diagnosis / BLOCKED only by schema compatibility**.

Accepted findings:
- `important_news_candidates.judgement_model` currently CHECKs only `gpt-5.6-luna` / `gpt-5.6-sol`.
- `important_news_candidates.generation_model` currently CHECKs only `gpt-5.6-luna` / `gpt-5.6-sol`.
- Runtime persists GPT model IDs into those columns.
- Therefore switching active runtime selectors to GPT-6 without a schema migration would fail at write time.
- The local prototype otherwise passed:
  - targeted changed-path tests: 172 / 0
  - full Important News suite: 423 / 0 with --no-check
  - changed logic/test deno checks passed
  - git diff --check passed
- production mutation = 0.

## Goal

Create a **source-only candidate** containing both:
1. a narrow schema migration that permits GPT-6 metadata IDs while preserving historical GPT-5.6 rows, and
2. the GPT-6 runtime unification already prototyped.

Do not apply the migration or deploy any Function in this H1.

## Mandatory startup

1. Read `.agent/ORCHESTRATION.md`
2. Read `.agent/CURRENT_STATE.md`
3. Read this TASK
4. Read `.agent/CODEX_REPORT.md`
5. Fresh fetch `origin/main`
6. Confirm no H2/G1/G2 file/object ownership conflict
7. Re-read the two original migrations that define the current CHECK constraints and inspect current source writes.

## Migration candidate requirements

Create exactly one new forward migration that:
- does **not** edit historical migration files
- preserves existing GPT-5.6 values
- permits:
  - `gpt-6-luna`
  - `gpt-6-sol`
- updates only the model-ID CHECK constraints needed for:
  - `judgement_model`
  - `generation_model`
- does not alter column types, nullability, RLS, grants, indexes, triggers, RPCs, or unrelated constraints
- is idempotence-safe only to the extent normal project migration conventions require; do not add broad defensive DDL that masks schema drift
- has a static/SQL contract test proving the allowed set and scope

If production schema read-only evidence shows the live constraint names/definitions materially differ from source, STOP for C1 rather than guessing.

## Runtime source changes

Rebuild the previously tested prototype on latest main:

### Importance judgement
- first pass: `gpt-5.6-luna` -> `gpt-6-luna`
- escalation: `gpt-5.6-sol` -> `gpt-6-sol`
- preserve escalation criteria and reasoning effort

### Breaking-market AI search
- `gpt-5.6-luna` -> `gpt-6-luna`
- preserve web-search/source validation, query cadence, and source rules

### Important News post generation
- draft / Fact / Voice / retry model -> `gpt-6-luna`
- preserve retry/publish/auto-publish behavior

### Cost accounting
- active GPT-6 Luna: $0.10 input / $0.50 output per 1M
- active GPT-6 Sol: $2 input / $10 output per 1M
- unknown active-model fallback must no longer silently use GPT-5.6 Luna pricing
- retain GPT-5.6 historical rates only where needed for already-written `ai_usage_events` / historical recomputation, with tests proving they are historical-only

## Model verification

Re-verify official OpenAI docs before finalizing:
- `gpt-6-luna`
- `gpt-6-sol`
- current standard short-context pricing

If IDs/prices differ from the values above, STOP for C1.

## Verification

At minimum:
- migration static/contract test PASS
- importance judgement tests PASS
- breaking-market source-fetcher tests PASS
- post-generation tests PASS
- generation-dispatch tests PASS where model assertions changed
- usage-ledger/cost tests PASS
- full Important News suite PASS or unrelated pre-existing failure explicitly proven unchanged
- changed-file Deno checks PASS
- `git diff --check` PASS
- fresh inventory proves no **active runtime selector** under `important-news-monitor` still chooses GPT-5.6
- any retained GPT-5.6 literals are historical-accounting/test fixtures only and documented
- existing GPT-6 app-copy V2 remains intact
- production mutation = 0

## Production restrictions

Forbidden:
- migration apply
- production DB write
- Edge Function deploy
- Cron/config change
- secret/Vault/provider setting change
- report regeneration/backfill
- manual/synthetic X post
- Push
- branch-protection bypass

Read-only production schema inspection is allowed only if needed to verify current constraint definitions.

## Deliverables / C1

Update `.agent/CODEX_REPORT.md` with:
1. exact new migration filename and DDL scope
2. read-only schema evidence if queried
3. source files changed
4. active model routing before/after
5. pricing/accounting before/after
6. complete test/check results
7. inventory of any retained GPT-5.6 literals and justification
8. branch/commit/PR
9. production mutation = 0
10. explicit next production rollout sequence, but do not execute it

On completion:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for C1

**推奨モデル：Luna。**
