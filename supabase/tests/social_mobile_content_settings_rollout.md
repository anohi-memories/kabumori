# social_mobile_content_settings — production apply plan (NOT executed)

Status: plan only. Nothing here has been run against production. Every step below needs its own
explicit approval, a fresh read-only preflight, and an operator at the keyboard.

## Why not `supabase db push` / `migration up`

The chain is two files:

1. `supabase/migrations/20260922045046_social_mobile_content_settings_candidate.sql` (historical, unchanged)
2. `supabase/migrations/20261003120000_social_mobile_content_settings_hardening.sql`

The Supabase CLI (2.116.0, proven by H2) applies each file — statements plus its history row — in its
own transaction. That is per-file atomicity, not whole-chain atomicity: file 1 commits, and if file 2
fails or the connection drops before it, the weak candidate (malformed JSON accepted, TRUNCATE etc.
inherited from default privileges) is live until someone finishes the chain.

The historical candidate is deliberately not rewritten: it is part of the reviewed history, and the
hardening file is written to accept exactly that candidate shape. Instead, both files and their two
history rows are applied in **one outer transaction** by an operator. If anything fails, nothing is
left: no table, no functions, no history rows (rehearsed by `social_mobile_content_settings_run.sh`,
marker `SMCS_ATOMIC_CHAIN_REHEARSAL_PASS`, which also shows that per-file application would leave the
weak candidate behind).

## Preflight (read-only, same day, same role that will apply)

Run in `BEGIN TRANSACTION READ ONLY` and stop on any surprise:

- `to_regclass('public.social_mobile_content_settings')` is NULL, and no `public` function named
  `social_mobile_content_settings_%` exists.
- Neither `20260922045046` nor `20261003120000` is in `supabase_migrations.schema_migrations`.
- The column list of `supabase_migrations.schema_migrations` (the insert below uses `version`, `name`;
  if the CLI version in use requires further NOT NULL columns, adjust the insert and get it re-reviewed).
- `current_user` is the role that owns `public.brands` (expected `postgres`).
- Default privileges for that role in `public`: tables may grant only to `anon`, `authenticated`,
  `service_role` (anything else makes the hardening's drift guard stop — fail closed, by design).
- `public.brands(id text PK)`, `public.brand_memberships(brand_id text FK ON DELETE CASCADE, user_id
  uuid, role in owner/admin/member/viewer)`, `auth.uid()` present (as in H2's 2026-10-03 read-back).
- Which other migrations are pending. This plan applies only these two versions. Other pending files
  (for example G4's `20261003090000_*`, which sorts before `20261003120000`) must be coordinated
  first, or a later `db push` will see out-of-order history.

## Apply (one session, one transaction)

From the repository root at the reviewed commit, as the preflight role:

```
psql "<production database URL, supplied by the operator>" \
  --single-transaction -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260922045046_social_mobile_content_settings_candidate.sql \
  -f supabase/migrations/20261003120000_social_mobile_content_settings_hardening.sql \
  -c "insert into supabase_migrations.schema_migrations (version, name) values
        ('20260922045046', 'social_mobile_content_settings_candidate'),
        ('20261003120000', 'social_mobile_content_settings_hardening')"
```

- `--single-transaction` wraps all three in one `BEGIN … COMMIT`; `ON_ERROR_STOP=1` turns any error
  into a rollback of everything.
- The history insert records the same versions `migration repair --status applied` would, but inside
  the same transaction as the schema it describes, so history and schema cannot disagree.
- Neither file contains its own `BEGIN`/`COMMIT` or non-transactional statements.

## Read-back (read-only, immediately after COMMIT)

- Both history versions present; table present; RLS on; exactly the three owner policies.
- Effective table privileges: only `authenticated` SELECT/INSERT/UPDATE; nothing for PUBLIC, `anon`,
  `service_role`; no column ACL.
- Exactly five `social_mobile_content_settings_%` functions owned by the table owner; EXECUTE only for
  `authenticated` on the four validators; nobody on `social_mobile_content_settings_version()`.
- Constraints: PK (immediate, btree), FK to brands ON DELETE CASCADE, the settings/persona contracts,
  provenance, analyzed-count and finite-version CHECKs; one trigger
  `social_mobile_content_settings_version`.
- (The hardening file already asserts the ACL/function/trigger/policy part as post-conditions; the
  read-back confirms the committed state from a separate session.)

## If read-back fails

The table is new and empty at that point. Removing it (table, the five functions, the two history rows)
is a separate, explicitly approved transaction — never an improvised repair.
