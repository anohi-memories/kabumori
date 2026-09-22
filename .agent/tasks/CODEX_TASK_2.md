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

## C2 review handoff — QA mobile source mismatch

The Phase 13 deployment and rejected-request smoke checks are complete, but the exactly-one real AI preview was **not** run. The mirrored app is displaying its local mock repository rather than the QA user's RLS-scoped Supabase data. This task is now `review_required` for C2 to decide the next safe QA setup; do not bypass the prohibition on app-wide data-source changes.

Evidence from the current mobile source and screen:
- `apps/social-mobile/src/data/repository-selection.ts` selects `mockRepository` unless `EXPO_PUBLIC_DATA_SOURCE === 'supabase'`.
- `apps/social-mobile/src/providers/active-account-provider.tsx` uses the static mock accounts unless the Supabase snapshot is `ready`.
- `apps/social-mobile/src/data/mock-repository.ts` contains the fixed `@kabumori` and `@brand_studio` rows and demo counts. The mock account has no `brandId`, while `BrandPostPreview` requires a `brandId`, handle, and authenticated session before enabling generation.
- The screenshot after QA sign-in still showed those static accounts. The absence of a live-source status card is consistent with `mock_preview` (the home UI intentionally hides that card in mock mode).
- `apps/social-mobile/src/app/accounts/index.tsx` initializes OAuth display state with local `useState('idle')`; it does not read back a durable per-user connection status. The earlier `@YumeYoasobi` “connected” display followed an OAuth callback, but after QA sign-in the UI showed the connect button again. This UI transition alone does **not** prove server-side unlink/revocation; no Vault/token read was performed.

Next safe step for C2 decision: authorize a narrowly isolated QA client/runtime configured to read the existing Supabase tenant data (without changing the app-wide source or any publish setting), or nominate another approved client path using the existing QA user's bearer session. Proceed only when the actual QA membership resolves to the expected `social_mobile_user_v1` brand and its verified test X account; do not select/use `@kabumori`, repeat OAuth, or call OpenAI until that context is proven. If the QA membership/account is not visible in the live source, investigate that read-only/RLS mismatch as a separate blocker.

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


## C2 review — 2026-09-21 (mobile QA source mismatch)

**BLOCKED for Phase 13 completion, but deployment/smoke portion is accepted. Resume the same H2 with a narrowly isolated QA runtime.**

