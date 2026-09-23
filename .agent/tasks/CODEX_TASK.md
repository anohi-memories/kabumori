# Codex Task

- task_id: kabumori-gpt6-luna-model-upgrade-on-pr8-20260923
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Luna
- purpose: open PR #8の同一workstream上で、ニュースapp copy生成・Factチェック・personalized reportsのOpenAI modelをGPT-6 Lunaへ更新し、関連テスト/コスト定数を追従させる。required Vercel checkは迂回せず、production deploy/migration/backfillは行わない。

## Current PR / blocker

- PR #8 is open and not merged.
- PR head before this task: `f5978b1f8d101f48206a65bc38772fb65db95de8`; updated head: `6f5b184bfd7406d356f2f499342013774fec02d5`.
- The new required Vercel check completed successfully; the previously observed rate-limit condition is no longer blocking this head.
- Do not bypass branch protection.
- Do not create a competing implementation branch if the existing PR #8 branch can be safely updated.

## Goal

Upgrade the relevant generation/checking paths from GPT-5.6 Luna to GPT-6 Luna using the official API model identifier confirmed from current OpenAI documentation.

Targets include at minimum:
- Important News app-copy draft generation
- Important News app-copy Fact check
- personalized reports draft generation
- personalized reports Fact check
- related model-name assertions/tests
- related application-side API cost estimator constants/telemetry that currently assume GPT-5.6 Luna pricing

Expected pricing to verify against official OpenAI docs before editing:
- GPT-6 Luna input: $0.10 / 1M tokens
- GPT-6 Luna output: $0.50 / 1M tokens

Do not trust this TASK blindly for the final model id or pricing; verify current official OpenAI API docs first. If the official values differ, STOP and report the discrepancy for C1 instead of guessing.

## Mandatory startup

1. Read `.agent/ORCHESTRATION.md`
2. Read `.agent/CURRENT_STATE.md`
3. Read this TASK
4. Read `.agent/CODEX_REPORT.md`
5. Fresh fetch `origin/main`
6. Inspect PR #8 branch and confirm it is still the correct single workstream for these changes.
7. Confirm no H2/G1/G2 ownership conflict on the exact files to be edited.

## Scope rules

- Prefer updating the existing PR #8 branch so the already-approved news producer/portfolio validator work and model upgrade remain one coherent candidate.
- Do not merge while the required Vercel status is failing.
- Do not modify unrelated model uses unless they are part of Important News app-copy or personalized reports.
- If other `gpt-5.6-luna` occurrences are found, inventory them in the report and only change them if they are clearly in-scope.
- No Sol fallback in this task.
- No display-time AI.
- No provider/tool behavior change beyond the model/pricing switch.

## Production restrictions

Forbidden:
- migration apply
- production DB write
- Edge Function deploy
- Cron change
- report regeneration/backfill
- secret/Vault/provider setting changes
- X/Push behavior change
- EAS/App Store operation

Production mutation must remain 0.

## Verification

At minimum:
- targeted Important News app-copy tests PASS
- targeted personalized report tests PASS
- model-id assertions updated and PASS
- cost estimator tests updated and PASS
- full Important News relevant suite run; pre-existing unrelated failure may remain only if proven unchanged/unrelated
- changed-file Deno checks PASS
- `git diff --check` PASS
- verify PR #8 still contains the previously C1-approved Important News producer V2 + Portfolio validator behavior unchanged
- verify Vercel blocker state separately; do not interpret quota failure as code failure
- no production mutation

## Handoff

Update `.agent/CODEX_REPORT.md` with:
1. official model id and pricing source checked
2. exact changed files
3. all old/new model constants
4. all old/new cost constants
5. tests/checks
6. whether any out-of-scope `gpt-5.6-luna` usages remain and where
7. PR #8 updated head SHA
8. Vercel check status
9. production mutation = 0

On completion:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for C1

**推奨モデル：Luna。**
