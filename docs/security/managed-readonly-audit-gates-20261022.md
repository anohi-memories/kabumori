# Managed read-only audit — gates, scope, no-secret controls and STOP conditions (G5 canonical candidate)

Status: **design + a local dry run only. Nothing in this task connects to a managed or production project** (not even read-only). The audit itself
runs only after the user's explicit approval (gate G0). Production stays **NO_GO** for every change.

- TASK `common-account-g5-managed-readonly-preflight-security-gates-20261022` (Issue #320, G5-01 generation, task 18, completion K5).
- Stacked on PR #432 (G5-17). New G5-owned files: this document, `supabase/preflight/managed_readonly_audit/audit.sql` (the SQL the audit would run),
  `supabase/tests/common_account_managed_audit_pg_{run.sh,test.ts}` (its local dry run) and
  `supabase/preflight/managed_disposable/g5_18_managed_audit_doc_test.ts`.
- Why: the open questions of G5-08 .. G5-17 (owners, ACLs, RLS, default privileges, exposed schemas, applied migrations, Auth shapes) are all
  **NOT_VERIFIED on managed**; this is the safe way to read them once.

Evidence labels: **[D]** derived by this task's local dry run; **[S]** read from a source in this repository; **[U]** NOT_VERIFIED.

## 1. Gates, in order

| Gate | What | Who | Pass when |
| --- | --- | --- | --- |
| G0 | **Approval**: the project (named by the user in chat), the database role, the time window, who runs it (the user / an operator, or Claude through a connection the user grants for this run only), and where the output goes | the user | an explicit "yes" to all five; anything unnamed = not approved |
| G1 | **Local dry run** of the exact `audit.sql` on a disposable PG17 (this task) | G5 | every section prints; read-only; canaries never printed; injected writes fail; S0 stops a writable run [D] |
| G2 | **The managed run**: `psql -X -A -F '|' -v ON_ERROR_STOP=1 -f audit.sql > audit-output.txt`, from the audit directory, the file unchanged (its sha256 compared with the reviewed commit) | the approved runner | the run ends with `## END (rolled back; nothing was written)` |
| G3 | **Output scan** before anyone else sees it: no secret-shaped string, no e-mail / phone, no project host, no row of a data table | G5 (local) | the scan is clean; else STOP and delete |
| G4 | **Analysis** against the contracts: G5-08 / G5-10 install rules, the R0 / R1 / T13 ACLs and owner (G5-17), the 2a-2 contract (D-2), the Data API rule R-1..R-14, the base tables (sections 12-14 of the Data API doc) | G5 | every finding labelled with its section line |
| G5 | **Report**: a summary on Issue #320 (no raw dump); the raw file stays local and is deleted after the analysis unless the user says otherwise | G5 | read back |
| G6 | **Follow-up**: each owner's fix in that owner's TASK (isolated SQL, PG17, Codex Sol (high)); any production change is a separate approval | owners | — |

## 2. What the audit reads (catalog metadata only)

| Section | Reads | Answers |
| --- | --- | --- |
| S0 | `transaction_read_only`, isolation, current role, server version; **STOP unless read-only** | the run is safe |
| S1 | relations of `public`, `private`, `auth`, `ai_ledger`, `storage`, `postona_x_resv`, `postona_threads_resv`, `postona_threads_binding`: kind, owner, RLS, FORCE, ACL | base tables exist? owners; RLS on `brands` (E-2); the 2a-2 ACL (D-2) |
| S2 | column ACLs **including system columns** (`attnum < 0`) | G3's question on `brand_memberships` column / system-column ACLs; D-2 |
| S3 | `pg_default_acl`, **global and per schema** | what new objects will be granted (the 10/30 change, global defaults) |
| S4 | functions of those schemas: owner, SECURITY DEFINER, volatility, config, ACL, **md5 of the body** | G5's R0 / R1 / W1 / W2 / T13 / session verdict owner + ACL (G5-17 Q3); bodies equal to the repository? |
| S5 | RLS policies: name, command, roles, USING / CHECK expressions | member policies on `brands` / `social_accounts`; "admin policies" |
| S6 | the API roles, Supabase's system roles and every owner of those objects: flags and **allowlisted** settings only (`pgrst.db_schemas`, `pgrst.db_extra_search_path`, `default_transaction_isolation`, `default_transaction_read_only`, `statement_timeout`, `search_path`, `row_security`, `session_replication_role`) | exposed schemas; the READ COMMITTED assumption (G5-11 / G5-17) |
| S7 | memberships of those roles (admin / inherit / set options) | PR #303's exposure; whether an API role reaches an owner |
| S8 | column shapes of `auth.users` / `auth.sessions` / `auth.identities`; md5 of `auth.uid()`'s definition | the claims / session assumptions of R0 / R1 / T13 / 003 |
| S9 | installed extensions | `pg_graphql`, others |
| S10 | `supabase_migrations.schema_migrations`: **version and name only** | which migrations are applied (2a-2? the F5 chain?) |
| S11 | event triggers | G3's question on catalog-rewrite side effects |
| S12 | the G5-12 effective-privilege audit of `public` (flags) | Data API exposure per role |

## 3. What the audit never reads, and how that is enforced

| Never | Enforced by |
| --- | --- |
| any row of a data table (auth users / sessions, storage objects, Vault, application tables) | the file selects from `pg_catalog`, the `auth` columns' catalog rows and the migration history's two columns only; a canary row in `public.brands` is never printed [D] |
| passwords, `pg_authid`, Vault secrets | not referenced by the file (doc test) |
| secret-bearing role settings (e.g. a JWT secret) | only the allowlisted keys of S6 are printed; a canary `pgrst.jwt_secret` is never printed while `pgrst.db_schemas` is [D] |
| function bodies, comments, migration statements | md5 only; comments not selected; `statements` not selected — canaries never printed [D] |
| any write | `BEGIN READ ONLY`; S0 stops a writable transaction [D]; injected INSERT / CREATE / GRANT fail and leave nothing [D]; `ROLLBACK` at the end |
| long locks | `statement_timeout = 30s`, `lock_timeout = 2s`; catalog reads take no conflicting locks |

## 4. STOP conditions (any one: stop, keep nothing, report the fact)

1. Gate G0 not fully approved, or the project / role differs from the approval.
2. The file's sha256 differs from the reviewed commit.
3. S0 does not report `read_only=on`, or any statement errors (`ON_ERROR_STOP`).
4. A statement waits on a lock or times out.
5. The output scan (G3) finds a secret-shaped string, personal data or a data row.
6. A safety check refuses the connection or a step: stop; do not retry by another path (PROJECT_RULES); report the refusal.

## 5. Approval the user would give (template)

> 「本番の読み取りだけの監査を許可します。プロジェクト: <名前>、役割: <役割>、時間: <開始〜終了 JST>、実行する人: <本人 / 運用者 / Claude（この1回だけの接続）>、出力の保存先: <ローカルの場所>。書き込み・付与・設定の変更は許可しません。」

Without such a sentence in chat, nothing in this document is run against managed.

## 6. Owner transport, T13 -> R1 and claims: what only the managed audit (or a disposable managed project) can settle

| # | Unknown | Settled by |
| --- | --- | --- |
| M-1 | who owns G5's R0 / R1 / T13 / 003 and G4's Threads RPCs; is the H5 transport role that owner (G5-17 Q3) | S4 + S6 + S7 |
| M-2 | R0 / R1 / 003 / T13 ACLs equal the install postconditions | S4 |
| M-3 | `auth.uid()` is the published definition | S8b (md5 against a reference) |
| M-4 | `auth.sessions` has `id` / `user_id` / `not_after` of the expected types | S8 |
| M-5 | RLS / owners of `auth.users` / `auth.sessions` satisfy the G5-08 every-row-visible rule | S1 + S7 |
| M-6 | roles do not change `default_transaction_isolation` away from READ COMMITTED | S6 |
| M-7 | which chain / candidate migrations are applied (2a-2, the F5 chain) | S10 |
| M-8 | PostgREST's claim delivery (`request.jwt.claims` vs per-claim settings), GoTrue's session rows on sign-out | **not by SQL**: a disposable managed project (Phase 13 plan) — stays NOT_VERIFIED |

Negative tests G3 / G4 should carry when they connect (in their own isolated suites): a transport role other than the owner -> permission denied
(G5-17); a per-claim `sub` mixed with JSON claims -> `AUTH_REQUIRED`; no `session_id` -> R0 / R1 `AUTH_REQUIRED`, T13 raises; a REPEATABLE READ or
SERIALIZABLE consumer -> refused (G5-11 C-2); a sign-out committed before R1's statement -> `SESSION_REVOKED`; an ended service -> T13 raises; a
pre-claimed workspace -> R0 `OWN_WORKSPACE_CONFLICT`, or R1 `unknown` + ROLLBACK; a malformed `owner_epoch` token -> rejected; W1 after a lifecycle
change -> `SERVICE_GENERATION_CHANGED`.

## 7. Data API (2026-10-27 / 2026-10-30), re-checked on 2026-10-22 JST

| Owner | Status |
| --- | --- |
| G4 | list received (#320 6317104735); D-2 acknowledged |
| G6 | **TASK assigned**: G6-16 `common-ai-g6-data-api-20261030-impact-inventory-readonly-20261022` (ready, Issue #321) — list pending, due 10/27 |
| G3 | **no Data API TASK**: Issue #318 is idle (`task_id: none`); ownership answers (fingerprints, brand_settings, daily_content_plans, `brand_id`, the `brands` DDL owner) still missing — the 担当ちゃ / 総合指令 must assign one |
| G5 | done (no impact) |

## 8. G3's query on PR #370 column / system-column ACLs (#320 6330443480)

Received. This design reads what the questions need on managed (S2 system-column ACLs, S11 event triggers). The six answers themselves (the
`brand_memberships` column-ACL policy, widening PR #303's L-1 check to columns / system columns, option B, the A2 operation owner, managed
side effects, the Data API interplay) are G5 decisions with Auth / ACL consequences and need their own G5 TASK; this task does not answer them.

## 9. Tests and what was executed

All commands ran in `/Users/yuya/Developer/kabumori-g5-18` (a clean worktree stacked on PR #432) against a throw-away local PostgreSQL 17.11
(`listen_addresses` empty, a Unix socket under `/private/tmp`, fake data, deleted at the end). No managed system, credential or network request.

| # | Check | Result |
| --- | --- | --- |
| 1 | `CAL_PGHOST=… CAL_PGPORT=… CAL_PGSUPER=… bash supabase/tests/common_account_managed_audit_pg_run.sh` | **5 tests** passed, 0 failed (three consecutive runs): every section printed in a read-only transaction with nothing changed; the five canaries (a data row, a function body, a `pgrst.jwt_secret` role setting, a table comment, a migration statement) never printed while `pgrst.db_schemas` and the md5 are; injected INSERT / CREATE / GRANT fail and leave nothing; S0 stops a writable run before S1 |
| 2 | regression, PG17: the G5 suites | owner transport 6, session verdict 13, R0 13, R1 15, G5-01 10, G5-02 5, owner epoch 19, base tables 5, D-2 4, Data API 6 — all passed |
| 3 | pure regression and the whole harness incl. the document tests | pure 42 passed; the whole harness **270 passed**, 0 failed (265 of PR #432 + 5 new) |
| 4 | type-check, lint, shell, whitespace; no product SQL / migration changed | `deno check --no-config`: no error; `deno lint --no-config`: no problem; `bash -n`, `git diff --check`: clean; `supabase/migrations` and `supabase/candidates`: unchanged |
