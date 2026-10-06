# Common account — Phase 2: service enrollment in both apps (source only)

Status: source candidate after the H1/C1 corrective (R1–R5) and its round 2 (S1 login identity, S2 queued
work cancelled before dispatch). Nothing is deployed and no production data was changed. Enforcement, RLS changes, producer filters, deletion routes and the deletion orchestrator are later
phases.

## Server contract (new forward migration `20261006230000_common_account_service_start_intent.sql`)

Phase 1's start RPCs restarted an `ended` entitlement, and the apps call them automatically on every
accepted session — so a service ended after the app last looked could be restarted with no user action
(H1 R1, reproduced with real lifecycle functions). The decision now lives in the lifecycle transaction:

| RPC (authenticated only, person = `auth.uid()`) | Behaviour |
|---|---|
| `start_kabumori_service()` / `start_x_autopost_service()` — automatic, unchanged names and grants | missing → creates the entitlement (Kabumori: also the profile), `{status:'active', service, started:true, shared_account}`; active → `{…, started:false, …}`, no change; **ended → nothing changes**, `{status:'reenroll_required', service, lifecycle_version}`; deleting / suspended / provisioning / locked / deleting account → `{status:'blocked', reason}` |
| `reactivate_kabumori_service(p_expected_lifecycle_version)` / `reactivate_x_autopost_service(…)` — new, explicit | restarts **only a currently ended** entitlement, **only** while the account's `lifecycle_version` equals the confirmed one (the restart moves it, so a confirmation works once); different version → `{status:'lifecycle_changed', service, lifecycle_version}`, no change; active → `{…, started:false, …}`, no change; never registered / no account → `{status:'not_registered', service}`, nothing created; other states → blocked |

`shared_account` (another service active on the same account) lets the apps show the shared-ID notice without
reading anything first. Lock order (auth.users row → account row → entitlement), SECURITY DEFINER, empty
`search_path` and authenticated-only EXECUTE are unchanged; old callers of the automatic RPCs only become
safer. Only `private.account_lifecycle_start_service` is replaced; everything else in the catalog is
byte-identical (proved by the runner).

