# Supabase Data API: explicit grants from 2026-10-30 — the shared rule (canonical candidate, G5)

Status: **policy + read-only inventory + local PG17 proofs.** No product SQL, migration, grant, RLS, Auth or managed setting is changed by this
document or its PR. Production stays **NO_GO**; any owner's fix is that owner's separate TASK (isolated SQL, PG17, Codex Sol (high)), and applying it
needs the user's explicit approval.

- TASK `common-account-g5-supabase-data-api-20261030-explicit-grants-impact-audit-20261021` (Issue #320, G5-01 generation, task 12, completion K5).
- Directive `SUPABASE-DATA-API-20261030-CROSS-SLOT` (Issue #320 comment 6303406473; the same directive on #318 / #319 / #321): G5 keeps the common rule
  and integrates the owners' impact lists; first lists due **2026-10-27**, the change lands **2026-10-30**.
- Source: Supabase changelog 45329, "Breaking change: tables not exposed to Data and GraphQL API automatically" (read 2026-10-21) [O].
- **G5-13 update** (task `common-account-g5-data-api-cross-slot-inventory-integration-20261021`, Issue #320 task 13): section 4 now separates confirmed
  facts from estimates, sections 9-11 hold the integration log, the owners' next-TASK proposals and a dated risk report draft; the scanner gained the
  "created by no migration" list and no longer mistakes `grant option` text for a GRANT.
- **G5-14 update** (task `common-account-g5-postona-base-tables-rebuild-risk-readonly-evidence-20261021`, Issue #320 task 14): section 12 holds the
  evidence on the four POSTONA base tables (provenance, dependants, the shape each rebuild must reproduce, an owner decision table, apply order and
  conflicts, minimal follow-up TASKs) with two new read-only tools and an empty-database PG17 proof.
- **G5-15 update** (task `common-account-g5-data-api-g4-impact-integration-owner-boundaries-20261021`, Issue #320 task 15): section 13 integrates
  G4's impact list (Issue #320 comment 6317104735, G4 Draft PR #420) — G4's proven facts, measurements, hypotheses and owner proposals kept apart — with
  G5's own read-only checks; the object set grows to `brand_settings`, `daily_content_plans` and `brand_id` on four operational tables.
- **G5-16 update** (task `common-account-g5-data-api-owner-inventory-d2-readonly-gate-20261022`, Issue #320 task 16): section 14 records the owners'
  status on 2026-10-22 (G3 / G6 have **no assigned inventory TASK**), proves D-2 on PG17 with the `20261007150000` ACL precondition taken verbatim,
  and lays out D-2's options, migration order and denial tests for G4.
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

## 4. Leads for other owners — CONFIRMED vs ESTIMATED (G5-13 integration, 2026-10-21 JST)

`python3 -B supabase/tests/common_account_data_api_grants_scan.py supabase/migrations` over main's 117 migrations [M] (scanner as of G5-13): 89 public
objects created; 88 named by some GRANT / REVOKE; 1 dropped by the next migration; 0 implicit; 6 identity keys, 0 `serial`; 0 schema-wide grant or
default-privilege statement; **0** files with a GRANT inside a function / DO body (the two G5-12 hits were `grant option` text in postcondition checks);
**5** public objects changed / granted / referenced by a migration but created by none.

### 4.1 Confirmed (read from the migration text on main)

| # | Fact | Where | 2026-10-30 impact | Owner / action |
| --- | --- | --- | --- | --- |
| C-1 | `public.market_report_generation_traces`: RLS on, `revoke all ... from public, anon, authenticated, service_role`, `grant select, insert ... to service_role`; the "dynamic" text is its own ACL postcondition, not a GRANT | `20261007120000` | **none** (explicit) | Kabumori report owner — no action for 10/30 |
| C-2 | schema `ai_ledger`: `revoke all on schema` and on all tables / sequences / functions from public and the three API roles; the seven public RPCs EXECUTE for `service_role` only | `20261010050613` | **none** (not public; without schema USAGE no API role reaches it, exposed or not) | G6 — no action for 10/30 |
| C-3 | `public.ai_lab_topic_claims` is created by dynamic SQL (`format('create table %1$I.ai_lab_topic_claims ...')`) inside the migration, then `revoke all on table public.ai_lab_topic_claims from public, anon, authenticated, service_role` | `20261004090000` (+ `20261007173000`) | **none** (explicit, rebuilt by its migration) | AI Lab owner — informational |
| C-4 | `us_premarkarket_report_settings` (sic) had no grant / RLS but is dropped by the next migration | `20260830022244` -> `20260830022321` | none | closed |
| C-5 | **Four POSTONA base tables are created by NO migration**: `public.brands`, `public.social_accounts`, `public.social_account_oauth_states`, `public.published_content_fingerprints` (they exist only in the remote base schema and in test fixtures). Migrations only add columns, constraints, `grant select ... to authenticated`, `revoke select ... from anon` and policies | first touched in `20260918120000`, `20260919120000`, `20260928160000` | not caused by 10/30, but **a db reset / preview branch cannot rebuild them, before or after** | **G3 / G4** (owners to agree) — needs a decision and an owner TASK (section 10) |
| C-6 | Three public views `v_mic_latest_metric_changes`, `v_mic_metric_observation_status`, `v_mic_source_fetch_status` carry explicit grants | `20260913090000` | none (views are outside the change) | MIC owner — R-12 review (security_invoker) informational |
| C-7 | Every G5 object | section 3 | none ([D] identical before / after) | G5 — done |

### 4.2 Estimated or NOT_VERIFIED (not facts; each needs the owner's or a read-only production check)

| # | Estimate | Why it is only an estimate | How to settle it |
| --- | --- | --- | --- |
| E-1 | The four base tables of C-5 probably still carry the **pre-change default ALL** for `anon` / `authenticated` / `service_role` (incl. `TRUNCATE` / `TRIGGER` / `REFERENCES`, which RLS does not stop), minus `anon` SELECT that `20260918120000` revoked | they were created outside migrations, by an unknown role, at an unknown time; no migration revokes the defaults | the read-only audit SQL on production (needs the user's approval for a read-only connection) |
| E-2 | RLS is enabled on `public.brands` in production | `20260918120000` creates a policy on it but no migration enables RLS on `brands`; the test world has it off | the same audit (`rls` column) |
| E-3 | Which schemas the Data API exposes, and whether GraphQL is enabled | no `supabase/config.toml` on main; managed settings are not readable from the repository | the project's API settings (owner / user) |
| E-4 | How preview branches and the CLI's local stack behave after 10/30 | the changelog does not say | observe on a disposable branch after 10/30 (user approval) |
| E-5 | The G3 / G4 / G6 impact | no list has arrived | their lists (due 2026-10-27) |

## 5. Owners' impact lists (to integrate here)

| Owner | Directive received | G5 notice (once each) | Impact list on #320 | Status (2026-10-21 JST) |
| --- | --- | --- | --- | --- |
| G5 | #320 6303406473 | — | this document | **done** (no impact, section 3) |
| G3 | #318 6303404723 | #318 6315180962 (+ the G5-13 difference, section 9) | not yet; **no inventory TASK assigned to this owner yet** (section 14.1) | **未回答 — due 2026-10-27** |
| G4 | #319 6303405548 | #319 6315181585 (+ the G5-13 difference, section 9) | **received** 2026-10-21 JST: #320 6317104735 (G4-17, Draft PR #420); integrated in section 13 | **received** (owner proposals pending G3) |
| G6 | #321 6303407251 | #321 6315182189 (+ the G5-13 closure of C-2, section 9) | not yet; **no inventory TASK assigned to this owner yet** (section 14.1) | **未回答 — due 2026-10-27** |
| Kabumori report / AI Lab / MIC owners | (not named in the directive) | — | — | C-1 / C-3 / C-6: no 10/30 action; the 担当ちゃ decides whether a list is needed |

When a list arrives, G5 adds only its confirmed rows here (object, schema, path, roles, grants, RLS, sequence, rebuild result, owner's proposed change
and its gate). Any change stays the owner's TASK; G5 does not rewrite another owner's TASK or SQL, and does not fill in an answer that has not arrived.

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

## 8. Tests and what was executed (the G5-12 run; G5-13's checks are in section 9)

All commands ran in `/Users/yuya/Developer/kabumori-g5-12` (a clean worktree stacked on PR #413) against a throw-away local PostgreSQL 17.11
(`listen_addresses` empty, a Unix socket under `/private/tmp`, fake data, deleted at the end). No managed system, credential or network request.

| # | Check | Result |
| --- | --- | --- |
| 1 | `CAL_PGHOST=… CAL_PGPORT=… CAL_PGSUPER=… bash supabase/tests/common_account_data_api_grants_pg_run.sh` (two worlds: before / after) | **6 tests** passed, 0 failed (three consecutive runs) |
| 2 | `python3 -B supabase/tests/common_account_data_api_grants_scan.py <main's supabase/migrations>` and its offline test `common_account_data_api_grants_scan_test.py` | 89 public objects; 88 named by a GRANT / REVOKE; 1 dropped by the next migration; 0 implicit; 6 identity, 0 serial; 0 schema-wide; 2 files with dynamic GRANTs. The scanner's offline test: `SCAN_TEST_PASS 9 checks` |
| 3 | regression: the G5 PG17 suites (session verdict, R0, R1, G5-01, G5-02, owner epoch) and the pure suites | PG17: session verdict 13, R0 13, R1 15, G5-01 10, G5-02 5, owner epoch 19 — all passed; pure 42 passed |
| 4 | the whole harness incl. the document tests | **238 passed**, 0 failed (233 of PR #413 + 5 new) |
| 5 | type-check, lint, shell, whitespace; no product SQL or migration changed | `deno check --no-config`: no error; `deno lint --no-config`: `Checked 59 files`, no problem; `bash -n`, the Python files parse, `git diff --check`: clean; `supabase/migrations` and `supabase/candidates`: unchanged |

## 9. G5-13 integration log (2026-10-21 JST)

| Step | Result |
| --- | --- |
| Owners' lists | Issues #320 / #318 / #319 / #321 read after the G5-12 REPORT: **no impact list from G3, G4 or G6 yet** (only G5's notices). Nothing is filled in for them. |
| G5-12 leads | the two "dynamic GRANT" files: confirmed explicit, no 10/30 impact (C-1, C-2); the base-table lead widened from two to **four** tables (C-5); `ai_lab_topic_claims` confirmed explicit (C-3) |
| Notices | one difference notice each to G3 / G4 (C-5's two added tables) and G6 (C-2 closed: no action for 10/30); no reminder of the 10/27 date beyond that |
| Scanner | `grant option` text no longer counts as a GRANT; a new list of public objects that migrations touch but none creates (offline test: 10 checks) |
| Tests | the scanner's offline test `SCAN_TEST_PASS 10 checks`; the Data API PG17 suite 6 passed (one run, unchanged code); pure 42 passed; the whole harness **244 passed** (238 of PR #415 + 6 new); `deno check` / `deno lint` / `git diff --check` clean; `supabase/migrations` and `supabase/candidates` unchanged |

## 10. Next-TASK proposals per owner (proposals only; no owner's TASK is changed)

| Owner | Proposal | Paths (theirs) | Depends on | Review / approval |
| --- | --- | --- | --- | --- |
| G3 / G4 (POSTONA) | 1. Agree who owns `brands`, `social_accounts`, `social_account_oauth_states`, `published_content_fingerprints`. 2. A read-only audit of their production ACL / RLS (E-1, E-2). 3. A migration candidate that makes them rebuildable (create if not exists, RLS, policies, `revoke all`, minimal grants — R-2 / R-3), proven on a disposable PG17 from an empty database and on a copy of the current shape; no anon; no `TRUNCATE` / `TRIGGER` / `REFERENCES`. | their `supabase/candidates/<owner>/` and docs | R-1..R-14; PR #303's revoke on `brand_memberships`; the users' approval for any production read | Codex Sol (high) for the SQL / RLS; the user's explicit approval for production |
| G6 | None for 10/30 (C-2). Optional: confirm the exposed schemas (E-3). | — | — | — |
| Kabumori report / AI Lab / MIC owners | None for 10/30 (C-1, C-3). MIC: an R-12 review of the three public views (security_invoker or a recorded reason). | their migrations / docs | R-12 | per change |
| G5 | Integrate the lists that arrive; recheck the issues on 2026-10-27 JST; keep the tools current. | this document, `supabase/tests/common_account_data_api_grants_*` | the owners' lists | 担当ちゃ |

## 11. Risk report draft for the 総合指令 (to be sent by the 担当ちゃ if the lists are late)

> **Supabase Data API 2026-10-30 — status as of 2026-10-21 JST (draft by G5).** G5: no impact (proven). G3 / G4 / G6: impact lists not yet received
> (due **2026-10-27**). Confirmed cross-slot facts: four POSTONA base tables (`brands`, `social_accounts`, `social_account_oauth_states`,
> `published_content_fingerprints`) are created by no migration, so a reset / preview cannot rebuild them — a pre-existing gap, not caused by 10/30;
> their production ACL may still carry the old default ALL (NOT_VERIFIED). Risk if a list arrives after 10/27: three days remain for an owner SQL
> candidate, PG17 proof and Sol review before 10/30. What 10/30 itself breaks: only **new** public tables / sequences created without explicit grants
> (they answer 42501 — fail closed, an availability issue, not a leak). Asks: (1) G3 / G4 / G6 lists by 10/27; (2) G3 / G4 agree the owner of the
> base tables; (3) the user decides whether to allow a read-only production ACL audit; (4) no new public table ships before 10/30 without R-2.

## 12. The four POSTONA base tables — evidence for the owners' decision (G5-14, 2026-10-21 JST)

Scope: `public.brands`, `public.social_accounts`, `public.social_account_oauth_states`, `public.published_content_fingerprints`. Evidence only; no
owner is decided here, no DDL / grant is written, and nothing below is a statement about production unless labelled.

### 12.1 Provenance (confirmed)

| Fact | Evidence |
| --- | --- |
| No migration on main creates any of the four tables | [D] a file read of every migration (`common_account_base_tables_pg_test.ts`); the reference extractor finds CREATEs only in test fixtures |
| Main's migrations depend on them: on an EMPTY database each refuses and leaves nothing | [D] PG17: `20260918120000` -> `PHASE4_PREFLIGHT_MISSING_TABLE:brands`; `20260919120000` and `20261007150000` -> `relation "public.social_accounts" does not exist`; `20260928160000` -> `SOCIAL_MOBILE_DELETION_PREREQUISITE_MISSING` and `20261006160000` -> `STAGE3B_PRECONDITION_MISSING` (both stop on an EARLIER prerequisite, recorded as such) |
| They predate the migrations | [M] `20260918120000`'s header: it "targets the production schema confirmed in the Phase 3 inventory"; it keeps "existing admin policies intact" (a comment, not a catalog fact) |
| G5's own chain depends on them | [M] `20261001150000` requires `brands.id` / `brands.code_profile_key` (text), `social_accounts.brand_id` / `connection_status`, `social_account_oauth_states.brand_id` (text) / `initiated_by_user_id` (uuid), and the FKs `social_accounts.brand_id -> brands` (no action), `social_account_oauth_states.brand_id -> brands` (no action), `social_account_oauth_states.initiated_by_user_id -> auth.users` (cascade) |
| The test fixtures disagree on the shapes | [M] `brands`: from `(id)` only to 7 columns; `social_account_oauth_states`: one fixture lacks `initiated_by_user_id`; `published_content_fingerprints`: one fixture adds `x_post_id` |

### 12.2 Who reads and writes them (confirmed, `common_account_base_tables_refs.py` over main)

| Table | Migrations (files) | Data API as `authenticated` (product code) | Data API as `service_role` (product code) | Structural hooks in migrations |
| --- | --- | --- | --- | --- |
| `brands` | 11 | app `supabase-repository.ts` (`id, display_name, is_active, publish_mode`); Edge `social-mobile-history-learning/live_dependencies.ts` (`id`, with the caller's token) | Edge `_shared/brand/brand_context.ts` (REST, service key) | member SELECT policy + authenticated SELECT + anon SELECT revoked (`20260918120000`); `social_mobile_deletion_guard` trigger (`20260928160000`); FKs from `brand_memberships`, `social_accounts`, `social_account_oauth_states`, content settings |
| `social_accounts` | 16 | app `supabase-repository.ts`, `onboarding-repository.ts` (`id, brand_id, platform, handle, connection_status, last_connection_error_code`); Edge `live_dependencies.ts` (caller's token) | Edge `brand_context.ts`, `ai_lab_vault_token_source.ts` (REST, service key) | the full contract of `20261007150000` (12.3); member SELECT policy; two triggers; columns / constraints / indexes added by `20260924023133`, `20261007150000` |
| `social_account_oauth_states` | 4 | none | none (SQL functions only) | FK / alter in `20260919120000`; deletion guard trigger; read / write by the OAuth RPCs |
| `published_content_fingerprints` | 2 | none | Edge `_shared/brand/ai_lab_brand_post_store.ts` (REST, service key) | deletion guard trigger; written by `20261006160000` (scheduled posting) |

Consequence for a rebuild (R-5 / R-6): `authenticated` needs SELECT on `brands` / `social_accounts` (with the member policies), and `service_role`
needs SELECT on `brands`, `social_accounts`, `published_content_fingerprints` for the three Edge readers above — each explicit and minimal. Test files
that mock `/rest/v1/...` and one false positive (the English word in `company_alias_test.ts`) are not product paths.

### 12.3 The shape a rebuild must reproduce

| Table | Known exactly | Known in part | Unknown [U] |
| --- | --- | --- | --- |
| `social_accounts` | **the `20261007150000` precondition is a complete contract**: 14 columns (`brand_id`, `connection_status`, `created_at`, `handle`, `id`, `last_connection_error_code`, `oauth_client_ref`, `platform`, `platform_user_id`, `publish_enabled`, `updated_at`, `vault_access_token_secret_id`, `vault_refresh_token_secret_id`, `verified_at` with types, defaults and nullability), 6 constraints, 3 indexes, RLS on and not forced, exactly the member SELECT policy, two triggers, table ACL = owner + `authenticated` SELECT + `service_role` at most DML / TRUNCATE / REFERENCES / MAINTAIN, nothing for PUBLIC / anon, no column ACL | — | whether `20261007150000` is applied in production (if it is, its preconditions held there) |
| `brands` | — | `id` text (PK; FKs point to it), `code_profile_key` text; the app reads `display_name`, `is_active`, `publish_mode`; member SELECT policy; authenticated SELECT; anon SELECT revoked; deletion guard trigger | the full column list, constraints, RLS flag (no migration enables it), the "admin policies", the full ACL |
| `social_account_oauth_states` | — | `brand_id` text (FK -> brands, no action), `initiated_by_user_id` uuid (FK -> auth.users, cascade); the fixture's other columns; deletion guard trigger | RLS, ACL, constraints, indexes |
| `published_content_fingerprints` | — | the fixtures' columns (`id`, `brand_id`, `social_account_id`, `post_type`, `normalized_text_sha256`, `published_at`, maybe `x_post_id`); deletion guard trigger | RLS, ACL, indexes, key type |

Review point for whoever owns `social_accounts` (R-5): the contract grants `authenticated` SELECT on the whole row, so a member can read
`vault_*_secret_id` (Vault references, not secrets); the app does not read those columns, so a column-level grant is possible.

### 12.4 Owner decision table (evidence only; G3 / G4 decide; G5 is a dependant)

| Table | Functional boundary (from the code) | Evidence points to | Open questions |
| --- | --- | --- | --- |
| `social_accounts` | OAuth connection, credentials (Vault ids), multi-provider contract; read by publishing and by G5 | **G4** (connection / credential; `20261007150000`'s contract; G4-17 already scopes it) | does G3 need write paths beyond publish flags? |
| `social_account_oauth_states` | the OAuth state of a connection | **G4** | — |
| `published_content_fingerprints` | publishing dedupe (written by scheduled posting) | **G3** (publishing) | the exact shape (`x_post_id`?) |
| `brands` | the workspace root: rows created by the X OAuth begin flow (`20260919120000`), publish mode / settings read by publishing (`20261003090000`, `20261006160100`), the workspace kind / owner read by G5 (`20261001150000`, the owner epoch) | **shared**: one DDL owner is needed; G4 (creates the rows) or G3 (publish settings) | who owns the DDL; G5 must be consulted on any change to `id` / `code_profile_key` / FKs (common-account invariants) |

### 12.5 Apply order and conflicts (for the owner TASK)

- A fresh reset needs the four tables **before** `20260918120000` (their first dependant), i.e. a migration with an earlier timestamp than files
  production has already applied — an out-of-order entry in the migration history. That needs a decision with the user (a repair of the history, or a
  bootstrap file for local / preview only that production never runs). [U] how the managed history would react.
- On production the tables exist: the file must be a strict no-op there (a `20261007150000`-style precondition that stops on any unknown shape), never
  a silent normalization of grants or policies.
- Order inside the file: `brands` first; then the tables that reference it; FKs, indexes, RLS + policies, `revoke all` then minimal grants (R-2 / R-3),
  no anon, no TRUNCATE / TRIGGER / REFERENCES to API roles; the deletion guard triggers come later (`20260928160000`) and must not be duplicated.
- Proof: from an empty database, every main migration then applies, `20261007150000`'s precondition passes on the rebuilt `social_accounts`, and the
  G5 runners no longer need fixtures for these four tables.

### 12.6 Minimal follow-up TASKs (proposals; no owner TASK is changed)

| # | Owner | Scope | Gate |
| --- | --- | --- | --- |
| 1 | G4 (G4-17, in progress) | owner proposal for `social_accounts` / `social_account_oauth_states` in its 10/27 list; `20261007150000` as the `social_accounts` spec | 担当ちゃ |
| 2 | G3 | owner proposal and shape for `published_content_fingerprints` in its 10/27 list | 担当ちゃ |
| 3 | G3 + G4 | agree the DDL owner of `brands` (G5 consulted) | 担当ちゃ |
| 4 | the agreed owner | an isolated base-tables migration candidate + PG17 from an empty database + the `20261007150000` precondition + a migration-history plan | Codex Sol (high); the user's approval for the history decision and for production |
| 5 | user | whether to allow a read-only production audit of the four tables (ACL / RLS / columns) | explicit approval |

### 12.7 The link to 2026-10-30 (stated honestly)

The 10/30 change does not touch these existing tables. The risk is pre-existing: a reset / preview cannot rebuild them, and their production ACL / RLS is
known only for `social_accounts` (and only if `20261007150000` is applied). If the rebuild migration is written after 10/30, its grants must be explicit
(R-2) or the app's and `social-mobile-history-learning`'s Data API reads of `brands` / `social_accounts` would answer 42501 on a rebuilt database.

| Check (G5-14) | Result |
| --- | --- |
| `common_account_base_tables_refs.py` over main + its offline test | brands 180 / social_accounts 379 / oauth_states 36 / fingerprints 19 references; created only in test fixtures; offline test `REFS_TEST_PASS 9 checks` |
| `common_account_base_tables_pg_run.sh` (empty database, PG17) | 3 tests passed, 0 failed (three consecutive runs); nothing left behind |
| regression + harness + checks | Data API PG17 6 passed; scanner test 10 checks; pure 42 passed; the whole harness **250 passed** (244 of PR #417 + 6 new); `deno check` / `deno lint` / `bash -n` / `git diff --check` clean; `supabase/migrations` and `supabase/candidates` unchanged |

## 13. G4's impact list, integrated (G5-15, 2026-10-22 JST)

Source: G4's `IMPACT_LIST` (Issue #320 comment 6317104735, task `postona-g4-data-api-20261030-social-account-schema-acl-impact-20261021`, G4 Draft PR #420
`docs/postona/data-api-20261030-g4-impact-20261021.md`, head `8bca839a8aae50169c72eb43393497e38740fd90`). G5 does not change G4's list; each row says what
G4 states and what G5 re-checked. G3 and G6 lists: **未着** (due 2026-10-27); G4 sent G3 one ownership note (#318 6317113668).

### 13.1 G4's statements, kept apart

| # | G4 states (its label) | G5 re-check |
| --- | --- | --- |
| G4-F1 | the four base tables are created by no migration (proven) | **confirmed** (section 12.1) |
| G4-F2 | on an empty database `20260918120000` stops with `PHASE4_PREFLIGHT_MISSING_TABLE:brands` (PG17) | **confirmed** [D] |
| G4-F3 | `public.brand_settings` and `public.daily_content_plans` are created by no migration; `20261006160200:42` requires `brand_settings`; the Edge `brand_context.ts` reads it as service_role; `daily_content_plans` appears in comments of `20260928160000` | **confirmed**: no CREATE of either [D: file read]; `20261006160200` refuses without `brand_settings` (`STAGE3B_PUBLISH_PRECONDITION_MISSING`) [M]; `daily_content_plans` is only in comments (no code reads it) [M] |
| G4-F4 | `scheduled_posts`, `post_execution_logs`, `posting_windows` (`20260828203000`) and `publish_claims` (`20260903120000`) are created without `brand_id`; no migration adds it; later files rely on it | **confirmed** [D]: rebuilt in main's order (tips, scheduler, claims), none of the four has `brand_id`; with stand-ins for `brands` / `social_accounts`, `20260918120000` stops with `PHASE4_PREFLIGHT_MISSING_COLUMN:scheduled_posts.brand_id`, nothing left behind; no migration contains `add column brand_id` |
| G4-F5 | the Data API readers by role (app / user-token Edge as `authenticated`; brand-post / AI-lab Edge as `service_role`); `social_account_oauth_states` has no Data API reader | **consistent** with section 12.2 (G5 lists the same files) |
| G4-F6 | G4's own new candidate tables follow R-2 / R-3 / R-6 / R-11 (no impact) | not re-checked by G5 (G4's candidates) |
| G4-H1 | the production ACL / RLS of the four tables; no migration enables RLS on `brands` | hypothesis (= E-1 / E-2) |
| G4-H2 | `20261007150000:280-293` lets `service_role` hold TRUNCATE / REFERENCES / MAINTAIN on `social_accounts`, against R-7 | **confirmed in the text** [M] (the precondition **allows**, it does not require them) — see D-1 |
| G4-H3 | some main migrations call themselves candidates not applied in production | hypothesis; which are applied is [U] |
| G4-P | owner proposals (13.3) and a minimal-grant table for a rebuild (13.2 D-2) | proposals, pending G3 |

### 13.2 Dangerous ACL assumptions and ordering conflicts (G5's reading)

| # | Point | Evidence | Consequence for the owner TASK |
| --- | --- | --- | --- |
| D-1 | `service_role` may hold TRUNCATE / REFERENCES / MAINTAIN on `social_accounts` under the `20261007150000` precondition | `20261007150000:285-288` [M] | a rebuild must not grant them (R-7); the precondition still passes without them |
| D-2 | **G4's own minimal-grant proposal (column SELECT for `authenticated`, the Vault references and `oauth_client_ref` excluded) contradicts the `20261007150000` precondition**, which requires a table-level `authenticated` SELECT and **no column ACL** | `20261007150000:289-293` [M] (`POSTONA_ACCOUNTS_PRECONDITION_ACL`) | order matters: amend the 2a-2 contract (G4) **with** the rebuild, or the rebuilt table makes `20261007150000` refuse; decide whether 2a-2 is applied in production first [U] |
| D-3 | members can read `vault_access_token_secret_id` / `vault_refresh_token_secret_id` through the whole-row SELECT the contract requires | section 12.3 | the reason D-2's column grant is worth the contract change (R-5) |
| D-4 | the service-role REST readers must not become a reason for broad grants | G4-F5, section 12.2 | column-minimal SELECT per reader now; G4's own idea of SECURITY DEFINER readers later |
| D-5 | `create table if not exists` in `20260828203000` / `20260903120000` is a no-op where the tables pre-existed (production per `20260918120000:4`, "Phase 3 inventory") but creates a **different shape** on a rebuild | G4-F4 [D] | the rebuild must either add `brand_id` (and whatever else production has) before `20260918120000`, or reproduce the base schema first; the production shape is [U] |
| D-6 | the production migration history is unknown | G4-H3 | a rebuild plan needs it (out-of-order entries, section 12.5) |

### 13.3 The extended object set and the owner proposals (candidates only)

| Object | In migrations | Data API readers (product code) | Reset stops at | G4's proposal | G5 note | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `social_accounts` | never created | authenticated (app, user-token Edge); service_role (brand / AI-lab Edge) | `20260919120000`, `20261007150000` | **G4** | consistent with 12.4 | candidate — G3 to agree |
| `social_account_oauth_states` | never created | none | (needs `social_accounts` first) | **G4** | consistent | candidate — G3 to agree |
| `published_content_fingerprints` | never created | service_role (AI-lab Edge) | `20261006160000` (earlier prerequisite) | **G3** | consistent | candidate — **G3 has not answered** |
| `brands` | never created | authenticated + service_role | `20260918120000` | **G4 (tentative)**; follows G3 / G5 if they prefer | 12.4 said "shared"; G5 must be consulted on `id` / `code_profile_key` / FKs | **open** |
| `brand_settings` | never created | service_role (`brand_context.ts`) | `20261006160200` | UNKNOWN (posting side, maybe G3) | — | **open** |
| `daily_content_plans` | never created | none (comments only) | none observed | UNKNOWN | cascades from `brands` per the comments | **open** |
| `brand_id` on `scheduled_posts` / `post_execution_logs` / `posting_windows` / `publish_claims` | tables created without it; never added | authenticated reads `scheduled_posts` (app) | `20260918120000` (`MISSING_COLUMN:scheduled_posts.brand_id`) | UNKNOWN (posting side, maybe G3) | — | **open** |

### 13.4 Next-TASK proposals per source owner (proposals only; no owner TASK is changed)

| Owner | Proposal | Review / approval |
| --- | --- | --- |
| G4 | (a) settle D-2: amend the `20261007150000` contract so a column-level `authenticated` SELECT (no Vault references) and no TRUNCATE / REFERENCES / MAINTAIN for `service_role` are accepted; (b) after G3 agrees, a rebuild candidate for `social_accounts` / `social_account_oauth_states` | Codex Sol (high); PG17 from an empty database **and** from a copy of the current shape |
| G3 (after its 10/27 list) | ownership answers for `published_content_fingerprints`, `brand_settings`, `daily_content_plans`, the `brand_id` columns; a rebuild candidate for the agreed ones | Codex Sol (high); same two PG17 starting points |
| G3 + G4 (+ G5 consulted) | one DDL owner for `brands` | 担当ちゃ |
| user | a read-only production audit of these objects (ACL, RLS, columns, applied migrations) before any rebuild touches production | explicit approval |

Separate gates, unchanged: everything in sections 10 / 12.6; production stays **NO_GO**.

| Check (G5-15) | Result |
| --- | --- |
| `common_account_base_tables_pg_run.sh` (two empty databases, PG17) | **5 tests** passed, 0 failed (three consecutive runs; 3 of G5-14 + the `brand_id` proof + the `brand_settings` / `daily_content_plans` file read); nothing left behind |
| regression + harness + checks | Data API PG17 6 passed; scanner test 10 checks; refs test 9 checks; pure 42 passed; the whole harness **255 passed** (250 of PR #421 + 5 new); `deno check` / `deno lint` / `bash -n` / `git diff --check` clean; `supabase/migrations` and `supabase/candidates` unchanged |

## 14. Owner status, D-2 proven, and what each owner still owes (G5-16, 2026-10-22 JST)

### 14.1 Owner status

| Owner | Impact list | What the owner said most recently | Consequence |
| --- | --- | --- | --- |
| G4 | **received** (#320 6317104735; integrated in section 13 — not counted twice) | REPORT #319 6328444274 (G4-18): acknowledges D-2 ("the 2a-2 contract must be fixed together with a rebuild"); waits for G3 on ownership | D-2 is G4's to fix in its own TASK |
| G3 | **未回答** (due 2026-10-27) | REPORT #318 6328926559 (G3-18): the Data API coordination is **outside its current TASK; it waits for a separate assignment** | **no G3 inventory TASK exists** — the 担当ちゃ / 総合指令 must assign one for the 10/27 date |
| G6 | **未回答** (due 2026-10-27) | TASK #321 G6-15: the Data API work is "a distinct pending inventory task to G5, not bundled" into the current patch | **no G6 inventory TASK exists** — same; G5's C-2 already shows `ai_ledger` has no 10/30 impact, so G6's list can be short |
| G5 | done (no impact) | — | — |

G5 does not assign another slot's TASK; this row is the request to the 担当ちゃ.

### 14.2 D-2, proven on the SQL text (PG17)

`common_account_d2_column_acl_pg_test.ts` runs the **verbatim** ACL precondition of `20261007150000` (`:280-294`, `POSTONA_ACCOUNTS_PRECONDITION_ACL`)
against a stand-in `public.social_accounts` with the contract's 14 columns [D]:

| Layout | Precondition | `authenticated` can read |
| --- | --- | --- |
| the contract: table-level SELECT for `authenticated`; service_role SELECT / INSERT / UPDATE / DELETE | **accepted** | every column, **including `vault_access_token_secret_id`** (D-3) |
| G4's proposal: column SELECT for `authenticated` (8 columns, no Vault references, no `oauth_client_ref`); column SELECT for service_role (its readers' columns) | **refused** (`POSTONA_ACCOUNTS_PRECONDITION_ACL`) | the 8 columns; the Vault references, `oauth_client_ref` and `select *` are **denied**; **both of the app's real select lists still work**; service_role still reads the Vault reference |
| table SELECT for `authenticated` + service_role SELECT / TRUNCATE / REFERENCES | **accepted** — the contract allows what R-7 forbids (D-1) | every column |

And among main's migrations only `20261007150000` asserts a table / column ACL on `social_accounts` [D: file read], so the 2a-2 contract is the
**only** ordering dependency of a column-level change.

### 14.3 D-2: options and a proposal for G4's own TASK (not G5's decision; G4's current TASK G4-19 is not interrupted)

| Option | Effect | Cost |
| --- | --- | --- |
| A. keep the contract | members keep reading the Vault references (references, not secrets) | an R-5 exception to record and accept explicitly |
| **B. amend the contract** (G5's suggestion) | accept exactly the column-level SELECT for `authenticated`, forbid a table-level one; forbid TRUNCATE / REFERENCES / MAINTAIN for service_role (R-7) | a reviewed change of G4's 2a-2 text |
| C. move the Vault references to a private table | the strongest separation | a schema change across G4's readers and writers |

Order for B, depending on a fact G5 cannot see [U]: is `20261007150000` applied in production?
- **not applied**: amend the candidate file itself before it is ever applied (it lives in main's migrations: a main change through G4's review);
- **applied**: a new G4 migration whose precondition is the current contract, that revokes the table-level SELECT and grants the columns in one
  transaction, and whose postcondition is the new contract; any later contract check must use the new one.

Denial tests that G4's TASK should carry (the ones above, plus): the member read policy still filters rows under column grants; `select=*` through
PostgREST answers 42501 (managed [U]); each Edge reader's column list works as service_role; the new precondition refuses the old table-level
layout and any TRUNCATE / REFERENCES / MAINTAIN / TRIGGER for service_role; from an empty database and from a copy of the current shape. Review:
Codex Sol (high); production: the user's approval and the production audit first.

### 14.4 What each owner still owes (unchanged facts, new status)

| Owner | Open items | Gate |
| --- | --- | --- |
| G3 (needs an assignment) | the 10/27 list; ownership answers for `published_content_fingerprints`, `brand_settings`, `daily_content_plans`, the `brand_id` columns; the `brands` DDL owner with G4 | 担当ちゃ / 総合指令 to assign |
| G4 | D-2 (14.3); rebuild of `social_accounts` / `social_account_oauth_states` after the ownership agreement | its own TASK, Codex Sol (high) |
| G6 (needs an assignment) | a short 10/27 list (`ai_ledger`: no 10/30 impact per C-2; exposed schemas [U]) | 担当ちゃ / 総合指令 to assign |
| G3 + G4 (+ G5) | the `brands` DDL owner — **undecided** | agreement |
| user | the production read-only audit (ACL, RLS, columns, applied migrations, default privileges incl. global `pg_default_acl` rows) | explicit approval |

### 14.5 Until 2026-10-30: the rule for any new public table (unchanged)

Every new public table or sequence ships in one migration with RLS, its policies, `revoke all` from the API roles and the minimal explicit grants
(R-1..R-14); no anon by default; no service_role table grant for server-only tables; never TRUNCATE / TRIGGER / REFERENCES; identity rather than
serial. Global default ACLs (`pg_default_acl` with no schema) can still grant new objects outside the 10/30 change: the read-only audit (R-14)
sees the effective result; the managed state is [U].

| Check (G5-16) | Result |
| --- | --- |
| `common_account_d2_column_acl_pg_run.sh` (PG17) | **4 tests** passed, 0 failed (three consecutive runs): `contract=accepted g4_column_proposal=POSTONA_ACCOUNTS_PRECONDITION_ACL r7_violation_allowed=accepted` |
| regression + harness + checks | base tables PG17 5 passed; Data API PG17 6 passed; scanner test 10 checks; refs test 9 checks; pure 42 passed; the whole harness **260 passed** (255 of PR #424 + 5 new); `deno check` / `deno lint` / `bash -n` / `git diff --check` clean; `supabase/migrations` and `supabase/candidates` unchanged |