Accepted:
- production preflight passed.
- only \`social-mobile-brand-dry-run\` was deployed.
- deployed Function is ACTIVE v1 with runtime files byte-equal to the reviewed Phase 12 source.
- unrelated Functions remained unchanged.
- unauthenticated POST failed closed with 401.
- unsupported GET failed closed with 405.
- rejected-request smoke did not reach OpenAI/X/Vault/scheduled-post paths.
- QA fixture remained intact: non-admin owner, one \`social_mobile_user_v1\` workspace, identity-verified test X account, \`publish_enabled=false\`, zero QA scheduled posts.
- no schema/RPC/RLS/Cron/settings/Portal/Vault/X mutation occurred.
- real OpenAI preview was correctly **not** attempted while the mobile client was showing mock data.

Blocker:
- the installed/mirrored mobile runtime is still using the static mock repository because its runtime data-source environment is not resolving to \`supabase\`.
- therefore the visible \`@kabumori\` / \`@brand_studio\` rows are mock fixtures, not a tenant-isolation leak.
- generation must not be attempted from that state.

Authorized continuation:
1. create/use a **QA-only local iOS runtime/build** from fresh \`origin/main\` with \`EXPO_PUBLIC_DATA_SOURCE=supabase\`.
2. this is a local QA runtime configuration only:
   - do not change the repository default.
   - do not change production app-wide settings.
   - do not commit secrets or environment values.
   - do not alter publish settings.
3. confirm in the QA runtime that the signed-in QA session resolves:
   - exactly the expected owned \`social_mobile_user_v1\` workspace,
   - exactly the identity-verified dedicated test X account,
   - no visibility of production brands/accounts.
4. if that read proof passes, execute exactly one real AI preview.
5. then perform the original Phase 13 postflight.
6. if the QA live source does not resolve the expected workspace/account, STOP for C2 with a read-only/RLS diagnosis; do not repeat OAuth and do not invoke OpenAI.
7. do not select/use \`@kabumori\`, do not relink X, and do not change \`publish_enabled\`.

Model:
- continue with **Luna**.
- Sol only if an actual Auth/RLS/runtime configuration discrepancy remains after the isolated QA runtime is proven to load the Supabase source.

Completion remains:
- return \`review_required / next_owner: chatgpt\` after the one real preview + postflight, or after a concrete blocker.


## C2 diagnosis — 2026-09-22 (verified account demoted by a later OAuth begin)

Read-only production diagnosis found the concrete blocker.

Facts:
- QA account \`@yumeyoasobi\` currently has:
  - \`connection_status='authorization_pending'\`
  - \`publish_enabled=false\`
  - non-null \`verified_at\`
  - \`code_profile_key='social_mobile_user_v1'\`
- OAuth history shows a successful consumed state at \`2026-09-21 11:36:17 UTC\`, matching \`verified_at\`.
- A later state was created at \`2026-09-21 13:48:17 UTC\` and remained unconsumed.
- Production definition of \`begin_social_mobile_x_oauth_connection\` unconditionally executes:
  \`set connection_status = 'authorization_pending'\`
  whenever an X social_account already exists.
- Therefore a later OAuth **start** demoted an already verified account before any successful callback. This explains the current "要確認" state. It is not an RLS leak and not evidence that the token/account binding was lost.

### Required fix candidate

Use Luna.

1. Fresh \`origin/main\`; inspect the Phase 9 migration/RPC source and tests.
2. Change the source candidate so starting/restarting OAuth does **not** destroy a previously verified binding:
   - for a new/unverified account, \`authorization_pending\` remains valid.
   - for an existing \`identity_verified\` account, preserve \`identity_verified\` during a new OAuth attempt.
   - clear/update only fields that are safe for an in-progress attempt; do not clear verified identity or publish flags.
   - callback success may continue to atomically refresh/bind tokens and end in \`identity_verified\`.
   - a failed/abandoned reconnect must leave the previously verified account usable as verified.
3. Add focused regression tests:
   - verified account + begin => still \`identity_verified\`.
   - pending/new account + begin => \`authorization_pending\`.
   - abandoned/expired state after verified begin does not demote the account.
   - successful callback after preserved verified state still completes normally.
4. Inspect mobile Accounts/OAuth UI:
   - starting reconnect must not cause durable server status regression.
   - do not add automatic reconnect behavior.
5. Do not hot-edit the production row and do not redeploy yet.
6. No real OAuth, OpenAI preview, X API, Vault mutation, publish change, schema apply, Cron, or app-wide data-source change in this fix step.
7. Return \`review_required / next_owner: chatgpt\` with exact changed files/tests and a safe rollout+repair proposal.

### Repair proposal to prepare, not execute before C2

After source fix approval, propose one bounded production follow-up:
- deploy only the corrected OAuth Function/RPC path as required by the implementation,
- restore the QA account from \`authorization_pending\` to \`identity_verified\` only if read-only preconditions still prove:
  - \`verified_at\` non-null,
  - same dedicated QA identity,
  - Vault access+refresh secret references still present,
  - no newer successful binding to another identity,
  - \`publish_enabled=false\`.
- then resume the Phase 13 live-data QA and exactly one AI preview.
- no X post/media/publish enablement.

## H2 source-fix follow-up — 2026-09-22

- status: `review_required`
- next_owner: `chatgpt`
- result: Added a production-application candidate migration that preserves an existing `identity_verified` status when `begin_social_mobile_x_oauth_connection` starts a reconnect. New or otherwise unverified accounts still transition to `authorization_pending`; `publish_enabled`, verified identity fields, and callback behavior are not changed.
- changed_files:
  - `supabase/migrations/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql`
  - `supabase/functions/x-oauth-connect-user/mobile_oauth_reconnect_test.ts`
- mobile_ui_review: `apps/social-mobile/src/app/accounts/index.tsx` keeps reconnect state local and does not add automatic reconnect behavior; no UI/source change was needed. The server-side status transition is the durable regression point.
- production: no migration apply, no production row repair, no deploy, no OAuth retry, no OpenAI preview, no X/Vault/Storage/scheduled-post mutation, and no Cron/settings change.
- next_recommendation: C2 review the additive replacement-RPC migration, then separately authorize production apply/deploy and read-only QA-row preconditions before restoring the QA status and resuming the one-shot preview.


## C2 review — 2026-09-22 (OAuth reconnect status hardening)

**PASS for the source-fix candidate. Phase 13 overall remains incomplete.**

Accepted:
- Root cause is confirmed: the existing begin RPC demotes every existing X account to \`authorization_pending\` before callback completion.
- Candidate migration \`20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql\` changes only the begin-RPC reconnect transition.
- Existing \`identity_verified\` rows remain \`identity_verified\` when a new OAuth attempt begins.
- New/unverified rows still use \`authorization_pending\`.
- \`publish_enabled\`, verified identity fields, Vault references, and callback completion behavior are not modified by the candidate.
- SECURITY DEFINER + explicit \`search_path='public'\` are preserved.
- EXECUTE remains restricted to \`authenticated\`; public/anon/service_role are revoked.
- Mobile review found no automatic reconnect trigger; no mobile source change is required.
- Source commit \`7985c3bd234e8eeee6d9d1855b668471c5475cdb\` is the reviewed fix.
- Focused tests and full OAuth/preview tests reported PASS.
- No production mutation occurred in this source-fix step.

Test limitation:
- reconnect tests are static migration-contract tests rather than disposable PostgreSQL runtime tests.
- Given the bounded \`create or replace function\` change and direct comparison with the current production definition, this is acceptable for **source approval**, but production rollout must use strict pre/post read-back and must not broaden scope.

### Next H2 gate

Continue with **Luna**.

1. Fresh \`origin/main\`.
2. Read-only production preflight:
   - current begin RPC still has the known unconditional demotion behavior,
   - QA account still has non-null \`verified_at\`,
   - QA account is still the dedicated test identity,
   - access-token and refresh-token Vault secret references are present (IDs/presence only; never secret values),
   - \`publish_enabled=false\`,
   - no newer successful OAuth binding to a different X identity,
   - QA membership/workspace unchanged,
   - existing production X accounts/admin OAuth unchanged.
3. STOP and report if any precondition differs.
4. **Do not apply the migration or repair the QA row unless there is an explicit trusted user authorization for those production mutations.**
5. After explicit authorization, the allowed production mutation is bounded to:
   - apply exactly migration \`20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql\`,
   - read back the begin RPC definition/ACL/search_path,
   - restore only the dedicated QA account's \`connection_status\` from \`authorization_pending\` to \`identity_verified\` if all preconditions still hold,
   - do not change \`publish_enabled\`, handle, platform_user_id, verified_at, Vault references, or other accounts.
6. Then resume the existing Phase 13 QA:
   - QA-only live Supabase runtime,
   - prove the account displays connected/identity_verified,
   - exactly one real AI preview,
   - no X API/media/post, no scheduled_posts write, no Vault token read/change, no publish enablement.
7. Final postflight and return \`review_required / next_owner: chatgpt\`.

Phase 13 is not done until the bounded repair + one real preview + postflight are complete.
