# Claude Task 2

- task_id: kabumori-pr32-no-clear-material-fix-merge-dryrun-20260925
- owner: claude
- slot: claude-2
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Opus5.5（高）
- purpose: PR #32 head 722d191で発見した no_clear_material / empty fact_ja 回帰を最小修正し、同じTASK内でPR更新→再テスト→merge→controlled redeploy→朝刊/大引けdry-runまで完了する。Codexレビューはユーザー方針により後回し。activationは禁止。

## K2 finding

At PR #32 head:
- `722d191dcbe4ba4ce5cf549659493df03d35a353`

Regression:
- IMPACT_INSTRUCTIONS now allows `fact_ja=""` for no_clear_material.
- `parseReportDraft().impacts()` filters out impacts with empty fact_ja.
- missing impact then causes `MISSING_HOLDING_IMPACTS` -> report fail.
- reproduced with a probe.

Production remains safe:
- personalized-reports v28
- app_enabled=false
- x_enabled=false
- merge/deploy/dry-run from the previous task did not occur
- production mutation from previous task = 0

## Chosen fix

Use **prompt-level per-holding input-state fact**, not parser widening.

For a holding with no usable material:
- keep the impact row
- keep `stance=no_clear_material`
- keep `fact_ja` non-empty
- wording must be scoped to that holding's own input only

Preferred example:
- 「この銘柄の入力には個別材料が含まれていません」

Do NOT use global packet-wide emptiness wording for a single holding.

This avoids changing parser/validator semantics and keeps existing required impact rows intact.

## Required source change

### A. no_clear_material fact_ja

Update prompt so:
- if the specific holding has no usable `own_news` / `related_market_news`, use a holding-scoped input-state fact
- do not leave fact_ja empty
- do not claim there is no news globally
- do not claim packet-wide emptiness unless packet-wide condition is truly met

### B. Fact checker

Add only the minimum precise allowance needed for the holding-scoped input-state statement.

It must be valid only when that holding's own_news and related_market_news are empty / provide no usable individual material.

Keep rejected:
- global no-news claims
- false holding-empty claim when that holding has news
- unsupported causal assertion
- unsupported intraday/future claim
- buy/sell recommendation
- fabricated data

### C. Regression tests

Must add deterministic regression proving:
1. no_clear_material impact with no usable holding news retains non-empty fact_ja
2. parseReportDraft keeps all holding impacts
3. no `MISSING_HOLDING_IMPACTS`
4. mixed-news packet:
   - holding A with news cannot claim no material
   - holding B without news can use holding-scoped input-state wording
5. global empty-input meta-claim still only allowed when packet-wide news is empty
6. broad world-state claims still fail
7. morning intraday claims still fail
8. close validator behavior unchanged
9. limits remain 120 / 160

## Scope

Prefer only:
- `supabase/functions/personalized-reports/report_logic.ts`
- `morning_contract_test.ts`
- a narrowly scoped new regression test only if necessary

Do not change:
- parser semantics unless this prompt-level fix proves impossible
- validator regexes
- MIC
- market_detail
- shared packet
- DB/schema/migration
- cron
- app_enabled/x_enabled
- X/admin/G1

If prompt-level fix is impossible without parser change, STOP and report before changing parser.

## Workflow

### Step 1 — source fix on PR #32

Work on current PR #32 branch/head lineage.
Do not create a competing PR.

Run:
- focused new regression
- morning_contract
- report_hardening
- close_validator
- full personalized-reports
- MIC context/integration
- related report/app suite
- deno check
- deno lint
- git diff --check

If any deterministic regression remains, STOP.

### Step 2 — update PR #32

Push the fix to the existing PR #32 branch.
Record new head.

No Codex review required at this stage per reduced-review policy.
Do not claim independent review.

### Step 3 — merge

Fresh fetch main and PR.
If:
- exact expected head
- conflict-free
- no overlapping active personalized-reports workstream
then merge PR #32.

Record merge SHA.

### Step 4 — controlled deploy

Deploy only:
- `personalized-reports`

Rules:
- verify_jwt=false
- app_enabled=false
- x_enabled=false
- no cron/settings/db/auth changes
- no other Edge Function deploy

Read back deployed source/version and verify match with merged main.

### Step 5 — dry-run

Required minimum:
- morning: 3
- close: 3

Morning must pass 3/3:
- Fact PASS
- local issues 0
- all holdings have impact rows
- no MISSING_HOLDING_IMPACTS
- no global no-news false claim
- holding-scoped no-material wording only when appropriate
- no unsupported intraday wording
- no unsafe causal assertion
- no malformed/truncated output

Close must pass 3/3:
- Fact PASS
- local issues 0
- no false INFERENCE_NOT_HEDGED
- no factual lead regression
- no unsafe causal assertion
- no malformed/truncated output

All dry-runs:
- reportId=null
- notification=not_attempted
- no persistence
- app_enabled=false
- x_enabled=false

## Review policy

Per user decision:
- do not create a new H1/H2 review after this low-scope prompt/Fact contract fix
- preserve existing deferred H2 history
- final high-risk/release review can be bundled later if needed

## Activation gate

**DO NOT set app_enabled=true.**

Even if all dry-runs pass:
- leave app_enabled=false
- report technical readiness only
- activation is a later ChatGPT/user decision

## Voice policy

Do not implement PASS/WARN/BLOCK in this task.

## Completion / K2

Report:
- root cause confirmation
- exact fix
- new PR #32 head
- all tests/counts
- merge SHA
- deployed version
- source read-back
- morning 3+ results
- close 3+ results
- impact completeness
- app_enabled/x_enabled before/after
- persistence/notification safety
- rollback status
- production mutations
- remaining review debt / activation gate
- whether report generation is technically stable enough to proceed to next phase

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K2.