Proof: `supabase/tests/common_account_service_start_intent_run.sh` (local PostgreSQL 17, fake data): preflight
refusals, additive/only-the-start-helper change, re-apply refused, behaviour for every state of both services
(H1's withdraw → stale start and X end → stale start sequences now stay ended), privileges, and two-session
races (end vs automatic start in both orders, X end vs start, two restarts with one confirmation, end vs a stale
restart).

Rollout order: this migration must be applied (separately approved) **before** an app build with this client
ships — the client accepts only the new answer shapes and fails closed otherwise.

## Client (identical logic in both apps below a 5-line header; a test pins that)

`src/lib/service-enrollment.ts` and `apps/social-mobile/src/domain/service-enrollment.ts`:

- **No client read before the RPC** (R4): the server decides atomically.
- **Session-bound transport** (R4): each request is a PostgREST call over `fetch` whose `Authorization` is the
  access token captured when the request started — never a shared client's current token. The token is not
  logged or stored. A request cancelled before dispatch is never sent; an answer that arrives after its request
  was cancelled is not an outcome.
- **One login, not merely one person** (S1): `loginSessionIdOf(userId, token)` reads the token's `session_id`
  (a required Supabase Auth claim: the UUID of the sign-in's session, kept when the token is refreshed, new for
  every sign-in or recovery link). It is only decoded, not verified (the server verifies the token on every
  request), so it only tells this device's logins apart; it stays in memory and is never logged or stored. It is
  accepted only for a well-formed token whose `sub` is exactly this person and whose `session_id` is a UUID;
  otherwise the login is unidentified: nothing is sent and the answer is blocked `ACCOUNT_NOT_FOUND` ("ログイン
  情報が無効です。もう一度ログインしてください"), never ready.
- **One logical enrollment per login**: concurrent callers of the same login — including a refreshed token of
  it — share one request; a decided outcome is reused until sign-out / another person or login / an explicit
  retry. A request for another person **or another login of the same person**, a newer request or a reset aborts
  the previous one (also a pending explicit restart), so a new login never adopts an old login's request or
  answer and always gets its own automatic start (and, if the service is ended, its own confirmation).
- **Strict answers** (R5): only the exact canonical shapes are accepted (exact key set, `started` and
  `shared_account` booleans, exact service, safe-integer version ≥ 1, known reasons). Anything else → blocked
  `UNKNOWN` (never ready).
- Removed login (`ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND / _AUTH_REQUIRED`) → blocked; transport/server errors →
  retryable.

### Kabumori (`src/`)

- `src/lib/auth.ts`: `prepareSession()` = automatic start bound to the session; `reactivateKabumori(session,
  version)` = the explicit restart; `signOut()` resets (cancels) pending work. The former `ensure_my_profile()`
  call is gone; the profile is created only by the service start.
- `src/lib/service-session.ts` + `src/providers/auth-provider.tsx` (R3, S1): every accepted session is
  `pending` before its request; every state is tagged with the person **and login**; only a settled **ready for
  that exact person and login** (and not loading) yields `serviceSession`. Refused, failed, pending and retrying
  states, another login's ready and an unidentified login yield null. Only the latest request may settle; a
  superseded (cancelled) request is not shown as a failure.
- `reenroll()` (R2, S1): sent at the click, once (a second tap while in flight sends nothing), only by the login
  that was shown the restart screen, with that session's token and the version the server reported; a newer
  request (another person, another login of the same person, sign-out) aborts it or makes its answer stale.
- `src/app/_layout.tsx`: recovery link → onboarding → refusal screen → transient-failure screen →
  `SignedInNavigator` **only when `serviceSession`** → loading. Push registration and notification routing get
  `serviceSession`. PR #94's root `news-detail` registration is preserved.

### X autopost (`apps/social-mobile/`)

- `ServiceEnrollmentGate` (after auth / recovery, before `DataProvider` / `OnboardingGate`; mock preview not
  gated; sign-out and the deletion entry always reachable): automatic start per login over the session-bound
  transport. The view, the open state and every answer are tagged with the person and login; a new login of the
  same person re-runs the automatic start (a token refresh of the same login does not). The restart click (R2)
  is sent immediately for the clicking person and login, once; nothing is remembered for later, so another
  person or a later login can never inherit it. Unmounting (sign-out / recovery) cancels and forgets.
- Queued work (S2): the automatic start is queued after commit; before it enters the gate it checks that its
  effect was not cleaned up (unmount on sign-out / recovery, another person or login, a retry), that no newer
  request exists and that the person and login are still current. Otherwise it sends nothing and leaves no
  state behind. Login still creates no workspace, OAuth state, credential or publish setting.

## Rollout plan (not executed)

1. Apply `20261006230000` with the same single-file, read-back discipline as Phase 1 (separate approval).
2. Ship each app's next native build (EAS / TestFlight are separate, approved steps). The apps are independent.
3. Old binaries are unaffected: Kabumori old builds call `ensure_my_profile()`, X old builds call nothing. People
   who sign up on an old build get no entitlement until a new build enrolls them; before any enforcement,
   observe with `check.sql` and, if needed, run a separately approved `backfill(true)`.
4. Rollback: ship the previous binary. The migration needs no rollback for old binaries; removing it would
   restore the unsafe automatic restart, so it stays.
5. Observation without PII: `check.sql` (`entitlements_by_kind`, dry-run `*_to_create`).

## Known limits

- Pre-dispatch cancellation is complete (also for queued X work); a request already on the wire when its
  login ends cannot be recalled — an explicit restart already sent by login A1 may still complete on the
  server under A1's own token (it is the person's own confirmation at that version, once) — but its answer
  never makes another login ready: the next login asks the server itself.
- A token refresh of the same login shares that login's pending request (including its own click's restart).
  Should a refresh ever carry another `session_id`, the only effect is one more idempotent automatic start.
- The login id is read from the token without verifying its signature; it is never used for authorization (the
  server decides everything from the verified token), only to keep this device's logins apart.
- Defence-in-depth checks no test can reach separately (mutation-tested; they survive because another guard
  already decides): the X click-result owner re-check (any owner change re-runs the automatic start, which
  makes the click's request stale) and the X "ready needs an identified login" check (the gate never answers
  ready for an unidentified login). Kabumori `reenroll()`'s login comparison is pinned by a source test only
  (its state is replaced by `pending` whenever the session changes).
