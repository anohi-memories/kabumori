# Common account — Phase 3c: disposable Supabase proof runbook (OFFLINE READY, NOT EXECUTED)

TASK `common-account-phase3c-disposable-supabase-proof-readiness-20261010` (G5).

**Verdict: `OFFLINE_READY_NOT_EXECUTED`.**

- Nothing in this document has been run against any Supabase project.
- No project exists, none was created, and no credential was set up.
- Whole-account managed Auth deletion stays **BLOCKED**: the Phase 3a gate `managed_auth_delete` is schema-locked to `blocked`.
- Neither candidate fence (Option A+B or Option D) is chosen or approved here.

**Immutable inputs** (cross-referenced, never edited by Phase 3c):

- PR121 at exact head `76b50e1e03f82faaa3460bab1603afa8fef3ce44` (Draft, unmerged).
  - `docs/common-account/phase3b-identity-writer-fence-feasibility.md` §8 is the source of E1–E12. Its 12 table rows are pinned byte-for-byte in
    `supabase/tests/common_account_disposable_e2e/pr121_e1_e12_rows.md`, sha256
    `8678d45539fa25e3373a29318770e0313999c411949d719e8b7cdbc2679f7b66`.
  - `supabase/migrations/20261010051938_common_account_service_write_guard.sql` and its `supabase/tests/common_account_write_guard_*` files.
- Phase 1 / 2 / 3a migrations on main (`20261001150000`, `20261006230000`, `20261009120000`).
- `docs/postona/threads-g5-t9-t10-t13-shared-contract-20261010.md` (G4/G5 contract, G4-owned document).

## 1. What Phase 3c adds (offline only)

| Path | What it is |
| --- | --- |
| this runbook | Exact E1–E12 procedure, gates, evidence rules, the A+B vs D comparison, the G4 dependency matrix (§9) and the next approvals (§10) |
| `supabase/tests/common_account_disposable_e2e/catalog.ts` | E1–E12 as data. Each entry has PR121 `what` / `pass` verbatim plus: kind (observation / destructive), destructive operations, extra approvals, timing control, inputs, observables and UNKNOWN conditions. |
| `…/guard.ts` | Deny-by-default validation of a future run request, a standalone project marker and a used-project ledger |
| `…/redact.ts` | Deterministic per-run redaction; allowlist for the E1 config capture |
| `…/evidence.ts` | Outcome model: only PASS counts; UNKNOWN / FAIL / NOT_RUN / missing all block; neither candidate is chosen |
| `…/plan.ts`, `…/cli.ts` | Dry-run plan printer and request validator. **No execute command, no network code.** |
| `…/catalog_fingerprint.sql` | Read-only catalog fingerprint: auth tables and privileges, foreign keys and cascades, triggers, lifecycle functions with owner/ACL/body hash, roles |
| `…/fingerprint_local_run.sh` | Offline proof, on a local PostgreSQL, that the fingerprint only reads, is deterministic and sees what the proof needs |
| `…/fixtures/*.sample.json` | Fake request, marker and ledger (fake refs) |
| `…/operator_checklist.md` | Checklist template for a future approved run |
| `…/*_test.ts` | Offline Deno tests: default deny, ambiguity, override refusal, consent per scenario, redaction, verdicts, E1–E12 coverage, static no-network rules |
| `…/harness_mutations.py` | Defect detection: 31 single mutations (guard, CLI, redaction, verdict, catalog, a network call) applied to a scratch copy; every one must make the suite fail |

Run the offline proof. Deno runs **without** net / env / run permissions; the static test asserts it.

```bash
deno test --no-config --no-check --allow-read supabase/tests/common_account_disposable_e2e/
```

```bash
CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_disposable_e2e/fingerprint_local_run.sh
```

```bash
deno run --no-config --allow-read supabase/tests/common_account_disposable_e2e/cli.ts plan
```

```bash
python3 supabase/tests/common_account_disposable_e2e/harness_mutations.py
```

## 2. Gates before ANY real step (all must hold; none is satisfied today)

