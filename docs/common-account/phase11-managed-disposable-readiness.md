# Common account — Phase 11 (F5): readiness for an isolated managed-disposable acceptance of POSTONA's shared sign-in

Status: **source-only preparation. Nothing was run against any managed project; no credential, project, user, secret, Auth
setting, migration or grant was created or used; no real X / Threads / Meta / OAuth call.** Production NO_GO (section 10).
Stacked on F5 PR #220. No POSTONA, Kabumori, F3 (X), F4 (Threads), G3/G4 or H5 file was changed (apps/social-mobile was
read only). The next stage (an actual disposable project) needs its **own, separate, explicit user approval** naming the
project and the rollback; this document and the harness are what that approval would be asked to approve.

The goal this serves: *the shared ID is the platform; POSTONA is its first app; Kabumori may pause.* A person must be able
to register, sign in, refresh, sign out, come back and end POSTONA **without any Kabumori profile, entitlement,
delivery, AI or deployment**, and a future app must be addable as one more independent service on the same login.

```bash
# a DRY RUN (the default): prints the plan, the gates, and why an execution would be refused. Calls nothing.
deno run --no-config --allow-read --allow-env=KABUMORI_DISPOSABLE_PROJECT_REF,KABUMORI_DISPOSABLE_ALLOWLIST,KABUMORI_PRODUCTION_PROJECT_REFS,\
KABUMORI_DISPOSABLE_API_URL,KABUMORI_DISPOSABLE_CONFIRM,KABUMORI_DISPOSABLE_PUBLISHABLE_KEY,KABUMORI_DISPOSABLE_SERVICE_ROLE_KEY,\
KABUMORI_DISPOSABLE_DB_URL,KABUMORI_DISPOSABLE_BASELINE_SHA256,KABUMORI_DISPOSABLE_BASELINE_PATH,KABUMORI_DISPOSABLE_INVENTORY_SHA256,\
KABUMORI_DISPOSABLE_TEST_EMAIL_DOMAIN \
  supabase/preflight/managed_disposable/cli.ts

deno test --no-config --no-check --allow-read supabase/preflight/managed_disposable/       # 27 offline tests (guard, runner, static, transports)
python3 supabase/tests/common_account_phase11_harness_mutations.py "$PWD"                  # 30 deliberate regressions of the harness
CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> \
  bash supabase/tests/common_account_phase11_model_run.sh                                  # the plan executed over a MODEL of the managed services
```

## 1. What is new in this phase

| Piece | Where | What it is |
| --- | --- | --- |
| target guard | `supabase/preflight/managed_disposable/guard.ts` | one pure function that answers "may this process mutate THIS project?" — allowlist, deny list, URL shape, confirmation, key kinds, database URL, e-mail domain; refuses with its own code per rule |
| plan | `.../plan.ts`, `plan.lock.json` | the ordered steps G1–G4, M1–M12, T1 and the ten pinned chain files (SHA-256) |
| runner | `.../runner.ts` | dry run by default (touches nothing); `execute` re-reads the project's identity before **every** mutating call; sends only pinned, unchanged, clean files; the first FAIL/STOP ends the run, teardown still runs; redaction |
| transports / CLI | `.../transports.ts`, `.../cli.ts` | the real HTTP (fetch) and psql adapters, never exercised here beyond their argument construction; the CLI refuses `--execute` unless the guard resolved a target |
| offline tests | `.../*_test.ts` | 27 tests with synthetic identifiers only |
| model run | `supabase/tests/common_account_phase11_{model_run.sh,plan_model_test.ts}` | the plan executed by its real runner over the Phase 9 fake GoTrue / PostgREST seams and a local PostgreSQL |
| harness mutations | `supabase/tests/common_account_phase11_harness_mutations.py` | 30 single-rule regressions of guard / runner / transports / CLI; every one is caught |

The Phase 9 seams (`common_account_phase9_seams.ts`) gained four additive routes for the model (settings, admin create-user,
service-role RPC, a GET of the two person-readable tables); Phase 9's 16 tests still pass unchanged.

