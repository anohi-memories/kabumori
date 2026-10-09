# Common account — Phase 3a: safe withdrawal and the deletion orchestrator (source only)

Status: source candidate, **with the PR112 H2 R1–R4/C1 corrective**. Nothing is deployed, no migration is
applied, no production data, session, Storage object, provider grant or login was touched. The Auth-delete
guard stays `shadow`; no enforcement is switched on. Built against the Phase 1 contract
(`phase1-lifecycle-foundation.md` §10/§14/§15) and the Phase 2 start/restart contract
(`phase2-service-enrollment.md`), not a parallel state machine.

**Release state.** 「かぶモリの利用を終了」 is complete as a source candidate. 「共通アカウントを削除」 is
**release-blocked**: the managed Auth delete sits behind a database gate that the candidate can only create
as `blocked` (H2 R3, §8). While it is blocked, a whole-account deletion is refused **before anything
changes** and the app says so. The full deletion feature is not claimed safe.

## 1. Three things the app now keeps apart

| Choice | What ends | What stays | Server path |
| --- | --- | --- | --- |
| **かぶモリの利用を終了** | the `kabumori` entitlement and every Kabumori row (the `profiles` row, cascading to stocks, alerts, notifications, push tokens, reports) | the login (共通ID), the X entitlement, the X workspace and its posting authorization | `account-delete` action `withdraw_kabumori` → `withdraw_kabumori_service` |
| **X自動投稿の利用を終了** | X only | — | unchanged: the X app's own `social-mobile-account-delete` saga (X-owned; not edited here) |
| **共通アカウントを削除** | every service (X first, then Kabumori), every session, the Apple grant, Storage, then the login itself | nothing | `account-delete` action `delete_common_account` → the orchestrator (§4); **release-blocked** (§8) |

The old Kabumori entry "アカウントを削除" (one tap that hard-deleted the shared login with whatever other
service hung off it) no longer exists, in the UI or on the server.

## 2. Files

| Part | Files |
| --- | --- |
| Orchestrator (server) | `supabase/functions/account-delete/lifecycle_logic.ts` (flows, injected dependencies), `http.ts` (routing, real adapters), `index.ts` (entry) |
| Removed | `supabase/functions/account-delete/delete_logic.ts` + its test (the direct Auth Admin hard delete) |
| Database candidate | `supabase/migrations/20261009120000_common_account_deletion_completion.sql` (not applied) |
| Database proof | `supabase/tests/common_account_deletion_completion_{run.sh,behavior.sql,mutations.sh,expected_catalog.txt}` |
| Server tests | `supabase/functions/account-delete/{lifecycle_logic_test,http_test,wiring_test}.ts`; TS mutations `supabase/tests/common_account_phase3a_ts_mutations.py` |
| Client | `src/lib/account-deletion.ts` (pure logic), `src/lib/account-deletion-client.ts` (network, fresh sign-in), `src/components/account-lifecycle-views.tsx` (both screens), `src/app/settings.tsx`, `src/lib/settings-menu.ts`, `src/components/service-access-screen.tsx` (resume), `src/lib/auth.ts` (`signOutThisDevice`) |
| Client tests | `tests/app/account-deletion_test.ts`, `tests/app/settings-menu_test.ts` |

## 3. Server API (`POST /functions/v1/account-delete`, JSON body, platform JWT verification ON)

The person is always the owner of the bearer token (`GET /auth/v1/user`). No request field names a user;
ids in a body are ignored. Every answer is `{ok:true, …}` or `{ok:false, error, reasons?, sessions_revoked?}`
with fixed codes only. Nothing is logged.

| `action` | Needs | Success | Notes |
| --- | --- | --- | --- |
| `preview` | a valid token | `account_status`, `lifecycle_version`, `services[{service,status}]`, `blockers` (fixed codes), `deletion_in_progress`, `deletion_available` (the release gate), `apple{required,supported,code_required}`, `x_cleanup` | read-only; the confirmation screen and the resume path |
| `withdraw_kabumori` | `confirmation:"END_KABUMORI_SERVICE"`, recent sign-in | `outcome: ended / already_ended / not_registered` | refused (`WITHDRAW_BLOCKED` + `ACCOUNT_DELETION_IN_PROGRESS`) while a whole-account deletion is open |
| `delete_common_account` | `confirmation:"DELETE_COMMON_ACCOUNT"`, recent sign-in, `expected_lifecycle_version` (from the preview), `apple_authorization_code` when Apple applies | `outcome: deleted` — only after the post-delete read-back verified it | §4; `COMMON_ACCOUNT_DELETION_UNAVAILABLE` while the gate is blocked |
| anything else, **including the legacy call with no body** | — | `400 ACTION_REQUIRED` | decided before any environment read or network request |

