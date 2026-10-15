# Common account — Phase 9 (F5): POSTONA-first shared sign-in and enrollment, proven offline

Status: **source candidate + executable offline proofs; nothing applied, nothing deployed, no managed Supabase touched,
no real Auth / OAuth / X / Threads / Meta call, no user created.** Production NO_GO (section 11). Stacked on F5 PR #193
(Phase 8). No POSTONA app, Kabumori app, F3 (X), F4 (Threads), G3/G4 or H5 file was changed.

The product decision this phase serves: **the common identity is the platform; POSTONA is its first app and
Kabumori may pause.** A person must be able to sign up for POSTONA, sign in again, refresh a session and come back
after ending the service **without any Kabumori profile, entitlement, deployment or code path**, while a future app can be
added as one more explicit, independently controlled service on the same login.

```bash
export CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser>
bash supabase/tests/common_account_phase9_shared_login_run.sh              # world, fence, e2e (about 1 minute)
python3 supabase/tests/common_account_phase9_mutations.py                  # 14 deliberate regressions of the migration
```

## 1. Map: where a person registers, signs in and is enrolled (verified in source)

There is **no server code of ours in the sign-up / sign-in path**: registration and authentication are GoTrue
(Supabase Auth, managed), called by the apps' own supabase-js client. Our code starts after a session exists.

