# Common account — Phase 3a: safe withdrawal and the deletion orchestrator (source only)

Status: source candidate. Nothing is deployed, no migration is applied, no production data, session,
Storage object, provider grant or login was touched. The Auth-delete guard stays `shadow`; no enforcement
is switched on. Built against the Phase 1 contract (`phase1-lifecycle-foundation.md` §10/§14/§15) and the
Phase 2 start/restart contract (`phase2-service-enrollment.md`), not a parallel state machine.

## 1. Three things the app now keeps apart

| Choice | What ends | What stays | Server path |
| --- | --- | --- | --- |
| **かぶモリの利用を終了** | the `kabumori` entitlement and every Kabumori row (the `profiles` row, cascading to stocks, alerts, notifications, push tokens, reports) | the login (共通ID), the X entitlement, the X workspace and its posting authorization | `account-delete` action `withdraw_kabumori` → `withdraw_kabumori_service` |
| **X自動投稿の利用を終了** | X only | — | unchanged: the X app's own `social-mobile-account-delete` saga (X-owned; not edited here) |
| **共通アカウントを削除** | every service (X first, then Kabumori), every session, the Apple grant, Storage, then the login itself | nothing | `account-delete` action `delete_common_account` → the orchestrator (§4) |

The old Kabumori entry "アカウントを削除" (one tap that hard-deleted the shared login with whatever other
service hung off it) no longer exists, in the UI or on the server.

## 2. Files

| Part | Files |
| --- | --- |
| Orchestrator (server) | `supabase/functions/account-delete/lifecycle_logic.ts` (flows, injected dependencies), `http.ts` (routing, real adapters), `index.ts` (entry) |
| Removed | `supabase/functions/account-delete/delete_logic.ts` + its test (the direct Auth Admin hard delete) |
| Database candidate | `supabase/migrations/20261009120000_common_account_deletion_completion.sql` (not applied) |
| Database proof | `supabase/tests/common_account_deletion_completion_{run.sh,behavior.sql,mutations.sh}` |
| Server tests | `supabase/functions/account-delete/{lifecycle_logic_test,http_test,wiring_test}.ts` |
| Client | `src/lib/account-deletion.ts` (pure logic), `src/lib/account-deletion-client.ts` (network, fresh sign-in), `src/components/account-lifecycle-views.tsx` (both screens), `src/app/settings.tsx`, `src/lib/settings-menu.ts`, `src/components/service-access-screen.tsx` (resume), `src/lib/auth.ts` (`signOutThisDevice`) |
| Client tests | `tests/app/account-deletion_test.ts`, `tests/app/settings-menu_test.ts` |

## 3. Server API (`POST /functions/v1/account-delete`, JSON body, platform JWT verification ON)

The person is always the owner of the bearer token (`GET /auth/v1/user`). No request field names a user;
ids in a body are ignored. Every answer is `{ok:true, …}` or `{ok:false, error, reasons?, sessions_revoked?}`
with fixed codes only. Nothing is logged.

| `action` | Needs | Success | Notes |
| --- | --- | --- | --- |
| `preview` | a valid token | `account_status`, `lifecycle_version`, `services[{service,status}]`, `blockers` (fixed codes), `deletion_in_progress`, `apple{required,supported,code_required}`, `x_cleanup` (`not_needed`/`supported`/`unsupported`) | read-only; the confirmation screen and the resume path |
| `withdraw_kabumori` | `confirmation:"END_KABUMORI_SERVICE"`, recent sign-in | `outcome: ended / already_ended / not_registered` | refused (`WITHDRAW_BLOCKED` + `ACCOUNT_DELETION_IN_PROGRESS`) while a whole-account deletion is open: that flow ends Kabumori itself, after X |
| `delete_common_account` | `confirmation:"DELETE_COMMON_ACCOUNT"`, recent sign-in, `expected_lifecycle_version` (from the preview), `apple_authorization_code` when Apple applies | `outcome: deleted` — only after the post-delete read-back verified it | §4 |
| anything else, **including the legacy call with no body** | — | `400 ACTION_REQUIRED` | decided before any environment read or network request: the legacy call deletes nothing |