1. **User approval of one exact, new, disposable project** — gate (a).
   - A fresh project created only for this proof, by the user or with the user's explicit instruction.
   - Fake data only: no production data, clone, import or copy.
   - **Never** `wsmznyzcvmuitkglfeuj`, the Kabumori/POSTONA project that G3 also writes to.
   - Billing and plan are the user's decision.
2. **A standalone project marker** (`project-marker.json`). It must:
   - live **outside** the repository;
   - not be the Supabase CLI link (`supabase/.temp/project-ref`);
   - name the same 20-letter ref;
   - say `environment: disposable`, with `contains_production_data: false` and `production_clone: false`;
   - be named `kabumori-disposable-proof-<…>` (no prod/live/staging/main/release/shared token);
   - carry this task id and a future `expires_at`.
3. **A used-project ledger**. Its absence denies the run. The ref must not be in it, and is added after teardown, so a project is never reused.
4. **Typed confirmation**, exactly: `I CONFIRM <ref> IS A DISPOSABLE PROJECT WITHOUT PRODUCTION DATA FOR RUN <run_id>`.
5. **Per-run, per-scenario destructive consent** — gate (b). Each destructive experiment needs its own
   `DESTROY-<E#>-<ref>-<run_id>`. A consent for an unrequested or observation-only scenario denies the run.
6. **Extra approvals:**
   - E7 needs `project_auth_config_change`: it enables a test Auth hook on the disposable project.
   - E11 needs `option_d_security_approval`, with **both** a user approval reference and an independent security review reference.
7. **`cli.ts validate` must answer `REQUEST_VALID_DRY_RUN_ONLY`** (exit 0), and its output is kept as the first evidence item.
   - There is no `--force`: every override-shaped flag or field is refused (`OVERRIDE_NOT_SUPPORTED`).
   - No default ref; no fallback to an environment variable or a CLI link.
   - The ref is never echoed.
8. **Never** use, at any point:
   - `supabase link`, `supabase db push`/`reset`/`pull`, `supabase migration up`/`repair`, `supabase functions deploy` or `supabase secrets`;
   - a Supabase MCP connection;
   - a production URL or key.
   - Migrations are applied to the disposable database only, as single reviewed files with `psql -f`, in a transaction.
9. **Credentials** — the disposable project's keys, database password and Management API token:
   - are held by the operator only (password manager, interactive prompt);
   - are never written to the repository, a file, shell history or evidence;
   - must not be pasted into chat.

The future executor does not exist. A later, separately reviewed task may add one; until then a run is manual, step by step, against this runbook.

## 3. Evidence, correlation and retention

- **Correlation id:** `<run_id>.<E#>.<seq>`, for example `p3c-run-20261011-01.E4.003`. It is recorded with every request and every SQL read-back.
- **Timestamps:**
  - Every event records the operator host time in UTC (ISO 8601) and in JST.
  - Every SQL read-back records `clock_timestamp()` from the database.
  - Clock skew is bounded at run start and end by three `select clock_timestamp()` round trips (minimum RTT / 2).
  - Without a skew bound, ordering claims are UNKNOWN.
- **Catalog fingerprint:** run `catalog_fingerprint.sql` inside `begin transaction read only; … rollback;` at run start, before and after every destructive experiment, and at run end. Keep each sha256.
  - Format reference (local fixture, not a project): 78 lines, sha256 `423c0d486abc752d531371d6c897efffe200b567ceab45a0599565575ccf3833`.
- **Redaction before write:** everything passes through `redact(text, run_id, [ref])` before it touches disk. That covers JWTs, `Bearer`/`Basic`, `apikey`/`authorization`/cookie headers, `code`/`state`/token/nonce/verifier parameters, secret-named JSON fields, e-mails, project hosts, UUIDs and IPv4 addresses.
  - UUIDs become stable per-run placeholders, so one fake user can be followed through a run, while two runs cannot be joined.
  - Configuration is captured only through `allowlist(config, E1_CONFIG_ALLOWLIST)`.
- **Per experiment**, one redacted JSON file:
  - `{ id, correlation ids, outcome PASS|FAIL|UNKNOWN|NOT_RUN, evidence[], e4Finding?, e4Mitigation?, notes }`;
  - the HTTP method, path template, status and GoTrue error code of each request — never bodies containing tokens;
  - SQL read-backs as counts and timestamps, with ids hashed.
