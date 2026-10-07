# Market report: generation traces + GPT-6.1 Sol — production rollout runbook (NOT executed)

Status: plan and rehearsed tooling only. Nothing here has been run against production. Every production step needs
its own explicit approval, a same-day read-only preflight and an operator at the keyboard. Two separate production
mutations: **M1** the trace migration, **M2** the `market-report-analysis` Edge Function deploy.

- Accepted source: `origin/main` containing PR #101 (merge `e49ecfcc2f6707f64b6282960f9eec61be2973d3`) and PR #107
  (merge `8738a186628989ce6c797d61ea80f5b721664c95`). The whole `market-report-analysis` import graph on `main` is
  byte-identical to `8738a186` (checked 2026-10-07).
- Migration: `supabase/migrations/20261007120000_market_report_generation_traces.sql`
  (version `20261007120000`, name `market_report_generation_traces`)
- Migration SHA-256 (pinned in the runner; Stage A refuses anything else):
  `f7eb5707fb9695ee6a94c5e2bc9f9eaa3ad4660a67e94f1ad62cb5b07984622b`
- Runner: `supabase/tests/market_report_generation_traces_rollout.sh` (`status`, `apply`, `apply --resume-history`, `proof`)
- Only Edge Function to deploy: `market-report-analysis`. No other function, no Cron, no gate, no secret, no DB setting.

## Production state found by the read-only preflight (2026-10-07 15:4x JST)

| Item | State |
|---|---|
| migration history `20261007120000` | **0 rows** (latest history version `20261006230000`) |
| `public.market_report_generation_traces`, helper, triggers, policies, related relations | **all absent** |
| role that will apply / own | `postgres` (not superuser, `createrole`) |
| `anon` / `authenticated` / `service_role` memberships | none; none of them in `postgres`, a superuser, `pg_read_all_data` or `pg_write_all_data`; none superuser |
| default privileges of `postgres` in `public` | tables: `anon` / `authenticated` / `service_role` get `TRUNCATE, REFERENCES, TRIGGER, MAINTAIN` (`Dxtm`); functions: owner only; sequences: owner only. Only the three API roles appear, all three are revoked by the migration → its access verification passes. |
| event triggers | `ensure_rls` (`rls_auto_enable`: enables RLS on every new `public` table; the migration enables RLS too — idempotent), `pgrst_ddl_watch` (reloads the PostgREST schema cache on DDL, so the function's REST insert into the new table works without a manual reload), extension-only triggers |
| `market-report-analysis` | v26 ACTIVE, `verify_jwt=false`, ezbr `addbb0a61338…`; deployed files byte-identical to PR #99 merge `e3379f80` (Luna, no trace writer, no registry) |
| difference to `main` | `analysis_logic.ts`, `handler.ts` changed; `debug_trace.ts`, `_shared/kabumori_ai_models.ts` new. Only PR #101 and PR #107 touched the graph since `e3379f80`. |
| environment the new code reads | `SUPABASE_URL`, `SUPABASE_SECRET_KEYS`, `SEND_PUSH_NOTIFICATIONS_CRON_SECRET`, `OPENAI_API_KEY` — **the same four as v26**; no new secret |

The runner's `proof` rebuilds this exact shape locally (non-superuser owner, the `Dxtm` table defaults, owner-only
function defaults, an `ensure_rls`-equivalent event trigger, the production ledger shape) and passes 93 checks.

## Order and why

1. **M1 — trace migration** (runner `apply`: Stage A → B → C, then postflight).
2. **Read-back of M1** (runner `status` → `STATE schema=EXACT history=EXACT`; the ACL lines below).
3. **M2 — deploy `market-report-analysis` only** from the clean accepted checkout.
4. **Read-back of M2** (version, `verify_jwt=false`, byte-for-byte download vs the pins below, all other functions unchanged).
5. No manual report, no replay, no invoke.
6. Wait for the next **natural** cycle.
7. Read-only observation (checklist below).

M1 before M2 because the new function writes one trace row per model generation, and the first natural Sol cycle
is the one worth tracing. The order is not a safety dependency: the function tolerates a missing table (the insert
fails, `GENERATION_TRACE_WRITE_FAILED:…` is logged, the report is delivered unchanged), and the table is inert without
the function. If M1 stops, M2 may still proceed after review (no traces until M1 is done); if M2 stops, M1 stays as is.

**Timing:** run both outside the market-report windows (data 07:50 / 16:15, analysis 07:55 / 08:05 / 16:20 / 16:35,
app 08:35 / 17:15 JST). Recommended: after the 2026-10-07 close cycle has completed (≥ 17:30 JST) — that close is the
last Luna baseline — so the first Sol cycle is the 2026-10-08 morning (07:55 JST).