**Recent sign-in (H2 C1)** = the newest `amr[].timestamp` of the server-verified token lies in
`[now − 600 s, now]` (the clock is read once; any future value, even +1 s, is refused; no skew allowance) and
`sub` is the verified user. Kabumori obtains it by a password sign-in in a **separate, memory-only Supabase
client**: the app's own session, its auth events and its Phase 2 service gate are untouched. The address
used is the signed-in one; nothing is typed or looked up. A fresh sign-in of another person is refused.

Error codes: `AUTH_REQUIRED`, `ACTION_REQUIRED`, `CONFIRMATION_REQUIRED`, `REAUTH_REQUIRED`,
`LIFECYCLE_VERSION_REQUIRED`, `LIFECYCLE_CHANGED`, `DELETION_BLOCKED`(+reasons),
`COMMON_ACCOUNT_DELETION_UNAVAILABLE`, `DELETION_IN_PROGRESS`, `RECONCILIATION_REQUIRED`,
`APPLE_REAUTH_REQUIRED`, `APPLE_REVOCATION_UNAVAILABLE`, `APPLE_REVOKE_FAILED`, `X_CLEANUP_UNSUPPORTED`,
`X_CLEANUP_IN_PROGRESS`, `X_CLEANUP_BLOCKED`, `X_CLEANUP_FAILED`, `SERVICE_CLEANUP_INCOMPLETE`,
`SESSION_REVOKE_FAILED`, `STORAGE_CLEANUP_FAILED`, `STORAGE_NOT_EMPTY`, `STORAGE_BUCKET_OWNED`,
`NOT_READY`(+reasons), `AUTH_DELETE_FAILED`, `AUTH_DELETE_UNCONFIRMED`, `DELETION_VERIFICATION_PENDING`,
`WITHDRAW_BLOCKED`, `WITHDRAW_INTERRUPTED`, `WITHDRAW_INCOMPLETE`, `FAILED`. `sessions_revoked:true` means
every session is already gone: the app signs out and the person signs in again to resume.

## 4. Whole-account deletion: the orchestrator

