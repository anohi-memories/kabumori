# Account lifecycle / deletion / legal links — phase 4 (G3, 2026-09-28)

This change is source-only.

- Nothing is deployed or applied: no migration apply, no Edge deploy, no real user deletion, no Auth or console change. `production_mutation=0`.
- Production was only read: catalog SELECTs, with no data rows read.
- It adds a **new privileged account-deletion boundary** (a service_role migration candidate and an Edge Function candidate). Independent review is mandatory before merge, apply or deploy.

## 1. Release compliance inventory

External requirements, as read on 2026-09-28:

- **App Review 5.1.1(v).** An app that supports account creation must offer account deletion inside the app.
  - The whole account record and its personal data must be deletable; deactivation is not enough.
  - The option must be easy to find, typically in account settings.
  - Deletion does not have to be immediate if the app says how long it takes and confirms completion.
  - Confirmation or re-authentication steps are allowed.
  - Legally required retention must be told to the user.
- **Sign in with Apple.** Apps that support it should revoke the user's tokens through the Sign in with Apple REST API when the account is deleted.
- **5.1.1(i).** A privacy policy link is required in App Store Connect and inside the app.
- **1.5.** An easy way to contact support is required.
- **4.8.** An app offering third-party social login must also offer an equivalent privacy-preserving option; Sign in with Apple qualifies.
- **Supabase.** `auth.admin.deleteUser` needs the service role and runs server-side only. A user who owns Storage objects cannot be deleted until they are removed.

State of the source before this change:

| item | state |
| --- | --- |
| social-mobile account deletion | **none** (no UI, no function) |
| Kabumori main-app `account-delete` function | exists (hard-deletes the auth user). See the gap in §6 |
| privacy / terms / support for social-mobile | **none**; no canonical social-mobile policy text exists (the Kabumori web pages are Kabumori-specific) |
| Sign in with Apple | source path exists; not enabled (`ios.bundleIdentifier` unset) |
| social-mobile Storage | none (media screen is mock-only; the single production bucket is not social-mobile) |

## 2. Production facts used (read-only catalog, 2026-09-28)

- `brand_memberships` **exists in production**: PK (brand_id, user_id), FK brand_id → brands ON DELETE CASCADE, FK user_id → auth.users ON DELETE CASCADE, role CHECK owner/admin/member/viewer, policy `social_mobile_membership_self_select`.
  - This contradicts `phase4-membership-rls-contract.md` ("not applied") and the G4 phase 3 STOP report. Both are stale on this point.
- The onboarding RPCs `begin_ / consume_ / complete_social_mobile_x_oauth_connection` exist, and so does `read_social_mobile_history_access_token`.
- `social_mobile_content_settings`, `post_queue_account_turns_v2` and `post_queue_attempts_v2` do **not** exist.
- References with ON DELETE:
  - **CASCADE:** `brand_memberships` (both FKs), `daily_content_plans.brand_id`, `social_account_oauth_states.initiated_by_user_id`, `profiles.id`, `admin_users.user_id`.
  - **NO ACTION:** every other reference to `brands`, `social_accounts` or `scheduled_posts`. That covers `social_accounts`, `social_account_oauth_states`, `scheduled_posts`, `post_execution_logs`, `posting_windows`, `publish_claims`, `published_content_fingerprints`, `x_account_refresh_state_v2`, `x_account_refresh_rollout`, `brand_settings`, the report settings/runs tables and `interaction_post_metrics`.
- Deleting only the auth user therefore removes the membership but **leaves** the user's `u_…` workspace, its X account row, the Vault token secrets, and the X grant itself (unrevoked).

## 3. Data classification (assumptions marked)