**OpenAI balance:** the account is on manual charge in the test phase. GPT-6.1 Sol is priced at $2 / $10 per 1M
input / output tokens (Luna was $0.2 / $1.2), so the same tokens cost about 10× (a 2-call morning ≈ $0.05 by the
upper-bound estimate). Check the balance before M2; a 429 `insufficient_quota` stops the cycle (it is not retried).

## M1 — the trace migration

Connection and guards are the same as `ai_lab_topic_claims_rollout.md` (libpq environment only; password in
`~/.pgpass` or a `PGPASSWORD` exported in the operator's shell for that command; nothing secret in files, arguments
or logs). Production requires all of:

- `TRACE_ROLLOUT_TARGET=production`
- `TRACE_ROLLOUT_ACK='apply 20261007120000_market_report_generation_traces to production after a same-day read-only preflight'`
- `TRACE_ROLLOUT_PROJECT_REF=<the 20-letter project ref>` and `PGHOST` or `PGUSER` containing it
- a TCP host, `PGSSLMODE=require` (or stronger), not port 6543
- `TRACE_EXPECTED_OWNER=postgres` and `PGUSER` = `postgres` (direct) or `postgres.<project ref>` (session pooler; the direct
  host is IPv6-only)
- no `TRACE_ROLLOUT_TEST_*` set

Steps (each its own go / no-go):

1. Clean checkout of the accepted `main`; `shasum -a 256 supabase/migrations/20261007120000_market_report_generation_traces.sql`
   equals the pin above.
2. `bash supabase/tests/market_report_generation_traces_rollout.sh status` → `STATE schema=ABSENT history=NONE`.
3. `bash supabase/tests/market_report_generation_traces_rollout.sh apply` → expected tail:
   `Stage A: migration committed`, `Stage B: catalog read-back = EXACT`, `Stage C: history recorded …`,
   `postflight: schema=EXACT history=EXACT`, `DONE`.
4. Independent read-only read-back (SQL editor or `supabase db query --linked`):
   - `select string_agg(format('%s %s %s', pg_get_userbyid(a.grantee), a.privilege_type, a.is_grantable), ', ' order by 1)
      from pg_class c, aclexplode(c.relacl) a where c.oid = 'public.market_report_generation_traces'::regclass and a.grantee <> c.relowner`
     → `service_role INSERT false, service_role SELECT false`
   - RLS on, 0 policies, 3 triggers enabled (`no_update`, `no_delete`, `no_truncate`)
   - `has_table_privilege` false for `anon` / `authenticated` on every privilege; `service_role` SELECT and INSERT only
   - one history row `20261007120000 market_report_generation_traces`

| Exit | Meaning | Operator action |
|---|---|---|
| 0 | done / already complete (read-only no-op) | continue with M2 |
| 2 | refused by a guard before connecting | fix the environment; nothing was touched |
| 10 | unexpected starting state / wrong bytes / wrong role / not PG 17 | stop; nothing applied |
| 11 | the migration failed before COMMIT (e.g. its own `MARKET_REPORT_TRACE_ACL_*` access refusal); schema and history absent | stop; find the cause; a new attempt is a new approval. The migration never repairs privileges. |
| 12 | Stage A outcome unknown; the runner read the catalog instead of retrying (ABSENT / EXACT / UNSAFE) | stop; review |
| 13 | Stage B mismatch | stop; history NOT written; no deploy; no automatic drop |
| 14 | schema present / history missing | stop; after review only `apply --resume-history` |
| 15 | postflight not exact | stop; no deploy |

The runner never drops objects, never runs a down migration and never edits history beyond inserting the one exact
row. Removing a bad new table is a separate, explicitly approved transaction.

## M2 — deploy `market-report-analysis` only

From a clean checkout of the accepted commit **without** `supabase/config.toml` (so the CLI cannot fall back to
another checkout), with explicit arguments:

```
supabase functions deploy market-report-analysis --workdir <clean checkout> --project-ref <project ref> --no-verify-jwt --use-api
```

Before: record `supabase functions list -o json` (all functions: version, `updated_at`, `verify_jwt`, `ezbr_sha256`).
After:

1. `market-report-analysis`: version +1, `ACTIVE`, `verify_jwt=false`; every other function's version / `updated_at` /
   `verify_jwt` / `ezbr_sha256` unchanged.
