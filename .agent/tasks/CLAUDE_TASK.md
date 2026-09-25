# Claude Task 2

- task_id: kabumori-report-dryrun-false-reject-hardening-20260925
- owner: claude
- slot: claude-2
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（極高）
- purpose: production v26 dry-runで残った大引けのfalse reject 2系統と朝刊Fact false positiveを、validator安全性を緩めずsource-onlyで最小修正する。deploy禁止。

## Latest K2 evidence

PR #26:
- reviewed head: `2b40a617e34c73c301e40a17692883ac70fd3e0a`
- merged: `f7498cd3a3c8be36c5c56ba19a437ba300d6f93a`

Current production:
- personalized-reports v26
- deployed by another workstream (MIC report-context integration), not by G2
- source matched then-current origin/main `4382a33`
- verify_jwt=false
- app_enabled=false
- cron unchanged

v26 dry-run:
- close: 3/5 PASS
- close failures:
  1. `値下がりの要因は特定できません。` => INFERENCE_NOT_HEDGED
  2. factual lead + unknown-cause clause, e.g. `小幅高でしたが、指数との比較では相対的に弱く、値動きの要因は特定できません。` => INFERENCE_NOT_HEDGED
- morning: 0/1, local issues 0 but Fact FAIL
- no truncation
- no IMPACT_TOO_LONG
- no unsafe causal assertion observed
- no persistence / no notification
- app_enabled remained false

## Goal

Fix only the remaining observed false-reject / false-positive classes while preserving fail-closed behavior.

### A. Unknown-cause movement vocabulary

Add only the clearly equivalent movement nouns:
- `値下がり`
- `値上がり`

to the narrow movement-prefix allowlist.

Keep:
- whole-sentence anchoring
- CAUSAL_ASSERTION-first rejection
- sentence-by-sentence validation
- no arbitrary adjective/noun prefix
- no free-text subject

Must PASS:
- 値下がりの要因は特定できません
- 当日の値下がり要因は特定できません
- 値上がりの理由は判断できません
- 当日の値上がりの原因は確認できません

Must still FAIL:
- 急な値下がりの要因は特定できません
- 半導体株の値上がり要因は特定できません
- 円安による値上がりの要因は特定できません
- 値下がりの要因は円高です
- 値上がりの理由は好決算です

### B. Close inference-field prompt hardening

Do NOT broaden the validator to accept a factual clause before an unknown-cause statement in this task.

Instead, strengthen the generation instructions so the inference field contains inference only.

The model must not write factual performance/comparison clauses such as:
- 小幅高でしたが
- 指数との比較では相対的に弱く
- 前日比で上昇しており

inside the inference field.

Facts belong in the fact field.

When causation cannot be supported, inference should be a bounded sentence such as:
- 値動きの要因は特定できません。
- 値下がりの要因は特定できません。

Do not duplicate facts from the packet merely to introduce that sentence.

Add regression tests that lock this prompt rule.

### C. Morning Fact false-positive hardening

Observed Fact FAIL treated wording such as:
- 「値動きを見守る朝刊」
- 「注意が必要」
- 「影響しやすい構成」

as recommendation / unsupported impact.

Preferred fix:
- harden the morning generation prompt/output wording
- avoid advisory-sounding phrases
- use neutral observation language, e.g. `注目点`, `確認ポイント`, `値動きを確認`
- do NOT weaken numeric/entity/factual Fact checks
- do NOT broadly relax the Fact checker

If a tiny Fact-instruction clarification is truly required, it must be narrowly justified by a regression test and must not make unsupported advice/impact claims pass.

## Mandatory startup

1. Use an independent worktree / checkout.
2. Read PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / this TASK / latest G2 report / H2 PR #26 report.
3. Fresh fetch origin/main.
4. Confirm PR #26 merge `f7498cd` is in main.
5. Inspect all later main changes touching personalized-reports, especially MIC integration.
6. Confirm changed files do not overlap another active workstream.
7. Production read-only check only.
8. No deploy.

If another active workstream is editing the same file(s), STOP and report the collision.

## Scope

Prefer changing only:
- `supabase/functions/personalized-reports/report_logic.ts`
- related personalized-reports tests

May adjust another file inside `supabase/functions/personalized-reports/` only if the morning Fact prompt/instruction actually lives there and the change is necessary.

Do not change:
- `mic_market_context.ts`
- MIC context semantics
- `market_detail.ts` unless evidence proves necessary
- `_shared/market_report_packet.ts`
- DB/schema/migration
- cron
- Auth/RLS
- X
- G1 release files
- prompt length budgets (morning 120 / close 160)

## Tests

Add exact regression coverage for:

PASS:
- 値下がりの要因は特定できません
- 当日の値下がり要因は特定できません
- 値上がりの理由は判断できません
- 当日の値上がりの原因は確認できません

FAIL:
- 急な値下がりの要因は特定できません
- 半導体株の値上がり要因は特定できません
- 円安による値上がりの要因は特定できません
- 値下がりの要因は円高です
- causal assertion + unknown-cause laundering
- factual lead clause + unsafe causal assertion
- punctuation/newline bypass variants

Prompt/output-policy tests:
- close inference prompt explicitly forbids factual lead clauses
- morning prompt avoids recommendation-like wording
- morning/close brief limits remain 120/160

Run:
- close-validator focused suite
- full personalized-reports suite
- related app/report tests if touched
- deno check
- deno lint
- git diff --check

## Forbidden

- Edge deploy
- production invoke / LLM dry-run
- app_enabled change
- cron/settings mutation
- DB/schema/migration
- MIC behavior change
- merge before K2

## Completion / K2

Create a PR and report:
- root causes separated into A/B/C
- exact source changes
- exact allow/reject boundary
- prompt wording change
- whether Fact checker itself changed; if yes, why
- tests/counts
- PR number/head
- production read-back
- production mutation=0
- overlap check with MIC/shared personalized-reports work
- recommendation for H2 review before any merge/deploy

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K2.
