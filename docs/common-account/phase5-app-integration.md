# Common account — Phase 5 (F5): how the real apps use the common ID and the service entitlement

Status: **source candidate + executable contract, nothing applied, nothing deployed, no managed Supabase touched.**
Production NO_GO (section 6). This file records the *verified* call paths of both apps, the request/response/error
contract they depend on, and the exact points the app owners must still wire. Built on PR #152 (Phase 4) and PR #121
(Phase 3b guard), both unmerged. No app, G3/G4 or H5 file was changed.

## 1. What is already wired (verified, not re-implemented)

| App | Entry (file:line) | Server call | What it decides |
| --- | --- | --- | --- |
| Kabumori | `src/lib/auth.ts:42` `prepareSession` -> `startServiceAutomatically(.., 'kabumori')`; called after every sign-in/sign-up (`auth.ts:59-78` `enrollAfterSignIn`) and for every accepted session by `src/providers/auth-provider.tsx:164` | `rpc start_kabumori_service()` | ready / reenroll_required / blocked |
| Kabumori (restart) | `src/lib/auth.ts:47` `reactivateKabumori`; the person's own click in `auth-provider.tsx:239-262` | `rpc reactivate_kabumori_service(p_expected_lifecycle_version)` | ready / reenroll_required / blocked |
| Kabumori (gate) | `src/app/_layout.tsx:104-105` shows `ServiceAccessScreen` (`src/components/service-access-screen.tsx`) instead of the app until ready | — | no service access without a ready outcome |
| POSTONA | `apps/social-mobile/src/features/service-enrollment/service-enrollment-gate.tsx` (gate built at the top with `'x_autopost'`; `ServiceEnrollmentGate`, children only when `outcome.kind === 'ready'`, ~line 138) | `rpc start_x_autopost_service()` / `reactivate_x_autopost_service(version)` | same |
| POSTONA (placement) | `apps/social-mobile/src/app/_layout.tsx:20`: `ServiceEnrollmentGate` wraps `DataProvider` and `OnboardingGate`, so no workspace data is loaded before ready | — | a login alone creates no workspace/OAuth state/credential |
| Old Kabumori builds | call `rpc ensure_my_profile()` | (Phase 4) a wrapper of the Phase 2 start | enrolled like the new start; ended -> `SERVICE_REENROLL_REQUIRED` |

Both client modules (`src/lib/service-enrollment.ts`, `apps/social-mobile/src/domain/service-enrollment.ts`) are
byte-for-byte the same logic; each app enrolls **only its own service** (the service is the function name, never an
argument). Apps never write a common-account table and never name a user.

## 2. Request / response / error contract (what the clients parse; proven against the real SQL)

`POST {SUPABASE_URL}/rest/v1/rpc/<fn>` with `apikey: <publishable key>`, `Authorization: Bearer <access token>`,
JSON body `{}` (start) or `{"p_expected_lifecycle_version": <integer >= 1>}` (restart). The person is the token's
subject (`auth.uid()`); the token's `session_id` identifies the login (a refresh keeps it, a new sign-in changes it).

| HTTP | Body (exact keys) | Client outcome | Meaning / what the app does |
| --- | --- | --- | --- |
| 200 | `{status:'active', service, started, shared_account}` | `ready{started, sharedAccountNotice = started && shared_account}` | enrolled; show the shared-ID notice once when `started` on a shared account |
| 200 | `{status:'reenroll_required', service, lifecycle_version}` | `reenroll_required{lifecycleVersion}` | ended earlier; show "利用登録する"; the click sends `reactivate_*` once with this version |
| 200 | `{status:'lifecycle_changed', service, lifecycle_version}` | `reenroll_required{new version}` | the state moved since the person looked; confirm again at the new version |
| 200 | `{status:'blocked', reason}`, reason in ACCOUNT_DELETION_IN_PROGRESS, ACCOUNT_LOCKED, SERVICE_DELETION_IN_PROGRESS, SERVICE_SUSPENDED, SERVICE_NOT_READY | `blocked{reason}` | fixed Japanese copy; `SERVICE_NOT_READY` is retryable, the others are not |
| 403 | `{message:'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' \| 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND'}` | `blocked{ACCOUNT_NOT_FOUND}` | no usable login (removed, no subject): sign in again |
| 401/403/4xx/5xx/network, expired or bad token, `anon` role | anything else | throws `EnrollmentUnavailableError` | nothing was decided; the gate's error view offers a retry (a new automatic start) |
| (no request) | token without a `session_id` | `blocked{ACCOUNT_NOT_FOUND}` | the gate never sends for a login it cannot identify |

Idempotency: the answer is the state, not an event. A repeat of a start answers `started:false` and changes nothing;
a restart's version is used once (a replay answers the *new* version as `reenroll_required` and changes nothing, so a
person who re-taps sees one extra confirmation; the next automatic start reports ready). Concurrent callers of one
login share one request (gate).

## 3. Verified end to end (executable: `common_account_phase5_app_contract_test.ts`)