| data | where | on deletion |
| --- | --- | --- |
| Auth user, identities, sessions | `auth.users` | deleted (admin API, last step) |
| workspace membership, oauth states keyed to the user | `brand_memberships`, `social_account_oauth_states` | deleted (cascade and purge) |
| own workspace `u_<md5(uid)[0:24]>` (`code_profile_key = social_mobile_user_v1`) | `brands` (+ `daily_content_plans` cascade) | deleted |
| X posting account and its tokens | `social_accounts`, Vault secrets | tokens **revoked at X**, secrets deleted, row deleted |
| schedule / history | `scheduled_posts`, `post_execution_logs`, `posting_windows`, `publish_claims`, `published_content_fingerprints` | deleted (**assumption:** no legal retention requirement; needs an owner/legal decision) |
| credential refresh state | `x_account_refresh_state_v2`, `x_account_refresh_rollout` | deleted |
| posts already published on X | X | **not deleted.** The user is told to delete them on X |
| deletion audit | `social_mobile_account_deletion_audit` | **retained**: SHA-256 of the user id plus fixed step/reason codes and a timestamp. **Assumption:** the retention period is undecided |
| platform backups / logs | Supabase | outside app control (**assumption:** covered by the privacy policy) |
| on-device onboarding flag | AsyncStorage | removed after a confirmed deletion |
| Kabumori main-app data of the same auth user | `profiles` and its dependents | cascades from the auth user |

Unexpected dependents, such as a `brand_settings` or report row on a `u_` workspace, abort the purge atomically (fail closed).

## 4. Deletion architecture (candidate)

The client calls the `social-mobile-account-delete` Edge Function (JWT verification on) with the user's access token.

**Pre-checks.** These have no side effects:

1. The user is taken from `GET /auth/v1/user` with the caller's own token. The body never names a user.
2. The body must carry `confirmation = DELETE_MY_ACCOUNT`.
3. Recent auth is required: the JWT `sub` equals the verified user, and the newest `amr` timestamp is at most 600 s old. The app obtains this with a fresh sign-in through one of the user's own methods, which must end as the same user or the app signs out.
4. Sign in with Apple users: refused (`APPLE_REVOCATION_UNAVAILABLE`) unless the Apple key is configured. A fresh native `authorizationCode` is also required.

**Sequence.** Each step is idempotent and serialized per user by an advisory lock:

| # | step | what it does |
| --- | --- | --- |
| 1 | `social_mobile_account_deletion_begin(uid)` (service_role only) | Blocks on `ADMIN_ACCOUNT`, `OWNS_OTHER_WORKSPACE`, `WORKSPACE_NOT_SELF_SERVICE`, `SHARED_WORKSPACE` (another member exists), `WORKSPACE_ROLE_MISMATCH`, `POSTING_IN_PROGRESS` (running post or publishing claim) or `CREDENTIAL_REFRESH_IN_PROGRESS`. Otherwise it **turns posting authority off first**: the workspace becomes inactive and `disabled`, `publish_enabled` becomes false, the refresh rollout goes to `off`, and pending posts become `failed`. A plain member of someone else's workspace is allowed; that workspace is never touched. |
| 2 | `…_credentials(uid)` | Returns the X tokens of the user's own workspace only, and only after step 1. |
| 3 | X revoke | `POST https://api.x.com/2/oauth2/revoke` for the refresh token, then the access token. Any failure stops here (`X_REVOKE_FAILED`); posting is already off and a retry is safe. |
| 4 | Apple revoke (SIWA users) | Exchanges the code at `appleid.apple.com/auth/token` with an ES256 client secret. The returned `id_token` subject must be one of the user's own Apple identities, otherwise nothing is revoked. Then it calls `/auth/revoke`. |
| 5 | `…_purge(uid)` | Re-checks everything. It then deletes, in FK order: refresh state → rollout → oauth states → fingerprints → claims → logs → windows → posts → X accounts → Vault secrets → workspace. Any unexpected dependent row aborts the whole purge. |
| 6 | `DELETE /auth/v1/admin/users/{uid}` | Removes the auth user. `404` counts as success. |

**Responses.** Only fixed codes are returned. Tokens, keys and server messages are never returned or logged. The app shows "deleted" only on `200 {ok:true}`, then signs out locally.

**Audit.** Each step writes to `social_mobile_account_deletion_audit`. This is best effort and never changes the outcome.