| # | Step (Phase 1 §10) | Call | Durable state | On a retry | Failure |
| --- | --- | --- | --- | --- | --- |
| 0 | caller, confirmation, recent sign-in, version | `GET /auth/v1/user` | — | — | 401 / 400 / 403 |
| 1 | read-only pre-checks: **release gate**, Apple code/config, X saga scope `social_only` | `common_account_deletion_release_gate`, eligibility, X `preview` | — | — | `COMMON_ACCOUNT_DELETION_UNAVAILABLE`, `APPLE_*`, `X_CLEANUP_UNSUPPORTED` — before anything changes |
| 2 | begin, bound to the version shown | `begin_common_account_deletion` | account `deleting`, operation `in_progress` | same operation, only at the version shown now | `LIFECYCLE_CHANGED`, `DELETION_BLOCKED` |
| 3 | **claim ownership** (R1) | `claim_common_account_deletion` (lease 600 s, fence +1) | `owner_lease`, `owner_fence` | a new claim after release / expiry | `DELETION_IN_PROGRESS`, `RECONCILIATION_REQUIRED` |
| 4a | X service (owned) | renew → `begin_service_deletion` → X saga `delete` (`social_only`) → `finish_service_deletion` | X entitlement → `ended`; the saga's tombstone | resumes from the X tombstone; skipped once ended | `X_CLEANUP_*`, `SERVICE_CLEANUP_INCOMPLETE` |
| 4b | Kabumori (owned) | renew → `withdraw_kabumori_service` | entitlement `ended`, profile gone | idempotent | `DELETION_BLOCKED`, `SERVICE_CLEANUP_INCOMPLETE` |
| 5 | sessions (owned) | renew → `logout?scope=global` → owned checkpoint `session_revocation` | checkpoint | repeated (a retry needed a new sign-in) | `SESSION_REVOKE_FAILED` |
| 6 | Apple (identity present; R2) | **intent** `begin_…_external_step(apple_revocation)` → `revokeAppleGrant` → **settle** (`succeeded` writes the checkpoint) | intent, then checkpoint | never replayed (§5) | `APPLE_REVOKE_FAILED` (definitive no), `RECONCILIATION_REQUIRED` (unknown / not recorded) |
| 7 | Storage (owned) | renew → inventory → Storage API `DELETE /object/{bucket}` → re-list (≤ 3 passes) → owned checkpoint `storage_cleanup` | checkpoint | repeated (idempotent) | `STORAGE_*`; the checkpoint is withdrawn |
| 8 | prepare + revalidate (owned) | `prepare_owned_…` → re-list Storage → `prepare_owned_…` | ready, bound to version/epoch/checkpoints | repeated | `NOT_READY`, `DELETION_BLOCKED` |
| 9 | **managed delete intent** (R1/R3) | `begin_…_external_step(managed_auth_delete)`: release gate, full re-evaluation under the **exclusive login lock**, evidence snapshot | intent + `managed_delete_required_checkpoints` / `managed_delete_identity_providers` | a crashed attempt is cleared after the settle window while the login is still there | `COMMON_ACCOUNT_DELETION_UNAVAILABLE` (gate), `NOT_READY` (any change since prepare) |
| 10 | managed Auth delete | `DELETE /auth/v1/admin/users/{id}` (service role, never SQL) | guard closes the operation `login_removed` | — | non-2xx → read back: present → settle `failed` → `AUTH_DELETE_FAILED`; unknown → `AUTH_DELETE_UNCONFIRMED` (intent stays) |
| 11 | post-delete read-back (R3/R4) | `complete_common_account_deletion` | `completed` + `verified_at` | re-asked: residue checked **now** | `DELETION_VERIFICATION_PENDING`; **success only for a verified completion** |

Ownership is given back (`release_…_claim`) on every path out of steps 4–11; an unsettled external step
stays recorded.

## 5. Ownership and external steps (H2 R1/R2)

- **One owner.** `begin` only creates or returns the open operation; its row lock ends with the RPC.
  Ownership is a durable lease (unguessable token, expiry, monotonic fence) taken by `claim` **before the
  first external action**. Every later step re-checks it in the database in the same transaction as its
  write: `renew` before X / Kabumori / sessions / Storage, owned checkpoints, owned prepare, step intents
  and settles. A second request (any token of the same person) gets `in_progress` → `DELETION_IN_PROGRESS`
  and calls nothing external. An owner whose lease expired or was taken over is refused at its next step
  and stops (`DELETION_IN_PROGRESS`), never reporting success. The lease (600 s) is longer than any Edge
  request; correctness does not rely on that: every write re-checks the token.
- **External steps that must not be repeated blindly** are recorded as in flight before the call and
  settled after it: `apple_revocation` (single-use code) and `managed_auth_delete`. Only one can be in
  flight. A takeover waits while one may still be running (900 s settle window, longer than any Edge
  request), then: an **unsettled Apple step is never replayed** — the operation answers
  `reconciliation_required` until an operator checks with Apple and records it as revoked or not
  (`resolve_common_account_deletion_external_step`, service role, never called by the function); an
  unsettled managed delete with the login still present did not happen and is cleared.
- **Apple outcomes:** `true` → settle `succeeded` (the checkpoint and the end of the intent in one
  transaction); `false` (definitive refusal) → settle `failed`, a new code may be used; the call broke off,
  or a known outcome could not be recorded → `RECONCILIATION_REQUIRED` with the intent left in place. The
  apple_revocation checkpoint cannot be written any other way (the owned-checkpoint RPC refuses it).

## 6. Session revocation and the stale-token policy

