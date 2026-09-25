# Codex Task 2

- task_id: kabumori-pr32-morning-fact-contract-final-review-20260925
- owner: codex
- slot: codex-2
- status: ready
- next_owner: codex
- priority: high
- recommended_model: Sol（高）
- purpose: PR #32の朝刊prompt↔Fact契約修正が、入力状態の正確なmeta-claimだけを許可し、no-news断定・unsupported intraday・因果/助言等の既存BLOCKを弱めていないことを独立最終レビューする。

## Review target

PR #32
- branch: `g2-morning-prompt-fact-contract-20260925`
- head: `749ce19f01ae191398a5b32420b657263c54dd57`
- changed:
  - `supabase/functions/personalized-reports/report_logic.ts`
  - `supabase/functions/personalized-reports/morning_contract_test.ts`

Production remains:
- personalized-reports v28
- verify_jwt=false
- app_enabled=false
- x_enabled=false
- no deploy from PR #32

## Review focus

### A. Timing contract

Confirm morning prompt no longer encourages unsupported observed-fact wording:
- 寄り付き後
- 場中
- 今日の値動きで〜

Confirm it still asks for useful watch/checkpoint content grounded in:
- prior close
- packet inputs
- supplied news/materials

Do not permit future/intraday observations that are absent from packet data.

### B. Empty-news contract

Allowed only when the packet/input news arrays are actually empty:
- 入力に個別の材料は含まれていません
- このレポートの入力には個別ニュースがありません
- 入力に明確な個別材料は含まれていません

Must remain rejected as broad world-state claims:
- 個別ニュースは確認されていません
- ニュースはありません
- 材料はありません

Confirm the allowance is conditional on packet/input emptiness and cannot be used when news is present.

### C. Fact/Safety regression

Verify no existing rejection was weakened for:
- unsupported numbers/entities/dates
- causal assertions
- unsupported impacts
- future market assertions
- buy/sell recommendations
- hallucinated fills
- shared_market contradiction
- inference inside fact_ja

### D. Scope

Confirm no changes to:
- validator regexes
- brief limits 120/160
- MIC integration
- market_detail
- shared market packet
- DB/schema/migration
- cron/settings
- X/admin/G1

## Adversarial tests

Try at least:
- news array non-empty + “入力に個別の材料は含まれていません”
- empty news + “ニュースはありません”
- empty news + “個別ニュースは確認されていません”
- “寄り付き後に上昇しています”
- “場中は強含みです”
- “今日の値動きでは買い場です”
- input-state meta-claim followed by unsupported causal assertion
- punctuation/newline variants

## Required verification

Run:
- morning_contract tests
- report_hardening
- close_validator
- full personalized-reports
- MIC context/integration tests
- related report/app suite
- deno check
- deno lint
- git diff --check

If a concrete bypass is found:
- minimal fix only on PR #32
- add regression
- push to PR #32
- do not merge/deploy

## Production safety

Read-only only:
- confirm v28
- app_enabled=false
- x_enabled=false
- cron unchanged

No production LLM/dry-run.
No deploy.
No settings/DB mutation.

## Completion / C2

Report:
- verdict PASS / PASS-WITH-FIX / FAIL
- final PR head
- exact allow/reject boundary
- adversarial results
- whether Fact semantics remain fail-closed outside the narrow meta-claim
- tests/counts
- production read-back
- production mutation=0
- recommendation for merge + controlled redeploy + morning>=3 / close>=3 dry-runs

When complete:
- status -> review_required
- next_owner -> chatgpt
- update `.agent/CODEX_REPORT_2.md`
- STOP for C2.