**Recent sign-in** = the X saga's rule, reused from its module: the newest `amr[].timestamp` of the
server-verified token is at most 600 s old (and not in the future), and `sub` is the verified user.
Kabumori obtains it by a password sign-in in a **separate, memory-only Supabase client** (own storage key,
no refresh timer): the app's own session, its auth events and its Phase 2 service gate are untouched. The
address used is the signed-in one; nothing is typed or looked up, so the screens enumerate nothing. A
fresh sign-in that resolves to another person is refused locally and ended.

Error codes: `AUTH_REQUIRED`, `ACTION_REQUIRED`, `CONFIRMATION_REQUIRED`, `REAUTH_REQUIRED`,
`LIFECYCLE_VERSION_REQUIRED`, `LIFECYCLE_CHANGED`, `DELETION_BLOCKED`(+reasons), `APPLE_REAUTH_REQUIRED`,
`APPLE_REVOCATION_UNAVAILABLE`, `APPLE_REVOKE_FAILED`, `X_CLEANUP_UNSUPPORTED`, `X_CLEANUP_IN_PROGRESS`,
`X_CLEANUP_BLOCKED`, `X_CLEANUP_FAILED`, `SERVICE_CLEANUP_INCOMPLETE`, `SESSION_REVOKE_FAILED`,
`STORAGE_CLEANUP_FAILED`, `STORAGE_NOT_EMPTY`, `STORAGE_BUCKET_OWNED`, `NOT_READY`(+reason),
`AUTH_DELETE_FAILED`, `AUTH_DELETE_UNCONFIRMED`, `DELETION_VERIFICATION_PENDING`, `WITHDRAW_BLOCKED`,
`WITHDRAW_INTERRUPTED`, `WITHDRAW_INCOMPLETE`, `FAILED`. Reasons are drawn from a fixed list; anything
else is `UNKNOWN`. `sessions_revoked:true` on a failure means every session is already gone: the app
signs out and the person signs in again to resume.

## 4. Whole-account deletion: the orchestrator

