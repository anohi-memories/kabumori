# G5-01: the common ID + service entitlement -> POSTONA authorization boundary (source-only contract)

Status: **contract + reference candidate + offline tests. Nothing is wired into an Edge function, the app or SQL; nothing was applied anywhere; no API role was
granted anything; no managed or production system, credential, OAuth, real SNS or paid API was touched.** Production is **NO_GO**.

- TASK `common-account-g5-postona-entitlement-auth-brand-boundary-offline-contract-20261019` (Issue #320, G5-01, completion K5).
- Stacked on PR #303 (owner-epoch R1–R3 fix, H1/C1 `PASS_FOCUSED_SOURCE_REVIEW` = source review only). The evidence about "today" is read from
  `origin/main` at `9802f590` (a read-only checkout); the F5 chain P3b..P10 and the owner-epoch candidate exist only in the F5 Draft-PR stack.
- New, G5-owned paths only: this document, `supabase/candidates/common_account_postona_authz/verdict.ts` (reference), the tests
  `supabase/tests/common_account_g5_01_authz_{test.ts,pg_test.ts,pg_run.sh,mutations.py}` and `supabase/preflight/managed_disposable/g5_01_contract_doc_test.ts`.
  The only edits to existing files are one line in each of the four older F5 mutation scripts (`common_account_phase11_harness`, `phase12_inventory`,
  `phase12_scanner`, `phase13_contract` `_mutations.py`): their copied trees now include the new reference directory, because the harness they run reads it.
  No file of G3 / F3, G4 / F4, G6 / F6, G1 / F1 or the app is edited.

Evidence labels: **[M]** observed in `origin/main` (path:line), **[C]** candidate in the F5 stack only, **[D]** derived by a test of this task, **[A]** assumption,
**[U]** unknown / NOT_VERIFIED.

## 1. Verdict

| Question | Answer |
| --- | --- |
| Does any POSTONA server path check the `x_autopost` entitlement today? | **No.** [M] Only the enrollment RPCs (`start_x_autopost_service`, `reactivate_x_autopost_service`) read the common account. Every POSTONA Edge function and write RPC skips it: consult, brand-dry-run, history-learning, publish-setting, X OAuth begin / consume / complete, `check_x_account_publish_authority`, `assert_x_publish_permission_for_legacy_post`, the brand_post dispatcher (`supabase/functions/_shared/brand/vault_account_brand_post.ts:36` says "Common-account (G5) boundary -- NOT enforced here"). The app's enrollment gate is the only stop, so an ended / suspended / deleting person can still call them with their JWT. |
| Is there a G5 answer a consumer could ask per request? | **Not in main.** [C] The F5 stack has the brand-level `public.common_account_brand_service_state` (service_role, P5) and the owner-only owner epoch (PR #303). Nothing calls them. [D] No API role can reach the owner, the owner epoch or the tables (test `the read this needs is NOT reachable by an API role today`). |
| What this task adds | The **G5 authorization verdict v1** contract (section 4): the same wire object G6 proposed on PR #336, answered for POSTONA features from the person's verified JWT, the live session, the common account, the entitlement, the brand membership / single owner and the F5 owner epoch; plus the **recheck rule** for every irreversible action (section 5). A pure reference (`verdict.ts`) and offline proofs on the real F5 chain. |
| Is the verdict ABA-resistant? | Yes [D]: the `owner_epoch` token binds the F5 brand owner epoch **and** the owner's `lifecycle_version` (which moves on every account-state and entitlement change, I7). Owner A -> B -> A, an entitlement ended and re-activated, a new login and a revoked session all change or refuse the verdict before the send (mock sends 0). |
| Does it fit G6's port? | Yes [D]: G6's real `createG5AuthorityPort` (PR #336 head `36b46a549cd34346ab2eb8241b3c3229b8179605`) accepts these verdicts and its recheck sees every change above (scratch run, not committed; section 9). |
| What must happen before production | A reviewed G5 read RPC (section 6, separate TASK + Codex Sol (high)), the F3 / G3 revoke for the owner epoch (PR #303 L-1), and each consumer wiring its own path (section 7). |

## 2. The chain today: what exists, what is a candidate, what is missing, who owns it

| Step | Exists in main [M] | Candidate only (F5 stack) [C] | Not implemented | Other owner |
| --- | --- | --- | --- | --- |
| 1. Login | GoTrue: email + password, OAuth (X, Google, Apple) with PKCE, native Apple id token, `linkIdentity` with a same-user check (`apps/social-mobile/src/providers/auth-provider.tsx:301,308`, `apps/social-mobile/src/lib/auth-client-flows.ts:59`); no anonymous sign-in in POSTONA | P9 enrollment fence refuses anonymous sessions for start / reactivate (`20261015090000`) | — | Auth configuration (managed) [U] |
| 2. The person's JWT -> principal | Each Edge function calls `GET /auth/v1/user` itself; there is **no shared helper** (`requireUser` / `assertBrandAccess` do not exist). Production `verify_jwt` (audit snapshot 2026-10-17, `docs/kabumori-resume/evidence/2026-10-17-final-audit/observations.json:2637-2805`): true for consult, brand-dry-run, history-learning, account-delete, social-mobile-account-delete, publish-setting; **false** for `x-oauth-connect-user` and `x-test-post` | P3b writer guard reads `sub` + `role` + `session_id` and a live `auth.sessions` row (`20261010051938:75-160`) — not wired | A shared Edge principal helper | each function's owner |
| 3. Session liveness | Nothing per request (a JWT stays valid until expiry after sign-out) | P3b / P9 read `auth.sessions` | Per-request check in Edge | GoTrue owns `auth.sessions` |
| 4. Common account + service entitlement | Tables, RLS own-row read, lifecycle_version (`20261001150000:224-238,341-352,410-477`); `start_*` / `reactivate_*` RPCs; **no server consumer** | P5 `common_account_brand_service_state(brand, service)` (service_role) and the owner-only `account_lifecycle_service_state_readonly` (`20261012230000:78-170`) | A per-request read callable from an Edge with the person's JWT | G5 |
| 5. Brand membership / owner | `brand_memberships` (owner, admin, member, viewer), self-select RLS (`20260918120000:41-93`); consult / dry-run / history-learning require `role = owner` + `social_mobile_user_v1`; **publish-setting accepts owner or admin** (`20261003090000:189`) | P5 `account_lifecycle_brand_owner` (exactly one owner of a user workspace); owner epoch (PR #303) | Owner epoch in any request path | membership writers: F3 / G3, G4, F4 (PR #285 §2) |
| 6. Feature policy (which features a service opens) | Implicit in each function | — | A declared POSTONA feature list (here: `POSTONA_FEATURES`) | G6 owns the AI plan rule (PR #336); POSTONA owners own the features |
| 7. Recheck before an irreversible call | x-test-post rechecks `check_x_account_publish_authority` right before the X create (lock-free STABLE read); account-delete renews its lease before each external step; **consult / dry-run / history-learning: one check, then the external call**; X OAuth: **the code is exchanged before the ownership recheck** (`supabase/functions/x-oauth-connect-user/oauth_logic.ts:271-289`) | — | A uniform recheck with a generation (section 5) | each function's owner |

## 3. POSTONA entry points and the app (facts the contract has to fit)

- **Edge functions** [M] (caller identity / brand / entitlement): consult and brand-dry-run take `brand_id` from the body only as a selector and require the
  caller's owner membership; history-learning is OFF unless its env flag is exactly `true`; publish-setting derives the brand from the social account in SQL
  under row locks; x-oauth-connect-user derives the brand in `begin_social_mobile_x_oauth_connection`, which **creates** `u_<md5>` + an owner membership when
  the caller owns none and does not look at `common_accounts` (`20260922003101:27-46`), so it can re-create a workspace during a common-account deletion;
  x-test-post (the brand_post dispatcher) has **no caller authentication in code** (`supabase/functions/x-test-post/index.ts:3302-3333`) and was
  `verify_jwt=false` in the 2026-10-17 snapshot.
- **The app** [M]: the enrollment gate calls `start_x_autopost_service` once per login and caches the answer for the whole login (no re-check on foreground
  or lifecycle change; `apps/social-mobile/src/features/service-enrollment/service-enrollment-gate.tsx:79-98`); the workspace is re-derived from the
  self-membership on each load and is safe only because onboarding refuses more than one brand (`apps/social-mobile/src/domain/onboarding.ts:62`); sign-out is
  `supabase.auth.signOut()` with the default (global) scope (`apps/social-mobile/src/providers/auth-provider.tsx:347`, Kabumori `src/lib/auth.ts:86`), so
  signing out of one app ends the shared login on every device of both apps. Brand ids are never taken from user input; requests are pinned to one login.

## 4. The G5 authorization verdict v1 (the contract)

**Wire object** — exactly G6's proposal (`docs/ai-provider/G6_APP_POLICY_AUTHORITY_PORT.md` on PR #336), so one answer serves G6, G3 / F3 and G4 / F4:

```
{ v: 1, decision: "allow" | "deny" | "unknown" | "pending", reason: <token> | null,
  scope: { app, feature, brand_slug },            // a copy of the question; a consumer refuses any difference
  subject: { kind: "user", user_id: <uuid> },     // the JWT subject, never a body field
  session: { state: "active" | "revoked" | "expired" | "unknown", ref: "s:<32 hex>" } | null,
  owner_epoch: "g5oe:<F5 brand owner epoch>:<owner lifecycle_version>" | null,
  entitlements: ["postona:x_autopost"],           // the scope app's ACTIVE entitlements only
  issued_at_ms, expires_at_ms }                   // an allow lives at most 60 s
```

- `principal_id` = `subject.user_id`, from the verified JWT (`sub`, `role = authenticated`, `session_id`). A user id in a request body is never read.
- `brand_id` = `scope.brand_slug` (POSTONA brand ids are text slugs, `^[a-z][a-z0-9_-]{0,63}$`); malformed ids are refused before any read.
- `service_key` = the feature's service (`x_autopost` for every POSTONA feature today; `x_autopost` is the POSTONA umbrella, Threads included).
- `session.ref` is a hash of the session id (the id never travels); stable for one login, different for a new one.
- `owner_epoch` is **opaque** to consumers (G6 already treats it so). It changes on every owner change (F5 epoch; A -> B -> A included) and on every account /
  entitlement change of the owner (`lifecycle_version`, I7). NULL only when the answer is not `allow`.
- The **generation** a consumer compares is `[user_id, session.ref, owner_epoch, entitlements]`.

**Decision order** (`decide`; anything missing or unexpected is `unknown` / `deny`, never `allow`):

| # | Check | Refusal |
| --- | --- | --- |
| 1 | the feature exists for the app (Kabumori / Miseiro / unknown features are not answered here) and the brand id is well formed — **nothing is read before this** | deny `FEATURE_NOT_ENABLED`, `BRAND_REQUIRED` |
| 2 | the caller: a uuid subject, role `authenticated`, a uuid session id — nothing is read otherwise | deny `AUTH_REQUIRED` |
| 3 | the login still exists; the session row is live | deny `AUTH_REQUIRED`, `SESSION_REVOKED`, `SESSION_EXPIRED`; unknown `SESSION_UNKNOWN` |
| 4 | the common account: present, not deleting, no open account deletion (退会), `active` | deny `ACCOUNT_NOT_FOUND`, `ACCOUNT_DELETION_IN_PROGRESS`, `ACCOUNT_LOCKED`; unknown `ACCOUNT_STATE_UNKNOWN` / `ACCOUNT_UNREADABLE` |
| 5 | the entitlement: present, no open service deletion, `active` (`provisioning` = pending) | deny `SERVICE_NOT_REGISTERED`, `SERVICE_DELETION_IN_PROGRESS`, `SERVICE_SUSPENDED`, `SERVICE_NOT_ACTIVE`; pending `SERVICE_PROVISIONING`; unknown `SERVICE_STATE_UNKNOWN` |
| 6 | the brand: the caller is a member (an unknown brand gives the **same** answer — no existence oracle), the role is allowed (owner only today), a user workspace, exactly one owner, the owner is the caller | deny `BRAND_ACCESS_DENIED`, `ROLE_NOT_ALLOWED`, `WORKSPACE_KIND_UNSUPPORTED`; unknown `WORKSPACE_OWNER_UNKNOWN` |
| 7 | the F5 owner epoch is a positive number (NULL = coverage broken / not installed / not one owner) | unknown `OWNER_EPOCH_UNAVAILABLE` |

**The facts** are read in **one statement** (one snapshot), so the owner, the owner epoch, the account and the entitlement cannot come from different moments
(the owner-epoch caller rule of PR #285 §3). The TEST-ONLY form is `FACTS_SQL` in `supabase/tests/common_account_g5_01_authz_pg_test.ts`. The read takes no
lock: it is advisory, and a writer that must not race a freeze still uses F5's locking guards (P3b / P5 assert) inside its own transaction.

**Owner only.** POSTONA workspaces are personal user workspaces (F5 P5 rule). An `admin` member is refused (`ROLE_NOT_ALLOWED`); publish-setting's
owner-or-admin rule (section 2, step 5) is the one place that differs and is the owner's to align.

## 5. The recheck rule for irreversible actions (TOCTOU)

An X / Threads post, an OAuth token exchange, a paid AI call and any external deletion step run only inside `guardIrreversible`:
accept the first verdict -> prepare -> ask a **fresh** verdict for the same scope -> require `allow` with the **same generation** -> act once.
G5 unreachable at the recheck, a refusal, a different scope or a changed generation send nothing (`AUTH_UNAVAILABLE_BEFORE_SEND`, `RECHECK_<reason>`,
`AUTH_CHANGED_BEFORE_SEND`). No database lock spans the external call; the residual window is from the recheck to the provider's acceptance, the same limit
F3's live fence documents (M1-F3). A consumer that cannot afford the recheck must not run the action.

## 6. The shared object this needs (DESIGN ONLY — a separate TASK behind Codex Sol (high))

There is no way for an Edge function to obtain these facts today: the owner, the owner epoch and the readonly service state are owner-only, the tables are
revoked from `service_role`, and the person's own RLS read cannot see the owner epoch or another member's role [D]. Proposed, **not created**:

- `public.common_account_authorization_verdict(p_app text, p_feature text, p_brand_id text) returns jsonb` — `STABLE`, `SECURITY DEFINER`,
  `set search_path = ''`, owned by the lifecycle owner, **EXECUTE to `authenticated` only**. The subject and the session id come from the request's JWT claims
  (`auth.uid()` and `session_id`, as P3b reads them), never from a parameter. One statement; returns the fields of section 4 without times (the Edge adds
  `issued_at_ms` / `expires_at_ms`), or a refusal. No lock, no write, no new table.
- A worker form for jobs with no person session (the brand_post dispatcher, a Threads dispatcher): `common_account_brand_service_state` (P5, service_role)
  **plus** the owner epoch compared in the **same statement as the claim**, with the attestation's stored epoch (G4's PR #282 / #287 pattern: `=`, NULL fails).
- Before either: the PR #303 install dependency (F3 / G3 revoke of TRIGGER / TRUNCATE / REFERENCES on `public.brand_memberships`), the PR #233 limited recheck,
  an isolated PG17 proof of the RPC's ACL (no API role but `authenticated`; MEMBER-path check as in PR #303), and the owner's approval.

## 7. Hand-off to other owners (one time; nothing of theirs is edited)

| Owner | What the contract asks | Evidence |
| --- | --- | --- |
| **G3 / F3** (X posting, reservations, worker) | Add the worker form (section 6) at the three points `vault_account_brand_post.ts:36-41` already names (`check_x_account_publish_authority`, `set_x_account_publish_authority('enabled')`, the `claim_due_post` planner); keep the recheck right before the X create. Decide `x-test-post`'s caller authentication: no check in code and `verify_jwt=false` in the 2026-10-17 snapshot means anyone with the URL can trigger due-post claiming and the dry-run modes (OpenAI cost) [M; live state U]. Align publish-setting's owner-or-admin rule. | section 2, 3 |
| **G4 / F4** (X / Threads connection, credentials) | Ask the verdict for `x_connect` / `threads_connect` and recheck it **before** the code exchange (today the X code is exchanged before the ownership recheck; `consume` checks only the initiator; DB error text reaches the client; `redirect_uri` has no server allowlist). `begin_social_mobile_x_oauth_connection` should refuse while the common account is deleting (it can re-create the workspace). Keep storing the F5 epoch as `bigint not null` and comparing with `=`. | section 2 step 7, section 3 |
| **G6 / F6** (common AI) | The wire is your v1 proposal unchanged; `owner_epoch` is opaque (`g5oe:<epoch>:<lifecycle_version>`); `postona:consult` / `post_generation` map to `x_autopost`. consult / brand-dry-run / history-learning have no entitlement check today; brand-dry-run falls back to defaults when its settings read fails. | section 4, 9 |
| **G1 / F1** (POSTONA app) | The gate's cached `ready` should be re-asked on foreground and when `lifecycle_version` changes; the global sign-out ends the other app's login too (decide `scope: 'local'` vs global and surface sign-out failures); one brand source for every screen before multi-brand. | section 3 |

## 8. NOT_VERIFIED and limits

- Managed Supabase: real grants, `verify_jwt` today, GoTrue's session revocation timing, PostgREST claim names — **NOT_VERIFIED**. The `verify_jwt` values are a
  2026-10-17 snapshot.
- No Edge function, app screen or SQL calls the reference; it is a contract, not an integration. The G5 read RPC does not exist.
- The verdict is advisory (no lock). It narrows the TOCTOU window to recheck -> provider acceptance; it cannot undo an accepted external call.
- Admin / member roles, organisation workspaces and Miseiro are out of scope (refused).
- PR #303 is a source PASS only (H1/C1); the owner epoch is not applied anywhere.

## 9. Tests (offline; exact commands and results in section 11)

- **Pure suite** `common_account_g5_01_authz_test.ts` (no network permission): the allowed state and its exact wire; a common ID without POSTONA; every
  entitlement / account state; other person / other brand / existence oracle; owner unknown; the caller only from the JWT (nothing read for a refused caller or
  feature); revocation / expiry; any missing fact is never allow; TOCTOU (A -> B -> A, entitlement ABA, revocation, deletion, owner change, G5 unreachable,
  tampered or foreign recheck, new login, expired first verdict) with a counting transport; 22 tampered wire objects; G6 shape compatibility.
- **PG17 suite** `common_account_g5_01_authz_pg_run.sh` -> `common_account_g5_01_authz_pg_test.ts`: the Phase 11 model baseline, the real membership migration, the
  ten F5 chain files and the PR #303 owner-epoch candidate; real `start_x_autopost_service`, `begin_service_deletion`, `begin_common_account_deletion`,
  `auth.sessions` rows and membership writes; F5 P5 `common_account_brand_service_state` as an oracle; the API-role reachability proof of section 6.
- **Mutation check** `common_account_g5_01_authz_mutations.py`: each rule of `verdict.ts` and of the facts read is broken in a copy; the pure suite or the PG17
  suite must fail.
- **G6 compatibility** (scratch, not committed): G6's `authority_port.ts` from PR #336 run over these verdicts.
- **Document test** `supabase/preflight/managed_disposable/g5_01_contract_doc_test.ts`.

## 10. Re-run

```bash
deno test --no-config --no-check supabase/tests/common_account_g5_01_authz_test.ts
CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_g5_01_authz_pg_run.sh
CAL_PGHOST=… CAL_PGPORT=… CAL_PGSUPER=… python3 supabase/tests/common_account_g5_01_authz_mutations.py <repository root>
deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/g5_01_contract_doc_test.ts
```

## 11. What was executed for this document

All commands ran in `/Users/yuya/Developer/kabumori-g5-01` (a clean worktree stacked on PR #303) against a throw-away local PostgreSQL 17.11 (`listen_addresses`
empty, a Unix socket under `/private/tmp`, fake data, deleted at the end; every runner refuses a host that is not a `/tmp` socket directory). Evidence about
`origin/main` was read from a read-only detached checkout at `9802f590`; every cited `path:line` was re-checked by a script against that checkout. No managed or
production system, no credential, no network request, no real X / Threads / AI.

| # | Check | Command | Result |
| --- | --- | --- | --- |
| 1 | the pure suite (no network permission) | `deno test --no-config --no-check supabase/tests/common_account_g5_01_authz_test.ts` | **13 tests** passed, 0 failed |
| 2 | the PG17 suite on the real F5 chain + the PR #303 candidate | `CAL_PGHOST=<tmp socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_g5_01_authz_pg_run.sh` | **10 tests** passed, 0 failed (three consecutive runs) |
| 3 | mutation check (feature policy, caller, session, account, entitlement, brand / owner, token, consumer check, recheck, facts read) | `python3 supabase/tests/common_account_g5_01_authz_mutations.py <repository root>` | control PASS, **39/39 detected**, 0 invalid (the first run found one survivor -- `decide` called directly with an `anon` caller -- and the pure suite gained that case) |
| 4 | G6 compatibility | G6's `authority_port.ts` from PR #336 (`36b46a549cd34346ab2eb8241b3c3229b8179605`) in a scratch folder, its `createG5AuthorityPort` fed with `decide()` | 1 scratch test passed: allow accepted; owner A -> B -> A and entitlement ABA change the generation; a revoked session and a removed entitlement are refused at the recheck; an unchanged world keeps the generation (not committed) |
| 5 | regression of the stack | `common_account_owner_epoch_run.sh`; `common_account_m2_ai_consult_authz_run.sh` | 19 passed; 12 passed |
| 6 | this document and the whole harness | `deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/` | **189 passed**, 0 failed (184 of PR #303 + 5 new) |
| 7 | type-check, lint, shell | `deno check --no-config` on the four new TypeScript files; `deno lint --no-config` on them; `bash -n` on the runner | no error; `Checked 4 files`; syntax OK |

Not run, on purpose: any managed or production access; wiring the reference into an Edge function or the app; creating the G5 read RPC; G3 / G4 / G6 / app
proofs against this contract; a Codex review (not required for a source-only contract unless a shared object is created -- section 6 is the gate).