- **Retention:**
  - Redacted evidence lives under an operator-chosen absolute directory outside the repository during the run.
  - After review, only a summary (outcomes, codes, counts, timestamps, fingerprint hashes, the `verdict()` output) is committed in a later TASK Report.
  - The local redacted evidence is deleted within 14 days of the review.
  - Raw, unredacted output is never written.
- **Teardown:** delete the fake users and buckets; delete the disposable project, which is the user's action; add the ref to the ledger.
- **Verdict:** `evidence.ts verdict()`.
  - A candidate reaches at best `EVIDENCE_COMPLETE_PENDING_INDEPENDENT_REVIEW`, and only if every experiment it needs is PASS with evidence.
  - Anything UNKNOWN fails closed. Nothing here opens a gate.

## 4. Timing control: what can and cannot be forced

| Control | Used by | What it proves | Where it stays inconclusive |
| --- | --- | --- | --- |
| **Operator-paced barrier.** The person stops at a step (e.g. at the provider consent screen) until the database read-back shows the previous step committed. | E2, E3, E4, E5, E7, E9 | Strict ordering of whole requests: "ban committed (read back), then callback". This is deterministic for V11 (E4). | Nothing inside one GoTrue request can be paused. |
| **Database lock latch.** A `psql` session holds `select … from auth.users where id = <fake user> for update` (or an uncommitted lifecycle RPC) while GoTrue or PostgREST acts. | E11, E12 | That a GoTrue identity insert queues behind our lock (its foreign-key `KEY SHARE` conflicts with `FOR UPDATE`). This is observed in `pg_stat_activity` (`wait_event_type = 'Lock'`) if the inspecting role may see other roles' sessions. | If `pg_stat_activity` hides GoTrue's backend (no `pg_read_all_stats`), the wait is UNKNOWN; only the final outcome is evidence. Never latch a GoTrue request longer than `api_max_request_duration`, or GoTrue cancels it. |
| **Statistical burst.** About 200 parallel requests around the ban commit, repeated. | E6 | An upper bound on observed windows only. | GoTrue's in-request window (user loaded before the ban, identity inserted after it) **cannot be forced** from outside. No observed overlap means UNKNOWN, not PASS. |

## 5. Experiments

Common to every experiment:

- Inputs are the approved ref, the `run_id`, the fake identities and the experiment-specific inputs in `catalog.ts`.
- Fake users are created fresh, one per experiment (e.g. `p3c-<run_id>-E4-1@<operator's disposable mail domain>`), with random throwaway passwords that are never logged.
- Provider accounts are dummy test accounts only.
- "Admin" calls use the disposable project's service key, held by the operator.
- SQL runs as `postgres` on the disposable database.
- Each experiment ends with the fingerprint, and with the fake user's per-table counts:
  - `select count(*) from auth.identities where user_id = $1` — and the same for `auth.sessions`, `auth.refresh_tokens` (via `session_id`), `auth.mfa_factors`, `auth.one_time_tokens` and the public lifecycle tables;
  - every table that exists in the fingerprint.

Paths and payload shapes below come from GoTrue master `ce9a8ee` and the public Management API (`AuthConfigResponse` fields checked 2026-10-10). If the project's version differs, the operator records the difference, and the result is UNKNOWN.

### E1 Version and config (observation)

- **PR121 pass (verbatim):** GoTrue ≥ v2.195.0 recorded. Manual linking, flow-state expiry, request duration, JWT expiry, session time-box and audit-to-Postgres recorded.
- **Steps:**
  1. `GET /auth/v1/health` and record `version`.
  2. Management API `GET /v1/projects/<ref>/config/auth` (operator token); keep only `allowlist(…, E1_CONFIG_ALLOWLIST)`: `security_manual_linking_enabled`, `api_max_request_duration`, `jwt_exp`, `sessions_timebox`, `sessions_inactivity_timeout`, `hook_custom_access_token_enabled`, … .
  3. Run the fingerprint; record `server_version_num`.
