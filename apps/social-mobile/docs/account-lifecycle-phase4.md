# Account lifecycle / deletion / legal links — phase 4 + 4b + 4c (G3, 2026-09-28/29)

Source-only; nothing was applied, deployed or deleted (`production_mutation=0`).
- Production was only read: catalog SELECTs, no data rows.
- This adds a **new privileged account-deletion boundary**. Independent review is mandatory before merge, apply or deploy.
- Phase 4b fixes the H2 C2 FAIL findings R1–R6 and the client-context issue on PR #52 (reviewed head `12146c4`).

## 1. Release compliance inventory

External requirements, read 2026-09-28/29:
- **App Review 5.1.1(v).** An app that supports account creation must offer in-app account deletion.
  - The account record and its personal data must go; deactivation is not enough.
  - Deletion may take time if the user is told how long and is told when it completes.
  - Confirmation or re-authentication steps are allowed.
- **Sign in with Apple.** The app should revoke the user's tokens through the REST API when the account is deleted. An authorization code is single-use.
- **5.1.1(i).** A privacy policy link is required. **1.5.** Support contact is required. **4.8.** Social login needs an equivalent privacy-preserving option.
- **Supabase Edge Functions.** Browser callers need CORS: allow-origin `*`, headers `authorization, x-client-info, apikey, content-type`, and a preflight response.
- **X revoke.** `POST https://api.x.com/2/oauth2/revoke` with `token` and `client_id`; a confidential client adds `Authorization: Basic`.

State of the source before phase 4:

| item | state |
| --- | --- |
| social-mobile account deletion | none |
| social-mobile privacy, terms and support | none. No canonical social-mobile policy text exists; nothing is invented here |
| Sign in with Apple | source path exists; not enabled (`ios.bundleIdentifier` unset) |
| social-mobile Storage | none |

## 2. Production facts used (read-only catalog)

- **`brand_memberships` exists in production:**
  - FK brand_id → brands ON DELETE CASCADE, and FK user_id → auth.users ON DELETE CASCADE.
  - Its policy is self-select.
  - `phase4-membership-rls-contract.md` and the G4 phase 3 STOP report say "not applied"; both are stale.
- **Cascade from `auth.users`:** `profiles.id` (Kabumori main-app data, with its own cascades) and `admin_users.user_id`.
- **NO ACTION:** every reference to `brands`, `social_accounts` or `scheduled_posts`, except `brand_memberships` and `daily_content_plans`.
- **Vault:** `vault.secrets` and `decrypted_secrets` are owned by supabase_admin. `postgres` has SELECT and DELETE (H2 read-back). The candidate functions do not pin an OWNER, so apply must verify it.

## 3. Cross-product scope (H2 R2)

The Supabase login is shared with the Kabumori main app. The model is the least destructive one that still deletes the whole account where it belongs only to this app.

| scope | when | deleted | kept |
| --- | --- | --- | --- |
| `social_and_login` | no `profiles` row for the user | the login (`auth.users`, which cascades identities and sessions) and all social-mobile data | posts already on X; the pseudonymous audit trail |
| `social_only` | the user has Kabumori main-app data | all social-mobile data | the shared login and all Kabumori data; the user is told to delete the Kabumori account from the Kabumori app |

How the scope is kept honest end to end:
- The screen shows the server's `preview` scope.
- The delete request carries `expected_scope`; any difference refuses with `SCOPE_CHANGED`.
- `finalize` locks the `auth.users` row, re-checks `profiles` and deletes the login in the **same transaction**. There is no hidden cascade: if Kabumori data appeared meanwhile, the login is kept (`MAIN_APP_ACCOUNT_PRESENT`) and the result says so.
- The Apple grant is revoked only when the login itself is deleted.

Remaining Kabumori-side coordination (G1/G2, reported only): Kabumori's `account-delete` deletes the shared login and can orphan a social workspace, its X grant and its Vault secrets. It should refuse users with `brand_memberships`, or first run this deletion.

## 4. Durable deletion state machine (H2 R1)

`public.social_mobile_account_deletions` has one row per user in deletion. It holds:
- `user_id` and the derived `workspace_id`;
- `state`, `resume_state` and `operator_reason`;
- `scope`, `apple_required` and `apple_revoked_at`;
- the bound `credential_set` and `revoked_fingerprints`;
- `lease_token` and `lease_expires_at`.

RLS is on and no role has grants. The row is removed on completion, or by an operator cancel.

```
none --acquire--> started --X revoke + mark (fingerprints)--> x_revoked --[Apple checkpoint]--> purge --> purged --finalize--> (row removed)
started / x_revoked / purged --problem--> operator_required --operator: retry | x_revoked_out_of_band | cancel
```

