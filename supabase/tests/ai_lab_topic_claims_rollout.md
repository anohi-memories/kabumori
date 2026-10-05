# ai_lab_topic_claims — production rollout runbook (NOT executed)

Status: plan and rehearsed tooling only. Nothing here has been run against production. Every production
step needs its own explicit approval, a same-day read-only preflight and an operator at the keyboard.

- Migration: `supabase/migrations/20261004090000_ai_lab_topic_claims.sql`
  (version `20261004090000`, name `ai_lab_topic_claims`)
- Accepted source: PR #82 head `9d30a68317dd523a96e6ce96bf7a0f6de23235d5`, merge `80e11c9207d44599db26a25195f1ee0091484231`
- Migration SHA-256 (pinned in the runner, Stage A refuses anything else):
  `30d8504173160f1dc9c3d7d1cf323d9890129d1ff117c2448aa1b2516629c09c`
- Runner: `supabase/tests/ai_lab_topic_claims_rollout.sh` (`status`, `apply`, `apply --resume-history`, `proof`)
- Only Edge Function to deploy afterwards: `x-test-post`. No Cron change.

## Why schema first, history second

The migration has its own `BEGIN … COMMIT` (with preflight, drift and ACL post-conditions inside). The
Supabase CLI writes the migration-history row only after the file's own `COMMIT`, in a separate step, so
schema and history can never share one transaction. If only the history insert fails, the database holds
the correct schema with no ledger row. Instead of `supabase db push` / `migration up` / the Management
API, an operator therefore runs three explicit stages, and the runner refuses to let history get ahead
of a verified schema:

| Stage | What | Never |
|---|---|---|
| A | the exact migration file alone, `psql -v ON_ERROR_STOP=1`, its own BEGIN/COMMIT untouched | other migrations in the same session, `--single-transaction`, `db push`, `migration up`, Management API apply, `--include-all`, repair/reconcile |
| B | read-only catalog read-back from a fresh session (below) | writing history when anything differs |
| C | one history row (`version`, `name`) in its own explicit transaction, then ledger read-back | upsert, retry, repair, deleting schema |

Stage B compares, from a separate read-only session:

- seven normalized catalog sections against SHA-256 values pinned from a fresh PostgreSQL 17 apply:
  columns (type, NOT NULL, default), constraints (PK/UNIQUE/CHECK definitions), indexes (definition plus
  `indisvalid`/`indisready`/`indislive`), relation (kind, persistence, RLS, FORCE RLS, policy count,
  trigger count, comment), table ACL (every non-owner grantee, plus column-ACL count), functions (exact
  signatures, SECURITY DEFINER, `search_path=""`, language, volatility, strictness, return type, body
  hash), function ACL (every non-owner grantee, canonical form
  `public.<name>(<argument types>) <grantee> <privilege> <t|f>`, sorted with `COLLATE "C"`, no parameter names);
- every read-back transaction pins `search_path = pg_catalog, public` first, and every aggregated list has an
  explicit ordering, so the server's or operator's `search_path` and the plan's row order cannot change a hash;
- environment checks: table and five functions owned by the expected owner; no unexpected overload;
  no API role (`anon`, `authenticated`, `service_role`) a member of the owner; no effective table
  privilege for any API role (including PostgreSQL 17 `MAINTAIN`); no column privilege; EXECUTE only for
  `service_role`; the superseded `ai_lab_topic_event_usage` table absent.

### 2026-10-05 Stage B false positive (fixed in the runner, not in the migration)

The first production Stage B (after Stage A) matched six of seven sections and failed only `function_acl`
(expected `28ba64ff…`, production `1720f5c8…`) while every semantic ACL check passed. Both hashes are the
same five rows `<function>(<args>) service_role EXECUTE f` in different orders: the old SQL aggregated
with `ORDER BY 1`, which inside an aggregate orders by the constant 1, i.e. not at all. The runner now
builds the canonical, explicitly ordered form above (new pin `5635c459…`, equal to the hash of exactly
those five grants); the other six pins are unchanged. Production stays `schema present / history missing`
until the corrected runner's Stage B passes and `apply --resume-history` (Stage C only) is approved.
Stage A is not re-run.

## Exit codes and what the operator does

| Exit | Meaning | Operator action |
|---|---|---|
| 0 | done, or already complete (read-only no-op) | continue with the deploy steps |
| 2 | refused by a guard before connecting | fix the environment; nothing was touched |
| 10 | starting state not the expected one (partial/drifted schema, wrong/stray history, history without schema, bad migration bytes, wrong session role, not PostgreSQL 17) | stop; nothing applied by this run; review |
| 11 | migration failed before COMMIT; read-back confirms schema absent and history absent | stop; find the cause (the migration prints its `AI_LAB_TOPIC_CLAIMS_*` reason); a new attempt is a new approval |
| 12 | Stage A outcome unknown (connection lost, response lost); the runner read the catalog instead of retrying and reports ABSENT / EXACT / UNSAFE | stop; ABSENT: new attempt only after review. EXACT: `apply --resume-history` only after review. UNSAFE: stop, no history, no deploy |
| 13 | Stage B mismatch | stop; history NOT written; no deploy; no automatic drop |
| 14 | schema present / history missing (Stage C failed, or found at start) | stop; no automatic retry; after review: `apply --resume-history` (re-runs Stage B, then Stage C) |
| 15 | postflight read-back not exact | stop; no deploy |