- **Not exposed by the config API:** flow-state expiry and audit-to-Postgres. They are filled in from E4 (measured flow lifetime) and E10 (audit rows present).
- **PASS:** version ≥ 2.195.0, every allowlisted field present, and the two back-filled values recorded.
- **FAIL:** version < 2.195.0 (V3 does not hold, so A+B cannot rely on refusing banned access tokens).
- **UNKNOWN:** a missing field; E4 or E10 not run.

### E2 Ban vs OAuth callback with automatic linking (destructive)

- **PR121 pass (verbatim):** 403 `user_banned`; no `auth.identities` row; no session.
- **Steps:**
  1. Create fake user U with a verified e-mail equal to the dummy provider account's verified e-mail.
  2. Admin `PUT /auth/v1/admin/users/<U>` with `{"ban_duration": "<long>"}`. Read back `banned_until > now()`. This is the barrier.
  3. Start the OAuth sign-in with the dummy provider account and complete the provider consent.
  4. Record the callback status and error code.
- **Read-back:** identities of U unchanged (no new provider row); no new session; counts before and after.
- **UNKNOWN:** the provider does not mark the e-mail verified; the provider fails before the callback.

### E3 Ban vs manual link started after the ban (destructive)

- **PR121 pass (verbatim):** `/user/identities/authorize` gives 403.
- **Steps:**
  1. U signs in (password) and keeps the access token.
  2. Admin ban, read back.
  3. `GET /auth/v1/user/identities/authorize?provider=<p>` with U's pre-ban access token.
  4. Record the status and error code.
- **UNKNOWN:** manual linking disabled. The refusal then has another cause; record it, but it is not PASS.

### E4 Manual link started before the ban, callback after it (destructive)

- **PR121 pass (verbatim):** Expected to **link**: confirms or refutes the counterexample. If it links, Option A needs manual linking off, or a settle time longer than the flow-state expiry.
- **Steps (operator-paced, deterministic):**
  1. Manual linking must be enabled on the disposable project (the POSTONA app needs it). Record the setting.
  2. U signs in. Call `/user/identities/authorize` and receive the provider URL; the flow state now exists.
  3. **Stop** at the provider consent screen.
  4. Admin ban U and read back `banned_until`.
  5. Complete the consent; the callback arrives after the ban.
- **Read-back:** `auth.identities` for U — a new provider row means **LINKED**; an error with no row means **REFUSED**. Compare the row's `created_at` with the ban read-back time.
- **Flow lifetime (fills E1):** repeat with fresh users and consent delays of 240 s, 310 s and 600 s. The longest delay that still links bounds the expiry.
- **PASS:** a conclusive LINKED or REFUSED, with the ordering read back (`e4Finding` set).
  - LINKED blocks A+B unless a mitigation is itself evidenced (`e4Mitigation`): manual linking verifiably off in the target setting, or a settle time longer than the measured flow lifetime.
- **UNKNOWN:** the ban time cannot be read back; the provider fails; manual linking cannot be enabled.

### E5 Ban vs refresh and ID-token grant; logout ordering (destructive)

- **PR121 pass (verbatim):** Refresh 400 `user_banned`; ID-token sign-in 403; `/logout` refused after the ban (so revoke before the ban).
- **Steps, user U-a:**
  1. Sign in, keeping the access and refresh tokens.
  2. Admin ban.
  3. `POST /auth/v1/token?grant_type=refresh_token`.
  4. Password sign-in.
  5. ID-token sign-in with the test OIDC issuer, if available.
  6. `POST /auth/v1/logout?scope=global` with the access token.
- **Steps, user U-b:**
  1. Sign in.
  2. `/logout?scope=global` **before** the ban (expect 204). Sessions = 0.
  3. Ban.
  4. Refresh fails because the session is gone.
- **UNKNOWN (ID-token half):** no test OIDC issuer.

### E6 Concurrency around the ban commit (destructive)

- **PR121 pass (verbatim):** The maximum time from ban commit to a committed identity is measured, and it is ≤ the configured request duration.
- **Steps:**
  1. Prepare about 200 automatic-link attempts for one fake user U: distinct dummy provider subjects sharing U's verified e-mail, via the test OIDC issuer, or a mix of link and sign-in requests.
  2. Fire them with a uniform jitter over ±2 s around an Admin ban of U.
  3. Repeat for at least 5 rounds, each with a fresh U.