| Step | Endpoint / RPC | Called from (exact source) | Owner |
| --- | --- | --- | --- |
| e-mail sign-up | `POST /auth/v1/signup` | POSTONA `apps/social-mobile/src/providers/auth-provider.tsx` (`signUpWithEmail`); Kabumori `src/lib/auth.ts` (`signUpWithEmail`) | GoTrue (managed) |
| e-mail sign-in | `POST /auth/v1/token?grant_type=password` | POSTONA `auth-provider.tsx` (`signIn`); Kabumori `src/lib/auth.ts` (`signInWithEmail`) | GoTrue |
| Apple / Google / X sign-in | `grant_type=id_token` (native Apple) or the OAuth redirect + PKCE exchange | POSTONA `src/lib/auth-client-flows.ts`, `domain/auth-flows.ts` | GoTrue |
| refresh / sign-out | `grant_type=refresh_token`, `POST /auth/v1/logout` | supabase-js (both apps) | GoTrue |
| **automatic enrollment** (every accepted session) | `rpc/start_x_autopost_service` (POSTONA), `rpc/start_kabumori_service` (Kabumori), legacy `rpc/ensure_my_profile` | POSTONA `domain/service-enrollment.ts` → `features/service-enrollment/service-enrollment-gate.tsx` (wrapped around the signed-in tree in `app/_layout.tsx`); Kabumori `src/lib/service-enrollment.ts` → `src/lib/auth.ts` (`enrollAfterSignIn`) | **G5/F5** |
| **explicit restart** of an ended service | `rpc/reactivate_x_autopost_service(p_expected_lifecycle_version)`, `rpc/reactivate_kabumori_service(...)` | the same two modules (the person's own click) | **G5/F5** |
| withdrawal of one service / deletion of the identity | Edge `account-delete` (`withdraw_postona`, `withdraw_kabumori`, `delete_common_account`) | Kabumori `src/lib/account-deletion*.ts`; POSTONA still calls the legacy `social-mobile-account-delete` (finding G4-1, PR #193 doc §9) | G5/F5 (POSTONA: G4) |

The two enrollment modules are **byte-identical in their rules** (a header-pinned contract); each app enrolls only its own
service key. POSTONA never calls a Kabumori RPC (test 1 asserts it on the wire).

### Missing wiring (verified, not assumed)

| What is **not** connected | Evidence | Owner / where handled |
| --- | --- | --- |
| The server does not require the `x_autopost` entitlement for POSTONA's own writes: the X onboarding RPCs (`begin_/complete_/consume_social_mobile_x_oauth_*`) and the Edge functions consult no entitlement; only the client gate does. A person who never enrolled, or whose service ended, can still call them with a valid token. | grep: no `service_entitlements` / `account_lifecycle_*` in them (main); PR #193 `I15` | G3 (T13 wiring, hand-off §10); F3's candidates (PR #182/#189/#204) fence publishing, not onboarding |
| POSTONA's deletion screen bypasses `account-delete` (legacy saga) | PR #193 `I14b` | G4 (PR #197 bridges the client; server and managed gates open) |
| `ensure_my_profile()` is the Kabumori bootstrap: calling it makes a Kabumori user. POSTONA never calls it. | `service-enrollment-gate.tsx`, test 1 | — |

## 2. The contracts (what the apps parse; pinned by `common_account_phase9_shared_login_test.ts`)

| RPC | Answer (jsonb) | Errors (SQLSTATE 42501 unless noted) |
| --- | --- | --- |
| `start_<service>_service()` | `{status:'active', service, started:boolean, shared_account:boolean}`; `{status:'reenroll_required', service, lifecycle_version}` (ended; **nothing changed**); `{status:'blocked', reason}` with `ACCOUNT_DELETION_IN_PROGRESS` · `ACCOUNT_LOCKED` · `SERVICE_DELETION_IN_PROGRESS` · `SERVICE_SUSPENDED` · `SERVICE_NOT_READY` | `ACCOUNT_LIFECYCLE_AUTH_REQUIRED` (no subject, **guest session**), `ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND` (token of a login that no longer exists); `anon` role: `permission denied` |
| `reactivate_<service>_service(bigint)` | as above, plus `{status:'lifecycle_changed', service, lifecycle_version}` (the version moved; nothing changed) and `{status:'not_registered', service}` | the same, **plus `ACCOUNT_LIFECYCLE_AUTH_REQUIRED` when the token's session is not a live row of `auth.sessions` for this login**, `ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE` when `auth.sessions` cannot be read (fails closed), `ACCOUNT_LIFECYCLE_VERSION_REQUIRED` (version < 1) |

Rules of the answers: `started` is true exactly once per (re)start; `shared_account` says another service of the same
login is active (the app shows the one-time notice only when `started && shared_account`); an `ended` service is **never**
restarted by the automatic start; a restart is bound to the lifecycle version the person saw and **moves it**, so a replay
of the same click answers `lifecycle_changed`. The person is always `auth.uid()`; **no signature carries a user id**.

HTTP as the apps meet it (PostgREST stand-in, to be re-verified in a managed project, §9): 200 with the jsonb; 401 expired
/ invalid token (`PGRST301/303`) or `anon`; 403 for the 42501 errors above; 404 `PGRST202` for a function that is not
exposed or a signature that does not match; 503 for `55P03` (lock timeout, retryable).
Client mapping (unchanged): a 42501 whose message names `ACCOUNT_NOT_FOUND` / `AUTH_REQUIRED` → `blocked ACCOUNT_NOT_FOUND`
("log in again"); every other error → `EnrollmentUnavailableError` (transient, retry); anything that is not the exact
canonical answer → `blocked UNKNOWN`.

## 3. Scenario matrix (all executable, `common_account_phase9_shared_login_test.ts`, 16 tests)

| # | Required scenario | Test | Result |
| --- | --- | --- | --- |
| 1 | new shared-ID sign-up + POSTONA entitlement, **no Kabumori anything** | 1 | one Auth user, one common account, `x_autopost:active`, 0 profiles / workspaces, 0 Kabumori RPCs; sign-up alone creates no account |
| 2 | repeat sign-in, session refresh, second device | 2 | a refreshed token is the same login (one request); refresh tokens are single use; a new sign-in is a new login decided idempotently; one entitlement |
| 3 | existing shared ID + POSTONA-only enrollment | 3 | same Auth user, no duplicate, `shared_account` notice once, Kabumori entitlement + profile byte-identical |
| 4 | the reverse order | 4 | profile root appears only with Kabumori; POSTONA row byte-identical |
| 5 | sign-up idempotency, duplicate and concurrent registration | 5 | six parallel sign-ups of one address → one user, one identity; confirmation mode: no session, no enrollment; repeats create nothing |
| 6 | provider identity / subject scoping | 6 (model) | an account is the Auth user: Apple with the same verified address links to the same user; a private-relay address is a different person → a different, unmerged common account; linking OFF → refused, no user |
| 7 | expired / forged / missing / stale JWT | 7, 8, 9 | expired → 401 before SQL, nothing written, refresh restores; forged key and `anon` → 401; removed login → `ACCOUNT_NOT_FOUND`, nothing created |
| 8 | suspended / ended / reactivation | 11 | suspended and locked refuse (Kabumori unaffected by POSTONA's suspension); ended → `reenroll_required`; wrong version changes nothing; right version restarts once; replay → changed |
| 9 | independence and withdrawal | 12 | ending POSTONA leaves Kabumori, its profile, the login and sign-in intact; ending Kabumori leaves POSTONA (no profile needed); restarting one never touches the other |
| 10 | user-level isolation, cross-user actions | 10, 16 | one person's rows never move for another's call; a user-id argument is not part of any signature (404); backend RPCs are not exposed and are `permission denied` to the role; direct writes denied; own status readable in granted columns only |
| 11 | multi-brand preservation | 15 | membership in another brand is untouched by enrollment; the self-service end is **refused** (`X_WORKSPACE_NOT_SELF_SERVICE`) rather than guessed |
| 12 | races | 13 | 8 first starts → exactly one `started`; 3 restarts of one version → exactly one; an end racing a start is never undone |
| 13 | exposed surface | 14 | exactly the five enrollment RPCs, none with a user argument; an unknown service key is refused |

## 4. Findings of this phase

**Fixed in this PR (F5-owned; migration `20261015090000_common_account_enrollment_session_fence`, unapplied):**

1. **F9-1 (security, medium): a signed-out device's unexpired token could restart an ended service.** Every service
   *writer* is bound to a live session (Phase 3b), but the **explicit restart** was not: `reactivate_*_service` answered for
   any token of the login inside its `exp`, including one whose session had been signed out or revoked. Reproduced
   (test 8, world without the fence: `ready started:true`), fixed (with the fence: `blocked ACCOUNT_NOT_FOUND`, service
   stays `ended`). The automatic start deliberately gained **no** such requirement: it is idempotent, never restarts, and
   is the first-sign-in path, so it must not depend on `auth.sessions`.
2. **F9-2 (defense in depth, low): a guest (`is_anonymous`) session was enrolled like any login.** Neither app has a guest
   mode and a hosted project keeps anonymous sign-ins off; the database now says so too (test 9, fail-before/pass-after).
   Reverse in the migration if a guest mode is ever introduced on purpose.

**Observed, by design, documented (no change):**

3. **F9-3 — the lifecycle version is account-wide.** Any service start/end moves `lifecycle_version`; a restart screen
   that captured a version before the other app enrolled gets `lifecycle_changed` and one more click. Safe, noisy only.
4. **F9-4 — the self-service end is not offered to a person with another brand membership** (`x_foreign` footprint,
   Phase 1). Enrollment, sign-in and refresh are unaffected; only withdrawal is routed to an operator. Test 15 pins it.
5. **F9-5 — identity linking is GoTrue configuration, not ours.** Our rule is "one Auth user = one common account; no merge
   by address, provider or subject". Whether a second provider with the same address becomes the *same* Auth user is a
   managed project setting; the model in test 6 shows both outcomes. Must be read back in the managed project (§9, M3).

**Not ours, handed off (§10):** the server does not enforce the `x_autopost` entitlement on POSTONA's own writes (G3).

## 5. Lifecycle and API contract for the platform (current and future apps)

* **One identity.** The common account is keyed by `auth.users.id` and nothing else. Created lazily by the first start of
  any service (`private.account_lifecycle_lock(user, create := true)`), never by sign-up itself.
* **One explicit entitlement per app**: `service_entitlements(user_id, service_key)` with states `active`, `suspended`
  (operator), `deleting` (an end is open), `ended`. Services start, suspend, end and restart **independently**; the account
  status (`active` / `locked` / `deleting`) is the only cross-service switch.
* **Automatic start never restarts**; only the person's own click at the version the server named does, on a live session.
* **Withdrawing one service** (owner lease → provider cleanup → the app's own saga → `finish_owned_service_deletion`)
  keeps the identity and every other service; **deleting the identity** is a different confirmation flow
  (`delete_common_account`) that refuses until every service is settled and is currently BLOCKED at `managed_auth_delete`.
* **Adding an app** is a reviewed migration, never a client parameter: (1) add its key to the `service_key` check and the
  lifecycle registry; (2) add `start_<app>_service()` / `reactivate_<app>_service(bigint)` that call
  `private.account_lifecycle_enrollment_fence` then the private start / restart; (3) add its provider results and
  footprint to the end / deletion functions; (4) copy `service-enrollment.ts` (rules unchanged); (5) extend the Phase 7
  probe inventory. A generic `start_service(text)` is intentionally **not** offered: a person-supplied key would widen the
  surface this proof pins (`14`).

## 6. Schema dependencies and versioned candidates

`20261001150000` foundation → `20261006230000` start intent → `20261009120000` deletion completion → `20261010051938`
writer guard (needs readable `auth.sessions`) → `20261012130000` core fence → `20261012230000` workspace state →
`20261013120000` service-deletion ownership → `20261013140000` reconciliation facts → **`20261015090000` enrollment
fence (new; needs 2, 3b and 8; five bodies replaced only while they are exactly Phase 2/4's, md5-pinned)**.
The migration changes **no** table, column, grant, policy or trigger (proved byte-for-byte by the `fence/exact` section).

## 7. Rollout and rollback order

Apply: schema first, one reviewed file at a time, never `db push` (`common_account_lifecycle_rollout.md`); this file after
Phase 8 and before any app build that relies on it (nothing in the apps changes). Verify with the Phase 7 probe (it now
knows the ninth member and the fence function). Rollback: `supabase/tests/common_account_enrollment_fence_rollback.sql`
restores the five bodies **byte for byte** (md5 pins re-checked by the runner) and drops the internal check; re-applying
works. No data is touched either way. If the fence must be disabled in an emergency, nothing else depends on it.

## 8. Failure modes

| Failure | What happens | Safe because |
| --- | --- | --- |
| `auth.sessions` unreadable (managed grant missing) | restart: `WRITER_FENCE_UNAVAILABLE`, start: unaffected | fails closed only for the rare explicit action; sign-up has no new dependency |
| token without `session_id` | start works (the app gate itself refuses such a token); restart refused | the apps never send such a token |
| a guest session appears | refused with the sign-in-again answer | no guest mode exists |
| migration applied after an app that expects it | impossible: no app change depends on it | additive, same answers on every passing call |
| a drifted wrapper body | the preflight refuses (`…_DRIFT:<function>`), nothing changes | somebody else's change is never overwritten |

## 9. Managed disposable-only verification plan (NOT executed; needs its own explicit approval, project and secrets)

Preconditions: a fresh, disposable Supabase project, never production; the Phase 7 gate (marker table +
`kabumori.disposable_probe=yes`); no real user data; synthetic mail addresses on a controlled domain; the chain applied
one reviewed file at a time with the Phase 7 probe run before and after each file. **STOP on the first mismatch.**

| # | Check (read-back after each) | Expected | STOP if |
| --- | --- | --- | --- |
| M1 | `auth.sessions` (columns `id`, `user_id`, `not_after`) readable by the migration owner | readable | unreadable → the fence (and Phase 3b) cannot be applied |
| M2 | simultaneous sign-up of one address from two clients | one `auth.users` row, one loses with `user_already_exists` (or the obfuscated user), one identity | two users, or a 5xx without a rollback |
| M3 | same verified address through Apple / Google while an e-mail login exists; and with automatic linking OFF | the documented linking behaviour of the project; **record which**; a private-relay address is a separate user | linking merges or splits unexpectedly relative to §4 F9-5 |
| M4 | sign-up → `start_x_autopost_service` → refresh → sign-out → sign-in → start | `started` once, then idempotent; access tokens carry `session_id`; refresh keeps it, a new sign-in changes it | claim names / `is_anonymous` differ from the model |
| M5 | `reactivate_*` with a token whose session was signed out (global and local) | refused (`403`, message `ACCOUNT_LIFECYCLE_AUTH_REQUIRED`) | accepted |
| M6 | anonymous sign-ins disabled; if a guest token is minted anyway | start refused (`is_anonymous: true`) | enrolled |
| M7 | `anon` key alone, expired token, token of a deleted user | 401 / 401 / `ACCOUNT_NOT_FOUND` with nothing created | any row appears |
| M8 | RLS identity: two users, each `select` on `service_entitlements` / `common_accounts` | own row only, granted columns only | another person's row, or `source` / `legacy_evidence` readable |
| M9 | ACL / ownership inventory (Phase 7 probe sections B, C, D) | exact | any difference |
| M10 | SQLSTATE → HTTP mapping for 42501 / P0001 / 55P03 as the real PostgREST returns it | matches §2 (or §2 and the client map are updated) | the client would treat a terminal answer as transient or the reverse |
| M11 | a lock timeout under concurrent starts (`55P03`) | retryable status, no partial rows | partial state |
| M12 | end POSTONA only (no Kabumori) with a login that has a Kabumori profile | login, profile, Kabumori entitlement intact; sign-in works | any change |

## 10. Hand-offs (concrete; none of these files was touched)

* **G3 (X onboarding, shared migration `20260919120000`)**: at the top of `begin_social_mobile_x_oauth_connection`,
  `complete_social_mobile_x_oauth_connection` and `consume_social_mobile_x_oauth_state` call
  `perform private.account_lifecycle_assert_active_service_write((select auth.uid()), 'x_autopost');` (the Phase 3b writer
  guard: active account, active entitlement, live session). Today a person with no / ended / suspended `x_autopost`
  entitlement can still create a workspace and start X OAuth. Also pin `search_path = ''` for these three definers.
* **G4 / POSTONA app**: nothing for sign-up / enrollment (it is wired and proven). Retire the legacy deletion call
  (PR #193 doc §9). The restart screen's `ACCOUNT_NOT_FOUND` copy ("もう一度ログインしてください") is the right answer for
  a signed-out token (F9-1): no change needed.
* **F3 / F4**: no change. F3's publish guard and F4's Threads guards read the same entitlement and are independent of
  this fence.
* **Coordinator**: one independent Sol (高) review of PRs #183 + #193 + this PR (the migration is small; the review should
  also read §9). The managed plan above needs a separate release TASK.

## 11. Not proven, and Production NO_GO

Not proven: real GoTrue behaviour (confirmation e-mails, linking settings, rate limits, refresh-token reuse interval,
anonymous sign-in setting), the real PostgREST status mapping, RLS under the real roles, `auth.sessions` privileges of the
managed owner, supabase-js client timing, the React gate (the apps' own tests), anything under load.

Production NO_GO: (1) PR #121 → … → #193 and this PR are unmerged Drafts; (2) the managed checks of §9 have not run;
(3) the server does not enforce the entitlement on POSTONA's own writes (G3); (4) POSTONA's deletion still bypasses
`account-delete`; (5) `managed_auth_delete` and `IDP_PREPAUSE_BLOCKED` stay blocked.
