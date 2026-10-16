# Phase 12 — schema baseline (BG1) and cron isolation (BG2), offline

Status: **source candidate, offline only. Production NO_GO.** (§8 records the four P2 corrections of the J1 V1 review.) Nothing here connects to, reads from or writes to a managed
project, production or otherwise. Every proof ran on throw-away local PostgreSQL 17 databases with fake data.
Parent: [Phase 11](phase11-managed-disposable-readiness.md) (PR #223). Release gates stay OFF; `managed_auth_delete` and
`IDP_PREPAUSE_BLOCKED` stay BLOCKED.

## 0. What this phase answers

Phase 11 built a harness that would apply the ten-file chain to a *disposable* managed project. It left two gaps open
(BG1, BG2) that make such a run unsafe or meaningless. This phase closes what can be closed **without** touching a managed
system, and states exactly what remains.

| | Gap | Closed here | Remains (needs a separate authorization) |
| --- | --- | --- | --- |
| BG1 | The repository's migrations are not a self-sufficient baseline | exact list of missing objects, provenance of every required object, a read-only inventory procedure + proof, a baseline read-back gate in the plan | run the inventory on production; owner approval of its contract digest; build the disposable baseline from it |
| BG2 | Eight migrations embed the production host with `cron.schedule` + `net.http_post` | fail-closed scanner, allowlist lock, negative corpus, a "silence" read-back, pinned probe files | review of every file of any future baseline export |

## 1. BG1 — the baseline gap, exactly

### 1.1 Provenance classes

Every object the chain's own preflights name is classified **from the repository's migration texts only** (comments
blanked; a commented-out `CREATE` creates nothing):

| Class | Meaning |
| --- | --- |
| `platform_managed` | `auth.*`, `storage.*`, `vault.*`, `extensions.*`: created by Supabase, never by this repository |
| `repository_created` | a repository migration contains `CREATE TABLE` / `CREATE FUNCTION` / `CREATE SCHEMA` for it |
| `repository_altered_only` | repository migrations only `ALTER` it: something outside the repository created it |
| `absent_from_repository` | no repository migration mentions it as created or altered |

A column is `migrations` (a creating migration declares it and the replay produced it with the same type), `platform_assumed`
(platform table; assumed present, read back by the probe), `fixture_only` (only the test fixtures define it — **never
treated as verified**), `blocked_replay` (a repository migration creates its table but the replay on a bare platform could
not run it), or `neither`.

### 1.2 The 17 relations the Phase 1 preflight requires

| Relation | Class | Created by (migration timestamp) | Replay on bare platform |
| --- | --- | --- | --- |
| `auth.users`, `auth.identities` | platform_managed | — | stand-in |
| `storage.buckets`, `storage.objects` | platform_managed | — | stand-in |
| `public.profiles`, `public.tracked_stocks`, `public.alert_settings`, `public.notifications` | repository_created | 20260901061217 | built |
| `public.admin_users` | repository_created | 20260901064201 | built |
| `public.device_push_tokens` | repository_created | 20260903160000 | built |
| `public.personalized_reports` | repository_created | 20260911230000 | built |
| `public.alert_category_settings` | repository_created | 20260913140000 | built |
| `public.brand_memberships` | repository_created | 20260918120000 | **not built** (needs `public.brands`) |
| `public.social_mobile_account_deletions` | repository_created | 20260928160000 | **not built** (needs the social-mobile stack and Vault) |
| `public.social_accounts` | **repository_altered_only** | — (altered 20260924023133, 20261007150000) | not built |
| `public.social_account_oauth_states` | **repository_altered_only** | — (altered 20260919120000) | not built |
| `public.brands` | **absent_from_repository** | — | not built |

Functions: `public.social_mobile_account_deletion_subject(uuid)` and `public.social_mobile_account_deletion_workspace(uuid)`
are created by `20260928160000` (not replayable on a bare platform). Schema `private`: created by `20260901064201`. Roles
`anon`, `authenticated`, `service_role`: platform managed.

### 1.3 The unknown baseline (never reconstructed)

Computed by `provenance.ts`, committed in
[`baseline_provenance.json`](../../supabase/preflight/managed_disposable/baseline_provenance.json):

- **3 relations**: `public.brands`, `public.social_accounts`, `public.social_account_oauth_states`.
- **6 columns the chain's preflight reads on them**: `brands.id`, `brands.code_profile_key`,
  `social_accounts.brand_id`, `social_accounts.connection_status`, `social_account_oauth_states.brand_id`,
  `social_account_oauth_states.initiated_by_user_id`. The fixtures define 31 columns on those three tables; they are listed
  in the report as `fixtureOnlyColumns` and are **not** evidence of production.
- **4 foreign keys that touch them**: `brand_memberships(brand_id)→brands(id)`, `social_accounts(brand_id)→brands(id)`,
  `social_account_oauth_states(brand_id)→brands(id)`, `social_account_oauth_states(initiated_by_user_id)→auth.users(id)`.
- **2 relations a repository migration creates but the replay could not**: `public.brand_memberships`,
  `public.social_mobile_account_deletions` (they depend on the unknown ones).
- Production constraints, defaults, indexes, policies, grants and owners of every one of these: **not inspected**.

### 1.4 Replay result (analysis only)

All 120 repository migrations were replayed in order on a bare platform stand-in
([`common_account_phase12_platform_stubs.sql`](../../supabase/tests/common_account_phase12_platform_stubs.sql), local only):
**87 apply, 33 fail**. The failures are the dependency chain on the unknown baseline (`relation "…" does not exist`,
`PHASE*_PRECONDITION_*_MISSING`, `…_VAULT_OR_QUEUE_MISSING`, `…SCHEMA_MISSING`), not defects of the chain. The conclusion is
that **the migration directory cannot be replayed into an empty project to obtain the baseline**, and must never be tried
on a managed project.

### 1.5 Fixture world versus replay world (the local diff)

`inventory/schema_inventory.sql` was run over both local worlds and checked against the requirement lists
(`baseline_requirements.ts` reads them out of the Phase 1 preflight, so a changed preflight is a changed requirement):

| World | Inventory lines | Requirement findings |
| --- | --- | --- |
| fixture (reviewed proof baseline) | 398 | **0** — provides all 17 relations, 26 columns, 14 foreign keys, 2 functions |
| replay (every repository migration on a bare platform) | 2024 | **24** — exactly the unknown baseline plus what depends on it (5 relations, 12 columns, 5 foreign keys, 2 functions) |

A test pins that the replay's `RELATION_MISSING` set equals `unknown.relations ∪ createdButNotReplayable`, and that the
report is bound to the inventory query by its SHA-256. Unknown objects therefore **fail readiness**; nothing synthesises
them. Regenerate / verify with
`supabase/tests/common_account_phase12_baseline_report_run.sh [--write|--check]`.

### 1.6 Platform-managed objects that are not in the repository

Assumed present and read back (never created) by the chain: `auth.users(id)`, `auth.identities(user_id, provider)`,
`auth.sessions(id, user_id, not_after)` (P3b and P9 read it), `storage.buckets/objects(owner_id)`, the three API roles, and
Vault when a baseline file references it. The plan's G3b now **requires** these in the project's own inventory before any
chain file is sent.

### 1.7 Provenance of each statement (what is a fact and how it is known)

| Source | What it supports | Status |
| --- | --- | --- |
| GitHub-reviewed migration files in this repository | creation/alteration of repository objects, chain order | verified (text) |
| Test fixtures (`social_mobile_account_deletion_fixture.sql`, …) | what the proofs assumed | **not evidence of production** |
| Local replay on a stand-in | which migrations are self-sufficient | observed locally |
| Documents (Phase 1–11) | design intent | claim |
| Managed production schema | everything else | **not inspected** — `unverified` |

## 2. Read-only schema-only production inventory (design; **not executed**)

Files: [`inventory/schema_inventory.sql`](../../supabase/preflight/managed_disposable/inventory/schema_inventory.sql),
[`inventory.ts`](../../supabase/preflight/managed_disposable/inventory.ts).

### 2.1 What it emits, what it never emits

One JSON object per line `{k, key, a}`; 22 kinds: `meta schema extension role membership relation column constraint index
trigger function policy type view_reference event_trigger publication foreign_data_wrapper foreign_server user_mapping
setting_scope default_acl language`. The attribute list of every kind is **closed** (`ATTRIBUTES`): an unexpected or absent
attribute makes the consumer STOP, so a changed query cannot start to leak a value unseen.

| Object | Emitted | Never emitted |
| --- | --- | --- |
| Column default, check / index / policy / trigger / view text | a **shape** (every string literal replaced by `'?'`) and the **SHA-256** of the full text | the text |
| Function | signature, kind, language, owner, security mode, volatility, ACL, `search_path`, body **SHA-256 + length**, five booleans (mentions cron / net / vault / URL / Supabase host) | the body; any function setting other than `search_path` (value `<redacted>`) |
| Foreign server / wrapper / table / user mapping | names and option **keys** | option values |
| Per-database / per-role settings | setting **names** | values |
| Role | attributes (`superuser`, `login`, `bypassrls`, …) | password hash, valid-until, role settings |
| Sequence | start / increment / min / max / cache / cycle / type | last value, any statistic |
| Everything | catalog structure | any row of any application, auth, storage, vault or cron table; comments; extension member objects (counted) |

### 2.2 Least privilege and preconditions

A login that can **CONNECT** and nothing else: every catalog read is open to PUBLIC. It must not be a superuser, an owner
of application tables or a member of `service_role`. The local proof asserts the reader cannot read a sentinel table,
`cron.job` or `vault.secrets`, and that its output is identical to the owner's.

### 2.3 Exact run (for a separately authorized session; placeholders only)

```
# operator terminal; the URL comes from the operator's secret store and is never pasted into chat, a log or git
export KABUMORI_INVENTORY_DB_URL='<read-only connection string>'
psql -X -q -A -t -v ON_ERROR_STOP=1 \
     -f supabase/preflight/managed_disposable/inventory/schema_inventory.sql \
     "$KABUMORI_INVENTORY_DB_URL" > ./inventory.ndjson      # kept OUTSIDE the repository
deno run --no-config --allow-read supabase/preflight/managed_disposable/inventory_cli.ts check ./inventory.ndjson
```

The script is one `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY … ROLLBACK`, with `statement_timeout`,
`lock_timeout` and `idle_in_transaction_session_timeout` set locally. It creates no object (a read-only transaction
forbids it), calls no function it defines, runs no dynamic SQL, and uses no extension function.

### 2.4 Checks that make the query itself reviewable

`checkInventorySql` (pure, tested with injected statements of every refused kind and with 9 mutants): the first statement is exactly the read-only
`BEGIN`, the last is `ROLLBACK`, the only other statements are `SET LOCAL` of three timeouts and `SELECT`; every FROM / JOIN
target and every `pg_*` name is on a catalog allowlist; every called function is on a function allowlist (`pg_read_file`,
`pg_sleep`, `nextval`, `set_config`, `dblink`, … are refused); no schema-qualified application object; no comma join (an
unqualified name would resolve through `search_path`). The file is pinned by SHA-256 in `plan.lock.json`.

### 2.5 Manifest, hash, replayability, STOP on drift

`canonicalize` sorts lines and keys and returns a SHA-256 of the whole manifest plus one per kind (so a drift is localised
without the manifest). `contractSubset` cuts the **baseline contract**: exactly what the chain needs (required relations —
owner, RLS, ACL for application tables; `relkind` for platform tables — required columns by type/null/default hash, primary
and unique keys of required application tables, the foreign keys the preflights name, the two required functions by body
hash and security mode, the required schemas and roles). Column position is dropped. Everything else stays in the full
manifest for the owner to read and is **not** part of the compared digest. `diffInventories` reports missing, extra and
changed (with the attribute names). Any difference is a STOP; nothing is repaired. `inventory_cli.ts check <manifest>
[--approved <sha256>]` prints counts, finding codes and digests (never a manifest line) and exits 0 only for
`READY_FOR_OWNER_REVIEW` (with `--approved`, only for that digest); `inventory_cli.ts diff <approved> <observed>` exits 1 on
any drift.

### 2.6 What is deliberately outside this inventory

`cron.job` rows (they hold commands, and may hold tokens), Vault contents, storage buckets, auth users, row counts and
statistics, table comments, function bodies, Realtime/replication slots, project-level Auth settings. The **count** of cron
jobs on the *disposable* project is read by plan step G3b/G3c (§3.5); reading `cron.job` on production is a separate,
differently-scoped authorization (§6, item A2) and is not part of the schema inventory. Anything that would need an
elevated role or reveal a secret is omitted rather than gated.

### 2.7 Local proof (planted fake values)

[`common_account_phase12_inventory_run.sh`](../../supabase/tests/common_account_phase12_inventory_run.sh) plants 24 `SENTINEL_*`
values and one sequence value (column default, check literal, index predicate, policy and trigger literals, view literal,
function body, function setting, role password, role / database settings, foreign-server password and host, user-mapping
password, foreign-table option, `cron.job` command, `vault.secrets` secret, table comment, URL path, sequence value). It
asserts, for a CONNECT-only login, the owner and a superuser: parses, valid against the attribute lists, no secret-shaped
text, **no planted value anywhere**; deterministic; same for reader and owner; the structure that *should* be there is
there (shape + hash, redacted settings, option keys, flags); the engine refuses an injected `CREATE`, `INSERT` and `GRANT`
(and the static check flags them); the sequence is not advanced; and six real changes (added column, same-shape other
literal, dropped policy, changed body, granted privilege, disabled RLS) are drifts. Result: `P12_INVENTORY_ALL_PASS` (57 assertions);
60/60 query / logic / tool / plan-step mutants detected.

## 3. BG2 — cron and HTTP isolation

### 3.1 The unsafe migrations (scanner result over all 120 files)

30 files have a **blocking** finding; 53 only review-level findings (`DATA_WRITE`, `DYNAMIC_SQL`, one top-level `SELECT`);
37 are clean. None of the ten chain files, nor the release probe, has a blocking finding; their review-level findings
are pinned statement by statement in the lock.

**The eight that arm production-host HTTP from the database** (each: `cron.schedule` + `net.http_post` + the production
Supabase host + a Vault read):

| Migration | `cron.schedule` sites | Also |
| --- | --- | --- |
| 20260908110000 important_news_publish_ready_cron | 1 | |
| 20260910163500 send_push_notifications_dispatch_cron | 1 | Vault |
| 20260916100000 mic_phase1b_automation_cron | 13 | Vault |
| 20260919090000 mic_fx_phase1_automation_cron | 5 | Vault |
| 20260921090000 mic_equity_index_phase1_automation_cron | 3 | Vault |
| 20260923090000 mic_macro_indicators_phase1a_automation_cron | 3 | Vault |
| 20260924093000 mic_estat_activation_and_gated_macro_cron | 2 | Vault |
| 20260930090000 mic_scenario_automation_cron_phase3c | 2 | Vault |

On a bare platform stand-in all eight **apply** (the stand-in has `cron.schedule` and `net.http_post`): replaying them on a
managed project arms jobs that call the production endpoint from a project that is not production. That is the hazard.

**Other unsafe effects**

- `20260923110440 important_news_monitor_caller_auth`: rewrites existing `cron.job` commands from Vault (no host in the
  text; it refuses with `IMPORTANT_NEWS_MONITOR_CRON_SECRET_NOT_CONFIGURED` when the secret is absent). A **ninth**
  cron-touching file; indirect.
- Vault readers/writers with no cron: `20260919120000`, `20260923120000`, `20260924170000`, `20260925120000`,
  `20260925140000`, `20260925150000`, `20260926032054`, `20260928160000` (`20260919120000` and `20260928160000` are
  real prerequisites of the proof baseline; see §3.2).
- 12 files with only `URL_LITERAL` / `URL_FRAGMENT`: URL strings in seed data (exchange calendars, source URLs). Not
  network calls; fail-closed means they need a reviewer before they could ever be locked.
- `20260929090000 news_discovery_observer`: `UNTRUSTED_LANGUAGE` is a **false positive** (a column named `language`);
  fail-closed scanners accept those.

### 3.2 The allowlisted minimal dependency chain

The only files the harness may send are the ten chain files (P1 … P10) and the operator-supplied baseline. Each is pinned in
`plan.lock.json` by SHA-256 together with what the review accepted *statement by statement* (`reviewed`: dynamic
statements by hash, write targets, top-level selects) and the corpus's network helper functions (`networkFunctions`, none).
`applyFile` refuses a file when (a) it is not pinned, (b) its bytes differ, (c) it has any blocking finding, (d) it has a
dynamic statement / write target / top-level select the lock did not accept, (e) it calls a corpus function that reaches
cron or the network, or (f) its text names another project. Never `supabase db push`; never replay the directory; **any
unknown SQL effect is a STOP**.

The chain depends on the baseline only through the 17 relations, 26 columns, 14 foreign keys and 2 functions of §1.3 — none
of the eight files is a dependency of the chain. The two Vault-using migrations of §3.1 that *are* the repository's creators
of required objects (`20260928160000` creates `social_mobile_account_deletions` and the two functions) are **not** replayed:
the operator-supplied baseline export carries their result, and the export is scanned by the same scanner before it is sent.

### 3.3 The scanner

[`sql_scan.ts`](../../supabase/preflight/managed_disposable/sql_scan.ts): a hand-written PostgreSQL lexer, not a regular
expression over raw text. Comments (nested `/* */`, `--`) are blanked **before** any rule; quoted identifiers are unquoted
and lower-cased; whitespace around dots is removed; dollar-quoted bodies are lexed recursively (an unlexable body is scanned
raw: more findings, never fewer). Rules: Supabase host, foreign project host, `http(s)://` literal and fragment, `cron.*` /
`pg_cron`, `net.*` / `pg_net` / `http_*`, `CREATE EXTENSION`, file/program access, foreign servers, Vault / `pgsodium`,
role changes, server settings, triggers on platform tables, event triggers, unicode-escaped spellings, untrusted
languages, dynamic SQL (`EXECUTE`, `PREPARE`, `query_to_xml`, `cursor_to_xml`), data writes, top-level `SELECT`
(a stored-function call at apply time), unknown statement kinds, unterminated literals. A function that reaches cron or net
becomes a *network helper*; a file that calls one is refused (`INDIRECT_NETWORK_CALL`).

Negative corpus (each is a test that must be refused): URL hidden by `--` and `/* */` comments; `net./**/http_post`,
`"net"."http_post"`, `net . http_post`; URL assembled from fragments; dollar-quoted body; `EXECUTE format(...)`;
`query_to_xml(...)`; a helper function that calls `net.http_post` and is invoked from another file; a function that
schedules cron indirectly; a malformed / uppercase / trailing-dot / port-suffixed host; a trigger on `auth.users`; a
`DO` block; `language plpython3u`; `U&"…"` spellings. 28/28 scanner / lock mutants detected; 37/37 harness mutants
(Phase 11 and 12) detected.

### 3.4 Unverified coverage (stated, not hidden)

- SQL assembled at run time from data (a URL read from a table, built with `chr()`); this is why an unaccepted `EXECUTE` is a
  finding and an accepted one is pinned by the hash of its text.
- Behaviour of production's own triggers, event triggers and platform hooks: **not inspected**. The inventory lists them
  (kinds `trigger`, `event_trigger`, function `mentions`) for the owner, but only a production run can supply them.
- Whether a managed project's `pg_cron` / `pg_net` extensions are enabled by default: unknown; G3c reads the counts either way.
- Supabase-managed webhooks / database webhooks (they are triggers calling `supabase_functions.http_request`): detected
  only if they appear in the inventory's trigger list.
- The scanner is lexical: a build step that rewrites a file after the lock is out of scope (the lock hashes the bytes).

### 3.5 What changed in the plan (Phase 11 plan, F5-owned files only)

| Step / rule | Change |
| --- | --- |
| guard | `KABUMORI_DISPOSABLE_INVENTORY_SHA256` (the approved contract digest, 64 hex) is required for execution: `INVENTORY_DIGEST_MISSING` |
| runner | any probe file must be pinned in the lock and equal to its pinned bytes before it is sent |
| `G3b` (new, read-only) | the project's own inventory is parsed, validated, secret-scanned; the contract subset must provide every requirement and its SHA-256 must equal the approved one; the cron / network footprint is recorded. Any difference is STOP and **no chain file is sent** |
| `G3c` (new, read-only) | after the last chain file the number of cron jobs and of user triggers reaching cron / net / http equals what G3b recorded |
| lock | now carries `requirements` (read from the Phase 1 preflight) and pins the inventory query |

Model run (`common_account_phase11_model_run.sh`): 26 steps pass including `G3b` (87 contract items) and `G3c`; a different
approved digest STOPs at `G3b` with zero files applied and teardown still running.

## 4. S0 – S3 acceptance (GO / NO_GO; nothing advances automatically)

| Gate | Criterion | Evidence now | State |
| --- | --- | --- | --- |
| **S0** Baseline known and owner-approved | A schema-only production inventory exists (kept outside git), `baselineReadiness` = `READY_FOR_OWNER_REVIEW` (all 3 unknown relations, 6 columns, 4 foreign keys present with matching types), the owner approved its contract digest, and the baseline export for the disposable project reproduces it | procedure + proof only; no inventory | **NO_GO** |
| **S1** Network-silent chain | the ten chain files and the baseline export pass the scanner with zero unaccepted findings; none of the eight files, the ninth or any Vault reader is in the send list; digests pinned | 10/10 chain files and the probe clean; negative corpus 11 tests (sql_scan_test.ts); mutants 28/28 | **GO for the chain (offline)**; baseline export **NO_GO** until it exists and is scanned |
| **S2** Disposable identity protection | allowlist, deny list (incl. every ref in the repository), typed confirmation, DB URL ref, marker re-read before every mutation, approved digest present, `G3b` before the chain | guard 9 tests + 37 harness mutants; model run incl. wrong-marker and tamper worlds | **GO (source)**; no project exists → **NO_GO to execute** |
| **S3** Silence and preservation | `G3c` unchanged footprint; `auth.users` count is exactly the run's own logins and teardown removes them; the POSTONA entitlement semantics (M4, M12) hold; no Kabumori row created for a POSTONA-only login | model run M4/M5/M7/M8/M10/M11 + T1 | **NO_GO** until the disposable run |

A **GO** on any row is a statement about the evidence listed, never an authorization to run. Each row's next step is a
separate, explicit approval (§6).

## 5. Tests

Run (all local, fake data): `deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/`
(66 tests); inventory proof `P12_INVENTORY_ALL_PASS` (57 assertions); baseline report `--check`; Phase 11 model run
`PHASE11_MODEL_ALL_PASS`; mutations — scanner/lock 28/28, harness 37/37 (Phase 11 + 12), inventory 60/60.
Not run: Phase 9 runner (seams unchanged except through the Phase 11 model); any managed environment; independent review.

Re-run (local PostgreSQL only; `CAL_PGHOST` must be a `/tmp` socket directory, anything else is refused):

```bash
deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/
CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_phase12_baseline_report_run.sh --check
CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_phase12_inventory_run.sh
CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_phase11_model_run.sh
python3 supabase/tests/common_account_phase12_scanner_mutations.py .
python3 supabase/tests/common_account_phase11_harness_mutations.py .
CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> python3 supabase/tests/common_account_phase12_inventory_mutations.py .
```

## 6. Handoffs and copy-ready future authorizations

No approval is implied by this document. Each item below is a separate user decision; the wording is meant to be copied.

**A1 — Production schema-only inventory (read-only).** *"Authorize a single read-only run of
`inventory/schema_inventory.sql` (SHA-256 `<hash from plan.lock.json>`) against the production database, with a dedicated
login that has CONNECT only, from the operator's machine. The output file stays outside git and chat; only
`inventory_cli.ts check` output (counts, finding codes, the contract digest) may be reported. STOP if the output contains
secret-shaped text, if a statement other than SELECT is needed, or if the role needs more than CONNECT."*

**A2 — Production cron state, separately.** *"Authorize reading the names, schedules and enabled flags (never the commands)
of `cron.job` on production, to know which of the eight files' jobs exist."* Different scope: it reads data.

**B — Owner approval.** *"I have read the manifest. I approve contract digest `<64 hex>` as the baseline the chain may
assume. The unknown relations/columns/foreign keys in provenance §1.3 are as listed."* Recorded in the Report, not in git.

**C — Disposable project and baseline export.** *"Authorize creating one new Supabase project named `<name>`, region
`<region>`, outside production; adding its ref to `KABUMORI_DISPOSABLE_ALLOWLIST` and to nothing else; producing a
schema-only baseline file for the 17 relations + 2 functions whose scanner result is empty; and recording its SHA-256."*

**D — Acceptance run.** *"Authorize `cli.ts --execute` against project `<ref>` with the lock at commit `<sha>`, the approved
digest `<64 hex>`, the baseline file digest `<64 hex>`; the plan stops at the first FAIL/STOP; teardown always runs; the
project is deleted afterwards."*

Owner hand-offs: **G3** (X onboarding RPC T13), **F3** (lock order; `hold()`), **F4** (Threads revoke), **G4/POSTONA**
(legacy withdrawal screen) are unchanged from Phase 10 §9 and not touched. For the baseline itself the only owner is whoever
operates production Supabase: they hold the inventory run (A1/A2) and the export (C).

## 7. Blockers (unchanged by this phase)

No production inventory; no approved digest; no baseline export; no disposable project; no managed-service behaviour
(PostgREST status mapping, real RLS, GoTrue linking, `auth.sessions` privilege); no independent review of Phases 9–12.
`managed_auth_delete` BLOCKED, `IDP_PREPAUSE_BLOCKED` BLOCKED, all release gates OFF.

## 8. J1 V1 corrections (R1 – R4), 2026-10-16

J1 V1 reviewed PR #226 and reproduced four P2 defects in this phase's guards. Each was reproduced against the exact PR #226
source (`3d87a845`), then fixed; the reproductions are kept as
[`j1_p2_reproductions_test.ts`](../../supabase/preflight/managed_disposable/j1_p2_reproductions_test.ts). Source-only; no
managed or production access; every transport in the tests is a stub or a local-database stand-in.

| | Defect (before) | Correction (after) |
| --- | --- | --- |
| **R1** | `ctx.probe` hashed `reader.read(path)` and then handed only the *path* to `sqlProbe`; the real transport read the file a second time and piped that to psql. A replacement written after the check was executed. | `Transport.sqlProbe(path, bytes)`: the runner reads the path **once**, verifies the pinned digest, and passes those bytes. The real transport reads no file at all (a static test forbids `readTextFile` in `transports.ts`). The test replaces the file after the check and asserts psql's stdin is the pinned bytes and the path was read once. |
| **R2** | `--only=G3-P1` skipped G3b: the first chain file was applied with an unverified (merely 64-hex) approved digest. | Three layers. (a) `Step.requires` (every mutating step except G3a and teardown requires `G3b`): an unsafe selection — a required step not selected, ordered later, or an unknown id — is refused **before any transport action**, not even an identity read; the CLI dry run prints it. (b) A required step is not run unless its requirement PASSED in this run. (c) At the mutation boundary itself (`applyFile`, any non-GET request, a held lock) a **baseline grant** is required: it exists only after G3b PASSED with evidence that names the approved digest *and* a probe whose pinned bytes this run actually sent; a PASS without that evidence is converted to STOP. Teardown stays runnable alone. Each chain invocation therefore carries G3b (`--only=G1,G3b,G3-P2`); the model run asserts the contract digest is the same before and after the chain, so this is stable. |
| **R3** | `networkFunctionNames` recorded only functions whose own body mentions cron / net, so `leaf (net.http_post) → middle → top SELECT` was accepted. Also found: a leaf with a single-quoted body (`AS '…'`), a `PROCEDURE`, and a renamed function were not recognised at all. | The corpus is closed over its call graph to a fixed point (multi-hop, cycles, helpers split over files); names are matched by bare name, so a schema or an overload does not exempt a call; the whole `CREATE FUNCTION / PROCEDURE` statement is read (any body spelling); `ALTER FUNCTION … RENAME` is an alias edge. The indirect-network finding is **blocking and independent of the lock**: a pinned SELECT fingerprint does not accept it. Functions that run run-time SQL (`EXECUTE`, …) are closed the same way: a call to one is `INDIRECT_DYNAMIC_CALL` unless the lock names it per file (`reviewed.indirectDynamic`; the committed lock names exactly three for P3a and eleven for the read-only probe). The lock also carries the closed `networkFunctions` / `dynamicFunctions` lists. |
| **R4** | `inventory_cli diff` parsed and printed both inputs without the secret scan or the shape contract; two equal contaminated manifests said "no drift", and a different pair echoed the offending identifier. | `diff` vets **both raw inputs** — read, secret scan, parse, closed shape — before comparing or formatting, exactly like `check`. A contaminated input (equal or different) is STOP with finding **codes and counts only**: no value, object name or path; a read failure carries no message (`check` no longer prints the manifest path either). While fixing it a second defect surfaced: the secret patterns used a leading `\b`, and `_` is a word character, so `s_sb_secret_…` or `x_sk_live_…` (a key behind an identifier prefix) was not seen; the prefixes now match inside identifiers (a letter or digit still blocks, so `task_…` is not `sk_…`). |

Also: `guard_test.ts` inherited a `TS2345` (`[Env, string][]` against the narrower `GuardCode` union) from PR #223; the case list is
now typed `[Env, GuardCode][]` and every file of the directory type-checks without `--no-check`.

**Not changed, still true.** G3c is after-the-fact and count-only; the inventory has still never been run on a managed
database; D1 whole-ID deletion consent, G3 T13, F3 legacy, POSTONA mobile issues and managed auth remain separate release
STOPs. Lexical scanning cannot see SQL assembled at run time from data: it fails closed on the *presence* of such a callee and
asks for a named acceptance, it does not resolve what it would do.
