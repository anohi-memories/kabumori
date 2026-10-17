# Phase 13 D-3 — hosted disposable Supabase preflight package (execution-ready, non-executing)

Status: **source-only specification, D-3_SPEC. Nothing in this document was run against any managed or production system.** No
Supabase project exists or was created, no production catalog was read, no migration was applied, no Auth / RLS / Edge / Cron /
secret / grant was touched, no OAuth / X / Threads / Meta / Apple / Google / paid-AI call was made, no external request was sent
except the reading of the provider's public documentation pages (section 9), no one signed in anywhere, nothing was merged or
deployed. Everything executed for this document is offline (section 12). Production is **NO_GO**; `managed_auth_delete` stays
BLOCKED, `IDP_PREPAUSE_BLOCKED` stays BLOCKED, `POSTONA_END_SOURCE_ENABLED` stays false in git and every release gate stays OFF.

TASK `common-account-f5-phase13-d3-hosted-sandbox-preflight-readiness-20261017` (G4 approved D-3 as design only). It stacks on
PR #259 (D-2) and adds only documentation, two pinned data files, one pure verifier and offline tests. What it is: a
**precise, reviewable package** from which G4 and the owner can decide each later gate separately. What it is not: an
environment approval, a project, a budget commitment or a permission. **A paper plan is not an environment approval.**

Evidence labels as in the architecture plan: **[O]** observed in this checkout, **[D]** derived by a tool of this phase (the command is
in section 12), **[P]** read on the provider's public page on the retrieval date (section 9; the page may have changed), **[A]** an
assumption, **[U]** unknown and never inferred.

## 1. What this document adds to the architecture plan