- **Per attempt:** correlation id, send and receive times, status, and whether an identity row exists (`created_at`). Per round: the ban read-back time.
- **PASS:** at least 20 attempts per round straddle the ban commit, within the skew bound, and the maximum (identity `created_at` − ban time) ≤ `api_max_request_duration`.
- **UNKNOWN:** no straddling attempts; throttling before GoTrue; an unbounded skew. The window **cannot be forced**, so this never proves absence.

### E7 Custom Access Token hook refusing a deleting account (destructive, extra approval)

- **PR121 pass (verbatim):** Refuses password, refresh, PKCE exchange and ID token. A PKCE link before the exchange **is** committed (V10). Measure latency, and the behaviour when the hook errors.
- **Steps:**
  1. In the disposable database, create a test hook function `public.p3c_access_token_hook(event jsonb) returns jsonb`.
     - It returns an error object when `public.common_accounts.status = 'deleting'` for `event->>'user_id'`.
     - `grant execute` to `supabase_auth_admin` only.
  2. Enable it with the Management API config `PATCH` (approval `project_auth_config_change`).
  3. Put U's account into `deleting` (`begin_common_account_deletion` through the service role in the disposable database).
  4. Try password, refresh, PKCE exchange and ID token.
  5. PKCE link: start, complete the callback, then exchange. The identity row should exist even though the exchange is refused.
  6. Make the hook raise on purpose and record what **every** user's sign-in does (blast radius).
  7. Record the hook latency.
  8. Disable the hook.
- **UNKNOWN:** the hook cannot be enabled on the project's plan.

### E8 Admin delete cascades on the project's schema (destructive)

- **PR121 pass (verbatim):** Every `auth` child row is gone. Phase 1's shadow guard records `login_removed`. Public foreign keys behave as in the fixtures.
- **Steps:**
  1. Apply Phase 1, 2 and 3a (single files, `psql -f`, in order) to the disposable database. Fingerprint.
  2. U: sign in (session, refresh token), start the Kabumori and POSTONA services through the real RPCs, link a second identity, and `begin_common_account_deletion`.
  3. Admin `DELETE /auth/v1/admin/users/<U>`.
  4. Take per-table counts before and after.
  5. Read back the Phase 1 operation: `status` and `last_error_code` (`login_removed` / `ACCOUNT_REMOVED_EXTERNALLY`).
  6. Fingerprint again.
- **UNKNOWN:** an auth table that cannot be read.

### E9 Stale tokens after logout, ban and delete, against PostgREST and Storage (destructive)

- **PR121 pass (verbatim):** Guarded writer codes match §6. Unguarded writer and Storage-upload outcomes are recorded. `auth.sessions` is readable by `postgres` (H5).
- **Steps:**
  1. With E12's guard and test writer in place, create a fake bucket `p3c-proof-<run>` with a test policy allowing an authenticated person to upload under `<auth.uid()>/`.
  2. For a fake user, call through PostgREST with the same old access token in four states: live, after a global logout, after a ban, and after an Admin delete.
     - `POST /rest/v1/rpc/fixture_guarded_service_write` — the guarded writer;
     - a direct insert into an RLS-owned test table — unguarded;
     - a Storage upload.
  3. Read back `storage.objects.owner_id`.
- **Expected from the PR121 guard:** live OK; logout `ACCOUNT_LIFECYCLE_AUTH_REQUIRED`; after delete `ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND`.
- **Unguarded and Storage outcomes:** recorded as facts. They feed the owner tasks.
- **UNKNOWN:** the token expired before the replay (`jwt_exp` too short — rerun with fresh tokens per state).

### E10 Audit log (destructive)

- **PR121 pass (verbatim):** `identity_linked` rows (actor, provider) persist after the user's deletion and can be read by `postgres` (H4).
- **Steps:**
  1. Link an identity to U.
  2. Count `auth.audit_log_entries` where `payload->>'action' = 'identity_linked'` and the actor is U (store only counts and timestamps).
  3. Admin delete U.
  4. Count again.
  5. Record `has_table_privilege` from the fingerprint.