Step 5 revokes every session (refresh token) of the login. Access tokens already issued are signed JWTs
that PostgREST and Storage accept until they expire (the project's JWT expiry, 1 h by default).

| A still-valid token tries to … | After `begin` | After the managed delete |
| --- | --- | --- |
| start or restart a service (`start_*`, `reactivate_*`) | refused `ACCOUNT_DELETION_IN_PROGRESS` | refused (no login row) |
| write Kabumori rows | fails once Kabumori ended (every table references `profiles`) | same |
| re-create a profile (`ensure_my_profile()`, or a direct insert allowed by `profiles_insert_own`) | **not gated** — the owned prepare and the managed intent refuse (`UNREGISTERED_SERVICE_FOOTPRINT`) | refused by the foreign key |
| create an X workspace (onboarding RPC / `x-oauth-connect-user`) | **not gated** — caught by the prepare / intent | `brands` survives: the read-back answers `RESIDUAL_SERVICE_DATA` (never completed) |
| upload to Storage | caught by the revalidation or the intent's re-evaluation | `owner_id` is plain text: the read-back finds it, the orchestrator removes it and verifies again; a later re-ask answers `residue_found` (R4) |
| link an Apple identity (GoTrue) | caught by the intent's re-evaluation **up to its commit** (race 5e) | **not observable** — the reason the gate stays blocked (§8) |
| call this function again | needs a fresh recent sign-in; Auth's `GET /user` is expected to refuse a token whose session was removed (to confirm on a real project) | the login is gone |

Finite re-reads narrow every window; they do not close the last one. The "not gated" rows and the
identity link are enforcement prerequisites (§9).

## 7. Storage

A read-only, `service_role`-only inventory (`common_account_deletion_storage_objects`) lists
`(bucket_id, name)` owned by the person (`owner_id` or the deprecated `owner`), ≤ 1000 per call with
`more`, plus `buckets_owned`. Unknown shape / read failure is `unknown_shape` / `probe_failed`, never
"empty". Removal only through `DELETE /storage/v1/object/{bucket}` with the service role, listed again
until empty; an owned bucket is refused (operator).

## 8. The managed delete and the release gate (H2 R3)

H2 reproduced: an Apple identity linked after the final prepare, then the login removed (the identity
cascades away), and the old read-back still answered `completed`. Corrected:

1. **Final decision under the exclusive login lock.** The managed delete intent re-runs the full Phase 1
   authorization (`private.account_lifecycle_authorization_problems`, including `REQUIRED_CHECKPOINTS_CHANGED`)
   while holding the `auth.users` row `FOR UPDATE`; an identity insert in flight holds `FOR KEY SHARE` on
   that row, so the decision waits for it and then refuses (race 5e). Any problem drops the readiness.
2. **Evidence.** The intent stores what the delete was decided against: the required checkpoints and the
   identity providers (names only). They survive the login removal (no foreign key).
3. **Verification needs the intent.** The read-back completes only an operation whose managed delete
   intent was recorded, whose readiness binding equals the intent's requirement, and whose every required
   checkpoint is recorded. A login removed by any other route is `LOGIN_REMOVED_WITHOUT_MANAGED_INTENT` —
   the H2 R3 reproduction now fails.
4. **Residual window → release gate.** An identity linked **after** the intent commits and before Auth's
   delete commits is erased by the cascade and is invisible to every later check (documented as a test,
   with the gate opened only by test-only DDL). Phase 1's guard is shadow and does not (cannot reliably)
   look at identity rows inside the cascade. So `private.account_lifecycle_release_gates` holds one row,
   `managed_auth_delete = blocked (IDENTITY_CHANGE_FENCE_MISSING)`, under a CHECK that allows only
   `blocked`. The intent RPC refuses while it is blocked, the Edge Function refuses before `begin`, and the
   app shows 「共通アカウントの削除は、現在準備中です」. No setting opens it; opening it is a reviewed
   migration that ships the missing prerequisite.
5. **Missing prerequisite (precise).** An identity-change fence for the window between the managed delete
   decision and Auth's delete commit, proven on a disposable real Supabase project — one of: (a) Auth
   refusing identity linking/sign-in for the login during the deletion (e.g. an Admin-API ban applied before
   the final decision, if and only if a real-project proof shows GoTrue refuses to create or link an identity
   for a banned user), (b) an Auth hook under our control that refuses it, or (c) an enforcing guard that
   can see identities inside the Auth cascade with a proven cascade order. Plus the §9 writer gates.

## 9. Enforcement readiness inventory (nothing switched on)

**Service creators** — gated: `start_*_service()`, `reactivate_*_service(v)` (Phase 1/2). **Not gated:**
`ensure_my_profile()` (still granted to `authenticated`), direct `insert into profiles`
(`profiles_insert_own` + `grant insert`), X workspace creation via `begin_social_mobile_x_oauth_connection`
(`x-oauth-connect-user`). Operator: `private.account_lifecycle_backfill` (takes the lifecycle locks).

**Login delete routes** — Kabumori `account-delete` **as deployed in production** (recorded as live in
`apps/social-mobile/docs/account-deletion-rollout-runbook.md`; not re-read here): no body →
`DELETE /auth/v1/admin/users/{id}` — **unsafe until this source is deployed**. This source: lifecycle only,
legacy call → `ACTION_REQUIRED`. X saga `social_mobile_account_deletion_finalize` in scope
`social_and_login` (`delete from auth.users` in SQL): not lifecycle-gated (X-owned; pinned by
`wiring_test.ts` as the only SQL login delete). Dashboard / operator deletes: the shadow guard only observes
(and the read-back never completes them).

**Service-role producers without an entitlement predicate** — `claim_pending_push_notifications`,
`enqueue_important_news_notifications`, `enqueue_personalized_report_notification`,
`personalized_report_news_inputs`, `important_news_app_copy_targets`, `personalized-reports`,
`send-push-notifications`, `x-test-post`, `important-news-*`, `news-discovery-observer`,
`market-intelligence-ingest`, `social-mobile-history-learning`.

**RLS / API / Edge boundaries** — Kabumori tables: own-row RLS + foreign key to `profiles`, no entitlement
predicate. X tables: membership-based. Edge Functions on a person's token: `account-delete`,
`social-mobile-account-delete`, `x-oauth-connect-user`, `x-test-post`, `social-mobile-consult`,
`social-mobile-publish-setting`, `social-mobile-brand-dry-run`, `social-mobile-history-learning` — none
checks an entitlement.

**Stale-JWT writer paths** — §6. **Identity-change fence** — §8.5. **Entitlement checks required** —
Kabumori RLS + producers; X onboarding RPC, posting producers and Edge Functions.

**Cross-service session effect (finding, unchanged)** — Kabumori's normal `signOut()` uses the SDK default
`scope: 'global'` (also signs out the X app). The two Phase 3a flows use `scope: 'local'`; changing the
normal logout is a product decision.

## 10. Database candidate `20261009120000_common_account_deletion_completion.sql`

- Replaces exactly one Phase 1 rule (an account deletion could never be `completed`). Adds to the
  operations table: `verified_at`; the owner lease/fence; the external-step intent; the managed delete
  evidence; seven CHECK rules (lease shape, step shape, intent shape, owner scope, completed shape incl.
  intent + closed step + no owner, verified shape). Adds the release-gate table (RLS on, no grant, one
  `blocked` row, CHECK `state = 'blocked'`).
- Functions (all SECURITY DEFINER, empty `search_path`; public ones `service_role` only, private ones owner
  only): `common_account_deletion_release_gate`, `claim_…`, `renew_…_claim`, `release_…_claim`,
  `set_owned_…_checkpoint`, `prepare_owned_…_auth_delete`, `begin_…_external_step`, `settle_…_external_step`,
  `resolve_…_external_step` (operator), `complete_common_account_deletion` (fresh residue on every call;
  historical `verified_at` kept), `common_account_deletion_storage_objects`,
  `record_common_account_deletion_error`; helpers `account_lifecycle_gate_open`, `…_owned_operation`,
  `…_residue`, `…_storage_inventory`.
- No write to auth/storage/vault, no e-mail, guard stays `shadow`; the only insert is the gate row; nothing
  else altered (the runner diffs the whole catalog against `…_expected_catalog.txt`, 44 exact lines).
- Proof (disposable PostgreSQL 17 only): preflight refusals; exact change and ACLs; refused re-apply;
  static rules; Phase 2 behavior unchanged; behavior G0 (shipped gate) and A–H, C5–C6, R1–R4 (including the
  two H2 reproductions, which now fail as intended, and the documented R3 residual); races: removal vs
  read-back (both orders), start vs begin (both orders), two owners, identity link vs managed decision.
  SQL mutation suite: 43 single-property breaks, all detected by name.

## 11. Client behavior (exact outcomes)

- **Settings**: 「かぶモリの利用を終了」 (keeps the login and other services) and 「共通アカウントを削除」
  (warns that every service on the ID is affected).
- **Withdrawal**: lists what is deleted and what stays, password, confirmation dialog. Success → this device
  only signs out; the next sign-in answers `reenroll_required` (Phase 2). Failure → message.
- **Deletion**: loads the preview; refuses up front (message, no button) while the release gate is blocked
  (the current state), for blockers, Apple, or an X cleanup that cannot keep the login. Otherwise password
  + typing 「削除」 + dialog. Verified success → dialog, sign out. `DELETION_IN_PROGRESS` → "進行中" message.
  `RECONCILIATION_REQUIRED` / verification pending → honest "運営で確認します" dialog, sign out.
  `LIFECYCLE_CHANGED` → preview reloaded.
- **Resume**: the deletion-in-progress screen offers 「削除手続きを続ける」; the `reenroll_required` screen
  offers 「共通アカウントを削除する」 (both show the gate message while blocked).
- Not changed: the public page `apps/kabumori-web/pages/account-deletion.html` — update it together with the
  client release that ships these screens, not before.

## 12. Rollout — separate, individually approved steps (none executed)

Order is binding; each step needs its own K5 / explicit approval. Real disposable-project proof and an
independent review come **before any production release**.

1. **Source merge candidate** — exact-head independent rereview of this corrective (DB/RPC/Auth/deletion).
   Merging source changes nothing in production.
2. **Disposable real Supabase project E2E** (never production): apply Phase 1 → Phase 2 → this candidate;
   deploy the functions there; prove `logout?scope=global`, `GET /user` with a revoked session, Admin
   delete/read incl. 404 and broken transport, Storage owner/`DELETE prefixes`, Apple identity shape and
   single-use code behaviour, the lease/takeover and reconciliation paths, and the §8.5 identity fence
   candidate. Independent review of that evidence.
3. **Production preflight** (read-only, same day): Phase 1 + Phase 2 objects/bodies/ACLs as reviewed, the
   "completed" rule present exactly once, guard `shadow`, none of this candidate's objects, no open
   `account_deletion` operation, the deployed `account-delete` bundle byte-identified.
4. **Production migration** — the single reviewed file (never `db push`), then read-back of the 44 catalog
   lines, ACLs and the `blocked` gate row.
5. **Edge deploy** of `account-delete` (from a checkout with `supabase/config.toml`; byte-verify). From then
   the legacy hard delete is gone; old app builds get `ACTION_REQUIRED`. `social-mobile-account-delete`
   deployment is X-owned.
6. **Client release** with these screens and the public page update.
7. **Feature activation** of whole-account deletion — only by a later reviewed migration that adds the §8.5
   prerequisite and opens the gate, after its own disposable-project proof.

**Rollback** never redeploys the pre-Phase-3 bodyless hard-delete bundle, even if the migration is unused:
the shutdown is a reviewed fail-closed function (every action refused) or this function with the gate
blocked; the migration is rolled forward, not dropped, once any lease/intent/completion exists.

## 13. Running the proofs

```bash
deno test --no-config --no-check --allow-read supabase/functions/account-delete/
deno test --no-config --no-check --no-lock --allow-read supabase/functions/social-mobile-account-delete/
deno test --no-config --no-check --allow-read --allow-env tests/app/
node --test tests/node/auth-provider-enrollment.test.mjs
CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> \
  bash supabase/tests/common_account_deletion_completion_run.sh
CAL_PGHOST=... CAL_PGPORT=... CAL_PGSUPER=... bash supabase/tests/common_account_deletion_completion_mutations.sh
python3 supabase/tests/common_account_phase3a_ts_mutations.py .
```

## 14. Named blockers (not relabelled as PASS)

1. Whole-account deletion is release-blocked until the §8.5 identity-change fence exists and is proven.
2. X-only people and a person whose Kabumori ended before X cannot be deleted through the orchestrator
   (X saga scope / its own SQL login delete — X-owned, G3/G4).
3. The legacy `account-delete` hard delete stays live in production until step 5.
4. Creator / entitlement / stale-JWT writer gates (§9) are not implemented.
5. The public web deletion page still describes the old flow.
6. No real-provider proof (Auth, Storage, Apple, X) and no Simulator / native test of the screens.
7. Lost response after a managed delete (operation `login_removed`, unverified, the person cannot call
   again) and Apple reconciliation need an operator runbook/tooling; the RPCs exist, the process does not.
8. No self-service cancel of an open deletion (`abort_common_account_deletion` is operator-only).
