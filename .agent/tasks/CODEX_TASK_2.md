# Codex Task 2

- task_id: x-autopost-phase0c-production-brand-scope-rollout-20260923
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: GPT-6 Sol Medium
- purpose: Phase0b C2 PASS後、compatibleなbrand-scoped publish-claim clientを先にproductionへdeployし、そのruntimeを確認したうえで、fresh preflight後にexact forward migrationを適用して3つのlegacy global UNIQUEを除去する。deploy/migration直前にユーザーの明示同意を必須とする。

## Required rollout order

1. fresh preflight only
2. explicit user confirmation
3. deploy compatible `x-test-post` first
4. runtime/source/hash read-back + smoke
5. fresh production schema/data/planner preflight
6. apply only exact approved forward migration
7. postflight read-back
8. no unrelated production change

Do not change this order.

## Mandatory fresh start

1. `git fetch origin main`
2. fresh `origin/main`
3. read `.agent/ORCHESTRATION.md`
4. read `.agent/CURRENT_STATE.md`
5. read this TASK
6. read latest `.agent/CODEX_REPORT_2.md`
7. inspect H1/G1/G2 for overlap
8. confirm Phase0b implementation commit and exact files are present
9. read-only production metadata refresh for `x-test-post`, the three tables/constraints/indexes, four planner RPCs, relevant Cron
10. confirm no source/history drift beyond the already-disclosed multibrand foundation issue

If another slot touches `x-test-post`, the three tables, planner RPCs, migration, Cron, or production settings, STOP.

## Gate A — read-only preflight only

Before asking for consent, confirm:

### Source
- Phase0b commit `76dfe74` or its byte-equivalent source is in fresh origin/main
- `publish_claim_logic.ts` requires nonblank brandId
- exact conflict target is `brand_id,post_type,date_jst`
- claim body writes brand_id
- complete/fail PATCH scope includes brand_id
- morning-greeting call sites pass trusted server-side brandContext.brand.id
- migration candidate path exists:
  `supabase/migrations/20260923102327_x_autopost_phase0_brand_scoped_uniqueness.sql`

### Production
- `x-test-post` current metadata/hash/source captured read-only
- three legacy global UNIQUE constraints still exist exactly:
  - posting_windows_post_type_slot_no_key
  - scheduled_posts_schedule_date_post_type_slot_no_key
  - publish_claims_post_type_date_jst_key
- three intended brand-scoped unique indexes remain valid
- brand_id is NOT NULL on all three tables
- no scoped duplicate excess
- four planner RPCs still have exact old scheduled_posts conflict target
- current Cron still points to `x-test-post`
- no unrelated production drift/overlap

No secret values, account identifiers, handles, or post bodies in report.

## Gate B — explicit confirmation immediately before production mutation

STOP and ask the user for a direct confirmation immediately before the first production mutation.

The confirmation request must clearly state that the next actions will:
- deploy the compatible brand-scoped `x-test-post` source to production first;
- verify runtime source/hash and safe smoke;
- then apply the exact reviewed migration that removes only the three legacy global UNIQUE constraints and updates only the four planner conflict targets;
- not change Cron, OAuth, Vault, account settings, publish_enabled, Netlify, or Vercel;
- not intentionally publish to X;
- stop immediately if preflight/runtime/read-back differs from expected.

A prior generic `OK`, `すすめて`, or task-start instruction does NOT count as this production-deploy/migration consent unless it is given directly in response to this exact confirmation request.

If explicit consent is absent, do not deploy and do not apply migration.

## Gate C — deploy compatible client first

After consent only:
1. deploy only `x-test-post`
2. preserve existing verify_jwt policy unless approved source metadata requires otherwise
3. no Cron change
4. no secret/config change
5. read back ACTIVE status/version/hash/source
6. byte/semantic compare deployed runtime for the changed publish-claim/morning-greeting/index files against approved origin/main
7. safe smoke that does not publish to X

If runtime/source mismatch or unsafe behavior appears, STOP. Do not apply migration.

## Gate D — fresh migration preflight

After successful Function deploy/runtime verification, re-read production:

- exact three legacy constraints still present
- exact three brand-scoped unique indexes valid
- brand_id NOT NULL
- scoped duplicates = 0
- four planner RPC definitions/security/search_path/ACL still match expected old target
- publish_claims client runtime now uses brand-scoped target
- Cron unchanged
- no overlapping production mutation since Gate A

If any mismatch, STOP. Do not apply migration.

## Gate E — exact migration apply

Apply only:
`supabase/migrations/20260923102327_x_autopost_phase0_brand_scoped_uniqueness.sql`

Requirements:
- exact bytes/hash from reviewed origin/main
- no `supabase db push`
- no migration-history repair
- no replay of old multibrand foundation migration
- no ad-hoc rewritten SQL
- one migration application only

## Gate F — postflight

Confirm:
- three legacy global UNIQUE constraints are absent
- three brand-scoped unique indexes remain valid
- no scoped duplicates
- all four planners now use `ON CONFLICT (brand_id, schedule_date, post_type, slot_no) DO NOTHING`
- planner SECURITY DEFINER/search_path/ACL unchanged
- x-test-post remains ACTIVE and runtime source unchanged from Gate C
- Cron unchanged
- publish_enabled unchanged
- OAuth/Vault/token untouched
- no unrelated Function changed
- no Netlify/Vercel change
- no intentional X post/API publish action occurred

If a safe non-publish DB behavior proof is possible without affecting live scheduling, perform only read-only/catalog checks. Do not create production scheduled test posts unless separately approved.

## Forbidden

- any unrelated Function deploy
- Cron change
- OAuth/Vault/token mutation
- publish_enabled change
- X API publish/media/repost
- scheduler behavior refactor
- token/account routing refactor
- queue fairness changes
- migration history repair
- replaying old foundation migration
- `supabase db push`
- Netlify/Vercel change

## Completion / C2

When complete or stopped:
- status -> `review_required`
- next_owner -> `chatgpt`
- update `.agent/CODEX_REPORT_2.md`

Report:
1. fresh source commit
2. Gate A preflight
3. explicit consent status
4. Function deploy metadata
5. runtime source/hash verification
6. safe smoke result
7. Gate D fresh preflight
8. exact migration hash and apply result
9. postflight constraint/index/planner read-back
10. Cron unchanged proof
11. unrelated Function unchanged proof
12. production mutation counts
13. X publish/media count = 0
14. remaining risks
15. next recommendation
16. commit/push/fresh-origin verification

Then STOP for C2.