- **Lease.** `acquire` gives a lease of 30–900 s (default 300). Every step must present the lease; otherwise it gets `LEASE_LOST`. A concurrent request gets `in_progress`. Failures release the lease, and it also expires on its own. The per-user advisory lock serializes each transaction.
- **Writer exclusion.** A `BEFORE INSERT OR UPDATE` guard trigger sits on `brands`, `brand_memberships`, `social_accounts`, `social_account_oauth_states`, `x_account_refresh_state_v2`, `x_account_refresh_rollout`, `scheduled_posts`, `publish_claims`, `published_content_fingerprints`, `post_execution_logs` and `posting_windows`.
  - For a `u_` workspace with a tombstone it raises `SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS`.
  - The only exception is the transaction holding the current lease (transaction-local setting; the lease is random and never leaves the server).
  - This covers X OAuth begin/complete (unmodified RPCs), credential refresh/rollout, posting, and workspace/account recreation during the purge → finalize gap.
  - A refresh that rotates Vault material also updates guarded rows in the same transaction, so it rolls back.
- **Snapshot race.** Any rotation that still gets through is caught: `mark_x_revoked` accepts only SHA-256 fingerprints equal to the current Vault material, and `purge` re-verifies them. A change goes to `operator_required CREDENTIALS_CHANGED`, never to an unrevoked purge.
- **Purge → login gap.** The tombstone stays in `purged` until `finalize`, and recreation fails closed. `finalize` deletes the login and the tombstone atomically. After the login is gone, recreation is impossible (membership FK).
- **Creation vs deletion serialization (phase 4c, H2 final finding).** One primitive is shared by both sides: a transaction advisory lock on the derived workspace id (`social_mobile_workspace:<u_…>`).
  - **Creation side.** The guard trigger takes the lock on every `INSERT` into `brands` or `brand_memberships` for a `u_` workspace, i.e. the first-onboarding / membership creation point.
    - It then reads the tombstone with a fresh snapshot.
    - Workspace creation outside READ COMMITTED is refused, because it could not see a newer tombstone.
    - The existing OAuth RPCs are unchanged.
  - **Deletion side.** `acquire` takes the same lock before any snapshot. The lease-holding steps and operator actions take it too.
  - **Onboarding started first and still uncommitted.** Deletion waits, then snapshots and deletes the new workspace. Success is reported with **zero orphans**.
  - **Deletion started first.** Onboarding waits, then fails closed.
  - **Lock order everywhere:** deletion lock → workspace lock → row / `auth.users` locks. Creators take the workspace lock before any FK key-share lock, so no cycle exists.
  - **finalize** re-checks, under both locks, that no row of the workspace exists (`WORKSPACE_REAPPEARED` → operator) before removing the login and the tombstone.
  - Proven by the runner's `ONBOARDING_FIRST` / `DELETION_FIRST` races, with deadlock detection.
- **Posting off first.** Pending posts are locked, and running posts, publishing claims and refreshing credentials block, all before the tombstone commits. Posting is disabled in the same transaction.

**Operator recovery** (`operator_resolve`, service_role, never called by the Edge Function):

| action | allowed from | effect |
| --- | --- | --- |
| `retry` | after fixing the data | resumes `resume_state`; re-binds the credential set only if resuming `started` |
| `x_revoked_out_of_band` | before purge | accepts the current material as revoked, after the operator revoked it at X |
| `cancel` | before purge | removes the tombstone; posting stays disabled |

## 5. Credential ownership invariant (H2 R3) and missing material (H2 R4)

The bound credential set is the ordered list of the workspace's X accounts (secret ids, platform user id, connection status) plus the OAuth verifier ids.

**Ownership.** Deletion refuses up front with `CREDENTIAL_OWNERSHIP_AMBIGUOUS`, before any external call, if any candidate secret id:
- is used twice inside the workspace (for example access = refresh);
- is referenced by another workspace's account;
- is referenced by an OAuth state outside the workspace or its accounts;
- is referenced by another account's refresh lease;
- or if a lease of the workspace's own account points at a different secret.

`credentials` and `purge` re-check this; a change goes to operator. Purge deletes only secret ids of the bound set.

**Revoke required.** An account needs revocation when it has any secret id, a `platform_user_id`, or status `connected` / `identity_verified`.
- If required and either token's material is missing or empty, the result is `operator_required CREDENTIAL_MATERIAL_MISSING`, never a skip.
- A truly never-connected account (no ids, no platform id, pending/unconnected status) proceeds without revocation.

## 6. Retry semantics

- **X.** The Edge Function revokes the refresh token, then the access token, for exactly the material `credentials` returned. It then reports their SHA-256 values. Once `x_revoked`, a retry never revokes again.
- **Apple (R5).** This applies only to `social_and_login` for users with an Apple identity.
  - The Edge Function exchanges the fresh native code. The `id_token` subject must be the user's own Apple identity. It then revokes and records the durable `apple_revoked_at` checkpoint.
  - A retry after a later failure skips Apple and needs no code.
  - If the checkpoint was not recorded, a fresh same-user native code is required.
  - The app drops the code after every attempt (codes are single-use), and after Apple failures it requires a fresh re-authentication.
- **Lost final response.**
  - `social_and_login`: the retry's token no longer resolves (`AUTH_REQUIRED`), and the message says the deletion may already be complete.
  - `social_only`: the retry simply completes again.

