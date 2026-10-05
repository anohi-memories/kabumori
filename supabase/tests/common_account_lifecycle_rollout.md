# common account lifecycle foundation — production rollout runbook (NOT executed)

Status: plan and rehearsed tooling only. Nothing here has been run against production. The production
write needs its own explicit approval, a same-day read-only preflight, a production-mutation mutex check
and an operator at the keyboard.

- Migration: `supabase/migrations/20261001150000_common_account_lifecycle_foundation.sql`
  (version `20261001150000`, name `common_account_lifecycle_foundation`)
- Accepted source: PR #70 merge `44121914b035e22380a4ca1bd8252a42713a2bbf`, fixed source `aa4d2d425d1d7c432d43c9ecfb8e978a40b80a65`
- Migration SHA-256 (pinned in the runner, Stage A refuses anything else):
  `e632214b5602c12ee73d9a7475af36791138099a1a7fdba7e8fb521afc01cde3`
- Runner: `supabase/tests/common_account_lifecycle_rollout.sh` (`status`, `apply`, `apply --resume-history`, `proof`)
- Mechanism: the same schema-first / history-second operator path as `ai_lab_topic_claims_rollout.sh`
  (PR #86 / #88), which completed the AI Lab production rollout on 2026-10-06.
- Nothing to deploy afterwards. No backfill, no Edge Function, no Cron, no flag.

## Why schema first, history second

The migration has its own `BEGIN … COMMIT` with an exact preflight and a postflight inside. Supabase CLI
(v2.115.0+) runs such a file as written and sends the history insert only after it, so schema and history
never share one transaction; `db push` / `migration up` would also apply every other local migration that
production's ledger does not list. The operator therefore runs three explicit stages, and the runner
refuses to let history get ahead of a verified schema:

| Stage | What | Never |
|---|---|---|
| A | `set lock_timeout = '5s'`, then the exact migration file alone, `psql -v ON_ERROR_STOP=1`, its own BEGIN/COMMIT untouched | other migrations in the same session, `--single-transaction`, `db push`, `migration up`, Management API apply, `--include-all`, repair |
| B | read-only catalog read-back from a fresh session (below) | writing history when anything differs |
| C | one history row (`version`, `name`) in its own explicit transaction, then ledger read-back | upsert, retry, repair, dropping schema |

`lock_timeout` is a session setting, not an edit of the file: `create table public.common_accounts (… references
auth.users)` takes a SHARE ROW EXCLUSIVE lock on `auth.users` until COMMIT. If a long transaction holds
`auth.users`, the migration gives up after 5 s and rolls back (exit 11) instead of queueing and holding
back every Auth write behind it. The file itself runs in milliseconds once it has the lock.

Stage B compares, from a separate read-only session with `search_path = pg_catalog, public` pinned:

- ten normalized sections against SHA-256 values pinned from a fresh PostgreSQL 17 apply: columns (type,
  NOT NULL, default) of the five tables and the view; constraints (definition, validated, deferrable);
  indexes (definition plus `indisvalid`/`indisready`/`indislive`); relations (kind, persistence, RLS, FORCE
  RLS, policy / trigger / internal-trigger counts, view definition, comment); policies (roles, command,
  USING, WITH CHECK); triggers (definition, enabled); table ACL (every non-owner table and column grant:
  exactly the 11 column SELECT grants to `authenticated`); the 33 functions (canonical signature, SECURITY
  DEFINER, `search_path=""`, language, volatility, strictness, result, definition hash); function ACL
  (exactly 2 EXECUTE to `authenticated`, 10 to `service_role`, nothing on the 21 internal helpers);
  state (settings `shadow / not_started / 1`, the three built-in checkpoints, zero accounts, entitlements
  and operations);
- environment checks: every relation and function owned by the expected owner; no overload or stray object
  under a target name in any schema; no API role (`anon`, `authenticated`, `service_role`) a member of the
  owner; no effective table privilege for any API role on the six relations (PostgreSQL 17 `MAINTAIN`
  included); effective column privilege exactly the 11 client SELECT columns; effective EXECUTE exactly the
  intended audience per function; RLS enabled on all five tables;
- existing objects: a fingerprint of everything else in schemas `public` and `private` (tables, columns,
  defaults, column/table ACLs, constraints, indexes, policies, triggers, functions with definition and ACL,
  types, schema ACLs, default privileges) taken right before Stage A must be identical after it.

## Exit codes and what the operator does

| Exit | Meaning | Operator action |
|---|---|---|
| 0 | done, or already complete (read-only no-op) | continue with the read-back below |
| 2 | refused by a guard before connecting | fix the environment; nothing was touched |
| 10 | starting state not the expected one (partial/drifted schema, stray object, wrong/stray history, history without schema, bad migration bytes, wrong session role, not PostgreSQL 17) | stop; nothing applied by this run; review |
| 11 | migration failed before COMMIT (its own preflight, any error, or the lock timeout); read-back confirms schema absent and history absent | stop; the runner prints the `COMMON_ACCOUNT_*` reason or the lock timeout; a new attempt is a new approval |
| 12 | Stage A outcome unknown (connection lost, response lost); the runner read the catalog instead of retrying and reports ABSENT / EXACT / UNSAFE | stop; ABSENT: new attempt only after review. EXACT: `apply --resume-history` only after review. UNSAFE: stop, no history |
| 13 | Stage B mismatch (new objects not exact, or an existing object changed) | stop; history NOT written; no automatic drop |
| 14 | schema present / history missing (Stage C failed, or found at start) | stop; no automatic retry; after review: `apply --resume-history` (re-runs Stage B, then Stage C) |
| 15 | postflight read-back not exact | stop |

The runner never drops objects, never runs the rollback file and never edits history beyond inserting the
one exact row. Removing a bad new object or a history row is a separate, explicitly approved transaction —
never an improvised repair. `--resume-history` has no in-run "before" fingerprint; compare the fingerprint it
prints with the same-day preflight value instead.

## Connection and guards (no secrets in files, arguments or logs)

libpq environment variables only. The password goes in `~/.pgpass` (mode 600) or a `PGPASSWORD` exported in
the operator's own shell for that one command; never on the command line, never in the repository, never in
a report. The runner prints no host, user, project ref or password.

Production requires all of:

- `CAL_ROLLOUT_TARGET=production`
- `CAL_ROLLOUT_ACK='apply 20261001150000_common_account_lifecycle_foundation to production after a same-day read-only preflight'`
- `CAL_ROLLOUT_PROJECT_REF=wsmznyzcvmuitkglfeuj` and `PGHOST` or `PGUSER` containing it
- a TCP host (not a socket), `PGSSLMODE=require` (or stronger), not the transaction pooler port 6543
- `CAL_EXPECTED_OWNER=postgres` and `PGUSER` = `postgres` (direct host) or `postgres.<project ref>` (session pooler);
  after connecting, `current_user` must be `postgres` and the server PostgreSQL 17 before anything is read or written
- no test hook (`CAL_ROLLOUT_TEST_*`) set; the 5 s lock timeout cannot be changed for production

The direct database host has only an IPv6 address; from a network without IPv6 use the session pooler
(port 5432, user `postgres.<project ref>`).

## Exact future production sequence

Each step is its own go/no-go. Stop at the first surprise.

1. **Mutex**: fresh `origin/main`; `.agent/ACTIVE_TASK.md`, `.agent/CURRENT_STATE.md` and every G/H TASK show
   no other production apply, deploy or permission change in progress or pending on the same project
   (2026-10-06: G4's PR #76 rollout and G3's PR #81 apply are both gated on separate approvals).
2. **Same-day read-only preflight**: `bash supabase/tests/common_account_lifecycle_preflight/run.sh` (nine
   single-SELECT files, catalog and aggregate output only, no PII): target absent in every form, dependency
   shape exact, owner privileges present, role graph / default privileges as recorded, ledger without the
   target version or name, renderer canary equal to the local cluster, and the existing-object fingerprint
   recorded. If any production change has landed since the approved preflight, repeat it.
3. **Pin the migration**: clean checkout of the approved commit; `shasum -a 256` of the migration equals the
   SHA-256 above (the runner enforces it again).
4. **Optional dry status**: `bash supabase/tests/common_account_lifecycle_rollout.sh status` with the
   production environment → `STATE schema=ABSENT history=NONE`.
5. **Stage A + B + C**: from the repository root of the pinned checkout, with the production environment
   exported in the operator's shell:
   `bash supabase/tests/common_account_lifecycle_rollout.sh apply`
   Expected output ends with `Stage B: existing objects unchanged`, `Stage B: catalog read-back = EXACT`,
   `Stage C: history recorded …`, `postflight: schema=EXACT history=EXACT`, `DONE`. Any `STOP[n]` → table above.
6. **Read-back** (read-only): `status` → `STATE schema=EXACT history=EXACT`; the Phase A bundle again →
   exactly the 12 relations / 33 functions / 10 triggers / 2 policies present, exactly one ledger row
   `20261001150000 | common_account_lifecycle_foundation`, nothing else in the ledger changed, and the
   existing-object fingerprint equal to the pre-apply value.
7. **API read-back** (read-only, informational): the `pgrst_ddl_watch` event trigger reloads the PostgREST
   schema cache on the migration's DDL. Do NOT call any of the new RPCs to test them — they write.
8. **Not part of this rollout**: `private.account_lifecycle_backfill(false)` (read-only count, needs its own
   authority), `backfill(true)`, client wiring, deletion-route changes, Auth/Storage/OAuth/Vault work,
   Edge deploys, Cron and flags.

## Production facts from the 2026-10-06 read-only preflight

Recorded so the read-back has a baseline; repeat the preflight before any write.

- PostgreSQL 17.6; the query session is `postgres` (not superuser, BYPASSRLS); default isolation READ COMMITTED;
  `postgres` has `lock_timeout = 0` and `statement_timeout = 2min`.
- Ledger `supabase_migrations.schema_migrations` (owner `postgres`; `version` text PK, `statements`, `name`,
  `created_by`, `idempotency_key` UNIQUE, `rollback`): 73 rows, max `20261004090000`, no row for `20261001150000`
  and none named like the foundation. It does not mirror the repository (59 repository versions absent, 27
  ledger-only versions), so `db push` / `migration up` are not usable.
- Every foundation object absent (12 relations, 12 types, 33 functions, 10 triggers, 2 policies, and the broad
  name patterns); schema `private` present (owner `postgres`, 0 relations, 1 function).
- The migration's own preflight re-derived: 17/17 relations, 26/26 typed columns, 14/14 exact foreign keys,
  every `profiles` child cascades, both helpers present (text, IMMUTABLE, `search_path=""`, EXECUTE only for
  `postgres`) with the 20260928160000 bodies.
- `postgres` has REFERENCES/SELECT on `auth.users`, SELECT on `auth.identities`, `storage.objects` and
  `storage.buckets`, and INSERT/DELETE on `public.profiles`; `auth.users` has 28 internal (FK) triggers and no
  user trigger — the apply adds exactly 2 internal ones.
- No API role is a member of anything; `postgres`'s default privileges in `public` grant only
  MAINTAIN/REFERENCES/TRIGGER/TRUNCATE on tables to the API roles and nothing on functions; none in `private`.
  The migration's explicit revokes remove all of them (proof covers the worst case and the empty case).
- `authenticated` has USAGE on schema `private` (pre-existing); the new private objects grant it nothing.
- Event triggers: `ensure_rls` (enables RLS on new `public` tables; proof case 1e), `pgrst_ddl_watch` /
  `pgrst_drop_watch` (schema cache reload) and extension hooks. No `pg_graphql`; `supabase_realtime` is not
  FOR ALL TABLES.
- Renderer canary: the 20260928160000 objects hash identically on production 17.6 and the local 17.11 cluster
  (7 of 7 sections), so the pinned Stage B sections mean the same thing on both.
- Existing-object fingerprint (preflight bundle `07`, Management API session):
  `d7a00f63a40e0c64da6b7f8993ea9a035e3d6d9d2a7deed861407c861c7795c3` (84 relations, 569 constraints, 200 indexes,
  61 policies, 46 triggers, 122 functions). Production changes in `public`/`private` by other work change it.

## Local rehearsal (what `proof` demonstrates)

`CAL_PGHOST=/private/tmp/<socket dir> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_lifecycle_rollout.sh proof`
builds the lifecycle suite's production-shaped baseline once (fixtures, the real onboarding and social-mobile
deletion migrations, Supabase's worst-case default grants to the API roles in `public` and `private`) plus the
production ledger shape, copies it per case, and runs the real `apply` / `status` paths:

1. clean success: ABSENT/NONE → A → B EXACT (existing objects unchanged) → C → exactly one history row →
   postflight EXACT; live sections equal the pins; settings / registry / empty tables as designed
2. the pinned ACL sections equal exactly the 12 reviewed EXECUTE grants and the 11 client column grants
3. every section and `status` identical under four session search_paths
4. the same pins after Supabase's 2026-10-30 default (no automatic grants to API roles), and with an
   `ensure_rls`-style event trigger enabling RLS on new public tables
5. 15 adverse privilege / security changes after completion are detected and block `apply`
6. completed state rerun → read-only no-op
7. migration fails before COMMIT (its own preflight; an injected error after every DDL) → STOP 11, nothing left
8. a transaction holding `auth.users` → Stage A gives up after the lock timeout → STOP 11, nothing left
9. Stage A response lost: nothing applied → STOP 12 ABSENT; committed → STOP 12 EXACT, plain rerun STOP 14,
   explicit `--resume-history` completes; partial object → STOP 12 UNSAFE
10. 12 kinds of drift between Stage A and Stage B (grant, permissive policy, wrong index, SECURITY INVOKER,
    extra EXECUTE, overload, dropped CHECK, disabled guard trigger, settings / registry change, a changed
    existing table grant, a changed existing helper) → STOP 13, no history; an invalid index is detected
11. Stage C history insert fails → STOP 14 with schema EXACT, objects kept; plain rerun still STOP 14; explicit
    resume completes with exactly one row
12. wrong history name, same name under another version, history without schema, stray object under a target
    name, drifted object after completion, `--resume-history` misuse, altered migration bytes → STOP 10
13. guards: every missing production switch refused before connecting; a fully switched target stops at the
    identity check

Test hooks used by the rehearsal (`CAL_ROLLOUT_TEST_MIGRATION`, `CAL_ROLLOUT_TEST_STAGE_A`,
`CAL_ROLLOUT_TEST_AFTER_STAGE_A_SQL`, `CAL_ROLLOUT_TEST_LOCK_TIMEOUT`) are refused for any non-local target.