The runner never drops objects, never runs a down migration and never edits history beyond inserting
the one exact row. Removing a bad new (empty) table/functions or a history row is a separate,
explicitly approved transaction — never an improvised repair.

## Connection and guards (no secrets in files, arguments or logs)

The runner takes libpq environment variables only. Put the password in `~/.pgpass` (mode 600) or a
`PGPASSWORD` exported in the operator's own shell for that one command; never on the command line,
never in a file in the repository, never pasted into a report. The runner prints no host, user,
project ref or password.

Production requires all of:

- `AILAB_ROLLOUT_TARGET=production`
- `AILAB_ROLLOUT_ACK='apply 20261004090000_ai_lab_topic_claims to production after a same-day read-only preflight'`
- `AILAB_ROLLOUT_PROJECT_REF=<the 20-letter project ref>` and `PGHOST` or `PGUSER` containing it
- a TCP host (not a socket), `PGSSLMODE=require` (or stronger), not the transaction pooler port 6543
- `AILAB_EXPECTED_OWNER=postgres` and `PGUSER` = `postgres` (direct host) or `postgres.<project ref>` (session pooler);
  after connecting, `current_user` must be `postgres` and the server PostgreSQL 17 before anything is read or written
- no test hook (`AILAB_ROLLOUT_TEST_*`) set

The direct database host has only an IPv6 address; from a network without IPv6 use the session pooler
(port 5432, user `postgres.<project ref>`).

Without `AILAB_ROLLOUT_TARGET=production` the runner accepts only a `/tmp` Unix-socket host.

## Cold ledger (no backfill)

`ai_lab_topic_claims` starts empty. Development-diary events that were already posted before the cutover
are NOT backfilled, and past post texts are not analysed to guess them. Duplicate prevention is
therefore guaranteed for posts made **after** the production cutover only; there is no retroactive
"never repeat anything ever posted" guarantee. (Diary entries older than the fresh window — currently
3 days — are not candidates anyway.)

## Exact future production sequence

Each numbered step is its own go/no-go. Stop at the first surprise.

1. **Same-day read-only preflight** (in `BEGIN TRANSACTION READ ONLY`, as the role that will apply):
   - `select current_user, current_setting('server_version_num')` → `postgres`, 17xxxx
   - `to_regclass('public.ai_lab_topic_claims')` and `to_regclass('public.ai_lab_topic_event_usage')` are NULL;
     no `public` function named `claim_ai_lab_topic`, `start_ai_lab_topic_provider`,
     `release_ai_lab_topic_claim`, `mark_ai_lab_topic_claim_ambiguous`, `settle_ai_lab_topic_claim_published`
   - `supabase_migrations.schema_migrations`: no row with version `20261004090000`, no row named
     `ai_lab_topic_claims` or `ai_lab_topic_event_usage`; column list still includes `version` (PK) and `name`
   - `pg_has_role(r, 'postgres', 'MEMBER')` is false for `anon`, `authenticated`, `service_role`
   - default privileges of `postgres` in `public` grant only to `anon`, `authenticated`, `service_role`
     (the migration revokes these and fails closed on anything else)
   - optionally the runner's own read-only classification: `ai_lab_topic_claims_rollout.sh status`
     → `STATE schema=ABSENT history=NONE`
2. **No running or overdue AI Lab job**:
   `select status, count(*) from public.scheduled_posts where brand_id = 'ai_salaryman_lab' and post_type = 'brand_post'
    and (status = 'running' or (status = 'pending' and scheduled_for < now())) group by status;` → no rows.
   Note the next scheduled AI Lab slot; finish steps 5–11 well before it, or wait until it has completed.
3. **Pin the migration**: clean checkout of the approved commit; `shasum -a 256` of the migration equals
   the SHA-256 above (the runner enforces this again).
4. **Pin `x-test-post`**: the approved commit's `supabase/functions/x-test-post/` plus its import graph
   (`deno info supabase/functions/x-test-post/index.ts`), recorded as file list + SHA-256 for the
   read-back in step 11. The deployed runtime must be the PR #82 runtime; deploying it before the
   migration makes every AI Lab post stop before X (`AI_LAB_TOPIC_RPC_FAILED`), which is safe but loses slots.
5. **Stage A + B + C**: from the repository root of the pinned checkout, with the production environment
   above exported in the operator's shell:
   `bash supabase/tests/ai_lab_topic_claims_rollout.sh apply`
   Expected output ends with `Stage B: catalog read-back = EXACT`, `Stage C: history recorded …`,
   `postflight: schema=EXACT history=EXACT`, `DONE`. Any `STOP[n]` → table above.
