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
- result: `review_required` — stopped before production mutation because the exact migration apply was rejected by the authorization gate.
- changed_files: no implementation files; control/report sync only.
- tests: no tests rerun; reviewed candidate remains 173 targeted/migration and 424 full-suite passes. Read-only post-rejection schema/history checks confirm unchanged production state.
- commit_hash: control/report commits on main after source main `c59058c3ba41218cf490f16b96bf4cb130e6ef8c`.
- push: completion controls synced to origin/main.
- deploy: none. `important-news-monitor` not deployed.
- remaining_issues: need explicit user approval for the exact production migration before continuing; then read back constraints and separately continue the reviewed Function deploy/natural verification sequence.
- safety_checks: rejected migration was not retried through another path. No DB/Function/Cron/config/secrets/X/Push mutation.
- next_recommendation: request exact migration approval; stop for C1.