- **UNKNOWN:** the table is absent or unreadable (audit-to-Postgres off). This also back-fills E1.

### E11 Option D (destructive, user + independent security approval)

- **PR121 pass (verbatim):** Can `postgres` `DELETE FROM auth.users` under our lock? Differences from the Admin delete. GoTrue's view of the user's tokens afterwards.
- **Run only** with `option_d_security_approval` (both references). This is a probe of the platform, not an adoption of Option D.
- **Steps:**
  1. Set up U as in E8.
  2. In one `psql` transaction on the disposable database, as `postgres`: `select … from auth.users where id = <U> for update`; record the permission outcome; then `delete from auth.users where id = <U>`; commit.
  3. Compare the per-table counts with E8.
  4. Afterwards, U's refresh token is refused and `GET /auth/v1/user` with U's access token answers 403 (`session_not_found` / user missing). Record both.
  5. **Latch variant:** hold the `for update` and fire an automatic-link attempt for U. GoTrue's insert queues (observe if visible). Then delete and commit: the link must fail with no identity row.
- **UNKNOWN:** E8 has no comparable result. A refused `DELETE` is a **FAIL for Option D** (not UNKNOWN).

### E12 Apply the guard migration on the disposable database (destructive)

- **PR121 pass (verbatim):** Preflight and postcondition pass. Catalog read-back. A G4-shaped writer wired **in the disposable database only** passes 6a–6g against real PostgREST.
- **Steps:**
  1. Apply PR121's `20261010051938_common_account_service_write_guard.sql` from the exact head (`psql -f`, single file) after Phase 1–3a. Record the notices.
  2. Fingerprint: the guard ACL must be exactly owner-only, and `auth.sessions` readable by the owner.
  3. Create PR121's `fixture_guarded_service_write` in the disposable database only.
  4. Replay races 6a–6g, with the writer called through PostgREST and the lifecycle side held open by a `psql` latch (e.g. 6a: an uncommitted `begin_common_account_deletion` with `pg_sleep(<8s)`).
  5. **Also run 6f-real**, the race between the intent commit and the deletion, as a negative reproduction:
     - open the Phase 3a gate in the disposable database only (test-only DDL, recorded);
     - record the managed-delete intent;
     - make a real GoTrue automatic link;
     - observe that it commits (the DB cannot fence it) and that the guarded writer still refuses.
- **UNKNOWN:** the migration owner differs from the writer owner (the guard is unreachable by design; record it).

## 6. A+B vs D (comparison only — no choice, no approval)

| | Option A+B (ban + settle + verify + Admin delete; access-token hook) | Option D (same-transaction SQL delete under the lifecycle lock) |
| --- | --- | --- |
| Experiments needed (`REQUIRED_FOR`) | E1, E2, E3, E4, E5, E6, E7, E8, E9, E10, E12 | E1, E8, E9, E10, E11, E12 |
| Known source-level obstacle | V11: a manual link begun before the ban completes after it. LINKED in E4 blocks A+B until a mitigation is evidenced. | Changes the established lifecycle safety model, under which this repository never deletes a login in SQL. Prohibited without separate user approval **and** an independent security review. |
| Version and config dependence | High: ≥ v2.195.0, manual linking, request duration, flow expiry, hook availability | Lower for the fence itself; it depends on `postgres` `DELETE` privilege and on the auth schema's cascades (E8, E11) |
| What stays unfenced even if proven | E6 windows can only be bounded statistically; a hook outage blocks every sign-in | GoTrue's admin-delete audit row is not written (E10/E11 compare); Supabase support stance unknown |
| Residual DB evidence | Audit-log check after delete (E10) | The delete commits with the decision; the latch variant shows queued links failing |

Passing every experiment for one candidate gives `EVIDENCE_COMPLETE_PENDING_INDEPENDENT_REVIEW`, not a release. Opening the gate needs its own reviewed migration and a separate production approval.

## 7. What offline readiness proves, and what it does not

**Proven offline:**