| # | Step (Phase 1 §10) | Call | Durable state | Repeated on retry? | Failure |
| --- | --- | --- | --- | --- | --- |
| 0 | verify caller, confirmation, recent sign-in, version present | `GET /auth/v1/user` | — | yes | 401 / 400 / 403 |
| 1 | read-only pre-checks: Apple code/config; X saga scope is `social_only` | `common_account_deletion_eligibility`, X `preview` | — | yes | `APPLE_*`, `X_CLEANUP_UNSUPPORTED` — before anything changes |
| 2 | begin, bound to the version shown | `begin_common_account_deletion(user, expected)` | account `deleting`; operation `in_progress` | resumes the same operation, **only at the version shown now** | `LIFECYCLE_CHANGED`, `DELETION_BLOCKED` |
| 3a | X service | `begin_service_deletion(x_autopost)` → X saga `delete` (scope `social_only`) → `finish_service_deletion` | X entitlement `deleting` → `ended`; the saga's own tombstone/lease | resumes from the X tombstone; skipped once `already_ended` | `X_CLEANUP_*`, `SERVICE_CLEANUP_INCOMPLETE` |
| 3b | Kabumori service | `withdraw_kabumori_service` | entitlement `ended`, profile removed (cascade) | idempotent (`already_ended`) | `DELETION_BLOCKED`, `SERVICE_CLEANUP_INCOMPLETE` |
| 3c | every entitlement ended (read back) | eligibility | — | yes | `SERVICE_CLEANUP_INCOMPLETE` |
| 4 | sessions | `POST /auth/v1/logout?scope=global` (person's token) → checkpoint `session_revocation` | checkpoint | **yes** (a retry needed a new sign-in, i.e. a new session) | `SESSION_REVOKE_FAILED` (no checkpoint) |
| 5 | Apple (identity present) | `revokeAppleGrant` (X module, reused) → checkpoint `apple_revocation` | checkpoint | **no** — the code is single-use; skipped once recorded | `APPLE_REVOKE_FAILED` (no checkpoint) |
| 6 | Storage | `common_account_deletion_storage_objects` → Storage API `DELETE /storage/v1/object/{bucket}` → list again (≤ 3 removal passes per request) → checkpoint `storage_cleanup` | checkpoint | yes (idempotent) | `STORAGE_NOT_EMPTY` / `STORAGE_CLEANUP_FAILED` / `STORAGE_BUCKET_OWNED`; the checkpoint is withdrawn (`clear_common_account_deletion_checkpoint`) |
| 7 | prepare | `prepare_common_account_auth_delete` | step `ready_for_managed_auth_delete` bound to version/epoch/checkpoints | yes | `NOT_READY`, `DELETION_BLOCKED` |
| 8 | revalidate immediately before the delete | Storage listed again (must be empty) + `prepare` again (must be ready for this operation) | — | yes | `STORAGE_NOT_EMPTY` (checkpoint withdrawn), `NOT_READY` |
| 9 | managed Auth delete | `DELETE /auth/v1/admin/users/{id}` (service role) — never SQL | the guard closes the operation as `login_removed` (`LOGIN_REMOVED_WHILE_READY_UNVERIFIED`) | — | non-2xx/non-404 → `GET /auth/v1/admin/users/{id}`: present → `AUTH_DELETE_FAILED` (retryable); unknown → `AUTH_DELETE_UNCONFIRMED`; absent → continue |
| 10 | post-delete read-back | `complete_common_account_deletion` (new) | operation `completed` + `verified_at` | — | Storage residue (a still-valid token uploaded after step 8) is removed once more and verified again; anything else → `DELETION_VERIFICATION_PENDING`. **Success is only ever a verified completion.** |

Only two consecutive `ready_for_managed_auth_delete` answers for this operation (step 7 and step 8)
reach step 9; the static and behavior tests pin that there is exactly one call site for the managed
delete and that every precondition precedes it. A 404 from Auth Admin is verified like any other delete,
never assumed. Every failure after step 2 stores its fixed code on the operation
(`record_common_account_deletion_error`) for an operator.

**Concurrency.** Two requests for one person share the one durable operation (`begin` answers
`in_progress`); the X saga's lease turns a concurrent X step into `X_CLEANUP_IN_PROGRESS`; withdrawal,
checkpoints, Storage removal and `prepare` are idempotent; `prepare` decides under the exclusive login
lock; a second managed delete gets 404 and is verified. A service start that commits after the preview
moves the version, so the confirmation is stale (`LIFECYCLE_CHANGED`); once `begin` committed, every
start answers `ACCOUNT_DELETION_IN_PROGRESS` (Phase 1 races 1/2/7, re-run here as race 5c).

## 5. Session revocation and the stale-token policy

Step 4 revokes every session (refresh token) of the login. Access tokens already issued are signed JWTs
that PostgREST and Storage accept until they expire (the project's JWT expiry, 1 h by default). What stops
them:

| A still-valid token tries to … | After `begin` (step 2) | After the managed delete (step 9) |
| --- | --- | --- |
| start or restart a service (`start_*`, `reactivate_*`) | refused `ACCOUNT_DELETION_IN_PROGRESS` | refused (no login row) |
| write Kabumori rows (stocks, alerts, push tokens, …) | fails once Kabumori ended: every table references `profiles`, which is gone | same |
| re-create a profile (`ensure_my_profile()`, or a direct `insert` allowed by `profiles_insert_own`) | **not gated** (legacy creator) — `prepare` then refuses (`UNREGISTERED_SERVICE_FOOTPRINT`) | the row would reference a missing login: refused by its foreign key |
| create an X workspace (onboarding RPC / `x-oauth-connect-user`) | **not gated**; the X saga's tombstone guard only covers the saga's own window — `prepare` refuses afterwards | `brands` survives a login delete: the read-back answers `RESIDUAL_SERVICE_DATA` → `DELETION_VERIFICATION_PENDING` (operator) |
| upload to Storage | the revalidation (step 8) catches it before the delete | `owner_id` is plain text, so the object survives: the read-back finds it, the orchestrator removes it through the API and verifies again |
| call this function again | needs a recent sign-in; a revoked session cannot refresh, and Auth's `GET /auth/v1/user` is expected to refuse a token whose session was removed (to be confirmed in runbook step 6) | the login is gone |

The two "not gated" rows are enforcement prerequisites (§9), not Phase 3a defects: they are caught by
evaluation (step 7/8) or by the read-back (step 10), never reported as a completed deletion.

## 6. Storage

The Storage API cannot list by owner, so the candidate adds a read-only, `service_role`-only inventory
(`common_account_deletion_storage_objects`): `(bucket_id, name)` of objects whose `owner_id` (or the
deprecated `owner`) is the person, at most 1000 per call with `more`, and `buckets_owned`. An unexpected
shape or any read failure is `unknown_shape` / `probe_failed`, never "empty". Removal happens **only**
through `DELETE /storage/v1/object/{bucket}` with the service role; the list is read again until it is
empty. A bucket owned by the person is refused (`STORAGE_BUCKET_OWNED`, operator). Kabumori and X store
no user-owned objects today (repository inventory: only `x-test-post` uses Storage, with the service
role), so this is normally one empty list.

## 7. Apple

The Kabumori app has no Sign in with Apple and therefore cannot obtain the authorization code a
revocation needs. A person with an Apple identity (from the X app) gets, before anything changes,
`APPLE_REAUTH_REQUIRED` (no code) or `APPLE_REVOCATION_UNAVAILABLE` (server not configured); the preview
says so and the screen shows a "contact us" message instead of a delete button. The server side is
complete for a client that can send the code (the X app later): it reuses the X module's
`revokeAppleGrant` (code exchanged, subject checked against the person's Apple identities, grant revoked),
records `apple_revocation` once, and never repeats it.

## 8. X boundary (no X file edited)

- Adapter: `XServiceCleaner { preview(token), run(token) }`, implemented in `http.ts` as two calls to the
  existing `social-mobile-account-delete` function with the person's own token — exactly what the X app
  sends (`{action:'preview'}`, `{action:'delete', confirmation:'DELETE_MY_ACCOUNT', expected_scope:'social_only'}`).
  The saga keeps all of its semantics: X OAuth token revocation of exactly the bound credential set,
  SHA-256 fingerprint check, Vault purge, posting authority off first, operator states, lease.
- Order: X **before** Kabumori. The saga's scope is `social_only` only while a Kabumori `profiles` row
  exists; in `social_and_login` its `finalize` deletes `auth.users` by SQL (a legacy route, §9). The
  orchestrator refuses (`X_CLEANUP_UNSUPPORTED`) whenever the saga would not keep the login, and treats a
  saga answer `login_deleted:true` as unverifiable (`DELETION_VERIFICATION_PENDING`, no further step).
- Wrapping: `begin_service_deletion('x_autopost')` before, `finish_service_deletion` after (the latter
  ends the entitlement only when no X footprint remains).
- G4 overlap: none. G4's PR #106 touches `20261007150000_postona_social_accounts_multi_provider.sql`, its
  tests, `migration_source_invariants_test.ts` and a POSTONA doc, and pins the owner/ACL of
  `social_mobile_account_deletion_guard()`. This slice edits none of those and no X schema, migration or
  function; it only imports two pure exports of the X module (`lastAuthenticatedAt`/`RECENT_AUTH_SECONDS`,
  `CONFIRMATION`) and `apple_revoke.ts`.
- Named follow-ups (X-owned, need G3/G4 coordination): (X1) make the saga's scope lifecycle-aware or drop
  its own login delete (Phase 1 §14) — then X-only people and a person who ended Kabumori first can be
  deleted through the orchestrator; (X2) the X app's own "delete" calls this orchestrator for the
  whole-account case and sends the Apple code; (X3) deploy `social-mobile-account-delete` (still
  undeployed) — until then the X adapter answers `failed` and a person with an X entitlement gets
  `X_CLEANUP_UNSUPPORTED` at the preview, before anything changes.

## 9. Enforcement readiness inventory (nothing switched on)

An enforcing Auth-delete guard is safe only when **every** row below is wired. Status after Phase 3a:

**Service creators**

| Creator | Gated by the lifecycle? |
| --- | --- |
| `start_kabumori_service()` / `start_x_autopost_service()` / `reactivate_*_service(v)` | yes (Phase 1/2) |
| `ensure_my_profile()` (authenticated, still granted) | **no** — Kabumori no longer calls it (Phase 2), any token can |
| direct `insert into profiles` (`profiles_insert_own` policy + `grant insert … to authenticated`) | **no** |
| X workspace: `begin_social_mobile_x_oauth_connection` via `x-oauth-connect-user` | **no** (Phase 1 §17: needs a lifecycle assertion first) |
| `private.account_lifecycle_backfill` | operator only; takes the lifecycle locks |

**Login delete routes**

| Route | Status |
| --- | --- |
| Kabumori `account-delete` **as deployed in production** (recorded as live in `apps/social-mobile/docs/account-deletion-rollout-runbook.md`; not re-read here) — no body → `DELETE /auth/v1/admin/users/{id}` | **unsafe until this source is deployed**; confirm the deployed bundle read-only in runbook step 2 |
| Kabumori `account-delete` (this source) | lifecycle orchestrator only; legacy call → `ACTION_REQUIRED` |
| X saga `social_mobile_account_deletion_finalize`, scope `social_and_login` (`delete from auth.users` in SQL) | **not lifecycle-gated** (X-owned, follow-up X1); pinned by `wiring_test.ts` as the only SQL login delete |
| Supabase Dashboard / operator `auth.admin.deleteUser` | outside the app; the shadow guard only observes |

**Service-role producers (bypass RLS; no entitlement predicate yet)** — `claim_pending_push_notifications`,
`enqueue_important_news_notifications`, `enqueue_personalized_report_notification`,
`personalized_report_news_inputs`, `important_news_app_copy_targets`, `personalized-reports`,
`send-push-notifications`, `x-test-post`, `important-news-*`, `news-discovery-observer`,
`market-intelligence-ingest`, `social-mobile-history-learning`. Kabumori producers read rows that cascade
from `profiles`, so a withdrawn person has none; an entitlement predicate is still required before
enforcement (Phase 1 §15 step 7).

**RLS / API / Edge boundaries** — Kabumori tables: own-row RLS (`auth.uid()`) + foreign key to `profiles`,
no entitlement predicate. X tables: membership-based, no entitlement predicate. Edge Functions that act
on a person's token: `account-delete`, `social-mobile-account-delete`, `x-oauth-connect-user`,
`x-test-post`, `social-mobile-consult`, `social-mobile-publish-setting`, `social-mobile-brand-dry-run`,
`social-mobile-history-learning` — none checks an entitlement yet.

**Stale-JWT writer paths** — §5 table. Required before enforcement: gate `ensure_my_profile` and the
direct profile insert (revoke, or route through `start_kabumori_service`), add the lifecycle assertion to
the X onboarding RPC, and decide a short access-token lifetime or a server-side session check for writers.

**Entitlement checks required** — Kabumori: today only the client gate (`serviceSession`); needed in RLS
for user tables and in every producer above. X: today only the X client gate; needed in the onboarding
RPC, the posting producers and the X Edge Functions.

**Readiness invalidators (Phase 1 §6 rows 9–14)** — still evaluation-only. Rows 13–14 (Apple identity,
Storage) are now handled by the orchestrator (checkpoint + re-list + read-back), but not by a durable
version move.

**Cross-service session effect (finding)** — Kabumori's normal `signOut()` uses the SDK default
`scope: 'global'`, which also signs the person out of the X app on the same login. Phase 3a uses
`scope: 'local'` after a withdrawal/deletion; changing the normal logout is a product decision (reported).

## 10. Database candidate `20261009120000_common_account_deletion_completion.sql`

- Replaces exactly one Phase 1 rule (an account deletion could never be `completed`) with: `completed` is
  allowed for an account deletion only with `verified_at`, a cleared `user_id` and a standing readiness
  (`current_step = ready_for_managed_auth_delete`); `verified_at` only on a completed account deletion.
- `complete_common_account_deletion(user, operation)`: finds the operation by id **and** the subject hash
  of the verified person; `login_present` while the login exists; completes only a `login_removed`
  operation that was ready when the login disappeared, with no account/entitlement row, no Kabumori/X/admin
  footprint and no Storage ownership left; otherwise `not_verified` + fixed reason kept on the operation.
  READ COMMITTED only; it waits for an uncommitted login removal (operation row lock).
- `common_account_deletion_storage_objects(user, limit)` (§6) and `record_common_account_deletion_error`.
- `service_role` only; SECURITY DEFINER, empty `search_path`; no write to auth/storage/vault, no e-mail,
  guard stays `shadow`, nothing else altered (the runner diffs the whole catalog).
- Proof (disposable PostgreSQL 17 only): preflight refusals (no Phase 2, changed rule, no settings row),
  exact change, refused re-apply, static rules, Phase 2 behavior suite unchanged, behavior A–H
  (Kabumori-only and dual-service flows with the real X saga, paged Storage inventory and re-list, four
  post-delete residues never completed, identity, table-level shape, grants), races (removal vs read-back
  in both orders; start vs begin in both orders). Mutation suite: 19 single-property breaks, all detected
  by name.

## 11. Client behavior (exact outcomes)

- **Settings**: two destructive entries, 「かぶモリの利用を終了」 (keeps the login and other services) and
  「共通アカウントを削除」 (warns that every service on the ID is affected).
- **Withdrawal screen**: lists what is deleted and what stays, asks for the password, confirms in a dialog.
  Success → dialog, then **this device only** signs out (`signOutThisDevice`, scope `local`): readiness is
  cleared at once; the next sign-in answers `reenroll_required` (Phase 2) and nothing restarts by itself.
  Failure → message, nothing claimed.
- **Deletion screen**: loads the preview with the app's own session; shows the services that will end,
  the X authorization revoke, the login and all sessions; refuses up front (message, no button) for
  blockers, Apple, or an X cleanup that cannot keep the login. Requires the password and typing 「削除」,
  then a dialog. Success (verified) → dialog, sign out. `sessions_revoked` or pending verification →
  dialog with the honest message, sign out. `LIFECYCLE_CHANGED` → the preview is reloaded and the person
  confirms again. Other failures → message; retry is possible.
- **Resume**: while a deletion is open the app stays closed (`ACCOUNT_DELETION_IN_PROGRESS`); that screen
  now offers 「削除手続きを続ける」, and the `reenroll_required` screen offers 「共通アカウントを削除する」.
- Not changed: the public page `apps/kabumori-web/pages/account-deletion.html` still describes the old
  single entry. It must be updated **together with the app release** that ships these screens (it is
  published from `main`), not before.

## 12. Rollout runbook (not executed; every step needs K5 / explicit approval)

1. Independent review of this source (DB/RPC/Auth/deletion boundary).
2. Read-only production preflight: Phase 1 + Phase 2 objects and ACLs as reviewed, the Phase 1
   "completed" rule present exactly once, guard `shadow`, no `verified_at` column, no open
   `account_deletion` operation.
3. Apply `20261009120000` as a single reviewed file (never `db push`); read back columns, the two rules,
   the four functions and their exact ACLs.
4. Deploy `social-mobile-account-delete` (X-owned decision) or accept that X people get
   `X_CLEANUP_UNSUPPORTED` until it is.
5. Deploy `account-delete` from a checkout that has `supabase/config.toml` (byte-verify the deployed
   bundle). From this moment the legacy hard delete is gone; an old app build gets `ACTION_REQUIRED` and
   shows its generic failure — it can no longer delete anything.
6. Disposable real-project proof (Phase 1 §10 prerequisite): one throwaway login per flow — withdrawal,
   Kabumori-only deletion, dual-service deletion with a fake X grant, a Storage object, Auth delete failure
   injection; read back every table, Storage, Auth.
7. App release with these screens; update the public deletion page at the same time.
8. Rollback: redeploy the previous function bundle only if the migration is not yet relied upon; the
   migration is additive except the replaced rule, and a rollback must refuse while any
   `completed` account deletion exists.

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

## 14. Known limits and next slice

- X-only people and a person whose Kabumori ended before X cannot be deleted through the orchestrator
  until follow-up X1 (fail closed: `X_CLEANUP_UNSUPPORTED`, nothing changes).
- A person stuck in `deleting` (X saga in an operator state, Storage that keeps refilling) can resume or
  contact support; there is no self-service cancel in this slice (`abort_common_account_deletion` exists
  for operators).
- A lost response after a successful managed delete leaves the operation `login_removed` / ready /
  unverified; the person can no longer call. An operator sweep (verify by subject hash) is a follow-up.
- Shadow guard only: a concurrent operator abort between the revalidation and the managed delete cannot be
  prevented (it is detected: the read-back answers `not_found`, never success).
- Not exercised on real Supabase: Auth `logout?scope=global`, `GET /user` with a revoked session, Admin
  delete/read, Storage `DELETE /object/{bucket}` with `prefixes` — all assumed from the documented APIs and
  only faked here; runbook step 6 must confirm each before deploy.
- Recommended next slice: X1 + X2 with G3/G4, then the creator gates of §9 (profile insert,
  `ensure_my_profile`, X onboarding assertion) as one reviewed migration, then the disposable real-project
  proof, then deploy.
