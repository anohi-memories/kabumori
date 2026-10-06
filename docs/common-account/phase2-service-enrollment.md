# Common account — Phase 2: service enrollment in both apps (source only)

Status: source candidate after the H1/C1 corrective (R1–R5). Nothing is deployed and no production data was
changed. Enforcement, RLS changes, producer filters, deletion routes and the deletion orchestrator are later
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
  logged or stored. A request cancelled before dispatch is never sent.
- **One logical enrollment per person**: concurrent callers share one request; a decided outcome is reused until
  sign-out / another person / an explicit retry. A request for another person, a newer request or a reset
  aborts the previous one. Same person with a refreshed token: no second request.
- **Strict answers** (R5): only the exact canonical shapes are accepted (exact key set, `started` and
  `shared_account` booleans, exact service, safe-integer version ≥ 1, known reasons). Anything else → blocked
  `UNKNOWN` (never ready).
- Removed login (`ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND / _AUTH_REQUIRED`) → blocked; transport/server errors →
  retryable.

### Kabumori (`src/`)

- `src/lib/auth.ts`: `prepareSession()` = automatic start bound to the session; `reactivateKabumori(session,
  version)` = the explicit restart; `signOut()` resets (cancels) pending work. The former `ensure_my_profile()`
  call is gone; the profile is created only by the service start.
- `src/lib/service-session.ts` + `src/providers/auth-provider.tsx` (R3): every accepted session is `pending`
  before its request; only a settled **ready for that exact person** (and not loading) yields `serviceSession`.
  Refused, failed, pending and retrying states yield null. Only the latest request may settle; a superseded
  (cancelled) request is not shown as a failure.
- `reenroll()` (R2): sent at the click, once (a second tap while in flight sends nothing), with that session's
  token and the version the server reported; a newer request (e.g. another person) makes its answer stale.
- `src/app/_layout.tsx`: recovery link → onboarding → refusal screen → transient-failure screen →
  `SignedInNavigator` **only when `serviceSession`** → loading. Push registration and notification routing get
  `serviceSession`. PR #94's root `news-detail` registration is preserved.

### X autopost (`apps/social-mobile/`)

- `ServiceEnrollmentGate` (after auth / recovery, before `DataProvider` / `OnboardingGate`; mock preview not
  gated; sign-out and the deletion entry always reachable): automatic start per person over the session-bound
  transport. The restart click (R2) is sent immediately for the clicking person and session, once; nothing is
  remembered for later, so a switch to another person can never inherit it. Unmounting (sign-out / recovery)
  cancels and forgets. Login still creates no workspace, OAuth state, credential or publish setting.

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

- Pre-dispatch cancellation is complete; a request already on the wire when its session ends cannot be
  recalled, but it carries only its own person's token and its answer is ignored.
- The X gate's re-check that the view belongs to the clicking person is defence in depth: the click handler is
  built from the same render's person, session and view, and the button is only rendered for the current person.