`docs/common-account/phase13-postona-disposable-supabase-architecture.md` (PR #250) is the plan; this package makes its D-3 branch
(a hosted disposable project) concrete enough to approve gate by gate, and it corrects three statements of that plan with evidence:

| # | Finding | Evidence | Consequence |
| --- | --- | --- | --- |
| **D3-1** | The plan's export step (A2) said `pg_dump --schema-only` by a login that can CONNECT and nothing else. That cannot work: pg_dump --schema-only needs SELECT on every table it dumps, because it takes an ACCESS SHARE lock on each (`permission denied for table`). Catalog reads (what the pinned inventory query does) work for the CONNECT-only login. | [D] `common_account_phase13_d3_dump_privilege.sh`, section 4.3 | PG2b has two methods and a decision (B); the least-privilege method (a catalog-only DDL generator) does not exist yet |
| **D3-2** | Creating the CONNECT-only login on production is itself a production **write**. The plan listed it as a precondition without a consent. | [O] the plan, section 4.2; [D] section 4.2 | consent `PG2A-LOGIN` is separate; decision A offers the alternative |
| **D3-3** | D-2's stand-in is injected at the validation-harness boundary; it is **not a deployed Edge function**, so the hosted project has no X saga to call and M12 cannot run there. The plan (section 8.3) still describes a deployed stand-in as an option. | [O] `docs/common-account/phase13-d2-x-saga-standin.md`; [D] `plan.ts` M12 answers MANUAL when `account-delete` is absent | decision F: M12 is excluded from the first managed pass and listed BLOCKED; the orchestration stays validated on the local harness |
| **D3-4** | F4's preflight (PR #243) REFUSES a redirect list that holds only the auth-callback URL; the plan's default D-4 was auth-callback only. | [D] `common_account_phase13_d3_f4_refusal.sh` (`auth_callback_only_list_is_refused`) | decision E recommends both exact URLs, no wildcard |
| **D3-5** | PG6 can only authorize what `plan.ts` implements: M1, M2, M4 to M11 and T1. M3 is manual; M12 is blocked; M13 to M15 and X-1 to X-7 are proposals, not steps. | [D] `d3_package_test.ts` | the PG6 phrase names only the existing steps |
| **D3-6** | The repository has no `supabase/config.toml`, so nothing about the project's settings is in git. | [O] absent | settings are read back into a sheet and decided by `d3_readback.ts` (section 3.5) |

What did not change: the chain (P1 to P10), the exclusion of 110 migrations, contract v2, the guard, G3b / G3c, the dry-run default.
Open problems that this package does **not** solve: R2′ (a POSTONA-only person gets the login-deleting X-saga scope; F3's), G3 T13
(F3's OAuth owner guard; its source candidate is PR #257, not read here), managed M12, and the #233 narrowed recheck (PG1).

## 2. Summary and GO / NO_GO

| Question | Answer |
| --- | --- |
| Is the package complete enough to decide PG1 to PG7 one by one? | Yes: each gate has prerequisites, a consent phrase (English and Japanese), evidence and STOP rules (sections 11 and 13). |
| Can anything be executed today? | No. **No gate is open today.** Only PG1 (a review) is possible next, and only on the owner's say. |
| What does the offline evidence prove? | That the package is consistent with this checkout and that its pins can fail (section 12). A harness PASS is a PASS of our orchestration on a model; it is **never** a PASS of a real remote revoke, the Vault, a managed OAuth flow or production. |
| Production | **NO_GO.** Unchanged. |

Order (each arrow is a separate approval, with **no implied permission**): PG1 restricted #233 recheck → PG2a production catalog inventory →
PG2b baseline DDL export → PG3 owner approves two digests → PG4 create one empty hosted project → PG5 apply baseline and chain, deploy
`account-delete`, set Auth → PG6 managed smoke → PG7 one sandbox build on a device. PG8 (real provider logins) and PG9 (production) are
different documents.

## 3. Hosted project architecture (deliverable 1)

### 3.1 Components and the facts about the real services

The project is one **new, empty, allow-listed** hosted Supabase project; never a branch, restore or copy of production. The real
services differ from the harness's fake server in ways the fake cannot show, so each row says what is known and what is not.

| Component | What we need | What is known (retrieved 2026-10-17, [P]) | What is not known (managed-only, NOT_VERIFIED) |
| --- | --- | --- | --- |
| Auth (GoTrue) | e-mail provider only, anonymous sign-ins off, sign-ups open, autoconfirm on for admin-created users | every access token carries a `session_id` claim that matches `auth.sessions` | whether the token carries an `amr` timestamp, whether a refresh keeps the `session_id` (M4 / M14), the anonymous default, the minimum JWT expiry |
| Redirect list | both app URLs exact, no wildcard (decision E) | entries are patterns with wildcard rules; the provider recommends exact paths | how a custom-scheme entry is matched and whether an exact entry matches a URL with an appended flow id (Q-1) |
| PostgREST | exposed schema `public` (plus the platform's `graphql_public`), never `private` | — | the exposed-schema default of a new project (read back) |
| Edge Functions | exactly `account-delete`, `verify_jwt` on | a function requires a valid JWT unless `verify_jwt = false` is set for it; the limits of section 9 | the status code a request without a JWT receives; the repository has no `supabase/config.toml`, so the setting is whatever the deployment set |
| Postgres | baseline + P1 to P10 + the marker row | — | whether `pg_cron` or `pg_net` is enabled on a new project (the pages say how to enable them, not the default) |
| Storage / Vault / Realtime | empty | — | — |
| Secrets | the platform's own names only | publishable keys start with `sb_publishable_`, secret keys with `sb_secret_`; the legacy anon / service_role keys are being deprecated by the end of 2026 | the exact names a new project injects (so an unknown name is a STOP for a person to review) |

### 3.2 Identity, allow-list and deny-list

The guard (`guard.ts`, unchanged) resolves a target only when every rule holds; it reports **all** failures, not the first. The
environment variables it reads (names only; the values are the owner's and never enter git, chat or a Report):

| Variable | Purpose |
| --- | --- |
| `KABUMORI_DISPOSABLE_PROJECT_REF` | the target project's ref |
| `KABUMORI_DISPOSABLE_ALLOWLIST` | the refs that may ever be mutated; holds the disposable only |
| `KABUMORI_PRODUCTION_PROJECT_REFS` | the production refs; the harness also adds every project host found in the migrations |
| `KABUMORI_DISPOSABLE_API_URL` | exactly the hosted form for that ref (no path, port, credential) |
| `KABUMORI_DISPOSABLE_CONFIRM` | the operator types the ref again |
| `KABUMORI_DISPOSABLE_PUBLISHABLE_KEY` | the publishable key (never a secret key) |
| `KABUMORI_DISPOSABLE_SERVICE_ROLE_KEY` | the secret key, for the admin API and service-role checks |
| `KABUMORI_DISPOSABLE_DB_URL` | the database URL; must name the same ref |
| `KABUMORI_DISPOSABLE_BASELINE_SHA256` | the digest of the reviewed baseline file |
| `KABUMORI_DISPOSABLE_BASELINE_PATH` | the path of that file |
| `KABUMORI_DISPOSABLE_INVENTORY_SHA256` | the contract digest the owner approved (PG3) |
| `KABUMORI_DISPOSABLE_TEST_EMAIL_DOMAIN` | a domain the operator controls (a reserved `.test` domain is recommended, because it cannot deliver) |

Allow / deny rules (each has a refusing test in `d3_package_test.ts`): the target is on the allow-list; the allow-list holds no
production ref (otherwise everything is refused); the deny-list is supplied and the migrations' hosts are added; the API URL is the
exact hosted form of the same ref; the confirmation repeats the ref; the database URL names the same ref (the direct host or the
pooler user `postgres.<ref>` both count); the key kinds are right; the e-mail domain is not a public mail provider; the project's
own marker row names the target before every mutation (`runner.ts`).

**Deny-list coverage [D].** `cli.ts` adds the project hosts found in `supabase/migrations/` to the deny-list. The test walks the
other tracked-type files (non-test source, scripts, docs, `.agent_v2`) and requires every project host they name to be one the
migrations already name: today there is exactly one project, and F4's preflight pins its SHA-256 as `PRODUCTION_REF_SHA256`; the two
sides agree (`deny_list_agreement`, section 12). A future file that names a second project would fail that test.

The disposable's ref is never written into git, chat or a Report: a phrase names the project by the first 12 hex digits of the SHA-256
of its ref, and the sheet holds the full SHA-256 only.

### 3.3 Roles and keys (separation)

| Credential | Held by | Used for | Never |
| --- | --- | --- | --- |
| publishable key (`sb_publishable_…`; a legacy anon key is the old form) | the harness (HTTP as a user); the sandbox build at PG7 | sign-in, PostgREST as a user, Edge calls | accepted where a secret key belongs (guard `PUBLISHABLE_KEY_WRONG_KIND`) |
| secret key (`sb_secret_…`; the legacy service_role key is the old form) | the harness only | the Auth admin API (create and delete the test logins), the checks that a user token cannot reach service-role-only RPCs | in the phone build, in git, in a log (the redactor masks it) |
| database URL (password) | the harness only | the pinned SQL: `read`, `probe` (both `default_transaction_read_only=on`) and `apply` / `hold` modes of `psqlInvocation` | split into libpq variables for the child so it is never in an argument list |
| the provider access token (dashboard / CLI) | the owner | creating the project, deploying the function, reading the settings | handed to an AI agent |

**Rule: every secret the executor needs is set in the executor's own environment by the owner, out of band. An AI agent never receives,
types or stores a key, a password or a token.** If an agent is asked to run a gate, the owner starts the process with the environment
already set; the agent sees only the harness's redacted output.

### 3.4 Network policy of the executor

The harness has two outbound paths and both are narrow: HTTPS to the one hosted API host (`transports.ts` builds
`<base>/<path>` from the guard's exact base URL, with `redirect: 'error'`, so a redirect to another host is an error), and `psql`
to the one database host the URL names. The recommended invocation makes the first one enforceable by the runtime:

```
deno run --no-config --allow-read --allow-env=<the twelve variable names of section 3.2> \
  --allow-net=<ref>.supabase.co:443 --allow-run=psql \
  supabase/preflight/managed_disposable/cli.ts --execute --only=<the ids of the consent phrase>
```

`--allow-net` is deliberately the API host only. `psql` is a child process outside the runtime's network permission: its host is
constrained by the guard (the database URL must name the same ref) and, if the owner wants a second lock, by the machine's own
firewall. The direct database host of a project may be IPv6-only [A: observed for the production project, not for a new one]; the
guard accepts the pooler form (`postgres.<ref>` on a `.pooler.supabase.com` host) for that case. A dry run needs none of this: it
needs no network, no key and no project (section 12).

### 3.5 Settings read-back (the sheet) — described, not executed

Auth providers, redirects, JWT expiry, exposed schemas, the function list and the secret names live in the project, not in git
(no `supabase/config.toml`). After PG4 and PG5 the owner reads them and writes a **sheet** (JSON, kept outside git, holding names,
flags, counts and digests only). `d3_readback.ts` decides it (pure, fail-closed: a missing field, an unknown name or an unexpected value
is a STOP), and `d3_readback_cli.ts` runs it on a file (`deno run --no-config --allow-read …`, section 12). Two stages: `created`
(right after PG4: nothing deployed) and `deployed` (after PG5: the function and the counts must be there). Passing the sheet is
**not** the F5 sign-off; the sign-off is the owner's record (section 7).

| Sheet section | Read from | Machine-read? | Finding codes |
| --- | --- | --- | --- |
| identity (ref SHA-256, plan, region label, created as new, organization holds production) | the dashboard; the marker row | the marker by the harness (G1), the rest by the owner | `IDENTITY_PRODUCTION`, `IDENTITY_NOT_NEW`, `IDENTITY_MARKER_MISMATCH` |
| Auth providers, sign-ups, autoconfirm | the public settings endpoint (G2 reads it) | yes | `PROVIDER_NOT_ALLOWED`, `PROVIDER_EMAIL_OFF`, `SIGNUPS_CLOSED`, `AUTOCONFIRM_OFF` |
| anonymous sign-ins, redirect list, JWT expiry | the dashboard | no (owner) | `ANONYMOUS_ON`, `REDIRECT_WILDCARD`, `REDIRECT_UNEXPECTED`, `REDIRECT_MISSING`, `JWT_EXPIRY_INVALID`, `JWT_EXPIRY_UNUSUAL` |
| exposed schemas | the dashboard | no (owner) | `SCHEMA_EXPOSED_NOT_ALLOWED`, `SCHEMA_PUBLIC_NOT_EXPOSED` |
| Edge functions (name, JWT verification, source digest) | the dashboard or the CLI function list; the source downloaded and diffed against the pinned bytes | no (owner) | `EDGE_FUNCTION_NOT_ALLOWED`, `EDGE_FUNCTION_MISSING`, `EDGE_VERIFY_JWT_OFF`, `EDGE_DIGEST_MISMATCH`, `EDGE_NOT_EMPTY` |
| secret names (values are never read) | the dashboard | no (owner) | `SECRET_NAME_FORBIDDEN`, `SECRET_NAME_UNKNOWN` |
| extensions, counts (cron jobs, network triggers, storage objects, vault secrets, push tokens, social accounts, scheduled posts) | the inventory and G3c | counts by the harness | `EXTENSION_FORBIDDEN`, `COUNTS_MISSING`, `COUNT_NOT_ZERO` |
| the side-effect attestation `no-x-no-ai-no-real-email` | the owner | no | `ATTESTATION_MISSING` |
| the sheet as a whole | — | — | `SHEET_SHAPE`, `SECRET_SHAPED` |

## 4. Baseline provenance: PG2a and PG2b (deliverable 2)

### 4.1 What contract v2 requires and what is unknown

Contract v2 (`docs/common-account/phase13-baseline-contract-v2.md`) reads from the chain's own preflights: the 17 relations, 26
columns, 14 foreign keys and 2 functions of Phase 1, plus `public.ensure_my_profile()` (P4), `public.social_accounts.platform` (P6) and
`auth.uid()` (P3b, P4). Known production shapes: P1 and P2 are recorded as applied on 2026-10-06 / 07. Unknown, never inferred: the
three relations no repository migration creates (`brands`, `social_accounts`, `social_account_oauth_states`), the 6 columns and 4
foreign keys touching them, `social_accounts.platform`'s nullability and default, the history of six production versions that are not
in the repository, and the real catalog's behaviour under the pinned query (its first evaluation is PG2a).

### 4.2 PG2a — the catalog inventory (A1): the safe read-only query set

| Item | Value |
| --- | --- |
| Query set | **one** file, `supabase/preflight/managed_disposable/inventory/schema_inventory.sql`; no other query is authorized |
| Digest | SHA-256 `93b1ca05e381989c342aa1add93e7ab710d6b69110b758151fb131fc8d5926cb`, equal to the entry in `plan.lock.json` (tested) |
| Shape | one `READ ONLY` transaction; the session also sets `default_transaction_read_only=on` (`psqlInvocation` modes `read` / `probe`); structure only: shapes and SHA-256 of stored expressions, no value, no function body, no row |
| Login | decision A: a dedicated login with CONNECT only (the Phase 12 proof ran the query as such a login on a local model; **creating it on production is a production write**, consent `PG2A-LOGIN`) or an existing owner login in a READ ONLY session (no write, broader credential) |
| Redaction | the query emits no value; `inventory_cli.ts check` re-vets the output (secret-shaped text, unknown kinds and attributes are STOPs) and prints counts, codes and digests only |
| Custody | the output file stays outside git and chat; only the `check` output is reported |
| Fingerprint | the contract digest (64 hex) of the contract subset; two runs minutes apart must give the same digest |
| STOP | secret-shaped output; a statement other than SELECT; a role that needs more than CONNECT; two different digests; a required object missing or retyped |

### 4.3 PG2b — the baseline DDL export (A2): the local finding and the two methods

The plan's A2 said `pg_dump --schema-only` by the CONNECT-only login. Reproduced on a throw-away local PostgreSQL 17 with a fake table
(`common_account_phase13_d3_dump_privilege.sh`, exact output in section 12):

| # | Login | Action | Result |
| --- | --- | --- | --- |
| a | CONNECT only | catalog definitions (`pg_get_indexdef`, `pg_attribute`) | **works**; a row read is `permission denied` |
| b | CONNECT only | `pg_dump --schema-only` | **fails**: `permission denied for table`, query `LOCK TABLE … IN ACCESS SHARE MODE` — pg_dump --schema-only needs SELECT on every table it dumps |
| c | a login with SELECT on the table | `pg_dump --schema-only` | works; the dump holds the definition and **no row** |
| d | CONNECT only | `pg_get_constraintdef` over the catalog | works |

So the CONNECT-only login suffices for PG2a but not for pg_dump. Two methods (decision B):

| Method | Credential | Exists today? | Note |
| --- | --- | --- | --- |
| B1 `pg_dump --schema-only` restricted to the listed relations | a login with SELECT on them (the owner's own) | yes | reads no row, but the credential could; run under `PGOPTIONS=-c default_transaction_read_only=on`; the output is a file outside git |
| B2 a catalog-only DDL generator (`pg_attribute`, `pg_get_constraintdef`, `pg_get_indexdef`, policies, ACLs, `pg_get_functiondef`) | the CONNECT-only login | **no** — a separate TASK and review | least privilege |

Object list (both methods): the relations, columns, constraints, indexes, policies and ACLs of the 17 baseline relations that
`baseline_provenance.json` lists, and the functions `social_mobile_account_deletion_subject`, `social_mobile_account_deletion_workspace`
and `ensure_my_profile` — nothing else. The file is then **trimmed by a person** (no trigger, cron, host, URL, Vault reference or literal),
re-scanned with `scanSql` (zero blocking findings) and digested; only the digest and the scan result are reported.
The contract digest A1 produced from production must equal the digest G3b reads from the disposable after the baseline is applied,
and after P1 and P2 are applied the inventory lines of the objects they created must equal production's (the P1 / P2 fidelity check of
the plan, section 4.4).

## 5. The pinned chain and the exclusion list (deliverable 3)

Only these ten files may ever be applied, in this order, by pinned bytes (`phase13-migration-dag.json`, `plan.lock.json`; the digests are
tested equal): **P1, P2, P3a, P3b, P4, P5, P6, P8, P9, P10**. The other 110 of the 120 repository migrations are never applied: 8 schedule
cron jobs that call the production host, 1 rewrites job commands, 8 reference the Vault, 12 seed URL literals, 1 is otherwise blocked,
47 are review-only and 33 are clean but unnecessary (what they created is carried by the baseline export). Forbidden: `supabase db push`,
`supabase link`, `supabase migration up`, `supabase db reset`, and any "apply all". The hosted project is changed only by `cli.ts` (guarded
psql and HTTPS) and by the owner's deployment of one function.

Synthetic data and verification: the logins of section 7 are created through the Auth admin API on the operator's test domain, with
per-run passwords that are never stored; the verification of RLS, ACL, ownership and the fence is the harness's M8, M9, M10 and the
G4 release probe (read-only, run again after the exercise as M9). No production row, dump, backup or token is ever restored.

## 6. Side-effect quarantine (deliverable 4)

The matrix is the plan's section 7; this package adds what makes it checkable on a hosted project:

| Vector | Control | Check |
| --- | --- | --- |
| `pg_cron`, `pg_net`, HTTP from the database | the 110 files are never applied; the scanner blocks `CRON_REFERENCE` / `NET_REFERENCE` and their transitive helpers; extensions are not enabled | G3b (fail-closed, non-skippable before any mutation), G3c (cron-job and network-trigger counts equal before and after), sheet `EXTENSION_FORBIDDEN`, `COUNT_NOT_ZERO` |
| time-of-check / time-of-use | the runner hands the bytes it verified to the transport; `sqlProbe(path, bytes)` reads no file | #233 recheck (PG1) |
| OAuth, X, Threads, Meta, Apple, Google | no provider except e-mail; no function other than `account-delete`; no secret of another system | sheet `PROVIDER_NOT_ALLOWED`, `EDGE_FUNCTION_NOT_ALLOWED`, `SECRET_NAME_FORBIDDEN`, `SECRET_NAME_UNKNOWN` |
| booking, posting, revoke | no X workspace, no Threads row, no reservation; the Threads and reservation switches stay false (F4's `OTHER_GATES_OFF`) | counts zero (`socialAccounts`, `scheduledPosts`) |
| paid AI, real e-mail, push | no AI key, admin-created users on a test domain, no push token | secret names, `pushTokens` zero, the attestation |
| storage, Vault | empty | `storageObjects`, `vaultSecrets` zero |
| production data and users | schema-only baseline, the disposable's own keys | allow-list, deny-list, marker row |
| the harness itself | allowed network is one host; keys redacted in every log line | section 3.4; `makeRedactor` |

## 7. Test users, sessions and the F4 preflight (deliverable 5)

| User | State | Expected | Where |
| --- | --- | --- | --- |
| **A** | POSTONA only, no Kabumori profile | `withdraw_postona` is refused (R2′, a known F3 limit) | local harness only (needs a saga) |
| **B** | POSTONA + Kabumori | POSTONA ends; Kabumori, profile and login unchanged | local harness (D-2 stand-in) |
| **C** | Kabumori only | POSTONA operations never touch it | M-steps with the fake model; managed M8 / M9 |
| **D** | POSTONA ended | re-enrollment required; a stale token restarts nothing | M5 |
| **E** | operator-seeded locked / deletion in progress | blocked outcomes | model |
| **F** | anonymous | refused | M6 |

Source versus managed, kept apart: **source** = the code on a model (fake GoTrue / PostgREST over a local database, injected clocks):
`lifecycle_logic_test.ts` (the 600-second boundary: `now` and `now − 600` accepted, `now − 601` and any future time refused), Phase 9 and
the model run. **Managed** = the real services: M4 (does the token carry `session_id`, does a refresh keep it), M5, M7, M10, the real
`verify_jwt` behaviour, Q-1. The 600-second rule can be checked on a hosted project only coarsely (about 570 s accepted, about 630 s
refused), because clock skew hides the exact boundary. `withdraw_postona` on the hosted project is excluded (decision F).

**D-2 stand-in markers and structural exclusion are pre-conditions of every gate that mentions the orchestration:** the stand-in's
answers carry `effects_performed:false`, `remote_x_verified:false`, `production_usable:false`, and its directory is unreachable from any
Edge entry (rules E1 to E6 of `phase13-d2-x-saga-standin.md`). They are re-run, not re-reviewed (section 12).

**F4's preflight (PR #243, pinned by blob in `phase13-migration-dag.json`) REFUSES today** — ten of its thirteen conditions fail on a
clean checkout — and keeps refusing until every condition below is established; a synthetic input that satisfies all thirteen is READY,
and breaking any one of them refuses again (`common_account_phase13_d3_f4_refusal.sh`, section 12). **No sign-off record exists and none
is issued by this document.**

| Condition | Established at | How |
| --- | --- | --- |
| `DATA_SOURCE_SUPABASE` | PG7 | the sandbox build's local environment file sets the data source to supabase |
| `SANDBOX_DECLARED` | PG4 | POSTONA_SMOKE_SANDBOX_REF is the project's ref (or local for a local stack) |
| `SANDBOX_NOT_PRODUCTION` | PG4 | the SHA-256 of that ref is not the production hash F4 pins (deny-list agreement tested in section 12) |
| `URL_NOT_PRODUCTION` | PG7 | the build's Supabase URL is not the production host |
| `URL_IS_DECLARED_SANDBOX` | PG7 | the build's Supabase URL is exactly the declared project |
| `ENV_FILES_CONSISTENT` | PG7 | no environment file of the app points anywhere else |
| `ENV_FILES_NO_MOCK` | PG7 | no environment file selects the mock data source |
| `KEY_IS_PUBLISHABLE` | PG7 | the build holds the publishable key only |
| `REDIRECTS_DECLARED` | PG5 | the Auth redirect list, read back in the sheet, holds both app URLs exactly and no wildcard (decision E) |
| `END_FLAG_LOCAL_ONLY` | PG7 | POSTONA_END_SOURCE_ENABLED is true in the working tree only and false in git HEAD |
| `OTHER_GATES_OFF` | PG7 | the Threads and reservation switches are false in source (already true) |
| `OWNER_SIGNOFF` | PG6 | the owner's F5 sign-off record (kept by the owner, never in git) |
| `SIDE_EFFECTS_ATTESTED` | PG5 | the attestation no-x-no-ai-no-real-email, backed by the secret-name list and the function list of the readback sheet |

The F5 sign-off record (what `OWNER_SIGNOFF` refers to) is the owner's, kept outside git: date and expiry, the `plan.lock.json` commit,
the two approved digests, the harness report summary, the accepted read-back sheet, the function list, the secret-name list, the
unchanged cron / network-trigger counts, and the sentence "this project holds no X, Threads, AI or production data".

## 8. Real OAuth stages (deliverable 6)

Real OAuth (Apple, Google, X, Threads) is **prohibited now**. It is PG8: one separately approved stage per provider, in the disposable
only, after PG6 and PG7, in a different document. This package keeps three things unresolved on purpose: **R2′** (F3), **T13** (F3's
OAuth owner guard; the source candidate PR #257 is not read or relied on here), and **managed M12**. A harness PASS cannot be reported as
a real remote revoke, a Vault operation or a managed OAuth PASS. The Threads provider has no app-side revoke (only Meta's callbacks), so a
Threads "revoked" is never claimed.

## 9. Cost, quotas and teardown (deliverable 7)

Retrieved on 2026-10-17 from the provider's public pages, **without signing in and without any account action**, through an automated
page reader that summarises a page for a question (`phase13-d3-cost-sources.json` holds the entries; the test checks that every figure
below is traceable to one). The pages say pricing may change, so the owner re-confirms on the live pages the day PG4 is decided.
A figure marked NOT_VERIFIED or "assumption" was not stated on a page and is not claimed.

| Tag | What the page says (summarised) | Figure | Unit | Source (public page) |
| --- | --- | --- | --- | --- |
| `cost:free-project-cap` | Free plan: two free projects; the limit counts across every organization in which the person is Owner or Administrator; paused projects do not count | 2 | active free projects | https://supabase.com/docs/guides/platform/billing-on-supabase |
| `cost:free-database` | Free plan database size | 500 | MB | https://supabase.com/pricing |
| `cost:free-egress` | Free plan egress | 5 | GB per month | https://supabase.com/pricing |
| `cost:free-mau` | Free plan monthly active users | 50000 | users | https://supabase.com/pricing |
| `cost:free-edge-invocations` | Free plan Edge Function invocations | 500000 | per month | https://supabase.com/pricing |
| `cost:free-storage` | Free plan storage | 1 | GB | https://supabase.com/pricing |
| `cost:free-pause-after` | Free plan projects are paused after a period of inactivity | 1 | week | https://supabase.com/pricing |
| `cost:pause-restore-window` | A paused project can be restored from the dashboard within a window | 1 | year | https://supabase.com/docs/guides/platform/upgrading |
| `cost:free-compute` | Free plan compute is the Nano size (shared CPU, up to 0.5 GB memory) at no charge; the page says Free plan compute is subject to change | 0 | USD per month | https://supabase.com/docs/guides/platform/compute-and-disk |
| `cost:pro-price` | Pro plan base price (from) | 25 | USD per month | https://supabase.com/pricing |
| `cost:pro-compute-credit` | Paid plans include a monthly compute credit per organization that covers one Micro instance; credits reset monthly and do not accumulate | 10 | USD per month | https://supabase.com/docs/guides/platform/manage-your-usage/compute |
| `cost:micro-hourly` | Micro compute, hourly price | 0.01344 | USD per hour | https://supabase.com/docs/guides/platform/compute-and-disk |
| `cost:micro-monthly` | Micro compute, monthly price (rounded by the page) | 10 | USD per month | https://supabase.com/pricing |
| `cost:compute-hourly-not-prorated` | Compute is charged per running hour and a partial hour is charged as a full hour | 1 | hour minimum step | https://supabase.com/docs/guides/platform/manage-your-usage/compute |
| `cost:deleted-stops-billing` | Billing for compute stops when a project is deleted; paused projects do not count toward compute usage | 0 | USD per hour after deletion | https://supabase.com/docs/guides/platform/manage-your-usage/compute |
| `cost:builtin-mail-rate` | The built-in mail sender is limited per project | 2 | emails per hour | https://supabase.com/docs/guides/auth/rate-limits |
| `cost:builtin-mail-recipients` | The built-in mail sender delivers only to addresses of the organization's team; other addresses fail | 1 | restriction | https://supabase.com/docs/guides/auth/auth-smtp |
| `cost:auth-signin-rate` | Sign-up and sign-in endpoint requests per IP address | 30 | requests per 5 minutes | https://supabase.com/docs/guides/auth/rate-limits |
| `cost:auth-token-rate` | Token endpoint requests per IP address | 150 | requests per 5 minutes | https://supabase.com/docs/guides/auth/rate-limits |
| `cost:edge-functions-free` | Edge Functions per project on the Free plan | 100 | functions | https://supabase.com/docs/guides/functions/limits |
| `cost:edge-cpu-time` | Edge Function CPU time per request | 2 | seconds | https://supabase.com/docs/guides/functions/limits |
| `cost:edge-wall-clock-free` | Edge Function wall-clock duration on the Free plan | 150 | seconds | https://supabase.com/docs/guides/functions/limits |
| `cost:keys-new-kinds` | Publishable keys start with sb_publishable_ and secret keys with sb_secret_; the legacy anon and service_role JWT keys are described as being deprecated by the end of 2026 with no removal date | 2026 | year of announced deprecation | https://supabase.com/docs/guides/api/api-keys |
| `cost:edge-verify-jwt-default` | By default an Edge Function requires a valid JWT in the authorization header; verify_jwt = false in config.toml switches it off per function | 1 | default is on | https://supabase.com/docs/guides/functions/function-configuration |
| `cost:session-id-claim` | Every access token carries a session_id claim that can be matched to the primary key of auth.sessions | 1 | claim present | https://supabase.com/docs/guides/auth/sessions |
| `cost:not-stated-pg-cron-default` | Whether pg_cron is enabled on a new project | NOT_VERIFIED (the page does not state it) | assumption: not claimed | https://supabase.com/docs/guides/database/extensions/pg_cron |
| `cost:not-stated-pg-net-default` | Whether pg_net is enabled on a new project (the page only says how to enable it) | NOT_VERIFIED (the page does not state it) | assumption: not claimed | https://supabase.com/docs/guides/database/extensions/pg_net |
| `cost:not-stated-anonymous-default` | Whether anonymous sign-ins are enabled by default | NOT_VERIFIED (the page does not state it) | assumption: not claimed | https://supabase.com/docs/guides/auth/auth-anonymous |
| `cost:not-stated-redirect-matching` | How a redirect allow-list entry that is a custom-scheme URL is matched, and whether an exact entry matches a URL carrying appended query parameters | NOT_VERIFIED (the page does not state it) | assumption: not claimed | https://supabase.com/docs/guides/auth/redirect-urls |
| `cost:not-stated-amr` | That the access token carries an amr claim with a timestamp | NOT_VERIFIED (the page does not state it) | assumption: not claimed | https://supabase.com/docs/guides/auth/sessions |
| `cost:not-stated-refresh-keeps-session` | That a token refresh keeps the same session_id | NOT_VERIFIED (the page does not state it) | assumption: not claimed | https://supabase.com/docs/guides/auth/sessions |
| `cost:not-stated-jwt-expiry-range` | The minimum and maximum configurable JWT expiry in seconds (the page recommends against under 5 minutes and over 1 hour) | NOT_VERIFIED (the page does not state it) | assumption: not claimed | https://supabase.com/docs/guides/auth/sessions |
| `cost:not-stated-no-jwt-status` | The status code a function answers to a request without a valid JWT | NOT_VERIFIED (the page does not state it) | assumption: not claimed | https://supabase.com/docs/guides/functions/function-configuration |
| `cost:not-stated-inactivity-docs` | How long a Free project may be inactive before it is paused, on the docs page (the pricing page states one week) | NOT_VERIFIED (the page does not state it) | assumption: not claimed | https://supabase.com/docs/guides/platform/upgrading |
| `cost:not-stated-proration` | Whether a paid plan subscription fee is prorated when a project is deleted early | NOT_VERIFIED (the page does not state it) | assumption: not claimed | https://supabase.com/docs/guides/platform/billing-on-supabase |

Cost envelopes (derived from the entries; the test recomputes them): one Micro instance costs 24 × 0.01344 = USD 0.32256 per day and
744 × 0.01344 = USD 9.99936 for a 31-day month, both inside the monthly compute credit.

| Envelope | Condition | Ceiling |
| --- | --- | --- |
| **E0-free** | a free project slot is available (two free projects across every organization the owner administers; paused projects do not count). **NOT_VERIFIED:** whether a slot is free cannot be read without signing in; the owner reads it at PG4 | USD 0 |
| **E1-pro-fallback** | a new organization on the Pro plan, one project, deleted the same day. The ceiling is the whole base price because the pages do not say whether it is prorated (assumption); compute stays inside the credit | USD 25 |

Budget stop: no gate starts before the owner has written the accepted envelope into the PG4 phrase; if a project exists longer than the
phrase's `<delete-by-jst>` date, deleting it is the first action. Mail: the built-in sender reaches only the organization's team at two
messages an hour, so users are admin-created and mail-based tests stay manual.

Teardown and rollback: T1 removes every login the run created (the guard on the common account may refuse a cascade and then says so);
then the owner **deletes the project**; billing for compute stops at deletion. Rollback of a failed run is deleting the project; nothing is
repaired in place and nothing is reused. The disposable's keys are valid nowhere else.

## 10. Decisions for G4 (A to G)

Each decision is the owner's; the recommendation is the author's and is not a decision.

| Decision | Question | Options | Recommendation (not a decision) | Why |
| --- | --- | --- | --- | --- |
| **A** | Which login runs the pinned production inventory query? | (1) a dedicated CONNECT-only login (creating it is a production write that needs consent PG2A-LOGIN); (2) an existing owner login in a READ ONLY session (no production write; the credential is broader than the query needs) | a dedicated CONNECT-only login | the query is pinned by SHA-256 and runs in one READ ONLY transaction either way; the dedicated login limits what a mistake could do, at the price of one production write the owner must consent to |
| **B** | How is the baseline DDL exported (PG2b)? | (1) pg_dump --schema-only restricted to the listed relations by a login that holds SELECT on them (available today; reads no row, but needs a data-capable credential); (2) a catalog-only generator run by the CONNECT-only login (does not exist; needs a separate TASK and review) | pg_dump by the owner's own login if G4 wants to proceed now; the generator if G4 wants least privilege and accepts one more TASK | local evidence (section 4): a CONNECT-only login cannot run pg_dump even with --schema-only, because pg_dump takes ACCESS SHARE locks that need SELECT |
| **C** | In which organization does the disposable project live? | (1) a new organization of its own (only the owner is a member); (2) the organization that holds production | a new organization of its own | membership of an organization gives access to every project in it; a separate organization makes a mix-up between the disposable and production a different login context |
| **D** | Which cost envelope does the owner accept? | (1) E0: Free plan, ceiling USD 0, only if a free project slot is available; (2) E1: a new Pro organization, ceiling USD 25, project deleted the same day | E0 if the owner's free slot is available, otherwise E1 | the pages state two free projects across every organization the owner administers; whether a slot is free cannot be read without signing in, so it is NOT_VERIFIED here |
| **E** | Which redirect URLs does the project's Auth list hold? | (1) kabumori-social://auth-callback and kabumori-social://oauth-callback, both exact, no wildcard (what F4's preflight requires); (2) kabumori-social://auth-callback only (what the app passes to Auth) | both exact, because F4's preflight REFUSES an auth-callback-only list and changing F4's contract is a different TASK; if the provider does not match an exact entry once a flow id is appended (Q-1), stop and go back to F4 | offline test of the pinned F4 preflight: an auth-callback-only list fails REDIRECTS_DECLARED |
| **F** | What happens to M12 (ending POSTONA alone) on the hosted project? | (1) excluded from the first managed pass and listed as BLOCKED; (2) a deployed inert stand-in, which needs an F3 / G3 contract, a digest pin and a separate approval; (3) F3's real saga, which holds the X revoke call and the login-deleting scope | excluded from the first managed pass; the validation of the orchestration stays on the local harness (D-2) | D-2's stand-in is injected at the harness boundary, not a function the project can reach; the legacy function is not deployed on the project |
| **G** | How is the project's configuration accepted? | (1) the owner fills the readback sheet from the dashboard and d3_readback.ts decides; (2) no sheet (not recommended: the repository has no config.toml) | the readback sheet | Auth providers, redirects, JWT expiry, exposed schemas, function list and secret names live in the project, not in git |

## 11. PR #233 narrowed review handoff and the prerequisite chain (deliverable 8)

**PG1 review scope** (an independent reviewer, Sol (high), only when relevant; **not** a wholesale repeat of Phase 11 / 12):

| Boundary | Files (under `supabase/preflight/managed_disposable/`) | Why a recheck is enough |
| --- | --- | --- |
| non-skippable G3b and the mutation grant | `runner.ts`, `plan.ts` | changed after the last security pass; every mutating path depends on it |
| probe bytes equal verified bytes | `runner.ts`, `transports.ts` (`sqlProbe`) | the inventory and the release probe travel this path |
| transitive helper closure, named acceptance | `sql_scan.ts`, `lock.ts` | the substitute for reading every SQL file |
| inventory input vetting | `inventory_cli.ts`, `inventory.ts` | the only tool that opens a production-derived file |
| files D-1 touched | `inventory.ts` (contract subset, requirement check), `baseline_requirements.ts`, `chain_preflight_audit.ts` | new since #233 |
| new in D-3 | `d3_readback.ts`, `d3_readback_cli.ts` | decide the sheet; pure; no I/O except the CLI's file read |
| out of scope | everything J1 passed unchanged; the G1 / G2 gate; F3 / F4 / F6 / H5 files; D-2's stand-in (testing only) | no duplicate review |

Re-run for the reviewer (all offline): the `managed_disposable` suite, the mutation scripts, the inventory proof and the model run — commands in
section 12.

**The prerequisite chain** (each gate depends on the one before it, and PG3 on both PG2a and PG2b; `phase13-d3-gates.json`):

| Gate | Needs | Produces |
| --- | --- | --- |
| **PG1** | #233 at its head | reviewer PASS or a P2 list |
| **PG2a** | PG1 PASS; decision A | an inventory output outside git; `READY_FOR_OWNER_REVIEW`; two equal contract digests |
| **PG2b** | PG2a; decision B | a trimmed baseline file outside git; its digest; zero blocking scanner findings |
| **PG3** | PG2a, PG2b | two approved digests in the Report |
| **PG4** | PG3; decisions C and D; sources re-confirmed | one empty project; sheet part 1 accepted (`created`) |
| **PG5** | PG4 | G1 to G4 PASS with the chain; P1 / P2 fidelity; `account-delete` deployed by pinned bytes; sheet part 2 accepted (`deployed`) |
| **PG6** | PG5 | M1, M2, M4 to M11 and T1 PASS; the owner's F5 sign-off record |
| **PG7** | PG6; F4's preflight prints READY | one sandbox build and one device test |

## 12. What was executed for this document (offline; exact commands and outputs)

All commands ran in `/Users/yuya/Developer/kabumori-f5-d3` (a clean worktree stacked on PR #259) or in a throw-away local PostgreSQL 17.11
(`listen_addresses` empty, a Unix socket under `/private/tmp`, fake data, deleted at the end; every script refuses a host that is not a
`/tmp` socket directory). No managed or production system, no credential, no project, no sign-in. The only outbound requests of the whole
task were reads of the provider's public documentation pages (section 9).

| # | Check | Command | Result |
| --- | --- | --- | --- |
| 1 | this package: gates, consent phrases, harness step ids, cost traceability, leakage, deny-list coverage, guard refusals, the read-back verifier, the document's claims | `deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/d3_package_test.ts` | **14 passed**, 0 failed |
| 2 | the whole harness suite, earlier tests included | `deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/` | **165 passed**, 0 failed (151 before + 14) |
| 3 | the production Edge function's own tests, unchanged | `deno test --no-config --no-check --allow-read --allow-env supabase/functions/account-delete/` | **143 passed**, 0 failed |
| 4 | type-check and lint | `deno check --no-config supabase/preflight/managed_disposable/*.ts supabase/preflight/managed_disposable/x_saga_standin/*.ts supabase/tests/common_account_phase13_d2_standin_test.ts`; `deno lint --no-config supabase/preflight/managed_disposable/ supabase/tests/common_account_phase13_d2_standin_test.ts` | no error; `Checked 42 files`, no problem |
| 5 | **F4's preflight refuses until authorized** (pinned blob b2ec507904e38e97cafb7928fafd075d71dfdb82 of PR #243, extracted with `git show`, only its pure decision function called with synthetic inputs) | `bash supabase/tests/common_account_phase13_d3_f4_refusal.sh` | `D3_F4_REFUSAL\|ALL\|PASS`: blob verified; deny-list agreement (one project in the migrations, one hash in F4); 13 conditions; a clean checkout is REFUSED with 10 failing; READY only when all 13 hold; each of the 13 broken alone (16 cases) is REFUSED; an auth-callback-only list is REFUSED; the result names no host, ref or key |
| 6 | **the CONNECT-only login and pg_dump** (local, fake table) | `CAL_PGHOST=<tmp socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_phase13_d3_dump_privilege.sh` | `D3_DUMP_PRIVILEGE\|ALL\|PASS`: (a) catalog definition readable, row not readable; (b) `pg_dump --schema-only` fails with `permission denied for table` at `LOCK TABLE … IN ACCESS SHARE MODE`; (c) with SELECT the schema-only dump has the definition and no row; (d) a catalog-only DDL query works |
| 7 | mutation check of this package (43 mutants: the verifier's rules, the gates and cost data, the document, the two scripts) | `CAL_PGHOST=… python3 supabase/tests/common_account_phase13_d3_mutations.py <repository root>` | control PASS, **43/43 detected**, 0 invalid |
| 8 | the read-back CLI on synthetic sheets (kept in the scratch directory, never committed) | `deno run --no-config --allow-read supabase/preflight/managed_disposable/d3_readback_cli.ts --sheet=<file> --stage=deployed --redirects=both-exact --function=account-delete:<sha256>` | a correct sheet: `READBACK\|OK`, exit 0; a sheet with Google on and an AI key name: two STOP lines, `READBACK\|REFUSED`, exit 1; no arguments: usage, exit 2 |
| 9 | earlier mutation checks and proofs still work (regression) | the contract, Phase 12 inventory, Phase 12 scanner, Phase 11 harness and D-2 mutation scripts; `common_account_phase13_d2_standin_run.sh` | contract mutation **35/35**, Phase 12 inventory **66/66**, Phase 12 scanner **37/37**, Phase 11 harness **49/49**, D-2 **38/38** detected (control PASS each); the D-2 database-backed run (`CAL_E2E=1 … bash supabase/tests/common_account_phase13_d2_standin_run.sh`): **10 passed** |
| 10 | the DAG tables and the dry run | `deno run --no-config --no-check --allow-read supabase/preflight/managed_disposable/architecture_dag.ts --check`; `env -i PATH="$PATH" HOME="$HOME" deno run --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/cli.ts` | `the DAG json and the generated tables are current`; `mode: dry-run`, `pass=0 fail=0 stop=0 warn=0 manual=0 not_run=29 complete=false` |
| 11 | scope and hygiene | `git diff --cached --name-only`; `git diff --cached --check`; a scan of the staged diff for key shapes, connection strings with a password and the one production ref; `git merge-tree --write-tree origin/main HEAD`; open PRs touching these paths | 11 files; nothing under `supabase/functions/`, `supabase/migrations/`, `apps/` or `.agent*`; clean; 0; 0; 0; no conflict; none |

Not run, on purpose: any managed or production access; the inventory SQL against any database but the local model; a real project; the
free-slot check (needs a sign-in); any real OAuth, X, Threads, Apple, Google, AI, mail or push call; any EAS build; any merge or deploy.
The checks above prove that the package is consistent with this checkout and that its pins can fail. They prove **no** managed or
production behaviour.


## 13. G4 decision memo and the consent phrases

**Completed (source and offline):** the hosted architecture and identity rules (3), the read-back sheet and its verifier (3.5), the PG2a / PG2b
split with the local privilege finding (4), the chain and exclusion list (5), the quarantine (6), the user matrix and the F4 refusal check (7),
sourced and dated costs (9), the decisions (10), the review scope and gate chain (11), the phrases below.
**NOT_VERIFIED** (section 14): everything managed, every production fact, the free-slot availability, every item the provider's pages do
not state, M12 on a project, M13 to M15 and X-1 to X-7 as steps, a catalog-only DDL generator, real OAuth, a device test.

There is **no implied permission**: a GO on one phrase never opens another, no phrase is given by being written here, and no phrase is
offered for PG8 or PG9. Each phrase has a Japanese rendering for the owner; the two say the same and end with the same non-authorization.

**PG1** — Restricted recheck of PR #233 (P2 x4) and of the files the D-1 / D-3 work touched (access: review_only; decides: owner; executes: an independent reviewer assigned by G4 (Sol, high); no write access; needs: nothing)

- `PG1-REVIEW` (English): An independent reviewer may review exactly the boundaries listed in section 11 of docs/common-account/phase13-d3-hosted-sandbox-preflight.md at PR head <40-hex>. No other file and no wider scope. This does not authorize any other gate.
- `PG1-REVIEW` (日本語): 独立レビュー担当は、PR head <40-hex> における docs/common-account/phase13-d3-hosted-sandbox-preflight.md の第11節に列挙された境界だけをレビューしてよい。それ以外のファイルや広い範囲は対象外。これ以外のゲートは承認しません。

  - Authorizes: reading the listed files at the stated head and reporting PASS or a P2 list.
  - Does not authorize: any production read; any project; a wholesale re-review of Phase 11 / 12.
  - Evidence that must pass: the reviewer's verdict; the offline suites of section 12 re-run by the reviewer.
  - STOP: any open P1 or P2.
  - Exists today: the review scope (section 11); the re-run commands (section 12).
  - Missing today: the review itself.

**PG2a** — Production catalog inventory (A1): one read-only run of the pinned query (access: production_read_only; decides: owner; executes: the owner, on the owner's machine; needs: PG1)

- `PG2A-LOGIN` (English): OPTIONAL, only if decision A chose a dedicated login: authorize creating ONE login role <login-name> on the production database with the CONNECT privilege only, and dropping it after the export of PG2b is done. This is a production write and the only one. This does not authorize any other gate.
- `PG2A-LOGIN` (日本語): 任意（判断Aで専用ログインを選んだ場合のみ）: 本番データベースに CONNECT 権限だけを持つログインロール <login-name> を 1 つ作成し、PG2b の出力が終わったら削除することを承認する。これは本番への書き込みであり、これ 1 件だけ。これ以外のゲートは承認しません。
- `PG2A-RUN` (English): Authorize ONE read-only run of supabase/preflight/managed_disposable/inventory/schema_inventory.sql (SHA-256 <64-hex>) against the production database, with the login <login-name>, in the window <window-jst>. The output file stays outside git and chat. This does not authorize any other gate.
- `PG2A-RUN` (日本語): 本番データベースに対し、ログイン <login-name> で supabase/preflight/managed_disposable/inventory/schema_inventory.sql（SHA-256 <64-hex>）を、<window-jst> の間に 1 回だけ読み取り専用で実行することを承認する。出力ファイルは git とチャットの外に置く。これ以外のゲートは承認しません。

  - Authorizes: one execution of the pinned query inside a READ ONLY transaction (twice, to compare, if the window allows).
  - Does not authorize: reading any row; the DDL export; any other query; any write other than the optional login role.
  - Evidence that must pass: inventory_cli.ts check output (counts, codes, digests only); two contract digests that are equal.
  - STOP: secret-shaped text in the output; any statement other than SELECT; a login that needs more than CONNECT; two runs with different contract digests; a required object missing or retyped.
  - Exists today: the pinned query and its SHA-256; inventory_cli.ts; the Phase 12 proof for a CONNECT-only login on a local model.
  - Missing today: a first evaluation against a real catalog (this run is that test).

**PG2b** — Baseline DDL export (A2): schema-only, human-trimmed, scanned (access: production_read_only; decides: owner; executes: the owner, on the owner's machine; needs: PG2a)

- `PG2B-RUN` (English): Authorize ONE schema-only export (no row is requested) of exactly the objects listed in baseline_provenance.json (contract version 2) from the production database, by method <method>, with the login <login-name>. The file stays outside git and chat; after human trimming only its SHA-256 and the scanner result are reported. This does not authorize any other gate.
- `PG2B-RUN` (日本語): 本番データベースから、baseline_provenance.json（契約バージョン 2）に列挙されたオブジェクトだけを、方法 <method>、ログイン <login-name> でスキーマのみ（行は要求しない）1 回エクスポートすることを承認する。ファイルは git とチャットの外に置き、人の手で整えた後は SHA-256 とスキャン結果だけを報告する。これ以外のゲートは承認しません。

  - Authorizes: one schema-only export of the listed objects.
  - Does not authorize: any row; any trigger, cron job, host, URL, Vault reference or literal staying in the file; applying the file anywhere.
  - Evidence that must pass: the file's SHA-256; scanSql result with zero blocking findings; the object list equals baseline_provenance.json.
  - STOP: any trigger / cron / host / URL / literal left after trimming; an object of the list missing from the file; the method needs more privilege than decision B allowed.
  - Exists today: the object list (contract v2); scanSql; local evidence that pg_dump --schema-only needs SELECT on every dumped table (section 4).
  - Missing today: a catalog-only DDL generator for the CONNECT-only login (a separate TASK); pg_dump is the method available today.

**PG3** — Owner approval of the contract digest and the baseline file digest (access: decision_only; decides: owner; executes: none (a decision recorded in the Report, not in git); needs: PG2a, PG2b)

- `PG3-APPROVE` (English): I approve baseline contract digest <64-hex> and baseline file digest <64-hex>. This approves no environment and no execution. This does not authorize any other gate.
- `PG3-APPROVE` (日本語): ベースライン契約ダイジェスト <64-hex> とベースラインファイルダイジェスト <64-hex> を承認する。環境も実行も承認しない。これ以外のゲートは承認しません。

  - Authorizes: using these two digests as the expected values of G3a / G3b.
  - Does not authorize: creating a project; applying anything.
  - Evidence that must pass: the Report line that records both digests.
  - STOP: a digest is not approved; the contract is extended after the approval (the digest must be approved again).
  - Exists today: G3b compares the digest in the harness.
  - Missing today: the digests (they do not exist until PG2a / PG2b).

**PG4** — Create ONE new empty hosted Supabase project (access: hosted_disposable_create; decides: owner; executes: the owner, in the provider's dashboard; needs: PG3)

- `PG4-CREATE` (English): Authorize creating ONE new empty Supabase project named <project-name> in organization <org-name> on plan <plan>, region <region>, with a budget ceiling of USD <budget>, solely for the disposable validation, and adding only its ref to KABUMORI_DISPOSABLE_ALLOWLIST. The project is deleted by <delete-by-jst>. It holds no secret of any other system and no production data. This does not authorize any other gate.
- `PG4-CREATE` (日本語): 組織 <org-name> のプラン <plan>、リージョン <region> に、使い捨て検証だけのための空の Supabase プロジェクト <project-name> を 1 つ新規作成し、そのrefだけを KABUMORI_DISPOSABLE_ALLOWLIST に加えることを承認する。予算上限は USD <budget>。プロジェクトは <delete-by-jst> までに削除する。他システムの秘密も本番データも入れない。これ以外のゲートは承認しません。

  - Authorizes: creating the project and recording its identity.
  - Does not authorize: applying the baseline or the chain; enabling any provider or extension; deploying any function.
  - Evidence that must pass: readback sheet part 1 accepted by d3_readback.ts; the guard resolves the target in dry-run with the new ref.
  - STOP: the project was created as a branch or restore of production; the project is in an organization that holds production; an extension pg_cron / pg_net is enabled and cannot be disabled.
  - Exists today: the guard (guard.ts) and its dry-run; d3_readback.ts (identity part).
  - Missing today: the project.

**PG5** — Apply the baseline and the pinned chain; deploy the pinned Edge function; set Auth (access: hosted_disposable_mutate; decides: owner; executes: the owner (or an agent the owner names) running cli.ts --execute with the owner's environment; needs: PG4)

- `PG5-DB` (English): Authorize cli.ts --execute --only=G1,G2,G3a,G3b,G3-P1,G3-P2,G3-P3a,G3-P3b,G3-P4,G3-P5,G3-P6,G3-P8,G3-P9,G3-P10,G3c,G4 against the project whose ref has SHA-256 prefix <sha256-12>, with plan.lock.json at commit <commit-sha>, contract digest <64-hex> and baseline digest <64-hex>. No other step and no other target. This does not authorize any other gate.
- `PG5-DB` (日本語): ref の SHA-256 先頭12桁が <sha256-12> のプロジェクトに対し、plan.lock.json を commit <commit-sha>、契約ダイジェスト <64-hex>、ベースラインダイジェスト <64-hex> に固定して、cli.ts --execute --only=G1,G2,G3a,G3b,G3-P1,G3-P2,G3-P3a,G3-P3b,G3-P4,G3-P5,G3-P6,G3-P8,G3-P9,G3-P10,G3c,G4 を実行することを承認する。他のステップや他の対象は含まない。これ以外のゲートは承認しません。
- `PG5-EDGE` (English): Authorize deploying exactly the Edge function account-delete, with verify_jwt on and source digest <64-hex>, to the project whose ref has SHA-256 prefix <sha256-12>, and setting its Auth options exactly as listed in the readback sheet part 2. No other function, no secret of any other system. This does not authorize any other gate.
- `PG5-EDGE` (日本語): ref の SHA-256 先頭12桁が <sha256-12> のプロジェクトに、verify_jwt を有効、ソースダイジェスト <64-hex> で、Edge 関数 account-delete だけをデプロイし、Auth の設定を読み戻しシート第2部のとおりに設定することを承認する。他の関数や他システムの秘密は含まない。これ以外のゲートは承認しません。

  - Authorizes: the listed harness steps against the one project; the deployment of one named function by pinned bytes.
  - Does not authorize: supabase db push; supabase link; any migration outside the chain; the stand-in or the legacy social-mobile-account-delete function; any provider other than e-mail.
  - Evidence that must pass: the harness report (every listed step PASS); G3c cron / network-trigger counts unchanged; the P1 / P2 fidelity check of the architecture plan section 4.4; readback sheet part 2 accepted by d3_readback.ts.
  - STOP: the first FAIL or STOP; a digest mismatch; a scanner finding; a function other than account-delete in the list; a secret name of X, Threads, AI, Apple, Google, SMTP or Expo.
  - Exists today: cli.ts, runner.ts, plan.ts (G1 ... G4 and the chain steps); the pinned digests; d3_readback.ts (part 2).
  - Missing today: a reviewed way to deploy account-delete by pinned bytes (a human step with a read-back and a source diff).

**PG6** — Managed smoke: the acceptance steps that exist today, stage AS-A only (access: hosted_disposable_exercise; decides: owner; executes: the owner (or an agent the owner names) running cli.ts --execute; needs: PG5)

- `PG6-SMOKE` (English): Authorize running the acceptance steps M1, M2, M4, M5, M6, M7, M8, M9, M10, M11 and the teardown T1 against the project whose ref has SHA-256 prefix <sha256-12>, with e-mail and password sign-in only. M12 is excluded unless it is separately approved. Real OAuth is excluded. This does not authorize any other gate.
- `PG6-SMOKE` (日本語): ref の SHA-256 先頭12桁が <sha256-12> のプロジェクトに対し、メールとパスワードのサインインだけで、受け入れステップ M1, M2, M4, M5, M6, M7, M8, M9, M10, M11 と後片付け T1 を実行することを承認する。M12 は別途承認しない限り含まない。実OAuthは含まない。これ以外のゲートは承認しません。

  - Authorizes: the listed steps and the teardown of the users they create.
  - Does not authorize: M3 (Apple / Google, manual); M12 (needs a saga the project can reach); the proposed M13 - M15 and X-1 ... X-7 (not implemented in plan.ts); any provider other than e-mail.
  - Evidence that must pass: every listed step PASS; T1 removed the logins; the F5 sign-off record is complete.
  - STOP: any FAIL or STOP; a 'complete' summary with an open item that is not listed as excluded.
  - Exists today: M1, M2, M4 - M11, T1 in plan.ts; the fake-server model run of the same steps.
  - Missing today: M12 on the project; M13 - M15 and X-1 ... X-7 as automated steps; M3 (manual, needs provider credentials).

**PG7** — One sandbox build on a device against the project (access: device; decides: owner; executes: the owner, with F4's sandbox preflight; needs: PG6)

- `PG7-DEVICE` (English): Authorize ONE sandbox build of the POSTONA app against the project whose ref has SHA-256 prefix <sha256-12>, with the publishable key only, and one device test by <tester> on <date-jst>. POSTONA_END_SOURCE_ENABLED stays false in git. This does not authorize any other gate.
- `PG7-DEVICE` (日本語): ref の SHA-256 先頭12桁が <sha256-12> のプロジェクトに対し、公開可能キーだけを使う POSTONA アプリのサンドボックスビルドを 1 回作り、<tester> が <date-jst> に実機で 1 回テストすることを承認する。POSTONA_END_SOURCE_ENABLED は git 上で false のまま。これ以外のゲートは承認しません。

  - Authorizes: one build and one device test.
  - Does not authorize: a build against production; a store submission; enabling any release flag in git.
  - Evidence that must pass: F4's sandbox preflight prints READY; F4's device checklist.
  - STOP: the preflight REFUSES; the build points anywhere but the project.
  - Exists today: F4's preflight on its pinned head (REFUSED today, as it must be).
  - Missing today: everything before it.

PG8 and PG9 have no phrase here: PG8 — later authentication stages (Google, Apple, X as a login, Threads), one approval per provider, in a different document; PG9 — production release is a different document and different TASKs; no phrase is offered here and none is implied.

## 14. NOT_VERIFIED, open questions and owners

| Item | Owner | How it is answered |
| --- | --- | --- |
| production catalog shapes (the three unknown relations, `social_accounts.platform`, the six production-only versions) | production read | PG2a / PG2b |
| contract v2 against the real catalog; the pinned query on a real catalog | production read | PG2a |
| whether a free project slot is available; the live prices | the owner | the dashboard at PG4 (no sign-in was made here) |
| every item marked NOT_VERIFIED in section 9 (extension defaults, anonymous default, redirect matching with an appended flow id, `amr`, refresh and `session_id`, JWT expiry range, the status for a missing JWT, proration) | managed | PG4 read-back, AS-A, M4, M14 |
| a catalog-only DDL generator for PG2b method B2 | F5 (a separate TASK) | design and review |
| M13 to M15 and X-1 to X-7 as automated steps | F5 (a later TASK) | add to `plan.ts` |
| M12 on the hosted project | F3 / G3 (a saga the project can reach) and G4 | decision F |
| R2′ | F3 | not fixed by anything here |
| T13 | F3 / G3 | PR #257 is a source candidate; its managed leg is not verified |
| #233 narrowed recheck | G4 / an independent reviewer | PG1 |
| the F5 sign-off record | the owner | after PG6 |
| any real provider login | later documents | PG8 |
| production | later documents | PG9 |