**Retry.** Every step is repeat-safe. For example, a second purge answers `nothing_to_purge`, and a second auth delete gets `404`, which counts as success.

## 5. App UX and configuration

**Login-methods screen.** It gains two cards:
- 「サポートと規約」: privacy policy, terms and support. Each shows 開く, or 準備中 when not configured.
- 「アカウントの削除」: a button that opens the deletion screen.

The developer-only diagnostics add `legal: …` and `account-deletion: …` status codes.

**Account deletion screen.** In order, it shows:
- What is deleted and what is kept, including that posts already on X are not deleted.
- The timing: immediate and irreversible.
- Step 1, re-authentication with the user's own usable method.
- Step 2, typing 「削除する」.
- Server-confirmed success, followed by an alert and local sign-out.

Until the build enables deletion, the screen says 準備中 and offers the support link if one is configured.

**Configuration.** All values are `EXPO_PUBLIC_*`, and missing or invalid means unavailable:

| variable | rule |
| --- | --- |
| `EXPO_PUBLIC_PRIVACY_POLICY_URL`, `EXPO_PUBLIC_TERMS_URL`, `EXPO_PUBLIC_SUPPORT_URL` | https only; no userinfo or port; no placeholder, local or IP hosts; no credential-like query or fragment |
| `EXPO_PUBLIC_SUPPORT_EMAIL` | used when no support page is set |
| `EXPO_PUBLIC_ACCOUNT_DELETION_ENABLED` | must be exactly `true` |

## 6. Existing Kabumori `account-delete` gap (other lane, reported only)

A social-mobile user calling the main-app `account-delete` function, or a Kabumori user who also used social-mobile, would lose only the auth user. The workspace, X account, Vault secrets and X grant would stay.

- The orphaned `platform_user_id` would also block reconnecting that X account later.
- It belongs to G1/G2. The recommendation is that `account-delete` refuse users with a `brand_memberships` row, or delegate to this boundary.

## 7. Operator gates before enabling (none executed)

1. Independent review (Opus 5.5 high, separate worktree) of the migration, the function and the client.
2. Single-file apply of `20260928160000_social_mobile_account_deletion_candidate.sql` after approval (never `db push`).
   - Then read back the grants.
   - Confirm that the function owner can `delete from vault.secrets` in production.
3. Deploy `social-mobile-account-delete` with JWT verification on and byte-verify it. It needs `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `X_CLIENT_ID` and `X_CLIENT_SECRET` (the same X client as `x-oauth-connect-user`).
   - The Apple values (`APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_CLIENT_ID`, `APPLE_PRIVATE_KEY`) are needed only when Sign in with Apple is enabled. Without them, Apple users are refused, never partially deleted.
4. Real-device E2E with a disposable test account. It covers:
   - blocked cases (shared workspace, running post);
   - X revoke;
   - purge verification by read-back;
   - auth user gone, and the same X account able to reconnect under a new account.
5. Owner/legal decisions:
   - audit retention period;
   - history retention (currently: none kept);
   - privacy policy, terms and support pages. Their text must come from the owner; nothing is invented here.
6. Set `EXPO_PUBLIC_ACCOUNT_DELETION_ENABLED=true` and the legal URLs for the release build.

## 8. Tests

- `apps/social-mobile`: `npm test`, which covers legal-link validation, the deletion client logic, the provider behavior on server answers, and the contracts.
- Edge: `deno test --no-check --no-lock --allow-read supabase/functions/social-mobile-account-delete/`.
- DB (disposable local cluster only): `DEL_PGHOST=/private/tmp/<dir> DEL_PGPORT=<port> DEL_PGSUPER=<user> supabase/tests/social_mobile_account_deletion_run.sh`. It checks, on fake data:
  - behavior;
  - exact-user binding;
  - blocked cases;
  - cross-user isolation;
  - fail-closed purge;
  - idempotency;
  - privileges;
  - audit without raw ids;
  - a concurrent-purge race.
