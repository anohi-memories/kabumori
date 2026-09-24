# Codex Task 2

- task_id: kabumori-pr23-close-validator-final-review-20260924
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Luna（極高）
- purpose: production v22 dry-runで発覚した大引け3/3 failureに対するPR #23を、validator安全性・文字数上限・未知原因文allowlist・回帰の観点で独立レビューする。review-onlyを基本とし、必要ならPR #23範囲の最小修正のみ。

## Incident context

Production sequence:
- v21: known-good
- v22: PR #19 implementation deployed with app_enabled=false
- morning dry-run: PASS
- close dry-run: 3/3 local validation failure
  - 1x INFERENCE_NOT_HEDGED
  - 2x IMPACT_TOO_LONG (brief total 104–136 chars vs old 100 limit)
- fail-closed: no report persistence / no notification
- production rolled back to v21 source, deployed as v23
- rollback read-back byte-identical to v21 source commit `4590ba6`
- app_enabled remains false

## Review target

PR #23
- branch: `g2-close-report-validator-fix-20260924`
- head: `5c22c71961496fc63e698e42e7c18cacc7f7cff3`
- changed source scope:
  - `supabase/functions/personalized-reports/report_logic.ts`
  - `supabase/functions/personalized-reports/report_upgrade_test.ts`
  - `supabase/functions/personalized-reports/close_validator_fix_test.ts`

## Intended fix

### Brief limits
- morning brief: 120 chars
- close brief: 160 chars
- detailed remains per-field 160 / 160 / 80

### Unknown-cause inference
Allow unhedged text only when it is narrowly an inability-to-determine statement.
Examples intended to pass:
- 明確な要因は特定できません
- 個別材料は確認できていません
- 材料との因果関係は確認できません

Still reject causal assertions without hedge:
- 円高が逆風になりました
- 半導体安が下落の原因です
- 金利上昇で売られました
- causal assertion + unknown-cause phrase appended

## Mandatory startup

1. Use independent worktree/checkout.
2. Read PROJECT_RULES.md, .agent/ORCHESTRATION.md, .agent/CURRENT_STATE.md, G2 Report, this TASK.
3. Fresh fetch origin/main and PR #23.
4. Verify PR head exactly `5c22c71961496fc63e698e42e7c18cacc7f7cff3`.
5. Confirm no overlap with G1/PR #21 and no X/admin scope.
6. Do not deploy or alter production.

## Review scope A — length policy

Verify:
- report_type actually selects the intended 120/160 limit
- combined brief length still includes fact + inference + watch
- detailed limits unchanged
- 160 close limit is enough for observed 104–136 range without turning brief entries into detailed prose
- prompt/schema/validator agree on the same limit
- exact boundary 160 pass / 161 fail
- morning remains concise and does not accidentally inherit close limit

## Review scope B — unknown-cause allowlist

Adversarially test the parser/regex.

Must pass only narrow uncertainty statements.
Try bypasses such as:
- causal claim before/after an allowed phrase
- multiple sentences with one unsafe sentence
- punctuation variants
- negation tricks
- "原因です。ただし特定できません"
- "円高を受けて下落しましたが理由は特定できません"
- allowed nouns used in unrelated sentences

Confirm checking is per sentence and one unsafe sentence rejects the whole inference.

## Review scope C — safety regression

Ensure existing checks remain:
- unsupported numeric facts
- dates/URLs
- trading advice
- unknown/duplicate/missing holdings
- unsupported basis
- direction contradiction
- Fact vs inference separation
- hedging for ordinary inference
- no_clear_material semantics

## Review scope D — production incident fidelity

Confirm fixtures genuinely represent the v22 dry-run failure modes rather than synthetic easy cases.
Check that:
- the exact unknown-cause sentence from production dry-run now passes
- 104–136 char close briefs pass
- >160 fails
- morning known-good behavior remains unchanged

## Required verification

At minimum:
- new close-validator tests
- full personalized-reports / relevant app tests
- deno check
- deno lint
- git diff --check

If feasible, run fuzz/adversarial variants around unknown-cause parsing.

## Bugfix authority

If a concrete issue is found:
- minimal fix only inside PR #23 scope
- add regression test
- push to PR #23
- do not merge
- do not deploy
- do not touch G1/X/admin/DB

## Forbidden

- production deploy
- app_enabled change
- cron/settings mutation
- DB/schema/migration
- Auth/RLS changes
- X changes
- merge PR #23

## Completion / C2

Report:
- verdict PASS / PASS-WITH-FIX / FAIL
- fresh main + PR head
- findings by severity
- final morning/close limits
- unknown-cause allowlist assessment
- adversarial bypass results
- regression/safety assessment
- exact tests/counts
- whether PR #23 is safe to merge
- whether redeploy + repeated close dry-run is recommended
- production mutation=0

When complete:
- status -> review_required
- next_owner -> chatgpt
- update .agent/CODEX_REPORT_2.md
- STOP for C2.
