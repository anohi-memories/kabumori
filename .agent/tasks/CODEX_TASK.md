# Codex Task

- task_id: kabumori-important-news-gpt6-schema-source-merge-20260923
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Luna
- purpose: C1 PASS済みのPR #9（GPT-6 model metadata CHECK migration candidate + Important News runtime GPT-6 unification）をlatest mainへfreshenし、再検証後mainへmergeする。production migration apply / Function deployは禁止。

## C1 decision

Previous task `kabumori-important-news-gpt6-schema-and-source-candidate-20260923` is **PASS**.

Verified at C1:
- PR #9 is open, mergeable, and required Vercel check is success.
- Candidate commit: `eefa3eabf4ddb4b07f6a300f34b0b395a4d7b691`.
- Exactly one forward migration was added:
  - `supabase/migrations/20260923035652_allow_gpt6_important_news_model_metadata.sql`
- The migration only replaces:
  - `important_news_candidates_judgement_model_check`
  - `important_news_candidates_generation_model_check`
- Allowed values after migration are:
  - `gpt-5.6-luna`
  - `gpt-5.6-sol`
  - `gpt-6-luna`
  - `gpt-6-sol`
  - NULL remains allowed.
- Production catalog read-only evidence matched the source constraint names/definitions before migration.
- No column type/nullability/RLS/grant/index/trigger/RPC/data behavior changed.
- Active Important News runtime routing on the candidate is:
  - judgement first pass -> `gpt-6-luna`
  - judgement escalation -> `gpt-6-sol`
  - breaking-market AI search -> `gpt-6-luna`
  - post draft/Fact/Voice/retries -> `gpt-6-luna`
- Active pricing:
  - GPT-6 Luna $0.10 input / $0.50 output per 1M
  - GPT-6 Sol $2 / $10 per 1M
- Unknown-model fallback now uses GPT-6 Luna rates.
- GPT-5.6 rates remain only for historical ledger recomputation/tests.
- Verification reported:
  - targeted 173 / 0
  - full Important News 424 / 0 with --no-check
  - changed logic/test deno checks passed
  - git diff --check passed
- The only index.ts typecheck blocker is the pre-existing unchanged `_shared/x_oauth2_post.ts:66` ArrayBufferLike/BufferSource issue.
- Production mutation = 0.

## Main drift review at C1

PR #9 is currently behind main by 4 commits. Main changes since candidate merge-base are control files only:
- `.agent/ACTIVE_TASK.md`
- `.agent/CODEX_REPORT.md`
- `.agent/CURRENT_STATE.md`
- `.agent/tasks/CODEX_TASK.md`
- `.agent/tasks/CODEX_TASK_2.md`

There is no overlap with the 12 PR #9 implementation/migration/test files.

## Mandatory startup

1. Read `.agent/ORCHESTRATION.md`
2. Read `.agent/CURRENT_STATE.md`
3. Read this TASK
4. Read `.agent/CODEX_REPORT.md`
5. Fresh fetch `origin/main`
6. Re-check PR #9 and current main
7. Confirm no new semantic overlap in the 12 approved PR #9 files
8. Confirm no H2/G1/G2 ownership conflict

## Freshen rules

- Rebase/freshen PR #9 onto latest main without dragging stale `.agent` control history.
- If any new semantic main change touches an approved PR #9 implementation/migration/test file, STOP for C1 instead of auto-resolving.
- Do not alter the approved migration scope.
- Do not broaden model-routing behavior.

## Verification after freshen

At minimum:
- migration static/contract test PASS
- importance judgement tests PASS
- breaking-market source-fetcher tests PASS
- post-generation/generation-dispatch tests PASS
- usage-ledger/cost tests PASS
- full Important News suite status recorded
- changed-file Deno checks PASS
- `git diff --check` PASS
- grep/inventory proves no active Important News runtime selector uses GPT-5.6
- retained GPT-5.6 literals are historical accounting/test fixtures only
- Vercel required check = success on final PR head
- production mutation = 0

## Merge

If checks pass:
- merge PR #9 to `main`
- read back resulting main SHA
- verify PR merged/closed
- verify all 12 approved files on main match the freshened candidate
- do NOT apply `20260923035652_allow_gpt6_important_news_model_metadata.sql`
- do NOT deploy `important-news-monitor`
- do NOT change Cron/config/secrets
- do NOT manually post to X or Push

## Handoff

Update `.agent/CODEX_REPORT.md` with:
1. pre-freshen main SHA
2. final PR head SHA
3. test/check results
4. Vercel result
5. merge/resulting main SHA
6. read-back proof that migration candidate + GPT-6 runtime unification are on main
7. production mutation = 0
8. explicit remaining rollout sequence:
   - exact single migration apply
   - read back both CHECK constraints
   - deploy only reviewed `important-news-monitor`
   - observe natural runtime/model metadata/cost records
   - separately handle the previously approved `personalized-reports` deploy / 9/18 close regeneration work; do not mix it into this merge

On completion:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for C1

**推奨モデル：Luna。**