## 2. Source map: POSTONA's sign-in, session and enrollment (apps/social-mobile, READ ONLY, this checkout)

| Concern | Exact source | Behavior (observed in source) |
| --- | --- | --- |
| client | `src/lib/supabase.ts` | `createClient(url, publishableKey)` with `flowType: 'pkce'`, `persistSession`, `autoRefreshToken`, `detectSessionInUrl: false`, `experimental.appendPkceFlowIdToRedirects: true`; a service/secret key in the publishable slot is refused; native refresh pauses with the app state |
| session persistence | `src/lib/session-storage.ts` | AsyncStorage (web: localStorage) through a sanitizing wrapper: access/refresh token and PKCE verifier slots persist; `provider_token` / `provider_refresh_token` are stripped on every write |
| e-mail | `src/providers/auth-provider.tsx` | `signUp({emailRedirectTo: kabumori-social://auth-callback})` (no enumeration: "already registered" looks like a new sign-up), `signInWithPassword`, `resetPasswordForEmail`, recovery bound to one user+session |
| X / Google (browser) | `src/lib/auth-client-flows.ts` | `signInWithOAuth({redirectTo, skipBrowserRedirect})`; the URL is opened only when it is exactly the project's `/auth/v1/authorize`; the callback completes only the flow this process started |
| Apple | the same | iOS: native `signInAsync` → `signInWithIdToken({provider:'apple', nonce})`; elsewhere browser OAuth (`apple_web`) |
| callback | `src/domain/auth-flows.ts` | strict parser of `kabumori-social://auth-callback` (one credential, valid flow id, no implicit tokens); a duplicate delivery shares one exchange; the posting callback `…://oauth-callback` is never an auth callback |
| linking | `auth-client-flows.ts` `linkOAuthProvider` / `linkAppleNative` | explicit, authenticated, same-user check; automatic identity linking is the project's own verified-e-mail behaviour (**not** ours) |
| provider readiness | `src/domain/auth-release-readiness.ts` | `e2eVerified` is **always false**; a provider is usable only when enabled in the project, configured for the build and implemented |
| **enrollment** | `src/features/service-enrollment/service-enrollment-gate.tsx`, `src/domain/service-enrollment.ts` | every real-data session calls `start_x_autopost_service()` once per login (token session id); an ended service is restarted only by the person's click at the version the server reported; **a build with `EXPO_PUBLIC_DATA_SOURCE` unset or `mock` is never enrolled** |
| logout / refresh | `auth-provider.tsx` | `signOut()` (global); a refresh keeps the login (session id), a new sign-in is a new login |
| deletion | `auth-provider.tsx` (`callDeletion`) | **this checkout still calls the legacy `social-mobile-account-delete`**; the bridge to `account-delete` is POSTONA PR #197, whose J4 findings PR #211 corrects — both unmerged |