## 7. Edge Function, platforms and CORS (H2 R6)

`POST` accepts two actions:
- `{action: 'preview'}` is read-only: scope, state and Apple needs.
- `{action: 'delete', confirmation: 'DELETE_MY_ACCOUNT', expected_scope, apple_authorization_code?}` performs the deletion. It requires recent authentication: `sub` equals the verified user and the newest `amr` is at most 600 s old.

`OPTIONS` answers 204 with CORS headers, and every response carries them.

**Supported:**
- iOS app: all methods, including Sign in with Apple.
- Android app and Expo web: email, X and Google re-authentication.

A Sign in with Apple user whose **login** would be deleted is told to use the iPhone app, because the browser cannot produce the native authorization code.

## 8. App UX

The login-methods screen links to support, terms and privacy, and to account deletion.

The deletion screen:
1. Loads the server preview.
2. Shows the scope-exact lists of what is deleted and kept.
3. Requires a fresh sign-in with the user's own method. It is Apple-only when an Apple code is needed.
4. Pins that confirmation to the exact user and session. A switch shows the confirmation as missing, and the provider refuses with `SESSION_CHANGED` before any request.
5. Requires typing 「削除する」.
6. Reports success only on `200 {ok:true}`, with a result text that states what happened to the login. It then signs out locally.

Until the build sets `EXPO_PUBLIC_ACCOUNT_DELETION_ENABLED=true`, the screen says 準備中 and shows the support link if configured.

Legal link configuration (`EXPO_PUBLIC_PRIVACY_POLICY_URL`, `EXPO_PUBLIC_TERMS_URL`, `EXPO_PUBLIC_SUPPORT_URL`, `EXPO_PUBLIC_SUPPORT_EMAIL`) accepts only valid https pages or a real e-mail address. Anything else is unavailable, never guessed.

## 9. Data classification (assumptions marked)

| data | on deletion |
| --- | --- |
| social workspace, X account rows, OAuth states, refresh state, schedule/history/logs/claims/fingerprints, Vault secrets | deleted. **Assumption:** no legal retention requirement; owner/legal decision |
| X grant | revoked at X |
| shared login | deleted only in `social_and_login` |
| Kabumori main-app data | never deleted by this flow |
| posts already published on X | kept (told to the user) |
| audit (`subject_sha256` of the user id + fixed codes + time) | kept. **Assumption:** retention period undecided. It is pseudonymous, not anonymous |
| Supabase backups/logs | outside app control. **Assumption:** covered by the privacy policy |
| issued access JWTs | still valid until expiry. Sensitive writers are blocked by the tombstone or the removed login; this is not claimed as instant invalidation |

## 10. Operator gates (none executed)

1. Independent review of the migration, the Edge Function and the client.
2. Single-file apply after approval (never `db push`).
   - Pin or verify the function OWNER.
   - Verify that owner can `DELETE` on `vault.secrets` and `auth.users`, and holds the trigger privileges on the guarded tables.
   - Read back the ACLs.
3. Deploy with JWT verification on and byte-verify. The function needs `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `X_CLIENT_ID` and `X_CLIENT_SECRET`. The Apple values (`APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_CLIENT_ID` = native bundle id, `APPLE_PRIVATE_KEY`) are needed only once Sign in with Apple is enabled.
4. Real-device E2E with disposable accounts:
   - both scopes;
   - a blocked case;
   - an X revoke;
   - a reconnect attempt during deletion;
   - a lost response;
   - Apple on iOS.
5. Owner/legal: history and audit retention; privacy policy, terms and support pages.
6. Kabumori-side coordination (§3).
7. Set `EXPO_PUBLIC_ACCOUNT_DELETION_ENABLED=true` and the legal URLs.

## 11. Tests

- **App.** `npm test` covers copy per scope, preview/result parsing, platform support, pinning, and provider behavior including the session switch.
- **Edge.** `deno test --no-check --no-lock --allow-read supabase/functions/social-mobile-account-delete/` covers the flows over a fake of the state machine: R4, the R5 retry, R6 CORS, the scope, and lease errors.
- **DB** (disposable local cluster only). `DEL_PGHOST=/private/tmp/<dir> DEL_PGPORT=<port> DEL_PGSUPER=<user> supabase/tests/social_mobile_account_deletion_run.sh` applies the fixture, the **real** onboarding RPC migrations and the candidate. It proves:
  - ACL;
  - blocked cases, including R3 shared/duplicate/foreign-verifier secrets;
  - the scope model;
  - the R1 reconnect-after-snapshot and purge→login-gap interleavings, plus every guarded writer;
  - vault rotation handling;
  - R4 operator paths;
  - the R5 checkpoint;
  - unexpected dependents;
  - audit hygiene;
  - acquire/acquire and acquire/reconnect races;
  - onboarding-first (uncommitted) and deletion-first first-onboarding races, with zero orphans and no deadlock;
  - the isolation guard.
