# Claude Task 2

- task_id: kabumori-close-unknown-cause-prefix-fix-20260924
- owner: claude
- slot: claude-2
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（極高）
- purpose: production v24 dry-runで確認した「妥当な原因不明文の誤拒否」を、validatorの安全性を維持したまま最小修正する。source/test/PRまで。deploy禁止。

## Incident evidence

PR #23はmerge済み:
- reviewed head: `47d8c7830ed08b087b2dff7bbe7cc8c0f4cc382f`
- merge SHA: `5df9512b43c885fff28b625d089eda249320b3c3`

Production v24 dry-run:
- close #1 FAIL: `下落の要因は特定できません。`
- close #2 FAIL: `当日の下落要因は特定できません。`
- close #3 PASS: `要因は特定できません。`
- morning PASS
- IMPACT_TOO_LONGは解消済み
- unsafe causal assertionは観測されず
- no persistence / no notification

Rollback:
- production v25 = known-good v21 source `4590ba6`
- verify_jwt=false
- app_enabled=false
- cron unchanged

## Goal

`UNDETERMINED_ONLY` / equivalent validator ruleを、実際の妥当な日本語だけ通すよう狭く拡張する。

Allow examples:
- 要因は特定できません
- 下落の要因は特定できません
- 当日の下落要因は特定できません
- 上昇の理由は判断できません
- 値動きの原因は確認できません
- 当日の変動要因は説明できません

Still reject:
- 円高が逆風になりましたが、要因は特定できません
- 円高を受けて下落しましたが理由は特定できません
- 金利上昇が原因です。ただし要因は特定できません
- causal assertion + hedge token laundering
- unrelated sentence containing allowed noun

## Implementation guidance

Prefer a narrow optional subject prefix such as:
- optional `当日の`
- optional movement noun: `下落|上昇|値動き|変動`
- optional `の`

Then require:
- unknown target noun: 要因/原因/理由/材料/因果関係/影響/背景
- cannot-determine verb phrase
- whole-sentence anchored match

Do NOT broaden to arbitrary free text.
Keep CAUSAL_ASSERTION rejection before unknown-cause acceptance.
Keep sentence-by-sentence validation.

## Mandatory startup

1. Independent worktree.
2. Read PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / this TASK / prior G2 Report / H2 C2 report.
3. Fresh fetch origin/main.
4. Confirm main contains PR #23 merge `5df9512`.
5. Confirm production remains v25 known-good and app_enabled=false by read-only check only.
6. No deploy in this task.

## Tests

Add regression fixtures for the exact two production failures:
- `下落の要因は特定できません。` => PASS
- `当日の下落要因は特定できません。` => PASS

Also test:
- 上昇の理由は判断できません => PASS
- 値動きの原因は確認できません => PASS
- causal + unknown clause => FAIL
- same-sentence hedge laundering => FAIL
- punctuation/newline multi-sentence unsafe case => FAIL
- unrelated allowed noun => FAIL
- existing production wording => PASS
- morning120 / close160 boundaries unchanged

Run:
- close-validator tests
- full personalized-reports suite
- deno check
- deno lint
- git diff --check

## Scope

May change only:
- `supabase/functions/personalized-reports/report_logic.ts`
- related personalized-reports validator tests

Do not change prompt/limits unless test evidence proves necessary.
Do not change market_detail, DB, schema, cron, Auth, X, G1 files.

## Forbidden

- Edge deploy
- app_enabled change
- cron/settings mutation
- DB/schema/migration
- merge before K2
- production LLM invocation

## Completion / K2

Create a new PR.
Report:
- root cause
- exact regex/parser change
- exact allow/reject examples
- tests/counts
- PR number/head
- production state read-back
- production mutation=0
- recommendation for H2 review + later redeploy dry-run

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K2.
