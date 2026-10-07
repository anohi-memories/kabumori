# Common account Phase 2 — production apply runbook for `20261006230000` (not executed)

Status: **applied to production on 2026-10-07** (user-approved; `common-account-v1-phase2-production-migration-apply-20261007`).
The procedure below ran once, pinned to this bundle at `36bea0ae`:
- Stage A committed at 13:47:09 JST.
- The history row was recorded at 13:47:28.
- Every read-back was ALL PASS: Stage B, the final one, and an independent re-read at 13:50.

It stays as the record of the procedure and as the template for later single-file applies.

## What is applied

- File: `supabase/migrations/20261006230000_common_account_service_start_intent.sql`. It is merged in PR #95
  (`d5bea735`) and is byte-identical to the H1-reviewed head `ba35b642`.
  - SHA-256: `2c736e5aa70c61bf5563eee185d226fbde2c7f37f034c262f5e4b31f81888fa4`.
- One transaction, carried by the file itself (`begin` … `commit`):
  1. An in-file preflight refuses unless all of these hold: the Phase 1 foundation is present, the guard is
     shadow, and nothing of this file exists yet.
  2. The file replaces `private.account_lifecycle_start_service(uuid,text)`.
  3. It adds two private helpers, `private.account_lifecycle_reactivate_service(uuid,text,bigint)`, and
     `public.reactivate_kabumori_service(bigint)` / `public.reactivate_x_autopost_service(bigint)`. The public
     RPCs are executable by `authenticated` only.
  4. An in-file postflight checks definer, empty `search_path` and the exact effective EXECUTE for all eight
     functions.
- The file has no table DDL and no row write. It changes no RLS, Auth, Storage, Vault or Cron.

## Production facts read on 2026-10-07 (read-only)

| Item | Observed |
|---|---|
| Server | PostgreSQL 17.6. `supabase db query --linked` runs as `postgres` |
| History | Latest `20261004090000`; Phase 1 `20261001150000` recorded as (version, name) only; `20261006230000` **absent** |
| Pending neighbours | PR #81 hardening `20261003120000` and PR #41 Stage 3B `20261006160000/160100/160200`: **not applied** |
| Touched objects | The five new functions are absent. The three existing ones are owned by `postgres`, are definers with `search_path=""`, and are executable by `authenticated` only (public) or by nobody (private). Their definition hashes equal a local apply of the reviewed Phase 1 source |
| Dependencies | `private.account_lifecycle_lock(uuid,boolean,boolean)` and `public.ensure_my_profile()` hash identical to the reviewed sources |
| Callers | Only `public.start_kabumori_service()` / `public.start_x_autopost_service()` call the start helper. No Edge function calls any of these RPCs (repository search) |
| Lifecycle | 5 logins, 5 active common accounts, 0 logins without an account. Entitlements: kabumori 2, x_autopost 1, all active / legacy_backfill. Operations 0. Settings shadow / not_started / epoch 1 |
| Client usage | `track_functions = none` (no call statistics). 0 `self_service` entitlements: no client has enrolled through the start RPCs yet |
| Privileges | The `postgres` default ACL for new functions in `public` grants only to `postgres`. API roles are members of no role. `authenticated` has USAGE on schema `private` (pre-existing); the file revokes EXECUTE on every private function it creates or replaces, and the postflight proves it |
| Event triggers | `ensure_rls` (CREATE TABLE only, not hit) and `pgrst_ddl_watch` (PostgREST reloads its schema, so the new RPCs appear to `authenticated`) |
| `run.sh before` | **ALL PASS** (24 checks) |

The production history does not track the repository one-to-one. Six production versions are not in the
repository, and many repository files are not in the history. That is pre-existing. **Never use
`supabase db push`**: it would try to apply every repository file that is missing from the history. Every
migration here is applied as a single reviewed file.

## Compatibility and rollout order

- Old binaries are unaffected:
  - Kabumori binaries released before Phase 2 call `ensure_my_profile()`, which is unchanged (identical hash
    before and after, proved locally).
  - X binaries call no lifecycle RPC.
- The start RPCs change their answers in two ways:
  - an active answer adds `shared_account`;
  - an ended entitlement answers `reenroll_required` and is no longer restarted.
- No current caller depends on the old shapes, since no Phase 2 build exists. Production has no ended
  entitlement today.
- The Phase 2 clients accept only the new answers and fail closed otherwise. So the order is:
  1. this migration;
  2. then app builds (EAS / TestFlight, separately approved).
- PR #81 / PR #41 touch no object of this file, and this file touches none of theirs, so either order works.
  - Applying this file first makes the history non-monotonic once they follow. That is acceptable with
    single-file procedures.
  - Each gate must take its own same-day baseline: the "untouched" fingerprints cover all public/private
    functions and relations, so a G3 apply in between would change them.

## Procedure (in a G5 production mutation window; no other slot may hold one)

Use a checkout of current `main`, with the tracked files clean. The bundle is
`supabase/tests/common_account_service_start_intent_preflight/`.