Both real client modules, unmodified, against the real SQL (Phase 1/2/3a + guard + Phase 4) on a disposable PostgreSQL,
through a PostgREST stand-in (HS256 tokens, claims, role, one transaction, SQLSTATE -> HTTP). 13 scenarios: new person
per app (only that service; login/identities untouched; no workspace); an existing ID opening the other app (only that
entitlement added; shared notice); the same request twice; service separation and cross-person naming refused (404);
ended service (no implicit restart; stale version changes nothing; explicit restart; replay); frozen account (the same
still-valid token blocked in both apps, nothing created, old-build path refused); locked / service deleting /
suspended reasons; removed login; expired / wrongly signed / anon / key-less / no-session tokens; gate sharing; old
builds; a legacy profile without an entitlement. Not proven: managed Supabase, real GoTrue tokens/sessions, the real
PostgREST error mapping, the React render of the gates (pinned by the apps' own tests).

## 4. What is NOT enforced yet, and the exact change (G3/G4-owned; this change touches none of it)

The apps' gates are a UI entry control. Server-side, POSTONA's X publish pipeline does not ask whether the workspace
owner's `x_autopost` service is still active (`supabase/functions/_shared/brand/vault_account_brand_post.ts`:
"Common-account (G5) boundary -- NOT enforced here"; no migration references `service_entitlements`). The Phase 3b guard
cannot serve these workers (it needs the person's own JWT and live session). F5 ships the missing primitives as a
new G5 candidate, `supabase/migrations/20261012230000_common_account_service_brand_state.sql` (unapplied):

| Primitive | Use |
| --- | --- |
| `public.common_account_brand_service_state(p_brand_id, p_service_key default 'x_autopost') -> text` (STABLE, service_role only) | `'active'` or a fixed code (`WORKSPACE_OWNER_UNKNOWN`, `ACCOUNT_DELETION_IN_PROGRESS`, `ACCOUNT_LOCKED`, `SERVICE_NOT_REGISTERED`, `SERVICE_DELETION_IN_PROGRESS`, `SERVICE_NOT_ACTIVE`, ...). Plain read, advisory, never blocks |
| `private.account_lifecycle_assert_brand_service_active(p_brand_id, p_service_key) -> void` (VOLATILE, owner-only) | the ordering variant for a reviewed definer writer: Phase 4 lock order, locks kept to commit, fixed code, 55P03 on a timed-out wait |

Owner resolution (G5 policy): only a user workspace (`code_profile_key = 'social_mobile_user_v1'`) with **exactly one**
`owner` membership; zero/several/other kinds -> `WORKSPACE_OWNER_UNKNOWN` (a refusal, never a guess).

Requested wiring (G3/G4, in their own reviewed change; names as in `20261006160200_x_account_publish_authority.sql`):

1. `public.check_x_account_publish_authority(...)` (STABLE SECURITY INVOKER, run by service_role; "before generation and
   again immediately before the X create"): before `return 'allowed'` add
   `if public.common_account_brand_service_state(p_brand_id, 'x_autopost') is distinct from 'active' then raise exception 'VAULT_PUBLISH_SERVICE_NOT_ACTIVE' using errcode = 'P0001'; end if;`
2. `public.set_x_account_publish_authority(..., 'enabled', ...)` (definer): after the account row lock, when
   `p_state = 'enabled'`: `perform private.account_lifecycle_assert_brand_service_active(v_account.brand_id, 'x_autopost');`
3. the due-post claim (`claim_due_post` planner): filter candidates with the predicate so a post is never claimed or
   generated for an ended service.
4. the service-only deletion saga must set the account's authority to `revoked` (`set_x_account_publish_authority(..., 'revoked', ...)`)
   and, for Threads, stay inside the T10 adapter port (`account-delete/provider_cleanup.ts`).
5. every authenticated POSTONA writer RPC (`begin_/complete_social_mobile_x_oauth_connection`,
   `set_social_account_publish_enabled`, the workspace ensure) calls the Phase 3b guard first (T13) and, for tables a stale
   token could still insert into, attaches the Phase 4 row fence.

Honest limit: no database lock spans the call to X. A freeze that commits between the last check and the X create can
let at most that one in-flight attempt complete; the read-back in the deletion flow reports it. This narrows the window,
it does not close it.

## 5. Kabumori (G1/G2): nothing is required

The wiring above already exists and is what ships. Optional: attach the Phase 4 row fence (`'user_id'`, `'kabumori'`) to
tables that create rows for a person (the `profiles` FK already removes them on withdrawal).

## 6. Production NO_GO — reasons (unchanged)

1. Phase 4 and this file are unapplied candidates; PR #121/#152 are unmerged drafts (H4 C4 reported #121 not mergeable
   against the then-current main; the merge order and a fresh-main check are still to be decided).
2. Managed Supabase behaviour unproven (U1-U3: Storage policy, `auth.sessions` privileges, audit log); PostgREST's real
   SQLSTATE mapping (`55P03`) unverified; anonymous sign-ins (`is_anonymous`) are not checked by the start RPCs, so the
   project setting must be confirmed off or accepted.
3. The Auth identity-link race keeps `managed_auth_delete` blocked; `IDP_PREPAUSE_BLOCKED` stays.
4. Section 4 is not wired by its owners; no real Threads adapter exists.

## 7. Run the proofs (disposable local PostgreSQL only)

```bash
CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> bash supabase/tests/common_account_core_fence_run.sh   # incl. section app
CAL_PGHOST=... CAL_PGPORT=... CAL_PGSUPER=... bash supabase/tests/common_account_brand_state_run.sh
CAL_PGHOST=... CAL_PGPORT=... CAL_PGSUPER=... python3 supabase/tests/common_account_brand_state_mutations.py
```