Build-time inputs a managed acceptance must set: `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
`EXPO_PUBLIC_DATA_SOURCE=supabase`, `EXPO_PUBLIC_AUTH_PROVIDERS` (only methods whose console gate is done),
`EXPO_PUBLIC_ACCOUNT_DELETION_ENABLED` (leave empty: deletion stays off). Native: URL scheme `kabumori-social`, iOS
`usesAppleSignIn`.

## 3. Production behaviour vs the source candidates (never claim the PRs are deployed)

| Layer | Recorded state | Evidence / caveat |
| --- | --- | --- |
| Phase 1 `20261001150000`, Phase 2 `20261006230000` | **applied to production** (history rows exist) | the repository's coordination files (2026-10-02 / 2026-10-07); not re-read now — a fresh read-only read-back is the first act of any later stage |
| Phase 3a … Phase 10 (`20261009120000` … `20261015120000`) | **unmerged Draft source candidates**, nothing applied | PR #121 → … → #206 → #214 → #220 |
| Edge `account-delete`, the X saga bridge, the Threads registry | source only; the shipped registry is empty (fails closed) | `I3` / `I4` of the Phase 8 assembled suite |
| POSTONA app | enrollment gate wired; deletion still the legacy saga in this checkout | PR #197 / #211 unmerged |
| server-side `x_autopost` entitlement on POSTONA's own writes | **absent** (only the client gate) | G3's T13 wiring (Phase 9 §4) |
| Auth project settings (providers, redirect allow-list, confirmation mode, anonymous sign-ins, JWT expiry, rate limits, `verify_jwt`) | **not in the repository and never read** | `supabase/config.toml` is not tracked; everything below that depends on them is a managed check |

## 4. Findings of this phase (observed; none fixed here, each has an owner)

| # | Finding | Evidence | Why it matters | Owner |
| --- | --- | --- | --- | --- |
| **BG1** | **`supabase/migrations/` is not a self-sufficient baseline.** `public.brands`, `public.social_accounts` and `public.social_account_oauth_states` (three of the 17 relations the Phase 1 preflight requires) are created by **no** repository migration, and `20260828213000_expand_tips_catalog.sql` needs a table (`tips_seed`) that is also created elsewhere. On a bare PostgreSQL with Supabase stand-ins, **33 of the 120** migrations fail in order. Every proof so far used reviewed *fixtures* that "mirror the production shape (read-only catalog inventories 2026-09-28 / 2026-10-01)". | experiment of this phase (bare stand-ins + all 120 files, in order) | a disposable project **cannot** be built from the repository alone; a *managed* acceptance on a hand-made schema would prove nothing about production | coordinator + operator: the reviewed baseline (section 6, stage B) |
| **BG2** | **Eight repository migrations name the production project's host, `cron.schedule(...)` and `net.http_post(...)`.** Applied to a disposable project they would arm jobs that call production. | `grep` of `supabase/migrations/`: `20260908110000_add_important_news_publish_ready_cron`, `20260910163500_add_send_push_notifications_dispatch_cron`, `20260916100000_mic_phase1b_automation_cron`, `20260919090000_mic_fx_phase1_automation_cron`, `20260921090000_mic_equity_index_phase1_automation_cron`, `20260923090000_mic_macro_indicators_phase1a_automation_cron`, `20260924093000_mic_estat_activation_and_gated_macro_cron`, `20260930090000_mic_scenario_automation_cron_phase3c` | `supabase db push` / "apply every migration" to a disposable project is **unsafe**; the harness refuses any file with a foreign project host, a cron schedule or a database HTTP call, and sends only pinned files | harness (done); owners of those migrations: none needed |
| **BG3** | The guard, the lock and the identity check exist because the project ref is only a string: a mistyped project, a stale `supabase link` or a copied `.env` is the realistic failure. | — | the harness never runs `supabase link`, `db push` or the CLI at all; psql with an explicit URL only | harness (done) |
| **BG4** | A POSTONA build with the default data source (`mock`) is **never enrolled**: a managed test with the default `.env.example` silently tests nothing. | `service-enrollment-gate.tsx` (`selection.kind === 'mock'`) | M4 would pass vacuously from a device | the device runbook (section 8, stage S5) |
| **BG5** | `account-delete`'s platform JWT verification (`verify_jwt`) is a deploy-time setting outside git. | `http.ts` header "Keep platform JWT verification ON"; no `config.toml` | an Edge function with verification off accepts any bearer | managed check M13 (below) |

## 5. Risk matrix (what can go wrong in the managed acceptance itself)

| Risk | Likelihood | Impact | Control in the harness / plan |
| --- | --- | --- | --- |
| mutating the production project | low, catastrophic | critical | allowlist + deny list + repository refs + URL shape + typed confirmation + DB URL ref + marker row read before **every** mutation; no CLI, no link |
| arming production cron / HTTP from a disposable | **real (BG2)** | high | foreign-host / cron / HTTP scan of every file before it is sent; only pinned files |
| a changed migration is applied unreviewed | medium | high | SHA-256 lock; a differing byte is never sent |
| baseline not production-shaped (BG1) | **certain unless handled** | the whole run is meaningless | operator-supplied, digest-pinned, scanned baseline (stage B); the chain's own preflights refuse a wrong shape |
| real e-mail sent to a real person | medium | medium | users are created through the admin API with a confirmed e-mail; sign-up with mail only when autoconfirm is on, else MANUAL; the test domain may not be a public mail provider |
| secrets in logs / history / argv | medium | high | env names only, redaction on every output, the DB password goes to libpq env, never argv |
| leftover test users | high | low | every created login is recorded; teardown always runs; the project itself is deleted by its owner |
| a passing model mistaken for managed proof | medium | high | the report lists non-modelled steps as NOT_RUN; `complete` is true only for a full execute with no manual item |
| rate limits (sign-up, e-mail, token) hit mid-run | medium | low | the run stops at the first non-2xx it did not expect; nothing is retried blindly |
| the lifecycle guard refuses test-user deletion at teardown | medium | low | teardown is best effort and reports; the project is deleted instead |

## 6. The acceptance protocol (an exact command plan for a FUTURE, separately approved run)

**Stage A — the project (the user's act, not the harness's).** A new Supabase project, never production, never a branch
of it, no production data, region and billing the user chooses; the owner's note names the ref. In its dashboard: e-mail
provider ON; "Confirm e-mail" OFF for the first pass (`mailer_autoconfirm`, so the harness never triggers mail); anonymous
sign-ins OFF; JWT expiry at the minimum (for M7's expired-token item); additional redirect URL
`kabumori-social://**` (the PKCE flow id is appended); Apple / Google only if M3 will be done. Then, **as the operator**:
create `public.kabumori_disposable_marker (project_ref text primary key, created_at timestamptz default now())` and insert
the project's own ref — this row is what the harness re-reads before every mutation.

