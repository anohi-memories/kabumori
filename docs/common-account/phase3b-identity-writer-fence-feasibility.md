# Common account — Phase 3b: identity-change and service-write fence feasibility (source only)

TASK `common-account-phase3b-identity-writer-fence-source-20261010` (G5). Nothing here is applied, deployed,
wired or switched on. Whole-account managed Auth deletion stays **unavailable**: the Phase 3a release gate
`managed_auth_delete` remains `blocked` (`IDENTITY_CHANGE_FENCE_MISSING`) under its schema CHECK.

**Conclusion: `BLOCKED_PENDING_DISPOSABLE_SUPABASE_PROOF`.**

- No identity-change fence can be proven without a real, disposable Supabase project. Reading GoTrue's
  source shows that a ban alone is **not** a fence. A manual link begun before the ban can complete after
  it (§3, T5). Every other ban path depends on the GoTrue version and project settings, which this task
  could not read.
- The G5-owned **service-write guard** (T13) is a feasible, locally proven candidate. It is source only and
  **not wired**. Wiring it into Kabumori and POSTONA writers belongs to their owners (§9).

## 1. Sources (read 2026-10-10 JST; data only, nothing executed)

| Source | Version | Used for |
| --- | --- | --- |
| `supabase/auth` (GoTrue) source | `master` @ `ce9a8ee` (2026-09-22). Latest release v2.197.0 (2026-09-09). The ban check on access tokens (#2642) first shipped in v2.195.0 (2026-08-03). | Read: `internal/api/{external,token,token_oidc,identity,user,admin,auth,middleware,api}.go`, `internal/tokens/service.go`, `internal/models/{linking,user}.go`, `internal/conf/configuration.go`, `internal/models/audit_log_entry.go`, `internal/storage/dial.go` |
| `supabase/auth` `external.go` | v2.150.0, v2.170.0, v2.185.0 | The ban is checked after the identity insert in all of them |
| `supabase/auth` migrations | `20210909172000` (identities), `20220811173540` (sessions, refresh_tokens), `20240427152123` (one_time_tokens), `20220224000811` (`auth.uid()`) | Cascades and claim source |
| `supabase/postgres` init scripts | `develop` | The older `auth.uid()` (`request.jwt.claim.sub` only) |
| Supabase docs | read 2026-10-10 | Auth hooks (Before User Created, Custom Access Token, …), Admin `ban_duration`, identity linking (automatic by verified email; manual linking off by default) |

**Could not be checked here** (production reads are forbidden, and no project was created):

- the project's GoTrue version;
- manual linking on or off — the POSTONA app's Phase 2 `linkIdentity()` needs it on;
- `API_MAX_REQUEST_DURATION`, the flow-state expiry, JWT expiry, session time-box and inactivity;
- audit-log persistence;
- the `postgres` role's privileges on `auth.*`;
- the Storage bucket policies, which are not in the repository's migrations.

## 2. Verified at source level vs unverified

Every "verified" row is GoTrue **source** behaviour, not the managed project's behaviour.

| # | Claim | Status |
| --- | --- | --- |
| V1 | **OAuth callback, automatic linking:** inside one transaction, GoTrue inserts the identity, updates metadata and writes the `identity_linked` audit row. Only **then** does it check `user.IsBanned()`. The ban raises `ForbiddenError`; the transaction rolls back, because only `CommitWithError` commits. | Source: master and v2.150.0 / v2.170.0 / v2.185.0. Not proven on the project. |
| V2 | **ID-token grant (native Apple):** sign-in without `link_identity` runs the same function, in the same order, inside a transaction. With `link_identity=true` it runs `requireAuthentication` first, then `linkIdentityToUser`. | Source |
| V3 | **`requireAuthentication` rejects a banned user's still-valid access token.** First released in v2.195.0 (PR #2642). It covers `/user`, `/reauthenticate`, `/logout`, `/user/identities/authorize`, identity deletion and the ID-token link. On master it also refuses a token whose session row is gone or invalid. Before v2.195.0, a banned user's access token still worked on these endpoints. | Source; version-dependent |
| V4 | **Token grants:** the refresh grant refuses a banned user ("Invalid Refresh Token: User Banned"), and so does the password grant. | Source |
| V5 | **Admin ban:** it only sets `banned_until` and revokes no session. Because `/logout` refuses banned users (≥ v2.195.0), **sessions must be revoked before the ban**. | Source |
| V6 | **Admin hard delete:** one transaction with a `user_deleted` audit row, then `DELETE FROM auth.users`. Everything else follows from foreign keys: identities, sessions and refresh tokens, and one-time tokens all cascade. | Source and auth migrations |
| V7 | `auth.uid()` = `coalesce(nullif(request.jwt.claim.sub,''), request.jwt.claims->>'sub')::uuid`. | Auth migration `20220224000811` |
| V8 | Access tokens carry `session_id` (`omitempty`). | Source (`tokens/service.go`) |
| V9 | **No Auth hook runs when an identity is linked to an existing user.** Before User Created runs only for new users. Custom Access Token runs when a token is issued. | Docs |
| V10 | **The Custom Access Token hook cannot roll back a PKCE link.** In the PKCE callback the identity is linked and committed with the flow state, and no token is issued in that transaction. A hook that refuses later, at the code exchange, does not undo the link. In the implicit flow a refusal would roll the link back. | Source |
| **V11** | **The manual-link callback never checks the ban.** Manual linking is the path behind `/user/identities/authorize` and the callback with `LinkingTargetID`. `linkIdentityToUser` inserts the identity with no `IsBanned()` check. The ban is only checked when the link **starts**. The flow state lives for at least 300 s (`defaultFlowStateExpiryDuration`, a floor). | Source — **this is a counterexample to "a ban fences links"** |
| V12 | Each request is bounded by `API_MAX_REQUEST_DURATION`, 10 s by default, enforced by a timeout middleware on every route. | Source; the project's value is unknown |
| V13 | GoTrue writes `auth.audit_log_entries` (`identity_linked`, with the actor) in the same transaction unless Postgres auditing is disabled (default: enabled). The table has no foreign key to users. | Source |

**Unverified hypotheses** — each must pass on a real disposable project (§8) before anything relies on it:

- **H1:** the project runs GoTrue ≥ v2.195.0.
- **H2:** every identity-creating path the project exposes refuses a banned user, except V11.
- **H3:** the window between GoTrue loading a user and committing an identity is at most the configured
  request duration, and the manual-link window is at most the configured flow-state expiry.
- **H4:** audit rows persist, can be read by `postgres`, and survive the user's deletion.
- **H5:** `postgres` can `SELECT` `auth.sessions`, `auth.identities` and `auth.users` (needed by the guard
  and Phase 3a), and whether it can `DELETE` from `auth.users` (needed by Option D).
- **H6:** PostgREST and Storage accept an access token until it expires, whatever happens to its session.
- **H7:** the Storage policies in the dashboard (no bucket is created in the repository's migrations).

## 3. Threat / race matrix

Terms:

- **Intent** is Phase 3a's `begin_common_account_deletion_external_step('managed_auth_delete')`. It decides
  under the exclusive `auth.users` lock and records `managed_delete_identity_providers`.
- **Guard** is §6, which is not wired today.
- **Proven** means a local disposable PostgreSQL test (names in §7).

| # | Scenario | Today (Phase 3a merged, gate blocked) | With the guard wired (owners' tasks) | Residual / needed proof | Owner |
| --- | --- | --- | --- | --- | --- |
| T1 | Identity link **committed before** the intent | The intent refuses with `REQUIRED_CHECKPOINTS_CHANGED` (an Apple identity) or records the provider in its evidence | same | none in the DB | G5 (proven: Phase 3a race 5e) |
| T2 | Identity link **in flight** at the intent | The link's insert holds `FOR KEY SHARE` on the user row, so the intent's `FOR UPDATE` waits, then sees the link and refuses | same | none in the DB | G5 (proven: 5e) |
| T3 | Identity link **after the intent commits, before Auth's delete** | **Nothing in SQL can stop it** (negative reproduction, race 6f). The delete cascades the identity away, so no later check can see it. The harms: a new provider grant, e.g. Apple, is never revoked, and new sessions follow. | Every guarded service write by that person is refused, even through the new session (6f). | Needs a GoTrue-side fence (Option A or D) proven on a real project | GoTrue / G5 |
| T4 | Same as T3 by **automatic linking**: a new provider with the same verified email | Same as T3 | Same as T3 | A ban covers it only if H1–H3 hold; the stale-load window is ≤ the request duration | GoTrue |
| **T5** | **Manual link started before the ban, completed after it** (V11) | Same as T3 | Same as T3 | **A ban does not fence it.** Option A needs a settle time longer than the flow-state expiry, or manual linking off, or Option D | GoTrue / product |
| T6 | Old **access token** after the session is revoked | PostgREST still accepts it until it expires | Guarded writers refuse it because the session is gone (B7, 6d). Unguarded writers are not fenced. | `ensure_my_profile()`, direct `profiles` inserts, the X onboarding RPCs and Storage uploads need their owners | G1/G2, G3/G4 |
| T7 | Old **refresh token** | Revocation deletes the session, so refresh fails. A banned user is refused (V4). | same | Real proof (E5) | GoTrue |
| T8 | Stale token **after the login is removed** | Writes with a foreign key fail. Storage (`owner_id` is plain text) is caught by the read-back (Phase 3a R4). | The guard answers `ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND` (C1, 6e) | Storage stays an owner/Storage-policy task | Storage / G5 |
| T9 | The **old deployed** Kabumori `account-delete` | A hard Admin delete with no body, outside the lifecycle | n/a | Dangerous until the fail-closed replacement deploy (Phase 3a §12 step 5), approved separately | G5 + user |
| T10 | X saga `social_and_login`, which runs `delete from auth.users` in SQL | Not gated by the lifecycle (X-owned) | n/a | It must be routed through the lifecycle, or refused, before `integration_state='started'` | G3/G4 |
| T11 | Operator, dashboard or direct Admin delete | Phase 1's shadow guard only observes; the read-back never completes it | n/a | Operator runbook | Operator |
| T12 | A service start or restart during deletion | Refused by Phase 1/2 | same | — | G5 |
| T13 | A service write racing `begin` (either order) | Not fenced | Serialized by the account lock: begin first, then the write is refused (6a); write first, then begin waits for it (6b, observed) | — | G5 guard + writer owner |
| T14 | A service write racing a POSTONA-only deletion | Not fenced | Refused with `SERVICE_DELETION_IN_PROGRESS` (6c); the other service is unaffected | — | same |
| T15 | A writer passes the guard another person's id | n/a | `ACCOUNT_LIFECYCLE_AUTH_REQUIRED` before any of that person's rows are locked (B5, 6g) | — | G5 |
| T16 | An API role calls the guard directly; an invoker-rights writer; a writer owned by another role | n/a | `permission denied` — fails closed (G0) | — | G5 |
| T17 | Ban, then a link transaction that **loaded the user before the ban** | Same as T3 | Same as T3 | A settle time is needed between ban and intent, at least the request duration (V12). Proven only by E6. | GoTrue |

**Ordering an Auth-side fence would need (Option A, if proven):**

1. Revoke the person's sessions while the account is not yet banned. This is V5: `/logout` refuses banned
   users.
2. Admin ban, with a duration longer than the deletion's worst case.
3. Wait out a settle time of at least `max(flow-state expiry, request duration)` plus margin, unless manual
   linking is proven off.
4. Phase 3a intent: exclusive lock, full re-evaluation, identity evidence.
5. Admin `GET` user: `banned_until` is still in the future and the identities equal the evidence, or the
   deletion aborts.
6. Admin delete.
7. Read-back, plus an audit-log check that no `identity_linked` row exists after step 2 (detection; failure
   is reconciliation).

On any abort before step 6, **unban** — itself an Admin write that needs a durable intent. If the ban is
outside our control, it leaves a person banned without a deletion, so the operator runbook is part of the
fence.

## 4. Writer inventory

Classes:

- **(i)** G5-owned, guardable here.
- **(ii)** Owned by another slot; needs an interface handoff (§9).
- **(iii)** Managed GoTrue / Storage; needs real-project proof.

| Class | Writer (file → function) | Role | Transaction / locks | Status |
| --- | --- | --- | --- | --- |
| (i) | `20261001150000` / `20261006230000` → `start_kabumori_service()`, `start_x_autopost_service()`, `reactivate_*_service(v)` | authenticated | Own transaction; I1 locks | Gated (Phase 1/2) |
| (i) | `20261001150000` → `private.account_lifecycle_backfill` | operator | I1 locks | Gated |
| (i) | `20261009120000` → owned lease / intent / complete RPCs | service_role | Owner lease, I1 locks | Gated, gate blocked |
| (i) | **This PR** `20261010051938` → `private.account_lifecycle_assert_active_service_write` | Owner only | The caller's transaction | **New, not wired** |
| (ii) G1/G2 | `20260924100000` → `public.ensure_my_profile()` | SECURITY INVOKER, authenticated | Single `INSERT … ON CONFLICT DO NOTHING` | **Not gated.** Phase 2 clients no longer call it (`src/lib/auth.ts`), but older builds may. |
| (ii) G1/G2 | `20260901061217` `profiles_insert_own` + `20260903150000` `grant insert on profiles to authenticated` | authenticated (RLS) | Direct PostgREST insert | **Not gated** |
| (ii) G1/G2 | Kabumori tables (own-row RLS, foreign key to `profiles`) | authenticated | Direct | They fail once the profile is gone. The hole is re-creating the profile (rows above). |
| (ii) G1/G2 | Service-role producers: push, reports, important news, … (Phase 3a §9) | service_role | Various | No entitlement predicate |
| (ii) G3/G4 | `20260919120000` (+ `20260922003101`) → `begin_social_mobile_x_oauth_connection`, `consume_social_mobile_x_oauth_state`, `complete_social_mobile_x_oauth_connection` (calls `vault.create_secret` / `update_secret`) | SECURITY DEFINER, authenticated, through `x-oauth-connect-user`, which forwards the person's own token | One transaction per RPC; `FOR UPDATE` on `social_accounts` | **Not gated.** Vault secrets do not cascade on a login delete. |
| (ii) G3/G4 | Future Threads begin/complete; T9 workspace provisioner | — | — | Contract T13 says call the guard first |
| (ii) G3/G4 | `20260928160000` → `social_mobile_account_deletion_finalize` (`delete from auth.users`, `social_and_login`) | service_role | Its own locks | A login delete outside the lifecycle |
| (ii) G3/G4 | POSTONA Edge functions on a person's token (`x-test-post`, `social-mobile-*`) | person token, service role | — | No entitlement check |
| (iii) | Identity create / link: OAuth callback, ID token, manual link (V1, V2, V11) | GoTrue | GoTrue transactions | §3 |
| (iii) | Sessions, refresh tokens, ban, Admin delete (V4–V6) | GoTrue | — | §8 |
| (iii) | Storage uploads (`owner_id` is plain text, no foreign key; buckets created outside the migrations) | Storage API, token | — | §8 E9 |
| (iii) | `auth.audit_log_entries` (V13) | GoTrue | Same transaction as the link | Detection only |

## 5. Options

- **A. Admin ban + settle + verify + Admin delete** (sequence in §3).
  - **For:** supported APIs only, nothing added to the `auth` schema.
  - **Against:** V11 (the manual-link bypass); version dependence (V3 needs ≥ v2.195.0); the stale-load
    window (T17); an unban/compensation step; and the ban affects every app sharing the login. That last
    point is intended, but it must be shown to the person.
  - **Status:** feasible only after E2–E7 pass. **Not implemented.**
- **B. Auth hook.**
  - **For:** a Custom Access Token hook that refuses tokens while the account is `deleting` would stop
    **new tokens** — sign-in, refresh and code exchange — on every path.
  - **Against:** no hook covers identity linking (V9). A PKCE link commits before any token (V10). A broken
    or slow hook stops every sign-in of both apps. The hook role needs a narrow grant to read the lifecycle.
  - **Status:** a complement to A, not a fence on its own. Needs E7. **Not implemented.**
- **C. A guard or trigger inside the Auth cascade or the `auth` schema.** Rejected by the TASK: unreviewed
  `auth`-schema objects and cascade-order assumptions. Phase 1 already showed such a guard cannot see
  identities inside the cascade.
- **D. Same-transaction SQL login delete under the intent's lock**, the way the X saga already does it.
  - **For:** the intent's `FOR UPDATE` on `auth.users` and the delete commit together. A link before it
    holds `KEY SHARE`, so the decision waits and sees it; a link after it fails the identity foreign key.
    That closes T3, T4, T5 and T17 at the database level, and it is locally provable. GoTrue's hard delete
    is the same `DELETE` plus an audit row (V6).
  - **Against:** it reverses the Phase 1/3a decision that this repository never deletes a login in SQL. It
    depends on H5 (`DELETE` privilege on the managed project) and on every `auth` child table cascading on
    the project's version — exactly the "unverifiable cascade assumptions" the TASK rules out until proven.
    Supabase does not document SQL login deletion as supported.
  - **Status:** strongest candidate, but it needs an explicit ChatGPT/user decision and E8 + E11.
    **Not implemented.**
- **E. Detection:** an audit-log check after the delete (V13, H4) turns a missed link into reconciliation.
  It never prevents anything.

**Recommendation.** Keep the gate blocked. Request one disposable-project authorization covering E1–E12.
After that, choose D (if H5 and the cascade proof pass and the SQL-delete decision is approved) or A+B
(if E2–E7 pass, with manual linking either off or covered by the settle time). In both cases, wire the
service-write guard (§6) into every class (ii) writer first.

## 6. Stage B: the service-write guard candidate (`20261010051938`, not wired)

`private.account_lifecycle_assert_active_service_write(p_user_id uuid, p_service_key text) returns void`.
A reviewed SECURITY DEFINER writer calls it as the **first** statement of its own transaction. It either
returns, or raises one fixed message with SQLSTATE `42501`. The locks it takes stay held until the writer
commits or rolls back.

1. **Isolation:** READ COMMITTED only; otherwise `ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE`.
2. **Service key:** `kabumori` or `x_autopost`; otherwise `ACCOUNT_LIFECYCLE_SERVICE_INVALID`. POSTONA,
   Threads included, uses `x_autopost` (T13).
3. **The caller is the person** (`ACCOUNT_LIFECYCLE_AUTH_REQUIRED` otherwise).
   - All claims come from **one source**, the one `auth.uid()` reads first (V7): the per-claim settings if
     present, otherwise the JSON claims. Sources are never mixed (B9).
   - The role claim is `authenticated`.
   - The subject is a uuid equal to both `p_user_id` and `auth.uid()`, checked **before any lock**. A
     writer that passes another person's id cannot even queue on that person's rows (6g).
   - `session_id` is a uuid.
4. **Lock order I1:** `private.account_lifecycle_lock(p_user_id, false)`, which takes `auth.users` KEY SHARE
   and then `common_accounts` FOR UPDATE. Then the `service_entitlements` row FOR UPDATE. Nothing is ever
   created.
5. **Account:**
   - a missing login or account → `ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND`;
   - `deleting`, or an open `account_deletion` operation → `ACCOUNT_DELETION_IN_PROGRESS`;
   - any other non-active state → `ACCOUNT_LOCKED`.
6. **Entitlement:**
   - missing → `SERVICE_NOT_REGISTERED`;
   - `deleting`, or an open `service_deletion` for that service → `SERVICE_DELETION_IN_PROGRESS`;
   - `ended`, `suspended` or `provisioning` → `SERVICE_NOT_ACTIVE`.
7. **Live session**, read **after** the lock wait (6d): a row of `auth.sessions` with this id, this user,
   and `not_after` null or in the future. It is read only and never locked, because GoTrue owns those rows.
   Missing → `ACCOUNT_LIFECYCLE_AUTH_REQUIRED`. Unreadable → `ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE`.

**ACL:** `revoke all … from public, anon, authenticated, service_role`. A postcondition requires an ACL of
exactly `owner=X/owner`, and that no API role (including `authenticator`) can execute it directly or
through membership.

- The **writer must be SECURITY DEFINER and owned by the guard's owner** (the lifecycle owner; on Supabase
  the migration role). Anything else fails closed with `permission denied` (G0). G4's T11/T12 preflight must
  confirm the production owner of its writers.
- The preflight requires Phase 1, an exact-shape `auth.sessions` the owner can read, and the Phase 1
  lifecycle lock not executable by any API role.

**Differences from the T13 memo** (to confirm at K5):

1. An added live-session check against `auth.sessions` (H5, E9).
2. An unknown key answers Phase 1's existing `ACCOUNT_LIFECYCLE_SERVICE_INVALID`.
3. Codes are exception messages with SQLSTATE 42501, so PostgREST returns 403 to an authenticated caller.
4. The entitlement `FOR UPDATE` is kept for T13 and Phase 1 consistency, although every entitlement
   change also locks the account row through Phase 1's trigger.

**Limits:**

- It fences only the writers that call it, and none does yet.
- It does not fence GoTrue, Storage, direct PostgREST table writes under RLS, or service-role producers.
- The session check filters stale sessions; it is not a lock. A revocation committing after the read but
  before the writer commits is not seen. Deletion ordering relies on the account and entitlement locks.
- A writer that takes its own locks **before** calling the guard can deadlock with the lifecycle RPCs.
  PostgreSQL then aborts one transaction, which fails closed; T13 requires the guard first.
- **Emergency rollback** (`supabase/tests/common_account_write_guard_rollback.sql`) drops only the guard.
  Writers that call it then fail closed (`does not exist`, nothing written), so rolling back the guard
  never reopens a writer.

## 7. Locally proven vs needs a real disposable project

**Proven on local PostgreSQL 17** (fake data; `common_account_write_guard_run.sh`):

- **Preflight refusals**, each leaving nothing behind:
  - no or reshaped `auth.sessions`;
  - `auth.sessions` unreadable;
  - the lifecycle lock executable by `authenticated`, `service_role` or PUBLIC;
  - the foundation missing.
- **Exact change:**
  - the rolled-back transaction leaves the catalog byte-identical;
  - the apply adds exactly one function, with an owner-only ACL;
  - nothing is removed or altered;
  - a re-apply is refused.
- **Static rules:**
  - no row writes, grants, replaced or dropped objects, triggers or policies;
  - no reference to the release gate or Vault;
  - no `auth.sessions` row lock;
  - the one function is VOLATILE SECURITY DEFINER with an empty search path.
- **Behavior G0–E:**
  - privileges, including inherited child roles, invoker writers and a foreign owner;
  - JWT shapes: legacy and JSON claims, malformed values, the anon and service_role claims;
  - other people's ids and sessions;
  - revoked or expired sessions;
  - every account and entitlement state, including inconsistent ones;
  - refusals create and write nothing.
- **Fail-closed environments:** REPEATABLE READ and SERIALIZABLE; `auth.sessions` unreadable at runtime.
- **Races (two sessions):**
  - 6a: begin, then write;
  - 6b: write, then begin — the begin was observed waiting;
  - 6c: POSTONA-only deletion, then write;
  - 6d: session revoked while waiting;
  - 6e: login removal in flight;
  - 6g: a foreign id is refused without queueing;
  - 6f: **negative reproduction** — after the intent commits, an identity insert and a new session are
    accepted by the database, the intent's evidence is stale, and every guarded write is still refused.
- **Rollback:** the catalog returns to its pre-candidate state, callers fail closed, and the candidate can
  be re-applied.
- **Mutations:** 28 of 28 detected (`common_account_write_guard_mutations.py`). The defense-in-depth
  exclusions are listed in its header.
- **Earlier phases:** T1/T2 stay proven by the Phase 3a runner, race 5e, re-run unchanged.

**Cannot be proven locally:**

- every V-row on the real project, H1–H7, and T3–T5, T7 and T17;
- the GoTrue version and config;
- PostgREST, Storage and Auth HTTP behaviour;
- the managed `auth` schema's privileges and cascades;
- Apple-specific linking.

Local mocks are **not** evidence for these.

## 8. Disposable real Supabase experiment plan (NOT authorized by this TASK)

**Prerequisites:**

- A separate written authorization.
- A **new throwaway project** — never `wsmznyzcvmuitkglfeuj`, which G3 also uses — on the production plan
  and region, with the production Auth settings mirrored.
- Record `GET /auth/v1/health` (version) and the Auth config.
- Test-only users and providers: email/password, one test OAuth or OIDC provider for linking, and the
  ID-token grant with a test OIDC issuer if supported. Apple behaviour stays unproven unless an Apple test
  app is authorized.
- No PII; tokens are never logged.
- Evidence is kept as redacted transcripts plus SQL read-backs.

**Teardown:** delete the project. Afterwards, an independent review of the evidence.

| Exp | What | Pass condition |
| --- | --- | --- |
| E1 | Version and config | GoTrue ≥ v2.195.0 recorded. Manual linking, flow-state expiry, request duration, JWT expiry, session time-box and audit-to-Postgres recorded. |
| E2 | Ban vs OAuth callback with automatic linking (same verified email) | 403 `user_banned`; no `auth.identities` row; no session |
| E3 | Ban vs manual link **started after** the ban | `/user/identities/authorize` gives 403 |
| E4 | **Manual link started before the ban, callback after it (V11)** | Expected to **link**: confirms or refutes the counterexample. If it links, Option A needs manual linking off, or a settle time longer than the flow-state expiry. |
| E5 | Ban vs refresh and ID-token grant; logout ordering | Refresh 400 `user_banned`; ID-token sign-in 403; `/logout` refused after the ban (so revoke before the ban) |
| E6 | Concurrency: about 200 parallel link and sign-in attempts fired around the ban commit, repeated | The maximum time from ban commit to a committed identity is measured, and it is ≤ the configured request duration |
| E7 | Custom Access Token hook refusing a `deleting` account | Refuses password, refresh, PKCE exchange and ID token. A PKCE link before the exchange **is** committed (V10). Measure latency, and the behaviour when the hook errors. |
| E8 | Admin delete cascades on the project's schema | Every `auth` child row is gone. Phase 1's shadow guard records `login_removed`. Public foreign keys behave as in the fixtures. |
| E9 | Stale tokens after logout, ban and delete, against PostgREST and Storage | Guarded writer codes match §6. Unguarded writer and Storage-upload outcomes are recorded. `auth.sessions` is readable by `postgres` (H5). |
| E10 | Audit log | `identity_linked` rows (actor, provider) persist after the user's deletion and can be read by `postgres` (H4) |
| E11 | Option D | Can `postgres` `DELETE FROM auth.users` under our lock? Differences from the Admin delete. GoTrue's view of the user's tokens afterwards. |
| E12 | Apply the guard migration on the disposable database | Preflight and postcondition pass. Catalog read-back. A G4-shaped writer wired **in the disposable database only** passes 6a–6g against real PostgREST. |

## 9. Interface tasks for other owners (drafts only — not assigned, nothing edited)

- **G1/G2 (Kabumori).**
  - Once no supported build calls `ensure_my_profile()`, revoke its `authenticated` EXECUTE, drop
    `profiles_insert_own`, and revoke `insert on profiles` from `authenticated`.
  - Alternatively, replace the profile creation with a SECURITY DEFINER writer, owned by the lifecycle
    owner, that calls the guard with `kabumori` first.
  - Design a lifecycle/entitlement predicate for the service-role producers (push, reports, news).
  - Each step needs its own migration, owned by Kabumori.
- **G3/G4 (POSTONA).**
  - Make `perform private.account_lifecycle_assert_active_service_write((select auth.uid()), 'x_autopost')`
    the first statement of `begin_` / `consume_` / `complete_social_mobile_x_oauth_connection`, Threads
    begin/complete and the T9 provisioner.
  - Those functions must be owned by the guard's owner.
  - Map the fixed codes in `x-oauth-connect-user` without logging tokens.
  - Never re-send a consumed OAuth code.
  - Route or refuse the X saga's `social_and_login` SQL login delete before lifecycle integration starts.
  - T11/T12 production ACL/owner read-back before any activation.
  - G3 has a production write window open on the same project: no concurrent writes.
- **G5 (after the real proof).**
  - Choose Option A+B or D, with ChatGPT/user approval.
  - Ship the orchestrator steps (revoke, ban, settle, verify, or the SQL delete) with a durable
    unban/compensation.
  - Open the gate only in a reviewed migration, with its own disposable-project proof.
  - The old deployed `account-delete` replacement stays a separate step (Phase 3a §12).
- **User / ChatGPT.**
  - A separate authorization for one disposable project and the E1–E12 scope.
  - Decide whether Option D (SQL login delete) is acceptable in principle.

## 10. Files and running the proofs

- `supabase/migrations/20261010051938_common_account_service_write_guard.sql` — the candidate, created with
  `supabase migration new`.
- `supabase/tests/common_account_write_guard_{fixture.sql,behavior.sql,run.sh,mutations.py,rollback.sql}`.

```bash
CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> \
  bash supabase/tests/common_account_write_guard_run.sh
CAL_PGHOST=... CAL_PGPORT=... CAL_PGSUPER=... python3 supabase/tests/common_account_write_guard_mutations.py
```

## 11. Remaining blockers (not relabelled as PASS)

1. **Identity-change fence:** unproven. A ban is not a fence while manual linking can complete after it
   (V11, T5). Needs E1–E8 and E10–E11.
2. **Guard not wired:** class (ii) writers are still unguarded (G1/G2, G3/G4 tasks).
3. **Phase 3a §14 still applies:**
   - the old production `account-delete` hard delete;
   - the X saga's SQL login delete;
   - X-only and already-ended Kabumori people;
   - the public deletion page;
   - the operator reconciliation audit;
   - Simulator and EAS.
4. **Storage:** policies and stale-token uploads unknown (E9).
