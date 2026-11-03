# Consumer owner / ACL alignment check (G5-43 — read-only, NOT applied, NOT in `supabase/migrations/`)

Production **NO_GO**. It is on top of the G5-42 migration candidate (`../postona_personal_auth_migration/`), whose own gates are unchanged.

## 1. What it is

`consumer_owner_alignment_check.sql` is **one read-only SELECT** over the catalog:
- it creates, changes and grants nothing;
- the tests run it inside a `READ ONLY` transaction;
- **zero rows means aligned.**

It checks the one ownership rule of G5-42 (`docs/common-account/g5-42-postona-auth-migration-and-consumer-contract.md` §3) against whatever is installed:
- **Every function that reaches an owner-only G5 gate is a SECURITY DEFINER function owned by the lifecycle owner, with a fixed search_path.** "Reaches" means directly, or through an owner-only helper such as G4's `postona_g4_x_oauth.require_person` or G3's `postona_x_resv.caller`.
- **No one else may execute an owner-only gate.**

| Code | Finding |
| --- | --- |
| `GATE_OWNER_MISSING` | S2-2 is absent (install G5 first) |
| `GATE_OWNER_IS_SUPERUSER` | the gates' owner is a superuser |
| `GATE_OWNER_REACHABLE` | anon / authenticated / service_role / authenticator is a member of that owner |
| `GATE_OWNER_DIFFERS` | a G5 private function has another owner |
| `GATE_ACL_WIDENED` | a G5 private function is executable by anyone but its owner, or has a NULL ACL (PUBLIC) |
| `ENTRY_ACL_CHANGED` | R1 / R0 are not exactly {owner, authenticated}, or W2 is not exactly {owner, service_role} |
| `CONSUMER_OWNER_MISMATCH` | a consumer is owned by another role (a superuser included) |
| `CONSUMER_NOT_DEFINER` | a consumer is SECURITY INVOKER |
| `CONSUMER_SEARCH_PATH` | a definer consumer has no fixed search_path, or `$user` / `pg_temp` in it |
| `CONSUMER_SEARCH_PATH_WRITABLE` | an API role may CREATE in a consumer's search_path schema |
| `NON_FUNCTION_DEPENDENT` | a view, default, policy … depends on a gate or protected helper (triggers are not: they run as their definer owner) |

## 2. How G4's owner / EXECUTE mismatch closes without a grant

- **G4's install precondition** (X `001`, Threads `001` / `002`) is `has_function_privilege(<owner of begin / complete>, <gate>, 'EXECUTE')`.
- **When the lifecycle owner installs G4**, that holds with no grant. It was measured with G4's real X `001`–`004`: all four install, and the real begin / consume run through the real G5 gates.
- **G5 grants nothing.** The check is the gate: it names every other way of making the precondition hold.
  - **An EXECUTE grant to another owner.** G4's precondition accepts it. G5 reports `GATE_ACL_WIDENED` and `CONSUMER_OWNER_MISMATCH`.
  - **A superuser owner.** G4's precondition accepts it, because `has_function_privilege` is true for a superuser. G5 reports `CONSUMER_OWNER_MISMATCH`.
  - **A later owner change.** G5 reports `CONSUMER_OWNER_MISMATCH`, and the call fails closed.

## 3. Use (procedure, not enforced)

Order of installs and checks:
1. Apply the G5-42 migration candidate as the lifecycle owner.
2. Install each consumer **as the same role**.
3. Run this check, expecting zero rows, after each consumer install and before any wiring or deploy.
4. A non-empty result is fixed at its cause: owner, definer, search_path or ACL. **Never by a grant on a gate.**

Withdrawal order:
1. Withdraw the consumers first. For G4, run its rollbacks `004` → `001`. G3's `001` has no rollback file; that is G3's to provide.
2. Then run the G5-42 rollback. It refuses with `BUNDLE_ROLLBACK_CALLERS` while any consumer remains.

## 4. Limits

**Not seen by the check:**
- a name built by dynamic SQL;
- other databases;
- callers outside the database: the Edge and the app.

**Consumer exposure is the consumer's own review.**
- A consumer may be granted to its users on purpose. Examples: G4's begin to `authenticated`, G3's API to its own role.
- A helper that is made executable stops being "protected", and its callers are then no longer followed through it.
- G4's own postconditions check its helpers' ACLs.

**Matching:**
- A gate is matched by its bare name, comments included, which over-reports and is conservative.
- A helper is matched by `schema.name`.

**Not run on any managed project.** The managed owners (e.g. whether the same migration role owns both the G5 chain and G4's functions) are **NOT_VERIFIED**.

## 5. Evidence (throw-away PostgreSQL 17.11, local socket, fake data)

How it ran:
- Runner: `supabase/tests/postona_personal_auth_consumer_alignment_pg_run.sh`.
  - It loads G4's real X files `001`–`004` (and their rollbacks) from PR #533 `98e5cf03`, and G3's `001` from PR #536 `1dc19904`.
  - Each file is pinned by blob.
- Worlds: `al` (aligned), `mo` (another owner) and `su` (superuser owner).
- Tests: `postona_personal_auth_consumer_alignment_pg_test.ts`.
- Result: **6 / 6 tests passed, 3 runs in a row.**
- Mutation: 18 / 18 mutants of the check detected (ASSERTION only).
