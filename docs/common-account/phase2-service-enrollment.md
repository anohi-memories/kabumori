# Common account — Phase 2: service enrollment in both apps (source only)

Status: source candidate. Nothing is deployed and no production data was changed. Enforcement, RLS
changes, producer filters, deletion routes and the deletion orchestrator are later phases.

## What changes

Both apps enroll every accepted session in their own service through the reviewed lifecycle RPCs that
Phase 1 installed in production (`EXECUTE` to `authenticated`, the person is always `auth.uid()`):

| App | RPC | Creates (idempotent, one server transaction) |
|---|---|---|
| Kabumori (`src/`) | `public.start_kabumori_service()` | common account if missing, active `kabumori` entitlement, `profiles` row |
| X autopost (`apps/social-mobile/`) | `public.start_x_autopost_service()` | common account if missing, active `x_autopost` entitlement — no workspace, social account, OAuth state, credential or publish setting |

The decision logic is one module, identical in both apps below its header (a test pins that):
`src/lib/service-enrollment.ts` and `apps/social-mobile/src/domain/service-enrollment.ts`.

1. Read the caller's own entitlement rows (`service_entitlements`, RLS own rows, column grant
   `service_key, status`).
2. This service `ended` → `reenroll_required`: nothing is started until the person presses
   「利用登録する」 (the RPC would restart an ended service, so the client never calls it silently).
3. Otherwise call the start RPC:
   - `{status:'active', service:<this service>}` → **ready**. If this call started the service and another
     service was already active, the person sees 「共通IDはお持ちです。このサービスの利用登録を行いました。」 once.
   - `{status:'blocked', reason}` → **blocked** with that reason (`ACCOUNT_DELETION_IN_PROGRESS`,
     `ACCOUNT_LOCKED`, `SERVICE_DELETION_IN_PROGRESS`, `SERVICE_SUSPENDED`, `SERVICE_NOT_READY`).
   - `ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND / _AUTH_REQUIRED` (a still-valid token of a removed login) →
     blocked `ACCOUNT_NOT_FOUND`.
   - anything else the client does not recognise → blocked `UNKNOWN` (never "ready").
   - transport / server errors (and a failed read in step 1) → a retryable error; nothing decided.
4. One logical enrollment per person: concurrent callers share one request, a decided outcome is reused
   until sign-out, a different person, or an explicit retry. Transient failures are not remembered.

No client writes `common_accounts` or `service_entitlements`, no code looks at e-mail, nothing merges
accounts, and each app enrolls only its own service.

### Kabumori

- `src/lib/auth.ts`: `prepareSession()` now enrolls (replacing the former `ensure_my_profile()` call —
  the profile is created by the service start, never separately); `reenrollKabumori()`,
  `resetServiceEnrollment()`; `signOut()` resets the remembered outcome.
- `src/providers/auth-provider.tsx`: every accepted session goes through `prepareSession()`. A refusal or
  an ended service becomes `serviceAccess`; a transient failure keeps the existing `profileError` path
  (retry / log out). `retry()` and `reenroll()` reset the remembered outcome.
- `src/app/_layout.tsx`: `session && serviceAccess` → `ServiceAccessScreen` (before the profile-recovery
  branch and before the app). Push-token registration and notification routing receive the session only
  when enrollment succeeded (previously they also ran while the profile was missing).
- `src/components/service-access-screen.tsx`: the refusal / re-enrollment screen (log out always offered).

### X autopost

- `apps/social-mobile/src/features/service-enrollment/service-enrollment-gate.tsx`: wraps the signed-in tree
  after auth and password recovery and before `DataProvider` / `OnboardingGate`, so no workspace data loads
  before enrollment. The local mock preview is never gated. Sign-out and the account-deletion entry stay
  reachable on every non-ready view (App Review 5.1.1(v)). Leaving the signed-in tree resets the outcome.
- `apps/social-mobile/src/app/_layout.tsx`: inserts the gate. `auth-provider.tsx` is unchanged; login still
  calls no RPC, and 「Xを接続」 remains the only path that creates a workspace or posting authorization.

## Rollout plan (not executed)

- Server: **no change**. The RPCs, grants, RLS and column grants are in production since the Phase 1 apply
  (2026-10-06). No Edge Function, config, secret, flag or migration is needed.
- Apps: ship each app's next native build with this source (EAS / TestFlight are separate, user-approved
  steps). The two apps are independent; either can go first.
- Old binaries keep working unchanged: Kabumori old builds still call `ensure_my_profile()` (still in
  production), X old builds call nothing. A person who signs up on an old build gets service data without
  an entitlement until they open a new build (which enrolls them) — the same gap the legacy backfill closed.
  Nothing enforces entitlements yet, so this only matters for later phases: before enforcement, rerun the
  read-only `check.sql` and, if needed, a separately approved `backfill(true)`.
- Rollback: ship the previous binary / revert the source. Entitlements created meanwhile stay `active`
  (harmless in shadow mode); there is nothing to roll back on the server.
- Observation without PII (read-only, aggregate): `supabase/tests/common_account_lifecycle_backfill/check.sql`
  — `entitlements_by_kind` shows `…/self_service/…` rows growing next to the 3 `legacy_backfill` rows, and the
  dry-run's `*_to_create` counts show logins that still need enrollment.

## Known limits

- The `ended` check and the start RPC are two calls; if a service were ended between them, the RPC would
  restart it. No deletion route ends a service yet (Phase 3), so the window is theoretical today.
- Kabumori still shows its loading view briefly on every auth event (existing behaviour); with the outcome
  remembered, enrollment adds no extra round trip after the first.
