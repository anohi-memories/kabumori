# Codex Task 2

- task_id: social-mobile-app-phase13-production-preview-rollout-and-qa-20260921
- owner: codex
- slot: codex-2
- status: ready
- next_owner: codex
- priority: high
- recommended_model: Luna
- purpose: Phase 12 C2 PASS済みの general-user preview candidate を production に安全に反映し、dedicated QA user + test X account で exactly one bounded real AI preview を実行して、tenant isolation・no-publish boundary・既存brand非回帰を確認する。real X post / media upload / publish_enabled=true / Cron はまだ禁止。

## Approved basis

Phase 12 Final C2: PASS。

Approved candidate:
- `social_mobile_user_v1` profile registered
- dedicated `social-mobile-brand-dry-run` Edge Function
- user-JWT-only tenant reads
- owner membership required
- exact social-mobile profile required
- exactly one identity-verified X account required
- no Vault/token read
- no scheduled_posts write
- no X adapter/publish path
- mobile preview-only UI
- tests 75/75 + typecheck/lint/iOS export/deno check/diff/static scan PASS
- implementation commit `60b610292398053494d9ed73b80617d2dd2eefe6`

Existing retained QA fixture:
- dedicated non-admin Auth QA user
- dedicated test X account
- OAuth verified
- `publish_enabled=false`
- tenant isolation previously proven
- do not clean up automatically

## Model policy

- Start and continue with **Luna**.
- Do not escalate just because production is involved.
- Escalate to Sol only if a concrete blocker appears involving Auth/RLS isolation, Edge Function deployment/runtime mismatch, OpenAI invocation safety, or unexpected production data mutation that Luna cannot resolve confidently.
- If escalation is needed, stop and report the exact blocker first.

## Scope A — fresh preflight

Before any production mutation:
1. read `.agent/ORCHESTRATION.md`
2. read `.agent/CURRENT_STATE.md`
3. read this TASK and `.agent/CODEX_REPORT_2.md`
4. inspect other 3 slots for overlap
5. fresh `origin/main`
6. verify approved candidate source is still byte-equivalent to reviewed commit where relevant
7. production read-only snapshot:
   - target Function `social-mobile-brand-dry-run` absent or current version/hash if already present
   - retained QA user still non-admin
   - QA membership count/owned brand
   - QA X account still identity_verified
   - QA `publish_enabled=false`
   - existing production X accounts unchanged
   - relevant brands/accounts/scheduled_posts counts and safe identity hashes
8. verify no other slot is deploying/changing the same shared brand files, same Edge Function, or same production settings

STOP if source drift, unexpected prior deployment, account mutation, or slot conflict is found.

## Scope B — deploy only the preview Function

Deploy exactly:
- `social-mobile-brand-dry-run`

Requirements:
- source must match reviewed `origin/main`
- custom user-JWT flow preserved
- no service_role use added
- no migration/schema/RPC/RLS changes
- no Cron/scheduler/settings changes
- no existing Function redeploy
- no X Developer Portal change
- no secret rotation

Post-deploy read-back:
- Function ACTIVE
- verify_jwt policy documented exactly as deployed
- runtime source/hash equivalent to approved source
- unrelated Function versions/updated_at unchanged

## Scope C — safe smoke before real AI

Run no-publish smoke checks first:
- unauthenticated request fails closed
- invalid/unsupported method fails closed
- no DB mutation from smoke
- no OpenAI call for rejected requests
- no X/Vault access

If possible, use a valid QA session for a pre-generation ownership read path without generation side effects. Do not expose credentials/session token in report.

## Scope D — exactly one real production AI preview

After B/C pass, execute exactly one real AI preview with the retained dedicated QA user and QA X account.

Required path:
1. sign in/use existing QA session
2. invoke `social-mobile-brand-dry-run` for the owned QA brand
3. exactly one OpenAI generation request
4. preview returns successfully to mobile/equivalent approved client
5. record only safe metadata:
   - success/status
   - workspace identity in non-sensitive form
   - connected QA handle if already public test handle
   - model name if returned
   - character count
   - preview-only/no-publish flags

Do NOT copy the full generated text into the report unless needed for a defect; if inspected, keep it minimal.

Forbidden:
- any X API call
- media upload
- scheduled_posts insert
- publish/repost
- `publish_enabled=true`
- Vault token read
- existing production account mutation
- Cron/scheduler change
- app-wide data-source switch

If the real AI call fails:
- do not retry repeatedly
- one controlled retry maximum only if failure is clearly transient and creates no write/publish risk
- otherwise stop for C2 with exact failure class

## Scope E — postflight proof

After the preview:
- verify QA user remains non-admin
- QA has only expected owned workspace
- QA X account remains identity_verified
- QA `publish_enabled=false`
- scheduled_posts count/identity for QA workspace unchanged
- no X/media post side effect
- no Vault token access/change attributable to preview
- existing AI Lab/kabumori/mio accounts unchanged
- existing admin OAuth unchanged
- no new OAuth state or account binding from preview
- no cross-tenant visibility regression

Run a rollback-only authenticated RLS read proof if needed, but no persistent mutation.

## Scope F — source/mobile sanity

Because mobile preview UI already exists:
- confirm current mobile code points to `social-mobile-brand-dry-run`
- no publish button/toggle exists on preview card
- typecheck/lint only if source changed since approved candidate or if environment requires fresh verification
- no source changes should be needed for a clean rollout

If a real defect is discovered:
- do not hot-patch production
- stop
- make source fix on fresh main
- test it
- return for C2 before redeploying

## Production boundary

Approved:
- deploy only `social-mobile-brand-dry-run`
- exactly one bounded real OpenAI preview call using dedicated QA fixture
- read-only/postflight checks

Not approved:
- migration/schema/RPC/RLS
- Cron/scheduler
- any X post/media/repost
- `publish_enabled=true`
- production settings changes
- Vault rotate/delete
- app-wide data-source switch
- billing/Push changes
- cleanup of QA fixture
- blind `db push` / migration-history repair

## Completion / C2

When complete:
- status -> `review_required`
- next_owner -> `chatgpt`
- update `.agent/CODEX_REPORT_2.md` with:
  1. fresh preflight
  2. exact Function deploy/version/hash/source-equivalence
  3. safe smoke results
  4. real AI preview result
  5. OpenAI call count
  6. proof of zero X/media/scheduled-post/publish side effects
  7. tenant isolation postflight
  8. existing production accounts/admin OAuth unchanged
  9. production mutation summary
  10. rollback path / next recommendation
- fresh-check `origin/main` before any control/report push
- STOP for C2
