# Codex Task

- task_id: kabumori-important-news-gpt6-schema-source-final-merge-20260923
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Luna
- purpose: Vercel required checkが成功したPR #9をfresh mainへ最終確認後mergeする。production migration apply / Function deployは禁止。

## C1 decision

Previous task `kabumori-important-news-gpt6-schema-source-merge-20260923` is **PASS to resume merge**.

Verified at C1:
- PR #9 remains open and mergeable.
- Current PR head: `ae78de17b2eb461b06e1674cdb045a78f7dbf620`.
- Required Vercel check on that exact head is now **success**.
- The retry commit from prior head `ebe3c588ec4edb080848d706d8ec5cf8ada42b1d` to `ae78de17b2eb461b06e1674cdb045a78f7dbf620` has **zero file changes**; it only retriggered the check.
- Main has advanced only one control/report commit since PR base `4d27304d4dce804c2ae5226fa338252e17f4560a`, touching only:
  - `.agent/ACTIVE_TASK.md`
  - `.agent/CODEX_REPORT.md`
  - `.agent/CURRENT_STATE.md`
  - `.agent/tasks/CODEX_TASK.md`
- No approved PR #9 implementation/migration/test file has main-side semantic drift.
- Previously verified candidate behavior/tests remain:
  - migration + targeted tests 173 / 0
  - full Important News 424 / 0
  - changed logic/test checks passed
  - git diff --check passed
- production mutation = 0.

## Mandatory startup

1. Read `.agent/ORCHESTRATION.md`
2. Read `.agent/CURRENT_STATE.md`
3. Read this TASK
4. Read `.agent/CODEX_REPORT.md`
5. Fresh fetch `origin/main`
6. Re-check PR #9 head/status and required checks
7. Confirm no new semantic overlap in the 12 approved files
8. Confirm H2/G1/G2 ownership remains non-conflicting

## Final merge rules

- Do not create another source change just to retrigger CI.
- If current PR head still has Vercel success and there is no semantic overlap, merge PR #9.
- No branch-protection bypass.
- If Vercel turns failing/pending again, STOP for C1.
- Do not alter the approved migration or GPT-6 routing.

## Read-back after merge

Verify:
- PR #9 is merged/closed
- resulting main SHA
- all 12 approved candidate files on main match the final PR head
- active Important News runtime routes:
  - judgement first pass -> `gpt-6-luna`
  - judgement escalation -> `gpt-6-sol`
  - breaking-market search -> `gpt-6-luna`
  - post draft/Fact/Voice/retries -> `gpt-6-luna`
- migration candidate is on main but **not applied**
- GPT-5.6 references in runtime area are historical ledger/test fixtures only

## Production restrictions

Still forbidden:
- applying `20260923035652_allow_gpt6_important_news_model_metadata.sql`
- Edge Function deploy
- DB write
- Cron/config/secrets change
- report regeneration/backfill
- manual X/Push

Production mutation must remain 0.

## Handoff

Update `.agent/CODEX_REPORT.md` with:
1. pre-merge main SHA
2. final PR head SHA
3. required-check result
4. merge/resulting main SHA
5. 12-file read-back result
6. active GPT-6 route confirmation
7. production mutation = 0
8. explicit remaining production rollout:
   - exact migration apply
   - read back both CHECK constraints
   - deploy reviewed `important-news-monitor`
   - natural runtime verification
   - separately handle `personalized-reports` production deploy + 9/18 close regeneration

On completion:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for C1

**推奨モデル：Luna。**


## Report

- task_id: `kabumori-important-news-gpt6-schema-source-final-merge-20260923`
- result: `review_required` — PR #9 merged after Vercel success; stop for C1.
- changed_files: PR #9's 12 approved files; this H1 additionally synced only `.agent/ACTIVE_TASK.md`, `.agent/CURRENT_STATE.md`, `.agent/tasks/CODEX_TASK.md`, and `.agent/CODEX_REPORT.md` control/report files.
- tests: reviewed candidate 173 targeted/migration tests and 424 full Important News tests passed; exact 12-file read-back matched PR head. Vercel required check passed.
- commit_hash: merge `83d994634f9b4891b8d939723939187b76bedaed` (report/control sync commits follow on main).
- push: PR #9 merged; H1 control/report sync committed to main.
- deploy: no Supabase Function deployment; no production migration applied.
- remaining_issues: exact GPT-6 metadata migration, constraint read-back, reviewed `important-news-monitor` deployment and natural-runtime verification require their separately approved next steps. Personalized Reports rollout and 9/18 close handling remain separate.
- safety_checks: no branch-protection bypass; production mutation 0; no DB write, Cron/config/secret change, X post, or Push.
- next_recommendation: C1 review this merged source result, then separately authorize the exact migration and Function deployment.