6. **API-cache read-back** (read-only). The new RPCs are reachable only after PostgREST's schema cache
   includes them. Check, do not assume: list the event triggers
   (`select evtname, evtenabled from pg_event_trigger order by 1`) and look for one that reloads the
   PostgREST cache on DDL (Supabase projects normally carry one such as `pgrst_ddl_watch`). If there is
   none, a cache reload (`NOTIFY pgrst, 'reload schema'`) is a separate, explicitly approved action — not
   part of this runbook. An API-side read-only check is the OpenAPI document (`GET /rest/v1/` with the
   service-role key taken from the secure store, never pasted into logs or reports), which should list the
   five `/rpc/` paths. Do NOT call any of the five RPCs to test them — `claim_ai_lab_topic` writes.
7. **Ledger read-back** (read-only): `ai_lab_topic_claims_rollout.sh status` →
   `STATE schema=EXACT history=EXACT`; and
   `select version, name from supabase_migrations.schema_migrations where version = '20261004090000'`
   → exactly one row `20261004090000 | ai_lab_topic_claims`.
8. (stop point) If anything in 5–7 is not exact: no deploy.
9. **Right before deploy, re-check step 2** (no running / overdue AI Lab job).
10. **Deploy `x-test-post` only**, from the pinned clean checkout that contains its own minimal untracked
    `supabase/config.toml` (project id + `[functions.x-test-post] verify_jwt = false`) and link files —
    otherwise the CLI walks up to another checkout and ships that tree:
    `supabase functions deploy x-test-post --project-ref <ref> --no-verify-jwt --use-api`
    (never without a function name, never `--prune`).
11. **Deploy read-back** (read-only): `supabase functions list` → `x-test-post` version incremented,
    `ACTIVE`, `verify_jwt=false`, every other function's version/`updated_at` unchanged;
    `supabase functions download x-test-post --use-api` into a scratch directory with its own
    `supabase/config.toml`, and byte-compare every file against step 4.
12. **No manual POST** to `x-test-post`.
13. **No manual scheduler invoke** and no Cron change.
14. **No backlog or candidate injection** (no hand-made `scheduled_posts` rows, no claim rows).
15. **Observe only a separately approved natural cycle**: the next scheduled AI Lab post logs
    `AI_LAB_TOPIC_CLAIM` with `claimedEventKey`; then one `ai_lab_topic_claims` row reaches `published`
    (read-only check). `AI_LAB_TOPIC_POOL_EXHAUSTED` or `AI_LAB_TOPIC_RPC_FAILED` means the slot was
    skipped before X — investigate, do not force a post.

## Local rehearsal (what `proof` demonstrates)

`AILAB_PGHOST=/private/tmp/<socket dir> AILAB_PGPORT=<port> AILAB_PGSUPER=<local superuser> bash supabase/tests/ai_lab_topic_claims_rollout.sh proof`
creates throwaway databases on a local PostgreSQL 17 cluster with Supabase-like API roles, default
privileges and the production ledger shape (`version` text PK, `statements` text[], `name`,
`created_by`, `idempotency_key` UNIQUE, `rollback` text[]), and runs the real `apply`/`status` paths:

1. clean success: ABSENT/NONE → A → B EXACT → C → exactly one history row → postflight EXACT; the live
   catalog sections equal the pinned values
2. migration fails before COMMIT (its own preflight; and an injected error just before COMMIT after all
   DDL) → STOP 11, no table, no functions, no history
3. Stage A response lost: nothing applied → STOP 12 ABSENT; committed → STOP 12 EXACT, plain rerun
   STOP 14, explicit `--resume-history` completes; partial object → STOP 12 UNSAFE; never rerun automatically
4. Stage B mismatch (anon grant, permissive policy, wrong index, SECURITY INVOKER, extra EXECUTE,
   overload, dropped CHECK) → STOP 13, no history, no deploy hint; invalid index detected
5. Stage C history insert fails → STOP 14 with schema EXACT, table kept, no history; plain rerun still
   STOP 14; explicit resume after the cause is fixed completes with exactly one row
6. completed state rerun → read-only no-op, nothing duplicated
7. wrong history name, wrong version, history without schema, superseded table, drifted object after
   completion, `--resume-history` misuse, altered migration bytes → STOP 10
8. guards: every missing production switch refused before connecting; a fully switched target stops at
   the identity check
9. the pinned `function_acl` equals the hash of the five canonical service_role EXECUTE grants; all seven
   sections and `status` are identical under the session search_paths `"$user", public, extensions`,
   `pg_catalog`, `public` and empty
10. adverse function ACL changes (EXECUTE to anon / authenticated / an unrelated role, EXECUTE revoked from
    service_role, grant option added, an overload) are each detected and block `apply`

Test hooks used by the rehearsal (`AILAB_ROLLOUT_TEST_MIGRATION`, `AILAB_ROLLOUT_TEST_STAGE_A`,
`AILAB_ROLLOUT_TEST_AFTER_STAGE_A_SQL`) are refused for any non-local target.