- the guard refuses by default, refuses ambiguity, production-like or reused projects, override flags, and missing or mismatched per-scenario consent;
- E11 cannot be requested without both approval references;
- redaction removes every token, key, code, e-mail, UUID, IP and project host from a fake transcript, deterministically and idempotently;
- the verdict never turns UNKNOWN into PASS and never chooses a candidate;
- E1–E12 are complete and verbatim;
- the harness has no network, process or environment access (static rules plus Deno permissions);
- the fingerprint SQL only reads, is deterministic, and sees cascades, triggers, owners and ACLs on the local fixture.

**Not proven:** any GoTrue, PostgREST, Storage or Management API behaviour, the platform's privileges and cascades, and every V/H item of PR121. Local mocks are not evidence.

## 8. Operator checklist

See `supabase/tests/common_account_disposable_e2e/operator_checklist.md`.

## 9. Dependency matrix (G4 integration contract; nothing implemented for other owners)

| Item | Owner | Depends on | State | Blocks |
| --- | --- | --- | --- | --- |
| T13 guard `private.account_lifecycle_assert_active_service_write` | G5 | Phase 1 lock; `auth.sessions` readable by the owner (E9/E12) | **Source candidate in Draft PR121 only**: not merged, applied or wired, and not available in production | every writer below |
| Threads `begin` / `complete` RPCs | G4 | T13 guard as their first statement; same owner role; T9 provisioner | G4 task (source/mock only) | Threads connect gate (`THREADS_CONNECT_PREREQUISITES_MET=false`) |
| T9 personal workspace provisioner | G4 | T13 guard first, then the workspace | G4 task (source/mock only) | Threads and X onboarding convergence |
| Existing X `begin` / `consume` / `complete` onboarding RPCs | G4 | T13 guard; same owner; X begin delegated to T9 | not started (separate G4 task) | the shared-account writer fence for POSTONA |
| Kabumori `ensure_my_profile()`, `profiles_insert_own`, `insert` grant | G1/G2 | Phase 2 clients everywhere; or a guarded definer writer | not started (draft interface in PR121 §9) | the Kabumori writer fence |
| Service-role producers (push, reports, news, POSTONA producers) | G1/G2, G3/G4 | a lifecycle / entitlement predicate design | not started | stale-producer gate |
| T10 provider-aware cleanup adapters (`confirmed_remote_revoked`, `local_removed_remote_unverified`, `reconciliation_required`, `blocked`) | G4 adapters, G5 lifecycle aggregation | Threads credential model; lifecycle step design | contract only (shared memo) | POSTONA-only withdrawal with Threads; whole-account deletion |
| GoTrue identity-change fence | G5 | E1–E12 on an approved disposable project; then the A+B vs D decision | **not proven** | `managed_auth_delete` gate |
| Release gate opening | G5 + user | everything above, independent review, separate production approval | blocked (schema CHECK) | whole-account deletion |

## 10. Approvals needed next (exact; none requested or granted by Phase 3c)

1. **One fresh disposable Supabase project.**
   - Created new for this proof; fake data only; no production data, clone, import or copy.
   - Its ref is given to the operator in writing.
   - Billing and plan are the user's decision. Phase 3c creates nothing and incurs no cost.
2. **Per-run destructive consent for each scenario** (`DESTROY-<E#>-<ref>-<run_id>`), given separately for each run.
3. **E7:** approval to enable a test Custom Access Token hook on the disposable project (`project_auth_config_change`).
4. **E11 (Option D probe):** a user approval **and** an independent security review, both before E11 runs. Running E11 approves nothing about adopting Option D.
5. **Optional dummy provider accounts:**
   - a test OAuth/OIDC provider (E2–E6);
   - a test OIDC issuer for the ID-token grant and E6;
   - Meta/Apple tester credentials only with dummy accounts and a separate approval.
   - Without them, the dependent halves stay UNKNOWN.
6. **One consolidated independent security review**, once the real G5 guard and G4's begin/complete, credential and cleanup boundaries exist together. No H1/H2 allocation now.
7. **Later, distinct production approvals** (migration apply, Edge deploy, gate opening), each with its own preflight. None follows from any disposable result automatically.
