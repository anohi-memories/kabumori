# Supabase Data API: explicit grants from 2026-10-30 — the shared rule (canonical candidate, G5)

Status: **policy + read-only inventory + local PG17 proofs.** No product SQL, migration, grant, RLS, Auth or managed setting is changed by this
document or its PR. Production stays **NO_GO**; any owner's fix is that owner's separate TASK (isolated SQL, PG17, Codex Sol (high)), and applying it
needs the user's explicit approval.

- TASK `common-account-g5-supabase-data-api-20261030-explicit-grants-impact-audit-20261021` (Issue #320, G5-01 generation, task 12, completion K5).
- Directive `SUPABASE-DATA-API-20261030-CROSS-SLOT` (Issue #320 comment 6303406473; the same directive on #318 / #319 / #321): G5 keeps the common rule
  and integrates the owners' impact lists; first lists due **2026-10-27**, the change lands **2026-10-30**.
- Source: Supabase changelog 45329, "Breaking change: tables not exposed to Data and GraphQL API automatically" (read 2026-10-21) [O].
- Stacked on PR #413 (G5-11). New G5-owned files only: this document, `supabase/tests/common_account_data_api_grants_{scan.py,scan_test.py,audit.sql,pg_run.sh,pg_test.ts}`
  and `supabase/preflight/managed_disposable/g5_12_data_api_grants_doc_test.ts`.

Evidence labels: **[O]** the official changelog; **[M]** `origin/main` `0c42933c` (text scan); **[C]** a candidate in the G5 Draft-PR stack; **[D]** derived
by a local PG17 test of this task; **[U]** NOT_VERIFIED.

## 1. What changes on 2026-10-30 [O]

| Item | Fact |
| --- | --- |
| Existing projects | From 2026-10-30, the default privileges of role `postgres` in schema `public` stop granting **tables** (`select, insert, update, delete`) and **sequences** (`usage, select`) to `anon`, `authenticated`, `service_role`. |
| Existing tables | Keep their grants and stay reachable. |
| Other schemas | `storage`, `auth`, `realtime` and custom schemas are not changed. |
| Functions, views | Not documented as part of the change (functions keep their EXECUTE defaults). |
| Creation path | Applies however the table is made (SQL editor, migrations, CLI, Management API, AI tools); the changelog recommends the GRANT next to RLS and policies in the same migration. |
| Error | A missing grant answers `42501` "permission denied for table". |
| GraphQL | The same: a table without grants is not reachable through `/graphql/v1`. |
| Direct Postgres connections | Not affected. |
| db reset, preview branches, local CLI | Not addressed by the changelog [U]; this document assumes a rebuild after 2026-10-30 behaves like a new table. |

## 2. The rule (applies to every owner)

| # | Rule |
| --- | --- |
| R-1 | **Default deny.** A new object in `public` is reachable by an API role only because its own migration says so. |
| R-2 | **One migration:** `create table` + `enable row level security` + the policies + `revoke all ... from public, anon, authenticated, service_role` + the minimal grants, together. A db reset or preview branch then rebuilds the same privileges before and after the change [D: the standard pattern is identical in both worlds]. |
| R-3 | **Revoke, then grant.** The explicit revoke makes the ACL independent of whatever the defaults are on that day [D: every G5 relation is identical in both worlds]. |
| R-4 | **anon: nothing**, unless a reviewed public-read decision exists; then SELECT only, with an RLS policy `to anon` and column limits. |
| R-5 | **authenticated: the minimum.** Per command, column-level where the row holds anything the person must not read or write; a policy for each granted command; never the changelog's bulk `select, insert, update, delete` by habit. |
| R-6 | **service_role: no table grant for server-only tables.** service_role bypasses RLS, so a grant is full access. Server work goes through reviewed SECURITY DEFINER functions with an explicit EXECUTE (the G5 pattern); a direct grant only when an Edge truly needs the table, minimal. |
| R-7 | **Never** `TRUNCATE`, `TRIGGER` or `REFERENCES` to an API role (PR #303: TRIGGER on a membership table is an owner-epoch bypass). |
| R-8 | **GRANT and RLS are independent and both required** for a person-facing table: RLS without a grant is `42501`; a grant without RLS is every row [D]. |
| R-9 | **Sequences:** prefer `generated ... as identity` (no sequence grant needed); a `serial` key needs `usage` on its sequence for an API insert [D]. |
| R-10 | **Server-only objects stay unexposed**: a non-exposed schema (`private`) and no API grant. Do not add grants to silence a `42501`; the changelog's example SQL granting all three roles is **forbidden** as a template here. |
| R-11 | **Functions are outside the change**: the `public` EXECUTE defaults remain, so every function keeps `revoke all ... from public, anon, authenticated, service_role` + an explicit EXECUTE for the one role that needs it; SECURITY DEFINER with an empty `search_path`. |
| R-12 | **Views run as their owner** (RLS of the base tables does not apply) unless `security_invoker = true`: no API grant on a view without it or an explicit review. |
| R-13 | **Common identity, entitlements, future Miseiro:** `public.common_accounts` / `public.service_entitlements` stay own-row, column SELECT for `authenticated`, no API write; every app (POSTONA, Kabumori, a future Miseiro) reads them through the same RLS and writes through the G5 RPCs. A new app is a new `service_key` behind an RPC, never a new table grant to `anon` or `service_role`. |
| R-14 | **Verify locally:** rebuild from migrations; run `supabase/tests/common_account_data_api_grants_audit.sql` (read-only); test anon, authenticated, another person, service_role, a missing grant refused, an excess grant flagged. |

## 3. G5's own objects — no impact

| Object | Schema / path | Roles needed | Grants (migration) | RLS / policies | Sequence | Created in |
| --- | --- | --- | --- | --- | --- | --- |
| `common_accounts` | public; Data API own-row read | authenticated SELECT (5 columns) | revoke all from public / anon / authenticated / service_role; `grant select (user_id, status, lifecycle_version, created_at, updated_at) to authenticated` | on; `common_accounts_select_own` | none (uuid key) | `20261001150000` [M] |
| `service_entitlements` | public; Data API own-row read | authenticated SELECT (6 columns) | revoke all ...; `grant select (user_id, service_key, status, activated_at, ended_at, updated_at) to authenticated` | on; `service_entitlements_select_own` | none | `20261001150000` [M] |
| `account_lifecycle_operations`, `_settings`, `_managed_checkpoints` | private; server-only | none (definer functions) | revoke all ... | on; none | none | `20261001150000` [M] |
| `account_lifecycle_release_gates` | private; server-only | none | revoke all ... | on; none | none | `20261009120000` [C] |
| `account_lifecycle_backfill_plan` (view) | private; server-only | none | revoke all ... | — | — | `20261001150000` [M] |
| `account_lifecycle_brand_owner_epochs` | private; server-only | none | revoke all ... | on; none | none | owner-epoch candidate (PR #303) [C] |
| functions (lifecycle RPCs, P3b / P5 / P9, R0 / R1 / W1 / W2 / GC / session verdict) | public + private | one role each (authenticated or service_role), or owner-only | revoke all + one explicit EXECUTE (or none) | — | — | the chain + candidates 001 / 002 / 003 [M] [C] |

Proof [D]: the same chain and candidates built twice — with the pre-change defaults and with the 2026-10-30 defaults — give an **identical** fingerprint
of every G5 relation, column grant, policy and function ACL; anon and service_role are denied both public tables in both worlds, authenticated sees
only its own row and only the granted columns, nobody writes; the audit flags the two tables only `REVIEW` (authenticated, SELECT, RLS on). G5 needs
**no change** for 2026-10-30, and new G5 objects keep R-2 / R-3. The migration-applied state of the chain in production is [U].

## 4. Leads for other owners (a text scan of `origin/main` and the test world — leads, not findings)

`python3 -B supabase/tests/common_account_data_api_grants_scan.py supabase/migrations` over main's 117 migrations [M]: 89 public objects created; 88 are
named by some GRANT / REVOKE in a migration; the remaining one was dropped by the next migration; 6 use identity keys, none `serial`; no schema-wide
grant or default-privilege statement.

| Lead | Where | Owner to confirm |
| --- | --- | --- |
| `us_premarkarket_report_settings` (sic) was created with no GRANT / REVOKE / RLS — **closed**: `20260830022321` drops it first thing and creates the correctly spelled table with explicit grants | `20260830022244` -> `20260830022321` | none (informational) |
| `public.brands` and `public.social_accounts` are **not created by any migration** on main: a db reset or preview branch cannot rebuild them, before or after 2026-10-30 | the base schema predates the migrations | POSTONA (G3 / G4 to agree the owner) |
| GRANTs inside dollar-quoted bodies (not parsed) | `20261007120000_market_report_generation_traces.sql`, `20261010050613_ai_provider_budget_ledger.sql` (schema `ai_ledger`, outside the change unless exposed) | Kabumori report owner; G6 |
| "Named by a GRANT / REVOKE" is not "minimal": a migration that grants without first revoking keeps whatever the defaults added | every owner | run the audit (R-14) on a local rebuild |
| In the PG17 test world, `social_mobile_account_deletion_audit`'s identity sequence differs between the two worlds (no functional effect: identity inserts need no sequence grant); the other differing relations come from test fixtures only | `20260928160000` | the account-deletion owner (informational) |

## 5. Owners' impact lists (to integrate here)

| Owner | Directive received | Impact list on #320 | Status |
| --- | --- | --- | --- |
| G5 | #320 6303406473 | this document | **done** (no impact, section 3) |
| G3 | #318 6303404723 | not yet (as of 2026-10-21 JST) | **未回答 — due 2026-10-27** |
| G4 | #319 6303405548 | not yet | **未回答 — due 2026-10-27** |
| G6 | #321 6303407251 | not yet | **未回答 — due 2026-10-27** |

When a list arrives, G5 adds only its confirmed rows here (object, schema, path, roles, grants, RLS, sequence, rebuild result, owner's proposed change
and its gate). Any change stays the owner's TASK; G5 does not rewrite another owner's TASK or SQL.

## 6. Gates and dates

| Date (JST) | Gate |
| --- | --- |
| 2026-10-27 | G3 / G4 / G6 send their first impact lists to #320 (directive). |
| after each list | G5 integrates confirmed rows; an owner's fix goes into that owner's own TASK with isolated SQL, PG17 / deny-net tests and a Codex Sol (high) review. |
| 2026-10-30 | The change lands. Existing tables keep their grants; new ones and rebuilds follow R-1..R-14. |
| any production apply | The user's explicit approval (migrations, grants, RLS, Auth). |

## 7. NOT_VERIFIED

The project's current default privileges and whether it opted in early; the Data API's exposed schemas and whether GraphQL is enabled; the
production ACLs of existing tables; which chain migrations are applied in production; how the CLI's local stack and preview branches behave after the
change; who created the base tables (`postgres` or another role — the change is documented for `postgres` only).

## 8. Tests and what was executed

All commands ran in `/Users/yuya/Developer/kabumori-g5-12` (a clean worktree stacked on PR #413) against a throw-away local PostgreSQL 17.11
(`listen_addresses` empty, a Unix socket under `/private/tmp`, fake data, deleted at the end). No managed system, credential or network request.

| # | Check | Result |
| --- | --- | --- |
| 1 | `CAL_PGHOST=… CAL_PGPORT=… CAL_PGSUPER=… bash supabase/tests/common_account_data_api_grants_pg_run.sh` (two worlds: before / after) | **6 tests** passed, 0 failed (three consecutive runs) |
| 2 | `python3 -B supabase/tests/common_account_data_api_grants_scan.py <main's supabase/migrations>` and its offline test `common_account_data_api_grants_scan_test.py` | 89 public objects; 88 named by a GRANT / REVOKE; 1 dropped by the next migration; 0 implicit; 6 identity, 0 serial; 0 schema-wide; 2 files with dynamic GRANTs. The scanner's offline test: `SCAN_TEST_PASS 9 checks` |
| 3 | regression: the G5 PG17 suites (session verdict, R0, R1, G5-01, G5-02, owner epoch) and the pure suites | PG17: session verdict 13, R0 13, R1 15, G5-01 10, G5-02 5, owner epoch 19 — all passed; pure 42 passed |
| 4 | the whole harness incl. the document tests | **238 passed**, 0 failed (233 of PR #413 + 5 new) |
| 5 | type-check, lint, shell, whitespace; no product SQL or migration changed | `deno check --no-config`: no error; `deno lint --no-config`: `Checked 59 files`, no problem; `bash -n`, the Python files parse, `git diff --check`: clean; `supabase/migrations` and `supabase/candidates`: unchanged |
