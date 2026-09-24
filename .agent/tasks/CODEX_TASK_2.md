# Codex Task 2

- task_id: kabumori-pr26-unknown-cause-prefix-final-review-20260925
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Luna（高）
- purpose: PR #26のunknown-cause prefix拡張が、productionで観測した妥当文だけを通し、因果断定や自由文を新たに許可していないことを独立レビューする。

## Review target

PR #26
- branch: `g2-close-unknown-cause-prefix-20260924`
- head: `2b40a617e34c73c301e40a17692883ac70fd3e0a`
- changed files:
  - `supabase/functions/personalized-reports/report_logic.ts`
  - `supabase/functions/personalized-reports/close_validator_fix_test.ts`

Production remains:
- v25 = known-good v21 source `4590ba6`
- app_enabled=false
- verify_jwt=false
- no deploy in PR #26 work

## Intended behavior

Must PASS:
- 下落の要因は特定できません
- 当日の下落要因は特定できません
- 要因は特定できません
- 上昇の理由は判断できません
- 値動きの原因は確認できません
- 当日の変動要因は説明できません
- 因果関係は確認できません

Must FAIL:
- 円高が逆風になりましたが、要因は特定できません
- 円高を受けて下落しましたが理由は特定できません
- 金利上昇が原因です。ただし要因は特定できません
- causal assertion + hedge token laundering
- unrelated free-text subjects
- allowed noun used in a factual causal assertion
- unsafe multi-sentence variants

## Mandatory startup

1. Independent worktree/checkout.
2. Read PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / this TASK / G2 Report.
3. Fresh fetch origin/main + PR #26.
4. Verify head exactly `2b40a617e34c73c301e40a17692883ac70fd3e0a`.
5. No deploy / merge / production mutation.

## Review focus

- whole-sentence anchors remain intact
- CAUSAL_ASSERTION still runs before unknown-cause acceptance
- sentence-by-sentence validation remains intact
- optional prefix is limited to:
  - optional 当日の
  - 下落|上昇|値動き|変動
  - optional の
- no arbitrary adjective/noun/causal subject can sneak in
- `因果関係` standalone target does not create bypasses
- punctuation/newline splitting still catches unsafe mixed text
- morning120 / close160 unchanged
- existing exact production wording still passes

## Adversarial cases

Try at least:
- 急な下落の要因は特定できません
- 半導体株の下落の要因は特定できません
- 円安による上昇の要因は特定できません
- 下落の要因は円高です
- 当日の下落要因は円高です
- 下落の要因は特定できませんが、円高が逆風です
- 下落の要因は特定できない可能性があります
- 要因は特定できません。円高が逆風です
- punctuation variants using 、。,.!！;；newline

## Required verification

- focused close-validator suite
- full personalized-reports suite
- deno check
- deno lint
- git diff --check

If a concrete bypass is found:
- minimal fix only in PR #26 scope
- add regression
- push to PR #26
- do not merge/deploy

## Completion / C2

Report:
- verdict PASS / PASS-WITH-FIX / FAIL
- final PR head
- findings
- exact allow/reject boundary
- adversarial results
- tests/counts
- safe-to-merge assessment
- recommendation for merge + redeploy + close dry-run 3–5 times
- production mutation=0

When complete:
- status -> review_required
- next_owner -> chatgpt
- update .agent/CODEX_REPORT_2.md
- STOP for C2.