2. `supabase functions download market-report-analysis --use-api` into a scratch directory; every file below equal by
   SHA-256 (the type-only `packet_schema.ts` may be absent from the download):

```
76c03f93e2e6fa5736eed292091e652e42f608a486cb4dda4e708d5cbe4af6de  market-report-analysis/index.ts
226e2b19b285618314dacbda4fe5f8470fd07d516bb49665b3bf42821b0cc6c3  market-report-analysis/handler.ts
830a03d5709e9f9875db96f7233b45dedad7b374ee6f3770f899b492a3bae559  market-report-analysis/analysis_logic.ts
6eb5d15230f475cddd696bb3199a98e17f95d8b0cf227de5ededfa54d39a19b1  market-report-analysis/analysis_input.ts
8e3e5b7a2b6a786de6f726377e09a633199e382b5a03d983dc2abbce825db12c  market-report-analysis/hard_fact_guards.ts
548773ebf6f4d088f4b557a611a07368a9c5394360cf1d0ed0591a45cd575042  market-report-analysis/transport_retry.ts
14989341c0ae80a6f54183eccb66f0158f3a43cd18a85dd68629276b6f5fcbb7  market-report-analysis/debug_trace.ts
c965b3141a5b842be77ebfb7b80e61ef21a6b32c79c61f25bb55ce9d4a3ec940  _shared/kabumori_ai_models.ts
92e2d2adb472372fe9909c4f2f12f6371af0a198f638fcddc241241c8c743412  _shared/market_report_packet.ts
da644570775335b27c3da36efd35b6470b8b6c277f2f05d11352eac1b35e50c2  _shared/market_report_story.ts
18a1d649f8bd131068965d622b3e05c211a3fcaa4347f92bdcaf00c15d1f12e7  _shared/absence_claims.ts
9b1150a8a4f2560cb2834076e40c13bacaa748d1a4530b83b53394db37378022  _shared/kabumori_voice.ts
7403e7c62f5abb6768b76b1d6d45359ad97730d4cdd2ac3e7f1d146b7e246621  market-report-data-packet/session_logic.ts
7bd340a5b0d093bb88c8c9a513a1825f472edcc3af6e43442cb21e1c11dd360c  market-report-data-packet/packet_schema.ts
```

3. `market_report_consumer_settings.app_enabled = false`, `x_enabled = false`; the eight market-report / personalized
   Cron jobs unchanged (schedule, active, `md5(command)`); no new `market_report_packets` row after the deploy.

STOP if any other function changed, `verify_jwt` changed, a byte differs, or a gate / Cron changed. Rollback source:
the current v26 bytes (= PR #99 merge `e3379f80`), redeployed the same way after review. Rolling M2 back does not
require touching M1.

## First natural cycle — read-only observation checklist

Compare against the Luna baseline (2026-10-06 close, 2026-10-07 close if it completes):

- cycle: status, `report_attempt_count`, first-try or retry, `report_last_error`; failure codes now include
  `ANALYSIS_OPENAI_<STEP>_INCOMPLETE:max_output_tokens` (a reasoning-token cap hit) and the old `_EMPTY` / `_INVALID_JSON`
- `report_diagnostics`: `ai_config_version`, `ai_generate_model` / `_reasoning` (`gpt-6.1-sol` / `medium`),
  `ai_fact_model` / `_reasoning` (`gpt-6.1-sol` / `low`), `calls`, `input_tokens`, `output_tokens`, `cost_usd`,
  `generation_attempts`, `content_regenerations`, `quality_rewrite`, `delivered_generation`, `hard_rejections`,
  `rejection_reasons`, `quality_warnings` (incl. `X_POINTS_GENERIC`, `X_POINTS_METRIC_RECAP`, `X_POINTS_NEAR_DUPLICATE`)
- `market_report_generation_traces` for that cycle: one row per generation; `stage`, `candidate`, `local_issues`,
  `fact_issues`, `selected_for_delivery`, `fallback_reason`, `request_hash`, `truncated`; no
  `GENERATION_TRACE_WRITE_FAILED` in the function logs
- content: headline, market summary, the three points (specific? any generic / recap?), X body (length, readability),
  app story (length, readability), unsupported causality, factual cross-check of every value / date / sign / 1306
- cost: `api_cost_usd` per packet vs the Luna packets (upper-bound estimate, no cached-input discount)

Do not weaken any Hard / delivery rule before this observation. Consumers stay OFF.

## Needs explicit user approval

- M1: run the runner `apply` against production (operator with database credentials).
- M2: the single-function deploy.
- Each is its own approval; an approval for one does not cover the other. A failed step is never retried without a new review.