0. Pin the inputs:

   ```bash
   shasum -a 256 supabase/migrations/20261006230000_common_account_service_start_intent.sql
   ```

   The result must be `2c736e5aa70c61bf5563eee185d226fbde2c7f37f034c262f5e4b31f81888fa4`.

1. Run the same-day read-only preflight. It must end with `ALL PASS (before)` and writes
   `out/before-<time>/baseline.json`:

   ```bash
   bash supabase/tests/common_account_service_start_intent_preflight/run.sh before
   ```

2. Record `production_mutation_window: ACTIVE` in the G5 TASK, then push it.

3. **Stage A — the only schema write.** Run it in the operator's terminal; psql asks for the database password.
   psql, not the Management API: on any error, psql ends the session, so the file's open transaction is rolled
   back with nothing left behind.

   ```bash
   PGHOST=aws-0-ap-northeast-1.pooler.supabase.com PGPORT=5432 PGUSER=postgres.wsmznyzcvmuitkglfeuj \
   PGDATABASE=postgres PGSSLMODE=require PGCONNECT_TIMEOUT=15 \
   PGOPTIONS='-c lock_timeout=5s -c statement_timeout=120s' \
   psql -X -v ON_ERROR_STOP=1 -f supabase/migrations/20261006230000_common_account_service_start_intent.sql
   ```

   Expected: exit 0, ending in `COMMIT`. The file runs `BEGIN`, a `DO` preflight, six `CREATE FUNCTION`
   (one of them a replace), six `REVOKE`, two `GRANT`, a `DO` postflight, then `COMMIT`.

4. **Stage B — read-back (read-only).** It must end with `ALL PASS (after)`.

   ```bash
   bash supabase/tests/common_account_service_start_intent_preflight/run.sh after <step-1 baseline.json>
   ```

   It checks:
   - all eight touched functions: exact definition hash, definer, `search_path=""`, ACL, effective EXECUTE and
     owner `postgres`;
   - no extra overload;
   - every other public/private function, table, column, policy and trigger unchanged against the baseline;
   - lifecycle row counts unchanged;
   - the smoke answers exact.

5. **Stage C — history, only after step 4 passed.** This is the second and last write: one row, in the same
   shape as Phase 1's.

   ```bash
   PGHOST=aws-0-ap-northeast-1.pooler.supabase.com PGPORT=5432 PGUSER=postgres.wsmznyzcvmuitkglfeuj \
   PGDATABASE=postgres PGSSLMODE=require PGCONNECT_TIMEOUT=15 \
   psql -X -v ON_ERROR_STOP=1 -c "insert into supabase_migrations.schema_migrations (version, name) values ('20261006230000', 'common_account_service_start_intent')"
   ```

6. **Final read-back.** It must end with `ALL PASS (after)`:

   ```bash
   bash supabase/tests/common_account_service_start_intent_preflight/run.sh after <step-1 baseline.json> --history
   ```

7. Record `production_mutation_window: CLOSED` in the G5 TASK.

## Abort and rollback

**Before COMMIT (Stage A exits non-zero):** nothing is committed. Possible causes:
- the in-file preflight or postflight raises one of:
  - `COMMON_ACCOUNT_START_INTENT_PREFLIGHT_FOUNDATION_MISSING`
  - `…_ALREADY_APPLIED`
  - `…_POSTFLIGHT_DEFINER`
  - `…_POSTFLIGHT_EXECUTE`
- a lock or statement timeout;
- a connection error.

Then:
1. Run `run.sh before`. It must pass again with the same fingerprints.
2. Close the window.
3. Report the exact message. Do not retry until it is understood.

**Outcome unknown** (for example, the connection was lost around `COMMIT`): classify read-only.
- If `run.sh before` passes, the file was not applied.
- If `run.sh after <baseline>` passes, it was applied; continue with Stage C.
- Anything else: STOP.

**After COMMIT, Stage B fails:** STOP, and add no history row.
- The repository has no reviewed reverse migration.
- Reverting would restore the unsafe automatic restart of ended services (R1), so it is not an option.
- A correction is a new, reviewed forward migration.
- Until then, no client depends on the new RPCs, because no Phase 2 build is out.

**Stage C fails:** the schema is present and the history is missing.
1. Re-run step 4.
2. Repeat only step 5, once.

Never repair the history with `migration repair`, and never use `db push`.

## Local proof of the bundle

```bash
PROOF_PGHOST=/private/tmp/<socket-dir> PROOF_PGPORT=<port> PROOF_PGSUPER=<local superuser> \
  bash supabase/tests/common_account_service_start_intent_preflight/proof.sh
```

The proof builds the same baseline as `common_account_service_start_intent_run.sh` on a disposable local
PostgreSQL 17, plus the production history ledger's shape.

It shows that `check.py` passes in these cases:
- before the apply;
- after it;
- after the history row.

It also shows that `check.py` fails, on the intended check, for each of these:
- before-mode on the applied state;
- a missing history row, and an extra one;
- an extra EXECUTE on a new private helper;
- an extra overload of a new RPC;
- an ACL change on an unrelated function;
- a changed row count.

`expected.json` is regenerated only with `proof.sh --write-expected`, together with a reviewed migration
change.