**Stage B — the baseline (the operator's act; BG1).** Produce one schema-only file that creates the 17 relations the
Phase 1 preflight lists, in the production shape, and **no** data, no cron, no host. The recommended source is a
schema-only export of exactly those relations from the production catalog by the operator under a separate read-only
approval; the repository's fixtures are test stand-ins and are **not** a substitute. Record its SHA-256 and review it.
The harness scans it for foreign hosts / cron / database HTTP before sending it.

**Stage C — configure the harness (environment names only; values never on a command line).**

| Variable | Meaning |
| --- | --- |
| `KABUMORI_DISPOSABLE_PROJECT_REF` | the target ref (20 characters) |
| `KABUMORI_DISPOSABLE_ALLOWLIST` | the test-only refs allowed (comma separated) |
| `KABUMORI_PRODUCTION_PROJECT_REFS` | the production refs (required; every ref the repository names is added automatically) |
| `KABUMORI_DISPOSABLE_API_URL` | exactly `https://<ref>.supabase.co` |
| `KABUMORI_DISPOSABLE_CONFIRM` | the ref again (typed) |
| `KABUMORI_DISPOSABLE_PUBLISHABLE_KEY`, `KABUMORI_DISPOSABLE_SERVICE_ROLE_KEY` | the project's keys (the right kinds) |
| `KABUMORI_DISPOSABLE_DB_URL` | `postgresql://…@db.<ref>.supabase.co/…` or the pooler form whose user is `postgres.<ref>` |
| `KABUMORI_DISPOSABLE_BASELINE_PATH`, `KABUMORI_DISPOSABLE_BASELINE_SHA256` | the reviewed baseline file and its digest |
| `KABUMORI_DISPOSABLE_INVENTORY_SHA256` | **(Phase 12)** the SHA-256 of the baseline *contract* the owner approved from a production inventory; execution is refused without it ([phase12](phase12-schema-baseline-and-cron-isolation.md) §2, §3.5) |
| `KABUMORI_DISPOSABLE_TEST_EMAIL_DOMAIN` | a domain the operator controls (never a public mail provider) |

**Stage D — dry run, then execute one gate at a time.**

```bash
# 1. a dry run with the variables set: shows the plan and whether an execution would be refused (and why)
deno run --no-config --allow-read --allow-env=<the names above> supabase/preflight/managed_disposable/cli.ts
# 2. read-only gates first
... cli.ts --execute --only=G1,G2
# 3. the baseline and the chain, one file at a time with its marker check
... cli.ts --execute --only=G1,G3a
... cli.ts --execute --only=G1,G3b,G3-P1   (then G3-P2, G3-P3a, G3-P3b, G3-P4, G3-P5, G3-P6, G3-P8, G3-P9, G3-P10, each WITH G3b:
                                           a mutating step is refused unless the baseline read-back is selected with it and passes in that run)
# 4. the release probe, then the acceptance checks, then teardown
... cli.ts --execute --only=G1,G4
... cli.ts --execute --only=G1,G2,G3b,M1,M4,M2,M6,M7,M5,M8,M10,M11,M12,M9,M3,T1   # G2 first: M2 needs the autoconfirm mode it records; G3b: every mutating check needs the baseline read-back in the same run
```

Each invocation prints one line per step (`PASS` / `FAIL` / `STOP` / `WARN` / `INFO` / `MANUAL` / `NOT_RUN`) and a
summary; **a run is "complete" only when every step passed and no manual item is open.** Exit code 1 on any FAIL / STOP,
2 when the guard refused. The first FAIL / STOP ends a run; teardown (T1) still runs.

**Stage E — teardown.** T1 removes every login the run created through the Auth admin API (a guard on `common_accounts`
may refuse a cascade; it then says so). The disposable project itself is deleted by its owner; nothing of it is reused.

## 7. M1–M12 (and the gates that frame them)

`Model` = exercised offline by the model run (a fake GoTrue/PostgREST over a local database: it proves the harness's
logic and that the assertion can fail, **not** the managed behaviour). `Auto` = the harness does it; `Manual` = the
operator acts and the harness reads back.

| Step | Check | Expected read-back | STOP when | Auto / Manual | Model |
| --- | --- | --- | --- | --- | --- |
| G1 | the project says which project it is | marker row = the allowlisted ref | no marker / another ref / two rows | Auto | yes |
| G2 | Auth settings (public endpoint) | e-mail ON; sign-ups open; autoconfirm recorded | e-mail provider OFF | Auto | yes |
| G3a | baseline schema | digest matches; scan clean; the 17 relations exist | digest / scan / SQL error | Auto | no |
| G3b | **(Phase 12)** baseline read-back: the project's own schema inventory (read-only) | the contract subset provides every required object and its SHA-256 is the approved one; the cron / network footprint is recorded | no approved digest, a required object missing or retyped, any drift, secret-shaped text | Auto | yes |
| G3c | **(Phase 12)** the chain left the project silent | cron jobs and cron / net / http triggers are exactly what G3b recorded | either count changed | Auto | yes |
| G3-P1 … P10 | chain files in release order, each followed by its marker function | file applies as written; marker present | any `COMMON_ACCOUNT_*` refusal, digest mismatch, missing marker | Auto | yes |
| G4 | read-only release probe | `RELEASE_PREFLIGHT\|PASS\|fail=0`; ledger WARNs listed | any FAIL / STOP line | Auto | yes |
| **M1** | `auth.sessions` readable by the owner of the lifecycle objects | columns `id,user_id,not_after`; owner has SELECT | unreadable (the writer guard and the fence cannot work) | Auto | yes |
| **M2** | six simultaneous sign-ups of one address | 1 user, 1 identity, no 5xx | two users, or a 5xx | Auto (autoconfirm ON; else MANUAL) | yes |
| **M3** | Apple/Google linking, private relay | outcome recorded as `linked_same_user` or `separate_users`; a relay address is a different person | an outcome that contradicts the identity rule | Manual + read-back | no |
| **M4** | sign-in → start → refresh → new sign-in | `started` once then idempotent; refresh keeps `session_id`, new sign-in changes it; one `x_autopost:active`, no Kabumori row/profile | no `session_id`; refresh changes it; second start `started:true` | Auto | yes |
| **M5** | signed-out device's valid token vs explicit restart | HTTP 403 `ACCOUNT_LIFECYCLE_AUTH_REQUIRED`/`ACCOUNT_NOT_FOUND`; service stays `ended` | the stale token restarts the service | Auto | yes (fail-before proven) |
| **M6** | anonymous sign-ins | refused by the project; if enabled, a guest token is refused by the start RPC | a guest is enrolled | Auto | yes |
| **M7** | anon key / forged token / deleted login's token; expired token | 401 / 401 / refusal and no row; expired: 401 after the JWT expiry | any is accepted or creates a row | Auto (a–c) + Manual (expiry) | yes (a–c) |
| **M8** | RLS identity | each token reads only its own `service_entitlements` / `common_accounts` rows; `source`, `legacy_evidence` not selectable | another person's row or a non-granted column | Auto | yes |
| **M9** | ACL / ownership / policy inventory after the exercise | probe PASS again | any FAIL / STOP | Auto | yes |
| **M10** | SQLSTATE → HTTP status | service-only function 401/403, private function 404, unknown signature 404 — never 2xx/5xx | a terminal refusal as 2xx or 5xx (the clients would accept or retry it) | Auto (statuses recorded) | yes |
| **M11** | lock timeout under concurrent starts | a held lock gives a retryable status (503 is the documented one, recorded); the entitlement is unchanged | 2xx while the lock is held; SQL text in the body | Auto | yes |
| **M12** | end POSTONA alone | `account-delete` answers `ended`; Auth user, Kabumori entitlement and profile byte-identical; no X call | the login or another service changes | Auto (needs the two Edge functions deployed; else MANUAL) | no |
| M13 (manual) | Edge `verify_jwt` is ON for `account-delete`; the service key is a secret only; logs hold no token | the dashboard / `functions` listing | verification OFF; a key in a log or a bundle | Manual | no |
| T1 | teardown | recorded logins removed | a login cannot be removed (report; delete the project) | Auto | yes |

The Phase 7 manual items M1–M10 (GoTrue claims, anonymous setting, `55P03`/`42501` over PostgREST, Storage owner id,
default privileges, Edge secrets) are covered by M1, M4–M7, M9–M11 and M13 above; Storage ownership (Phase 7 M7) is not
part of the POSTONA sign-in acceptance and stays in the Phase 7 checklist.

## 8. GO / NO_GO gates by stage (every gate is a separate, explicit decision; none is open today)

| Stage | GO needs | NO_GO / STOP when |
| --- | --- | --- |
| **S0** approve a disposable project | the user's written approval naming owner, billing, region, the ref, the allowlist, the deny list and the teardown | any wish to reuse production, a production branch or a production backup |
| **S1** source stack and apply order | the F5 chain (#121 → … → #220), F3 PR #204 (its own review passed; unmerged), F4 PR #180 as needed for M12, reviewed in the Phase 7 order; `plan.lock.json` matches disk | an unreviewed or changed file; an out-of-order file (each refuses with its own code) |
| **S2** baseline | a reviewed, digest-pinned production-shape schema (BG1) | the repository's migrations used as a baseline; any data, cron or foreign host in it |
| **S3** chain and probe | G3 and G4 pass on the disposable project | any FAIL / STOP; a WARN that is not explained |
| **S4** acceptance M1–M12 | every step PASS with its manual items recorded | any FAIL / STOP; a "complete" claimed with an open manual item |
| **S5** app callback and device | redirect allow-list, provider configuration, `EXPO_PUBLIC_DATA_SOURCE=supabase`, a real-device pass of sign-up / sign-in / refresh / re-login (`e2eVerified` is source-false by design) | a mock-data build tested (BG4); provider enabled without its console gate |
| **S6** server-side entitlement and legacy deletion | G3 wires T13 into the three X onboarding RPCs; the legacy `social-mobile-account-delete` can no longer delete a login that has a common account (F3/G3); POSTONA's deletion goes through `account-delete` (PR #197 + #211) | `begin_social_mobile_x_oauth_*` callable without an active entitlement; the legacy saga reachable for a common-account holder |
| **S7** X / Threads revoke, F3 legacy, D1 | a real revoke answer read back under F3's own acceptance; F3 `hold()` / F3-L1 / R2' resolved; Threads remote-unverified behaviour accepted as consent; **D1: the whole-ID deletion needs the person's informed, count-bound consent when X posts are unconfirmed** | any whole-ID deletion path opened before D1 is approved and built |
| **S8** production | its own TASKs: schema-first one file at a time (`supabase/tests/common_account_lifecycle_rollout.md`), same-day read-only preflight, mutation window | anything in this document is not a production approval |

`managed_auth_delete` stays BLOCKED, `IDP_PREPAUSE_BLOCKED` stays BLOCKED and every release flag stays OFF through S0–S7.

## 9. Dependency inventory and copy-ready hand-offs (observed source vs managed behaviour kept apart)

**For the coordinator / operator (BG1, BG2, S0, S2).**
> The managed acceptance needs (1) a user approval naming a new disposable Supabase project, (2) a reviewed schema-only
> baseline of the 17 relations `20261001150000`'s preflight lists — `public.brands`, `public.social_accounts` and
> `public.social_account_oauth_states` are created by no repository migration — taken under a separate read-only approval,
> and (3) the rule that **no `supabase db push`, `supabase link` or "apply all migrations" is ever used on it**: eight
> repository migrations schedule cron jobs that call the production project's URL. Use
> `supabase/preflight/managed_disposable/cli.ts` only. *Observed in source: migrations, fixtures, probe. Not observed:
> the production catalog (never read here).*

**For G3 / F3 (X onboarding, legacy saga).**
> (a) `begin_social_mobile_x_oauth_connection`, `complete_social_mobile_x_oauth_connection` and
> `consume_social_mobile_x_oauth_state` (migration `20260919120000`) consult no entitlement: add
> `perform private.account_lifecycle_assert_active_service_write((select auth.uid()), 'x_autopost');` at the top of each
> (and pin `search_path = ''`). (b) The legacy `social-mobile-account-delete` `action: 'delete'` deletes the login and
> the common-account row of a POSTONA-only person (observed `I14b`); contain it for any person who has a common account.
> (c) F3's inherited `hold()` still compares the lease against `now()`; F3-L1 (legacy lock order) and R2' (scope derived
> from the absence of a Kabumori profile, so a POSTONA-only person cannot end POSTONA alone) are open. *Managed behaviour
> (deployed code, older builds) not inspected.*

**For G4 / POSTONA app owner.**
> This checkout's `auth-provider.tsx` calls the legacy deletion function. PR #197 bridges it to `account-delete` and
> PR #211 corrects the J4 P2 findings; neither is merged. Before any device acceptance: a build with
> `EXPO_PUBLIC_DATA_SOURCE=supabase` (a default build is the mock preview and is never enrolled), providers listed in
> `EXPO_PUBLIC_AUTH_PROVIDERS` only after their console gate, `EXPO_PUBLIC_ACCOUNT_DELETION_ENABLED` empty.

**For F4 / Threads.** Nothing is needed for sign-in / enrollment. For M12 (POSTONA end) the Threads cleanup pair stays
un-granted and the registry empty (a person with a Threads connection is refused before anything is touched).

**For F5 (next).** Decide D1; implement the informed-consent flow only after approval; keep the harness's lock in step
with any chain change (`cli.ts --write-lock` and a reviewed diff).

## 10. Not executed, and what is still unproven

Not executed (by prohibition): any managed project, real Auth sign-up / OAuth, real X / Threads, a device, the Edge
functions on a platform, any secret, Cron, migration or grant. Unproven: real GoTrue behaviour (confirmation e-mail,
identity linking, rate limits, refresh reuse interval, anonymous setting, claim names), real PostgREST status mapping
and role timeouts, RLS under the real roles, the managed owner's privileges, the production catalog (BG1), the platform
JWT verification of the Edge function, and everything listed in section 8 as a gate.

Production NO_GO: PR #121 → … → #220 are unmerged Drafts; the managed checks have not run; the server does not enforce
the entitlement on POSTONA's own writes (G3); POSTONA's deletion still bypasses `account-delete` in this checkout;
`managed_auth_delete` and `IDP_PREPAUSE_BLOCKED` stay blocked; D1 is open.

## 11. Proof inventory (this phase)

See the PR description and the F5 Report for the exact run results (offline tests 27, harness mutations 30, model run 5,
Phase 9 regression, secret scan). The model run's own report is reproduced by `common_account_phase11_model_run.sh`.
