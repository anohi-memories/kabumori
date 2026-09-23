# Codex Task

- task_id: kabumori-important-news-gpt6-production-rollout-20260923
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: GPT-6 Sol Medium
- purpose: C1 PASS済みのGPT-6 Important News sourceを、承認済みの単一migration適用 → constraint read-back → reviewed `important-news-monitor` deploy → 自然実行確認の順でproductionへ安全に反映する。Personalized Reportsや9/18再生成は混ぜない。

## C1 decision

Previous task `kabumori-important-news-gpt6-schema-source-final-merge-20260923` is **PASS**.

Verified:
- PR #9 is merged and closed.
- merge/resulting main: `83d994634f9b4891b8d939723939187b76bedaed`
- Vercel on resulting main: success.
- all 12 approved source/migration/test files were read back as matching the final PR head.
- source-level active routes are:
  - judgement first-pass -> `gpt-6-luna`
  - judgement escalation -> `gpt-6-sol`
  - breaking-market search -> `gpt-6-luna`
  - post draft/Fact/Voice/retries -> `gpt-6-luna`
- production migration and `important-news-monitor` deployment have **not** yet been performed.
- production mutation from prior H1 = 0.

## Mandatory startup

1. Read `.agent/ORCHESTRATION.md`
2. Read `.agent/CURRENT_STATE.md`
3. Read this TASK
4. Read `.agent/CODEX_REPORT.md`
5. Fresh fetch `origin/main`
6. Confirm main still contains the exact reviewed migration:
   - `supabase/migrations/20260923035652_allow_gpt6_important_news_model_metadata.sql`
7. Confirm no H2/G1/G2 ownership conflict on:
   - `important_news_candidates` CHECK constraints
   - `important-news-monitor` Edge Function
   - relevant Cron/config
8. Confirm current production schema read-only before mutation:
   - both CHECK constraints exist under the reviewed names
   - both still permit only GPT-5.6 IDs before apply
9. Do **not** use blind `supabase db push`, `--include-all`, migration-history repair, or broad migration application.

## Production rollout sequence

### Step 1 — exact migration apply

Apply **only**:
`20260923035652_allow_gpt6_important_news_model_metadata.sql`

No other migration may be applied.

Immediately read back both production CHECK constraints and prove:
- `important_news_candidates_judgement_model_check`
- `important_news_candidates_generation_model_check`

allow:
- NULL
- `gpt-5.6-luna`
- `gpt-5.6-sol`
- `gpt-6-luna`
- `gpt-6-sol`

and no unrelated schema/RLS/grant/index/trigger/RPC change occurred.

If exact apply or read-back is ambiguous, STOP for C1 before Function deploy.

### Step 2 — deploy reviewed Function only

Deploy only:
- `supabase/functions/important-news-monitor`

Use exact source from current reviewed main. Do not edit source during rollout.

Read back deployed Function metadata/version/source hash if supported and verify it corresponds to reviewed source.

Do not deploy:
- `personalized-reports`
- `important-news-shadow`
- `x-test-post`
- any social-mobile Function
- any other Function.

### Step 3 — natural runtime verification

Do not manually inject a candidate and do not manually post to X.

Observe natural scheduled/runtime activity after deploy and verify, when a qualifying model call naturally occurs:
- stored judgement/generation model metadata accepts GPT-6 IDs without constraint error
- usage records use GPT-6 model IDs/rates
- no new `CHECK constraint` / model-ID persistence error
- no unexpected increase in failure state attributable to the rollout

If no qualifying candidate occurs in the bounded observation window, report that explicitly; do not manufacture traffic.

## Safety restrictions

Do not change:
- Cron schedule
- provider/source allowlists
- search cadence/query strategy
- secrets/Vault/provider credentials
- publish/auto-publish gates
- X OAuth
- Push
- app UI
- Portfolio
- Personalized Reports
- 9/18 close report
- Vercel/Netlify settings

No manual/synthetic X post or Push.

## Verification

Record:
- preflight production constraint definitions
- exact migration application result
- postflight constraint definitions
- Edge Function before/after version/hash where available
- source-to-deployed read-back evidence where available
- natural runtime observation result
- any errors
- exact production mutations performed

## Stop conditions

STOP immediately for C1 if:
- production constraint names/definitions differ materially from reviewed assumptions
- exact single-migration apply cannot be guaranteed
- migration applies but read-back differs from expected
- Function source cannot be matched to reviewed main
- another workstream owns the same DB constraints/Function/config
- deploy creates unexpected regression/error

## Handoff

Update `.agent/CODEX_REPORT.md` with:
1. preflight schema evidence
2. exact migration apply method/result
3. postflight schema evidence
4. Function before/after metadata/hash
5. natural runtime verification result
6. any observed GPT-6 metadata/cost row evidence
7. production mutations, explicitly enumerated
8. anything still unverified
9. confirmation that Personalized Reports and 9/18 regeneration were untouched
10. recommendation for C1

On completion:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for C1

**推奨モデル：GPT-6 Sol Medium。**



## Report

- task_id: `kabumori-important-news-gpt6-production-rollout-20260923`
- result: `review_required` — exact approved migration applied and read back; reviewed Function deployment rejected by approval guard.
- changed_files: production change is only the reviewed CHECK-constraint migration; controls/report updated on main.
- tests: source candidate's prior 173 targeted/migration and 424 full-suite passes carried forward; no production runtime tests because Function is not deployed.
- commit_hash: production main source `83d994634f9b4891b8d939723939187b76bedaed`; completion control/report commits follow on main.
- push: completion controls synced to main.
- deploy: no Edge Function deployed. Existing `important-news-monitor` remains ACTIVE v61, `verify_jwt=false`, source hash unchanged.
- remaining_issues: Supabase migration history recorded `20260923084819_allow_gpt6_important_news_model_metadata`, while repo filename is `20260923035652_...`; no repair attempted. Need explicit user approval for Function deploy and direction on the history-version discrepancy.
- safety_checks: no alternate deployment path, no branch/migration-history repair, no other DDL/RLS/grant/config/Cron/secrets/X/Push changes.
- next_recommendation: C1 review postflight and authorize next action explicitly.
