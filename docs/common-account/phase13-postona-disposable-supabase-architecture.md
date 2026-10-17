# Phase 13 (F5) — detailed architecture plan: a disposable Supabase for POSTONA's shared-ID enrollment, re-authentication, service ending and entitlements

Status: **read-only / source-only design. Nothing in this document was run against any managed or production system.** No
Supabase project was created, no schema-only inventory was taken, no migration was applied, no Auth / RLS / Edge / Storage /
Cron / grant / secret was touched, no OAuth / X / Threads / Meta / Apple / Google call was made, no external HTTP request was
sent, nothing was merged or deployed. The only things executed are offline: on this checkout, on a throw-away local PostgreSQL
with fake data, and on a read-only scratch checkout of F4's PR (section 13 lists every command and its output). Production is
**NO_GO**; every gate in section 11 is a separate, explicit owner decision and none is open.

TASK `common-account-f5-postona-disposable-supabase-architecture-plan-20261017` (G4 approved `SOURCE_ONLY_DESIGN_GO` on
2026-10-17). It stacks on F5 PR #233 and adds only documentation, one pinned evidence file, one offline verifier, one offline
local-database oracle and one offline test (section 13).

What this serves: *the shared ID is the platform; POSTONA is its first app; Kabumori may pause.* A person must be able to
register, sign in, refresh, re-authenticate, sign out, come back and **end POSTONA alone** — with no Kabumori profile,
entitlement, delivery, AI or deployment involved — and a future app must be addable as one more independent service on the same
login.

Evidence labels: **[O]** observed in this checkout (a file and line), **[R]** recorded in the repository's own coordination
files (a person wrote it down; not re-read from the system), **[D]** derived by this phase's tools from the checkout (and
reproducible by the commands in section 13), **[A]** an assumption that needs external confirmation, **[U]** unknown — never
inferred. "Source-model" means exercised offline against a model (a fake GoTrue / PostgREST over a local database, injected
clocks): it proves our code, **not** the managed service. "Managed-only" means unknown until a disposable project exists.

## 1. Summary, findings and the decisions this plan asks for

**Recommended path** (each arrow is a separate approval, section 11): restricted recheck of #233 → a production **read-only**
schema-only inventory *and* a reviewed schema-only DDL export of the baseline objects → the owner approves the contract digest
→ a **new, empty, allow-listed** disposable Supabase project → baseline + the ten-file chain + exactly the Edge functions of
section 6 → the Phase 11/12 harness run (M1–M13 plus the additions below) → a sandbox build on an iPhone → only then a
production plan, which is a different document.

What this phase found that changes the plan (none is fixed here; each has an owner):

| # | Finding | Evidence | Consequence |
| --- | --- | --- | --- |
| **F-1** | **The Phase 12 baseline contract is incomplete.** It was extracted from the Phase 1 preflight only. A local oracle (remove one baseline object, apply the chain, see who refuses) shows two more apply-time prerequisites: the function **`public.ensure_my_profile()`** (P4 refuses with `COMMON_ACCOUNT_CORE_FENCE_PREFLIGHT_ENSURE_MY_PROFILE_SHAPE`) and the column **`public.social_accounts.platform`** (P6 refuses with `COMMON_ACCOUNT_SERVICE_OWNERSHIP_PREFLIGHT_SHAPE`). | [D] section 4.3, `phase13-prerequisite-oracle.tsv` | G3b would pass and the run would still STOP at P4 / P6. Fail-closed, but the baseline export and the contract must be extended **before** any production read is requested (D-1). |
| **F-2** | `withdraw_postona` asks the **legacy** Edge function `social-mobile-account-delete` for its X-saga preview; any answer other than scope `social_only` gives `409 X_CLEANUP_UNSUPPORTED`. A POSTONA-only person (no Kabumori profile) gets scope `social_and_login` and is refused even with the real function (F3's R2′). | [O] `supabase/functions/account-delete/lifecycle_logic.ts:748`, `supabase/functions/account-delete/http.ts:189–192`; [R] `docs/common-account/phase10-x-ack-snapshot.md:179` | M12 on a disposable needs either F3's real saga (it contains the X revoke call and the login-deleting scope) or an **inert, reviewed stand-in**. This plan chooses the stand-in for the first managed pass (D-2); its source does not exist yet. |
| **F-3** | F4's preflight (#243) requires **both** `kabumori-social://auth-callback` and `kabumori-social://oauth-callback` in the project's Auth redirect list, no wildcard. The app passes only `auth-callback` to Auth and enables `appendPkceFlowIdToRedirects`. | [O] `apps/social-mobile/src/domain/auth-flows.ts:15,17`, `apps/social-mobile/src/lib/auth-client-flows.ts:61,91`, `apps/social-mobile/src/lib/supabase.ts:52`; #243 doc §2 (`external`, pinned) | Whether a hosted Auth accepts an **exact** entry when a flow id is appended is a managed-only unknown (Q-1). Phase 11 and #243 do not agree on the list; this plan resolves it as a managed check, not by guessing. |
| **F-4** | This Mac has the Supabase CLI but **no Docker**, so a local Supabase stack (real GoTrue / PostgREST / Edge runtime at no cost) cannot run here. | [D] section 13 (`command -v`) | The cheaper first stage needs an external action; the hosted project stays the default (D-3). |
| **F-5** | The repository has **no `supabase/config.toml`**. Every Auth / Edge / API setting a test depends on (`verify_jwt`, providers, redirects, exposed schemas, JWT expiry) lives in the project, not in git. | [D] `ls supabase/config.toml` → absent | Settings are set by a human and **read back**, never assumed (section 6.1, M13). |
| **F-6** | Production history is not the repository's history: six production versions are not in the repository and many repository files are not in the history. | [R] `docs/common-account/phase2-production-apply.md` | `supabase db push` and "apply all" are forbidden; the DAG in section 5 is the only order. |

**Decisions requested from G4 / the owner** (defaults in bold):

| id | question | options |
| --- | --- | --- |
| **D-1** | Extend the contract and the baseline export with `ensure_my_profile()` and `social_accounts.platform` before the production read? | **yes, before** / after the first inventory (costs a second production read) |
| **D-2** | M12 on the disposable: how is the X-saga preview answered? | **an inert, reviewed, digest-pinned stand-in** (contract: F3/G3; pin: F5) / F3's real saga (a later, separate approval: it holds the X revoke call and the login-deleting scope) / skip M12 (rejected: it is the point) |
| **D-3** | Where does the first managed-like run happen? | **a hosted disposable project** / a local Supabase stack first (needs Docker installed by the owner), hosted second |
| **D-4** | Redirect allow-list for the first pass | **`auth-callback` exact only; Q-1 decides whether a pattern is needed** / both URLs exact, as #243 requires today |
| **D-5** | Apply P1 / P2 to the disposable although production already has them? | **yes, then compare their objects with the production inventory (section 4.4 fidelity check)** / start from a baseline that already contains them |

## 2. Evidence base (exact heads, read with `gh pr view` on 2026-10-17 JST)

| Item | PR | Head | Notes |
| --- | --- | --- | --- |
| Phase 11 harness | #223 | `28695586f63a30c739a44b829e79a7950932b5e7` | guard, runner, plan, lock, model run |
| Phase 12 baseline / cron isolation | #226 | `3d87a8457ddade3209583cbb820d5e5feec23f00` | scanner, lock, inventory, G3b / G3c |
| Phase 12 J1 V1 fixes | #233 | `499a9e1fac595064fbc3928725be8907db1b692b` | **this plan's base**; probe bytes, non-skippable G3b, transitive helpers, safe diff |
| G1 / G2 mobile (enrollment gate) | #240 | `5e462ba73be691c80f75198d57782626f1d241cc` | on #238 `b8e91ea8eb7c28e44820f15da5f697a9b3d4f8d6`, #236 `605d8776c6be2e33ec247af7c82a99270cf32b82`, #230 `e6725a165cd8f116a964926cdfceaa9334590491` |
| F4 non-production preflight | #243 | `60e4a4c059a9d7304e5a48a7b3219ab801e822ae` | not in this tree; files pinned by blob id in `phase13-migration-dag.json` → `external` |
| POSTONA client deletion boundary | #197 | `2171ee4c02ea2eec46562d81595f5460e5507d9d` | client closes the legacy path; the **server** legacy function is F3 / G3's |
| F3 X saga (ack, lease, rollback) | #204 | `45b08a879749b853d3dc77465d9e65e8fd684305` | referenced, not re-opened |

Files that exist only on other branches are never read by this plan's verifier; they are pinned by commit and git blob id
(`phase13-migration-dag.json` → `external`).

## 3. Architecture at a glance

```
 operator machine                                     phone (sandbox build only)
 +----------------------------------+                +----------------------------+
 | supabase/preflight/managed_      |                | POSTONA build with         |
 | disposable/cli.ts (Deno) + psql  |                | EXPO_PUBLIC_DATA_SOURCE=   |
 | guard, lock, scanner, G3b / G3c  |                | supabase, sandbox URL and  |
 +----------------+-----------------+                | publishable key only       |
   HTTPS (keys of the sandbox) | psql (DB URL)        +--------------+-------------+
                  |                                                  | HTTPS (publishable key)
                  v                                                  v
 +------------------ disposable Supabase project (new, empty, allow-listed) --------------------------------+
 | Auth (GoTrue): e-mail provider only; anonymous OFF; no Apple / Google / X provider in the first pass       |
 | PostgREST: public schema exposed, private schema NOT exposed                                               |
 | Postgres: baseline export + P1..P10 + public.kabumori_disposable_marker; fake users A..F                   |
 | Edge: account-delete (verify_jwt ON) + an inert X-saga stand-in (D-2)                                      |
 | NOT present: pg_cron / pg_net jobs, Vault contents, Storage objects, X / Threads / AI / Apple secrets,     |
 |              production data, production users or tokens                                                   |
 +-------------------------------------------------------------------------------------------------------------+
   nothing else is reachable: no production project, no X / Threads / Apple / Google / paid AI, no mail to a person
```

Boundaries: the harness never runs `supabase link`, `db push` or any CLI mutation (psql and HTTPS with an explicit, guarded
target only); the Edge deployment is a human step with pinned digests and a read-back; the phone build never holds a service
key; the disposable project holds no secret of any other system.

## 4. Baseline: origin, the missing relations, and the safe future inventory (deliverable 1)

### 4.1 Which required objects have a known origin

The Phase 1 preflight in `supabase/migrations/20261001150000_common_account_lifecycle_foundation.sql` requires 17 relations,
26 columns, 14 foreign keys and 2 functions [D, `supabase/preflight/managed_disposable/baseline_provenance.json`]. That
migration's own application to production (2026-10-06, APPLIED_PASS [R]) is indirect evidence that production met that
preflight on that day; a fresh read is still the first act of any later stage.

| Class | Relations | Origin |
| --- | --- | --- |
| platform managed (4) | `auth.users`, `auth.identities`, `storage.buckets`, `storage.objects` | Supabase creates them; never this repository [O] |
| created by a repository migration (10) | `public.profiles`, `tracked_stocks`, `alert_settings`, `notifications` (`20260901061217`); `admin_users` (`20260901064201`); `device_push_tokens` (`20260903160000`); `personalized_reports` (`20260911230000`); `alert_category_settings` (`20260913140000`); `brand_memberships` (`20260918120000`); `social_mobile_account_deletions` (`20260928160000`) | known DDL [D]; whether each is applied in production is **[U]** — the baseline export carries production's state, not a replay |
| altered by migrations only (2) | `public.social_accounts` (`20260924023133`, `20261007150000`), `public.social_account_oauth_states` (`20260919120000`) | **the creating DDL is not in the repository** [D]; `docs/postona/multi-social-phase1.md:43` also records "production DDL is outside the repository" for `social_accounts` [R] |
| absent from the repository (1) | `public.brands` | no migration creates it [D]; `docs/postona/multi-social-phase1.md:42` describes it only through its use [R] |

**Unknown, listed and never inferred** [D]: 3 relations (`brands`, `social_accounts`, `social_account_oauth_states`); 6
columns the Phase 1 preflight reads (`brands.id`, `brands.code_profile_key`, `social_accounts.brand_id`,
`social_accounts.connection_status`, `social_account_oauth_states.brand_id`, `social_account_oauth_states.initiated_by_user_id`);
4 foreign keys touching them; and 2 relations that depend on them and cannot be replayed on a bare platform
(`brand_memberships`, `social_mobile_account_deletions`). The test fixtures define their own columns on the three unknown tables;
those are **not** evidence of what production has. Who created the three tables in production, and when, is **[U]**.

### 4.2 The safe future procedure (not executed; needs its own permission)

Two production reads, both **read-only and schema-only**, both under an operator login, neither reading a row:

| id | what | how (exact) | output custody |
| --- | --- | --- | --- |
| **A1** catalog inventory | structure only: shape and the SHA-256 of every stored expression; no value, no function body, no row | `psql -X -q -A -t -v ON_ERROR_STOP=1 -f supabase/preflight/managed_disposable/inventory/schema_inventory.sql "$KABUMORI_INVENTORY_DB_URL" > inventory.ndjson` as a login that can **CONNECT and nothing else**; then `inventory_cli.ts check` (counts, codes, digests only). The query is one `READ ONLY` transaction; its SHA-256 `93b1ca05e381989c342aa1add93e7ab710d6b69110b758151fb131fc8d5926cb` is pinned in `plan.lock.json` | a file outside git and chat; only the `check` output may be reported |
| **A2** DDL export of the baseline objects | the *text* needed to build the baseline: the 17 relations (columns, constraints, indexes, owner, ACL, RLS flag) and the functions `social_mobile_account_deletion_subject`, `social_mobile_account_deletion_workspace` and (D-1) **`ensure_my_profile`** — nothing else | `pg_dump --schema-only` restricted to those tables plus `pg_get_functiondef` for the functions, by the operator; then **reviewed and trimmed by a human** (no trigger, cron, host, URL, Vault reference, literal) and re-scanned with `scanSql`: zero blocking findings; its SHA-256 is recorded | a file outside git; only its digest and the scanner result are reported |

A1 alone cannot build a baseline (it stores hashes, not text); A2 alone cannot prove fidelity (it has no digest of the whole).
Both are needed, and the contract digest A1 produced from production must equal the contract digest G3b reads from the
disposable **after** A2 is applied.

### 4.3 The contract is incomplete: what the chain needs beyond the Phase 12 list (finding F-1)

`supabase/tests/common_account_phase13_prerequisite_oracle.sh` takes the Phase 11 model baseline (fixtures plus the three real
prerequisite migrations, **no chain file**), removes one object in a fresh copy, applies P1..P10 in release order and records the
first refusal. The control (nothing removed) accepts the whole chain. Over 96 candidates (evidence file
`docs/common-account/phase13-prerequisite-oracle.tsv`, pinned by digest in `phase13-migration-dag.json` → `oracle`): 23 functions,
10 tables, 11 triggers and 44 columns could be removed with **no** refusal; four removals were refused, and **two of those four
are not in the contract** (section 5, generated table). Four more objects cannot be dropped alone (they have dependents); they
are listed as "not tested".

What the oracle cannot see, stated: runtime dependencies of plpgsql bodies (late bound), the type / nullability / default of an
object that is present, and the real production catalog (never read). So it proves *necessity at apply time* of the two extra
objects; it does not prove everything else is unnecessary at run time — the managed M-steps decide that (Q-7).

**Required follow-up (D-1; owner F5; no code is touched by this task):** add to `supabase/preflight/managed_disposable/baseline_requirements.ts`
the shape of `public.ensure_my_profile()` (the check P4 makes at apply time) and the existence of `public.social_accounts.platform`
(the check P6 makes); extend A2 accordingly; regenerate `baseline_provenance.json` and `plan.lock.json`. Evidence that production
has the original `ensure_my_profile()`: the 2026-10-07 read-only preflight recorded its hash as identical to the reviewed source
[R, `docs/common-account/phase2-production-apply.md`].

### 4.4 Acceptance, fingerprints and STOP conditions

| Check | Accept when | STOP when |
| --- | --- | --- |
| inventory output | parses; every kind has only its closed attribute list; no secret-shaped text; `inventory_cli check` says `READY_FOR_OWNER_REVIEW` | any secret-shaped text; an unreadable, duplicate or unknown kind; `UNEXPECTED_ATTRIBUTE`; a required object missing or retyped |
| stability | two inventories taken minutes apart have the same contract digest | they differ (production is changing under the read: take it again in a quiet window) |
| unclassified schemas | none, or each named and reviewed | a schema that is neither application nor known platform appears unreviewed |
| owner approval | the owner approves the **contract digest** (64 hex) after reading the manifest locally | the digest is not approved, or the contract was extended afterwards |
| baseline export | zero blocking scanner findings; digest recorded; applied to the disposable; G3b equals the approved digest | any finding; G3b differs |
| **P1 / P2 fidelity (new)** | after the disposable has P1 and P2, the inventory lines of the objects they created equal production's (same body hashes, owners, ACLs): the repository files are what production runs | any difference: the repository is not what production runs — stop and report before P3a |

## 5. Pinned migration dependency DAG, candidate order and exclusion list (deliverable 2)

Rule [D]: a migration is applied to the disposable **only** if it is a chain node, byte-identical to its digest, with no blocking
scanner finding. Nothing else is ever applied: what the 110 other files created is carried by the A2 export, and eight of them
schedule production-targeting jobs. Production state [R]: **P1 applied 2026-10-06 (`.agent/CURRENT_STATE.md`, "Final K5 —
Common-account Phase 1 foundation applied PASS — 2026-10-06"), P2 applied 2026-10-07 (`.agent/tasks/CLAUDE_TASK_5.md`, "Phase 2
production apply — 2026-10-07（APPLIED_PASS）")**; P3a…P10 are unmerged Draft source; no record of any later common-account
migration being applied. The tables below are **generated** from the checkout by `architecture_dag.ts` (section 13) and compared
byte for byte by the test; do not edit them by hand.

<!-- GENERATED:DAG:BEGIN -->

### Chain (the only files that may be applied), in release order

| # | id | file | sha256 | production | requires (earlier chain files, baseline relations, platform objects) | marker |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | P1 | `20261001150000_common_account_lifecycle_foundation.sql` | `e632214b5602c12e…` | **applied** | auth.identities, auth.users, admin_users, alert_category_settings, alert_settings, brand_memberships, brands, device_push_tokens, notifications, personalized_reports, profiles, social_account_oauth_states, social_accounts, social_mobile_account_deletions, tracked_stocks, storage.buckets, storage.objects, auth.users, auth.identities, auth.uid(), storage.* | `public.start_kabumori_service()` |
| 2 | P2 | `20261006230000_common_account_service_start_intent.sql` | `2c736e5aa70c61bf…` | **applied** | P1, auth.users, profiles, auth.users, auth.uid() | `public.reactivate_kabumori_service(bigint)` |
| 3 | P3a | `20261009120000_common_account_deletion_completion.sql` | `fd340765dd1aa889…` | Draft | P1, P2, auth.identities, auth.users, storage.buckets, storage.objects, auth.users, auth.identities, storage.* | `public.claim_common_account_deletion(uuid,uuid,integer)` |
| 4 | P3b | `20261010051938_common_account_service_write_guard.sql` | `d6db1c1343a409ab…` | Draft | P1, auth.sessions, auth.uid() | `private.account_lifecycle_assert_active_service_write(uuid,text)` |
| 5 | P4 | `20261012130000_common_account_core_service_fence.sql` | `88dd4507b9b2c2d0…` | Draft | P1, P2, P3b, profiles, auth.uid() | `private.account_lifecycle_service_state_refusal(uuid,text)` |
| 6 | P5 | `20261012230000_common_account_service_brand_state.sql` | `3131444556e5d56f…` | Draft | P1, P4, auth.users, brand_memberships, brands, auth.users | `public.common_account_brand_service_state(text,text)` |
| 7 | P6 | `20261013120000_common_account_service_deletion_ownership.sql` | `ce10e97368122926…` | Draft | P1, P3a, P4, P5, social_accounts | `public.claim_service_deletion(uuid,text,uuid,uuid,uuid,integer)` |
| 8 | P8 | `20261013140000_common_account_service_reconciliation_facts.sql` | `5745621a188f30ec…` | Draft | P1, P6 | `public.common_account_service_end_result(uuid,text)` |
| 9 | P9 | `20261015090000_common_account_enrollment_session_fence.sql` | `129d8b803bb37543…` | Draft | P1, P2, P3b, P8, auth.sessions, auth.uid() | `private.account_lifecycle_enrollment_fence(uuid,boolean)` |
| 10 | P10 | `20261015120000_common_account_x_unconfirmed_snapshot_record.sql` | `766e6fce56ef56c2…` | Draft | P1, P6, P8 | `public.record_owned_service_deletion_x_unconfirmed(uuid,text,uuid,uuid,integer,text)` |

Full digests: [`phase13-migration-dag.json`](phase13-migration-dag.json) (`chain[].sha256`); they equal `plan.lock.json`.

### Exclusion list: 110 of 120 repository migrations are never applied

| bucket | files |
| --- | --- |
| `cron_net_production_host` | 8 |
| `cron_indirect` | 1 |
| `vault_reference` | 8 |
| `url_literal_seed` | 12 |
| `other_blocking` | 1 |
| `review_only` | 47 |
| `clean` | 33 |

The 8 that name the production host with `cron.schedule` + `net.http_post`:

- `20260908110000_add_important_news_publish_ready_cron.sql`
- `20260910163500_add_send_push_notifications_dispatch_cron.sql`
- `20260916100000_mic_phase1b_automation_cron.sql`
- `20260919090000_mic_fx_phase1_automation_cron.sql`
- `20260921090000_mic_equity_index_phase1_automation_cron.sql`
- `20260923090000_mic_macro_indicators_phase1a_automation_cron.sql`
- `20260924093000_mic_estat_activation_and_gated_macro_cron.sql`
- `20260930090000_mic_scenario_automation_cron_phase3c.sql`

Indirect cron (rewrites existing job commands from Vault; no host in its text):

- `20260923110440_important_news_monitor_caller_auth.sql`

### Prerequisites the chain has at apply time (prerequisite oracle, local model baseline)

Control (unmodified model baseline, whole chain): **OK**. Candidates removed one at a time: function 27, table 11, trigger 11, column 47.

| removed object | kind | first refusal | file that refuses | in the Phase 12 contract |
| --- | --- | --- | --- | --- |
| `public.ensure_my_profile()` | function | P4: `COMMON_ACCOUNT_CORE_FENCE_PREFLIGHT_ENSURE_MY_PROFILE_SHAPE` | `20261012130000_common_account_core_service_fence.sql` | **NO — gap** |
| `public.social_mobile_account_deletion_subject()` | function | P1: `COMMON_ACCOUNT_PREFLIGHT_FUNCTION_MISMATCH` | `20261001150000_common_account_lifecycle_foundation.sql` | yes |
| `public.social_mobile_account_deletion_workspace()` | function | P1: `COMMON_ACCOUNT_PREFLIGHT_FUNCTION_MISMATCH` | `20261001150000_common_account_lifecycle_foundation.sql` | yes |
| `public.social_accounts.platform` | column | P6: `COMMON_ACCOUNT_SERVICE_OWNERSHIP_PREFLIGHT_SHAPE` | `20261013120000_common_account_service_deletion_ownership.sql` | **NO — gap** |

Not testable alone (they have dependents): `public.social_mobile_account_deletion_guard`, `public.scheduled_posts`, `public.social_accounts.id`, `public.tracked_stocks.id`.

<!-- GENERATED:DAG:END -->

**Unknown blockers (never inferred).**

1. The six production versions that are not in the repository, and the repository files that are not in the production history
   [R, `docs/common-account/phase2-production-apply.md`]: the DAG is about the repository's files; production's own history is
   read only by A1 / A2.
2. The two prerequisites of F-1 until the contract is extended and checked against production.
3. Neighbouring production migrations that were pending on 2026-10-07 (`20261003120000`, `20261006160000`, `20261006160100`,
   `20261006160200`) and `20261007150000`: their state now is **[U]**; none of them touches an object of the chain except
   `social_accounts` (`20261007150000`), whose shape A1 / A2 supply.
4. The three unknown relations: columns, constraints, indexes, policies, triggers and grants are known only through fixtures.
5. The stack: P3a…P10 live on unmerged PR branches; any change to a stacked PR changes a digest and invalidates the lock.

## 6. Disposable project: components, identity, users, teardown, cost (deliverable 4)

### 6.1 Components (and what must be absent)

| Component | Needed | Setting | Read-back before use |
| --- | --- | --- | --- |
| Project | one new project, never a branch or restore of production, never one that holds data | owner, billing and region chosen by the user | ref kept in the owner's note only |
| Postgres | baseline (A2) + P1..P10 + `public.kabumori_disposable_marker` (one row = the allow-listed ref) | applied only by `cli.ts` | marker row (G1); inventory (G3b); G3c counts |
| Auth (GoTrue) | e-mail provider ON; "confirm e-mail" OFF for the first pass; anonymous sign-ins OFF; sign-ups open; JWT expiry at the minimum for the expired-token check; Apple / Google / X OFF | dashboard | `/auth/v1/settings` (G2) and the dashboard values |
| PostgREST | exposed schema `public` only; `private` **not** exposed | dashboard | M10: a private function answers 404 |
| Edge | **only** `account-delete` (`verify_jwt` ON) and the inert X-saga stand-in (D-2) | a human deploys pinned bytes | function list: names, `verify_jwt`, digests; source download diffed against the pinned files (runbook §6 method) |
| Secrets | the platform-provided ones only (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`); **no** X, Threads, Apple, Google, AI, SMTP-provider or Expo secret | none to add | secret **names** listed (values never read) |
| Extensions | `pg_cron` and `pg_net` **not enabled**; no `create extension` by any applied file | dashboard default / operator | the inventory's `extension` lines; G3c counts |
| Storage / Realtime / Vault | no object, no channel, no secret | — | M12 reads the Storage inventory (empty) |

Two facts that shape the Edge deployment [O]: `account-delete` imports source from `supabase/functions/social-mobile-account-delete/`
(`apple_revoke.ts`, `delete_logic.ts`) and builds an Apple-revocation dependency only when `appleConfigFrom` finds Apple
configuration (`supabase/functions/account-delete/http.ts:15,137,186`); with no Apple secret `revokeApple` is `null`. A function
named `social-mobile-account-delete` is deployed from a directory of that name, so the stand-in must live **outside**
`supabase/functions/` (a scratch functions root) so that it never shadows the real source `account-delete` imports.

### 6.2 Environment identity: allow-list, deny-list, no production anything

The guard (`supabase/preflight/managed_disposable/guard.ts`) resolves a target only when all of these hold: the ref is on an
explicit allow-list of test-only projects; the allow-list holds no production ref; a production deny-list is supplied **and**
every project ref found in the repository's own files is added to it; the API URL is exactly the hosted form for that ref; the
operator typed the ref again; the DB URL names the same ref; the keys are the right kinds (no service role where a publishable
key belongs); the test e-mail domain is not a public mail provider (`EMAIL_DOMAIN_NOT_CONTROLLED`; the guard cannot prove that
the operator *controls* the domain — a reserved `.test` domain, which is not deliverable, is the plan's recommendation [A]);
and the project's own marker row names the target before **every** mutation (`runner.ts`). Client side, #243 adds a SHA-256 of
the production ref (never the ref) and refuses an environment that points anywhere else. This plan adds one rule: the
disposable's ref is never written into git, chat, a Report or an issue — only its SHA-256 and the owner's note.

### 6.3 Fake users, data rules, teardown and rollback

| user | state | purpose | expected |
| --- | --- | --- | --- |
| **A** | POSTONA only (`x_autopost` active), **no** Kabumori profile | enrollment (M4); the R2′ limitation | `withdraw_postona` answers `X_CLEANUP_UNSUPPORTED` — confirms F3's known limit; **not** a defect to fix here |
| **B** | POSTONA + Kabumori (profile exists) | M12 positive; cross-service isolation | POSTONA ends; Kabumori, profile and login byte-identical |
| **C** | Kabumori only | POSTONA operations never touch it; explicit enrollment into POSTONA | independent entitlements |
| **D** | POSTONA ended | `reenroll_required`; restart only at the reported version; stale token (M5) | no automatic restart |
| **E** | operator-seeded `locked` / `deletion in progress` (service-role SQL) | blocked outcomes in the gate | refusal copy, no bypass |
| **F** | anonymous | M6 | refused |

Rules: every login is created through the Auth admin API with an address on a domain the operator controls; passwords are
generated per run and never stored; no production row, token, dump or backup is ever restored or copied; no X workspace, Threads
provider row, Storage object or push token exists. Teardown: T1 removes every login the run created (a guard on the common
account may refuse a cascade — it then says so); then the owner **deletes the project**. Rollback of a failed run is deleting
the project; nothing is repaired in place and nothing is reused. The disposable's keys are throw-away and valid nowhere else.

### 6.4 Cost and capacity — assumptions that need external confirmation **[A]**

None of this is verified from the checkout. Confirm on the provider's live pricing and limits pages at approval time; no
figure is claimed.

| id | assumption | why it matters | if false |
| --- | --- | --- | --- |
| CA-1 | The owner's organisation can create one more project at no extra charge on the free tier | cost of the run | a paid compute add-on for the hours the project exists; delete it the same day |
| CA-2 | Free projects are paused after a period of inactivity | a stage left idle may need a restore | do the stages back to back; never resume a paused project without re-reading the marker |
| CA-3 | The built-in mail sender is rate-limited and may deliver only to members of the organisation | mail-based sign-up is unusable | users are admin-created with confirmed addresses; mail-based tests stay MANUAL |
| CA-4 | At this scale (a handful of users, two Edge functions) database size, egress, invocations and MAU limits are irrelevant | capacity | none expected |
| CA-5 | `pg_net` / `pg_cron` are not enabled by default in a new project, or can be left disabled | BG2 | if enabled by default, the extension inventory records it and G3c remains the guard |
| CA-6 | Auth settings changes (providers, redirects, JWT expiry) apply immediately | ordering of the run | re-read `/auth/v1/settings` before each stage |

## 7. Isolation from side effects: the negative plan (deliverable 3)

Everything below reuses what #233 provides: pinned bytes, the fail-closed scanner with the transitive helper closure
(`networkFunctions` is empty for the current corpus; `dynamicFunctions` is the named-acceptance list of 30), G3b before any
chain mutation (non-skippable, enforced at the mutation boundary), G3c before / after counts, and the dry-run default.

| Vector | Where it exists today [D] | Control | Check and STOP evidence |
| --- | --- | --- | --- |
| `pg_cron` schedule | 8 repository migrations plus 1 indirect rewriter (section 5, buckets `cron_net_production_host`, `cron_indirect`) | never applied; scanner `CRON_REFERENCE` blocks; extension not enabled | G3c: `cron.job` count and cron-reaching trigger count equal before / after; inventory `extension` lines; STOP on any increase |
| `pg_net` / `net.http_post` | the same 8 | scanner `NET_REFERENCE`; closure over helpers (`INDIRECT_NETWORK_CALL`, blocking, not acceptable by the lock); baseline export re-scanned | scanner result stored with the file digest; STOP on any finding in the chain or the export |
| indirect SQL helper chain (leaf → middle → top) | none in the corpus today (`networkFunctions: []`) | transitive closure by bare name; `INDIRECT_DYNAMIC_CALL` needs a named acceptance | lock regenerated and reviewed on any corpus change; `plan_static_test.ts` compares lock and a fresh build |
| production server URLs | the 8 files name the production host | `FOREIGN_PROJECT_HOST` / `SUPABASE_HOST_REFERENCE`; the guard adds every repository ref to the deny list | STOP at the guard (`TARGET_IS_PRODUCTION`) or the scanner |
| OAuth callback | `kabumori-social://oauth-callback` is the X **posting** callback; Auth receives only `auth-callback` | Edge `x-oauth-connect-user` not deployed; no X client secret; Auth providers OFF in the first pass | secret-name list empty of X; Edge function list; Auth settings read-back |
| X / Threads publish or revoke | `account-delete` → `social-mobile-account-delete` (X saga); the Threads provider registry ships empty and fails closed | the stand-in answers only `preview` / `run` for a user with no X workspace and calls nothing; no X / Threads secret; Threads and reservation gates OFF (#243 `OTHER_GATES_OFF`) | M12 asserts no outbound call (the stand-in has no network code; reviewed); STOP on any X / Threads row |
| paid AI | `social-mobile-consult` and the AI pipeline functions | not deployed; no AI key; #243 `SIDE_EFFECTS_ATTESTED` | secret names; Edge list |
| e-mail | Auth sign-up / recovery mail | admin-created users; autoconfirm; test domain | no mail-sending flow is part of the automated plan |
| push (Expo) | `device_push_tokens`; function `send-push-notifications` | table empty; function not deployed | row count 0; Edge list |
| database webhooks / event triggers | none expected | inventory `trigger` / `event_trigger` kinds | STOP on a trigger that mentions net or cron |
| production data, users, tokens | the baseline export is schema-only | no dump, backup, branch or import; the keys are the disposable's own | marker + allow-list + deny-list; A2 reviewed for literals |

STOP evidence format for every row: the step id, the finding code, the file digest or object name, and **no value** (the
redactor and the closed inventory attribute lists guarantee that).

## 8. Auth, PostgREST / RLS, RPC and Edge: what is verified, and where (deliverable 5)

### 8.1 `session_id` and the 600-second rule

| Fact | Source [O] | Source-model coverage | Managed-only unknown / test |
| --- | --- | --- | --- |
| the login is the token's `session_id`; a refresh keeps it, a new sign-in changes it | client `loginSessionIdOf` (`apps/social-mobile/src/domain/service-enrollment.ts:114`); SQL reads `request.jwt.claim.session_id` or `request.jwt.claims->>'session_id'` (`supabase/migrations/20261010051938_common_account_service_write_guard.sql:97,107`; `supabase/migrations/20261015090000_common_account_enrollment_session_fence.sql:108,117`) | Phase 9 suite; the model run's M4 | **M4**: GoTrue puts `session_id` in every access token; refresh keeps it |
| session liveness | `exists (select 1 from auth.sessions s where s.id = session and s.user_id = user and (s.not_after is null or s.not_after > clock_timestamp()))` (P3b `:154–156`, P9 `:138–140`); apply-time check that `auth.sessions` has `id`, `user_id`, `not_after` and is readable (P3b `:55–64`, P9 `:80–84`) | model with a stand-in `auth.sessions` | **M1**: the owner role can read it; **M5**: sign-out removes or expires the row |
| recent authentication | `RECENT_AUTH_SECONDS = 600` (`supabase/functions/social-mobile-account-delete/delete_logic.ts:21`); the newest `amr[].timestamp` of the verified token (`delete_logic.ts:74–81`); accepted only in `[now − 600, now]` (`supabase/functions/account-delete/lifecycle_logic.ts:207–210`) and used by withdraw (`:685`, `:721`) and whole-ID deletion (`:826`) | **exact boundary, source-model:** `supabase/functions/account-delete/lifecycle_logic_test.ts:82` (`now`, `now − 600` accepted; `now − 601` and any future time refused) | **M14 (proposed, not in `plan.ts`)**: GoTrue puts a numeric `timestamp` in `amr`; a **refresh does not advance it**; a managed check can only be coarse (≈ 570 s accepted, ≈ 630 s refused) because wall-clock skew makes 599 / 601 unobservable |
| a re-authentication is a new login | `reauthenticate` pins `{ userId, sessionId }` of the new session and refuses a different user (`apps/social-mobile/src/providers/auth-provider.tsx:212–238`) | G1 / G2 assembled tests (#238 / #240) | **M15 (proposed)**: an e-mail re-sign-in yields a new `session_id` for the same user and the enrollment gate asks again |

### 8.2 PostgREST, RLS, cross-user and cross-service rejection

Existing automated steps, run unchanged (`supabase/preflight/managed_disposable/plan.ts`): **M2** simultaneous sign-ups, **M5**
stale token vs restart, **M6** anonymous, **M7** anon key / forged / deleted-login token, **M8** RLS (own rows only; `source`,
`legacy_evidence` not selectable), **M9** ACL / ownership inventory again, **M10** SQLSTATE → HTTP status, **M11** lock timeout →
retryable. Additions of this plan (managed-only unless stated; **proposed**, to be added to `plan.ts` in a later TASK — not
done here):

| id | check | expected |
| --- | --- | --- |
| X-1 | user A's token reads / writes user B's `common_accounts` / `service_entitlements` through PostgREST | empty / refused |
| X-2 | `withdraw_postona` of B leaves C's rows and B's Kabumori entitlement, profile and login byte-identical | M12 read-back |
| X-3 | `reactivate_x_autopost_service(version)` with a stale version | `lifecycle_changed`; no change |
| X-4 | `reactivate_kabumori_service` with POSTONA's version | refused; independent state |
| X-5 | `begin_social_mobile_x_oauth_*` for a user with **no** active `x_autopost` entitlement | **callable today (G3's T13 gap, known)** — recorded, not fixed here (Phase 11 stage S6) |
| X-6 | service-role-only RPCs (`begin_service_deletion`, `claim_service_deletion`, `record_owned_*`, `finish_owned_*`) with a user token | 401 / 403, never 2xx |
| X-7 | a `private`-schema function by URL | 404 |

### 8.3 Edge functions and the closure of the legacy deletion path

| Check | Expected | Source |
| --- | --- | --- |
| `verify_jwt` ON for `account-delete` | a request with no `Authorization` header is refused by the platform before any code runs; the function also verifies the caller through `/auth/v1/user` | header `Keep platform JWT verification ON` (`supabase/functions/account-delete/http.ts:2`); runbook "must show `verify_jwt=true`" (`apps/social-mobile/docs/account-deletion-rollout-runbook.md:168`); no `config.toml` (F-5) → managed read-back (M13) |
| accepted actions | exactly `preview`, `withdraw_kabumori`, `withdraw_postona`, `delete_common_account`; anything else — including the legacy call with no body, which used to hard-delete the login — answers `400 ACTION_REQUIRED` before any request leaves the function | `supabase/functions/account-delete/http.ts:9–10,127`, dispatch `:220–226` |
| whole-ID deletion stays closed | `delete_common_account` with a valid confirmation, recent authentication and lifecycle version answers `409 COMMON_ACCOUNT_DELETION_UNAVAILABLE` while the `managed_auth_delete` gate is not `open` | `supabase/functions/account-delete/lifecycle_logic.ts:267–270,826–834` |
| the legacy `social-mobile-account-delete` | **not deployed** on the disposable (a call answers 404) except as the inert stand-in, which refuses every action but `preview` / `run`, and `run` only for a user with no X workspace | the client closure is #197 (`apps/social-mobile/docs/j5-postona-deletion-boundary.md`, pinned in `external`); the **server** closure is F3 / G3's and is **not claimed** here |
| the real saga, if ever deployed | answers `SCOPE_CHANGED` when the requested scope differs from the current one (`supabase/functions/social-mobile-account-delete/delete_logic.ts:156`); `social_and_login` is its login-deleting scope | separate approval, F3 |

The stand-in (D-2) is a new Edge source that does not exist yet: a pinned, reviewed function that answers `preview` with
`{ ok: true, scope: 'social_only', state: 'none' }` and `run` with the saga's success shape for a user with no X workspace, imports
nothing, calls no URL, and refuses everything else. Its contract belongs to F3 / G3; F5 pins its bytes in a lock like the
migrations. Until it exists, M12 cannot run (Phase 11 already says "else MANUAL").

## 9. Authentication stages (deliverable 6)

Real OAuth is **prohibited now**. The stages are ordered by how much of the outside world each touches; each is a separate
approval and starts only when the previous one is recorded PASS. Everything happens in the disposable project only.

| Stage | Method | Needs | Redirect handling | Side-effect isolation | Notes |
| --- | --- | --- | --- | --- | --- |
| **AS-A** (first, offline) | e-mail + password | autoconfirm ON, admin-created users | `kabumori-social://auth-callback` only; Q-1 decides exact vs pattern | no mail flow; no provider | everything in M1–M15; the sandbox build uses `EXPO_PUBLIC_AUTH_PROVIDERS=email` |
| AS-B | Google (browser) | a Google OAuth client created for this project, a test Google account | exact `auth-callback`; the provider's callback is the project's own `https://<ref>.supabase.co/auth/v1/callback` | real Google consent only; no data scopes | M3: linking behaviour (same verified e-mail → one user?) |
| AS-C | Apple (native and web) | Apple Developer service id / key, bundle id; the nonce flow | same | real Apple only; Apple revocation matters only to whole-ID deletion, which is closed | private-relay address ≠ the real address (M3) |
| AS-D | X as a **login** provider | an X developer app with this project's callback | same | **not** the X posting authorization (`x-oauth-connect-user` stays undeployed) | the login provider and the posting grant are different things |
| AS-E | Threads | none as a login; the Threads connection is Edge-based (F4's stack) | `…://oauth-callback` is a posting callback, not an Auth redirect | needs F4's Threads task and its own approval | out of scope until F4 finishes |

**Q-1 (managed-only).** The app passes `redirectTo: kabumori-social://auth-callback` and sets
`experimental.appendPkceFlowIdToRedirects: true`, so the URL Auth sees carries an appended flow id. Whether an **exact**
allow-list entry matches that is the provider's behaviour, not ours. Test it in AS-A before any other stage: sign up with the
exact entry only; if the redirect is refused, the minimal pattern that works is recorded and #243's "no wildcard" rule is revisited
with F4 — this plan does not pick a pattern in advance. Related: #243 also demands `oauth-callback` in Auth's list; from the
source only `auth-callback` is ever given to Auth, so that entry widens the list for no test benefit — a question for F4 (D-4).

## 10. F4 #243 preflight and Phase 12 #233 recheck (deliverables 7 and 8)

### 10.1 What #243 needs, and who provides it

| #243 check | Satisfied by | When |
| --- | --- | --- |
| `DATA_SOURCE_SUPABASE`, `ENV_FILES_CONSISTENT`, `ENV_FILES_NO_MOCK`, `KEY_IS_PUBLISHABLE`, `URL_NOT_PRODUCTION`, `URL_IS_DECLARED_SANDBOX` | the sandbox build's local `.env.local` (not committed) and the project's publishable key | PG7 |
| `SANDBOX_DECLARED`, `SANDBOX_NOT_PRODUCTION` | `POSTONA_SMOKE_SANDBOX_REF` = the allow-listed disposable ref (or `local` with a localhost URL, D-3), compared to a SHA-256 of the production ref | PG4 / PG7 |
| `REDIRECTS_DECLARED` | `POSTONA_SMOKE_AUTH_REDIRECTS` as configured on the project (Q-1, D-4) | PG5 |
| `END_FLAG_LOCAL_ONLY` | `POSTONA_END_SOURCE_ENABLED` true in the working tree only, false in Git `HEAD` | PG7 |
| `OTHER_GATES_OFF` | Threads / reservation switches false in source | already true |
| `OWNER_SIGNOFF` | the F5 sign-off record below | after PG6 |
| `SIDE_EFFECTS_ATTESTED` | `no-x-no-ai-no-real-email`, backed by the secret-name and Edge-list read-back | after PG5 |

**F5 sign-off record** (what `POSTONA_SMOKE_F5_SIGNOFF` refers to; kept by the owner, never in git): date and expiry; the
`plan.lock.json` commit; the baseline digest and the approved contract digest; the harness report summary (`complete`, no open
manual item except those listed); the Auth settings read-back (providers, autoconfirm, redirects, anonymous, JWT expiry); the
Edge function list (names, `verify_jwt`, digests); the secret-name list; confirmation that `cron.job` and network-trigger counts
are unchanged; and the sentence "this project holds no X, Threads, AI or production data".

### 10.2 Confirmed REFUSED today (offline; exact output in section 13)

On the exact #243 head, in a clean environment, the script prints `PREFLIGHT: REFUSED (10 failing)` and exits 1; it passes only
`ENV_FILES_CONSISTENT`, `ENV_FILES_NO_MOCK` and `OTHER_GATES_OFF`. Its own 15 tests pass. Nothing in this plan changes that
until PG4–PG6 have produced a project, its settings and the sign-off. **No F5 sign-off exists and none is issued by this
document.**

### 10.3 Phase 12 #233: the restricted recheck required before any real apply (no whole-scope review)

| Boundary | Where | Why a recheck is enough |
| --- | --- | --- |
| non-skippable G3b and the mutation grant | `runner.ts` (`unsafeSelection`, baseline grant at the mutation boundary), `plan.ts` (`requires`) | changed after the last security pass; every mutating path depends on it |
| probe bytes = verified bytes | `runner.ts` probe handling, `transports.ts` `sqlProbe(path, bytes)` | the inventory and the release probe both travel this path |
| transitive helper closure and named acceptance | `sql_scan.ts` closure functions, `lock.ts`, `runner.ts` refusals | the substitute for reading every SQL file by eye |
| inventory input vetting | `inventory_cli.ts` `vet`, `inventory.ts` `secretFindings` / shape validation | the only tool that opens a production-derived file |
| **not yet evaluated against a real catalog** | `inventory/schema_inventory.sql` redaction over real definitions; the contract subset in `inventory.ts` | A1's first run is itself the test; the recheck covers the query text and the allow-lists only |
| out of scope | everything J1 passed unchanged; the G1 / G2 gate (#240, reviewed separately); older phases | no duplicate review |

(All paths are under `supabase/preflight/managed_disposable/`.) Re-run for the recheck, all offline: the `managed_disposable`
Deno suite, the scanner / harness / inventory mutation scripts, the inventory proof and the model run — commands in
`docs/common-account/phase11-managed-disposable-readiness.md` and `docs/common-account/phase12-schema-baseline-and-cron-isolation.md`.

## 11. Phased GO / NO_GO (deliverable 9)

Every row is a **separate, explicit owner approval**. A GO on one row never implies the next. All rows are NO_GO today. The
column "Phase 11 stage" maps each gate to the existing S0–S8 table, which this one refines and does not replace.

| Gate | Phase 11 stage | What is approved | Prerequisites | Copy-ready approval | Tests / evidence that must pass | STOP |
| --- | --- | --- | --- | --- | --- | --- |
| **PG0** this design | — | the plan as the basis for the next gates | — | G4 accepted `SOURCE_ONLY_DESIGN_GO` on 2026-10-17 | `architecture_plan_test.ts`, section 13 | — |
| **PG1** restricted #233 recheck | S1 | one focused review of section 10.3 | #233 stays at its head | "J1 may review exactly the boundaries of section 10.3 of Phase 13" | reviewer PASS or a P2 list | any P1 / P2 open |
| **PG2a** production catalog inventory (A1) | S2 | one read-only run of the pinned query by a CONNECT-only login | PG1; D-1 settled | "Authorize one read-only run of `inventory/schema_inventory.sql` (SHA-256 `<from plan.lock.json>`) against production, with login `<name>` that can only CONNECT, on `<date / window>`; the output file stays outside git and chat" | `inventory_cli check` = `READY_FOR_OWNER_REVIEW`; two runs, same contract digest | secret-shaped output; any statement other than SELECT; a role that needs more than CONNECT |
| **PG2b** DDL export (A2) | S2 | `pg_dump --schema-only` of the baseline objects, then human trim | PG2a; contract extended (D-1) | "Authorize a read-only schema-only export of the 17 baseline relations and the three baseline functions; reviewed and trimmed; only the digest and the scan result are reported" | zero blocking scanner findings; digest recorded | any trigger / cron / host / URL / literal left in |
| **PG3** owner approval | S2 | the contract digest and the baseline file | PG2a, PG2b | "I approve contract digest `<64 hex>` and baseline digest `<64 hex>`" (recorded in the Report, not in git) | G3b equality is then possible | the digest is not approved |
| **PG4** disposable project | S0 | creation of one empty project (hosted) **or** a local stack | PG3; D-3 | "Authorize creating one new Supabase project `<name>`, region `<r>`, outside production; add its ref to `KABUMORI_DISPOSABLE_ALLOWLIST` only" | marker row; Auth read-back; extensions list | reuse of production, a branch, a backup |
| **PG5** test migration / RPC / Edge deployment | S3 | baseline + P1..P10 by pinned bytes; `account-delete` and the stand-in by pinned bytes; Auth settings | PG4; stand-in reviewed (D-2) | "Authorize `cli.ts --execute` for steps G1..G4 against project `<ref>` with the lock at commit `<sha>`, contract digest `<hex>`, baseline digest `<hex>`; deploy exactly these Edge functions with these digests" | G3b, G3c, G4 probe, the P1 / P2 fidelity check (4.4); function list; secret names | the first FAIL / STOP |
| **PG6** managed smoke | S4 | M1–M15 and X-1…X-7, stage AS-A only | PG5 | "Authorize the acceptance run M1–M15 and X-1…X-7 against project `<ref>`; teardown always" | every step PASS; manual items recorded | any FAIL / STOP; a "complete" with an open item |
| **PG7** iPhone test | S5 | a sandbox build against the project | PG6; the F5 sign-off record; #243 prints READY | "Authorize a sandbox build and a device test against project `<ref>`" | #243 prints READY; F4's checklist | the preflight REFUSES |
| **PG8** later auth stages | S5 / S6 / S7 | AS-B … AS-E, one at a time | PG6 / PG7 PASS; provider credentials created for the disposable only | one approval per provider | its row in section 9 | any real data scope |
| **PG9** production release | S8 | **a different document and TASKs** | all of the above, D1, G3 T13, F3 legacy, managed Auth proofs | — | — | not authorized by anything here |

`managed_auth_delete` stays BLOCKED, `IDP_PREPAUSE_BLOCKED` stays BLOCKED, `POSTONA_END_SOURCE_ENABLED` stays false in Git, and
every release gate stays OFF through PG0–PG8. The disposable project should be created **immediately before** PG5 (CA-2): PG4
may be approved early, but the project is not needed until the baseline exists.

## 12. Handoff to POSTONA G4 (deliverable 10)

- **PRs and heads:** this branch stacks on #233 `499a9e1fac595064fbc3928725be8907db1b692b`; the cited heads are in section 2.
- **Open decisions:** D-1 … D-5 (section 1). Q-1 (redirect pattern) and CA-1 … CA-6 (cost, capacity) need external confirmation.
- **Requests to other owners:** **F3 / G3** — the contract of the X-saga stand-in and the server closure of the legacy
  `social-mobile-account-delete` (R2′, F3-L1); **F4** — whether `oauth-callback` belongs in Auth's redirect list (#243) and the
  Threads task's timing; **F5 (next TASK)** — extend the contract and the baseline export (F-1), pin the stand-in, add M14 /
  M15 / X-1…X-7 to the plan.
- **Blockers that remain:** BG1 (the production inventory is not taken), the two contract gaps, the stand-in does not exist, no
  disposable project, no Docker for a local stack, the #233 recheck is pending, D1 whole-ID deletion consent, G3 T13, F3
  legacy and R2′, and everything in section 8 marked managed-only.
- **Safety boundaries kept:** no project, inventory, migration, OAuth, SNS, AI, mail, external HTTP, merge or deploy; production
  NO_GO; the Kabumori pause and the common Auth / POSTONA operation untouched.
- **Cost / capacity:** assumptions CA-1 … CA-6 only; no figure is claimed.
- **Next requests, in order:** (1) decide D-1 … D-3; (2) F5 contract extension + stand-in pin; (3) PG1 recheck; (4) PG2a / PG2b
  approvals when the owner is ready.

## 13. What was executed for this document (offline; exact commands and outputs)

All commands ran in `/Users/yuya/Developer/kabumori-f5-arch` (a clean worktree of #233), in a scratch local PostgreSQL 17 with
fake data, or in a detached read-only scratch checkout of #243's head, with no network and no credential. Outputs are quoted from
the runs; nothing is claimed beyond them.

| # | Check | Command (run from the worktree root unless stated) | Result |
| --- | --- | --- | --- |
| 1 | the pinned DAG, the exclusion list and the oracle summary are reproducible and equal the committed files | `deno run --no-config --no-check --allow-read --allow-write supabase/preflight/managed_disposable/architecture_dag.ts --write`, then `deno run --no-config --no-check --allow-read supabase/preflight/managed_disposable/architecture_dag.ts --check` | `wrote docs/common-account/phase13-migration-dag.json (10 chain nodes, 110 excluded) and the generated tables of …`; then `the DAG json and the generated tables are current` |
| 2 | links, hashes, dependency order, secrets, production refs, partition of the 120 migrations, the BG2 list, the oracle numbers, every cited line, the 13 #243 checks, the G3b-before-mutation order, the dry run | `deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/architecture_plan_test.ts` | 17 passed, 0 failed (mutation-style cases included: one added byte, a smuggled `cron.schedule`, a tampered table are each detected) |
| 3 | the whole harness suite, unchanged tests included | `deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/` | 101 passed, 0 failed (84 existing + 17 new) |
| 4 | type-check and lint of the two new TypeScript files | `deno check --no-config supabase/preflight/managed_disposable/architecture_dag.ts supabase/preflight/managed_disposable/architecture_plan_test.ts`; `deno lint --no-config` on the same two files | both clean (`Checked 2 files`) |
| 5 | the harness in its default dry-run mode, empty environment, no transport | `env -i PATH="$PATH" HOME="$HOME" deno run --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/cli.ts` | `mode: dry-run`, 29 steps `NOT_RUN`, `summary: pass=0 fail=0 stop=0 warn=0 manual=0 not_run=29 complete=false`; nothing was called |
| 6 | the prerequisite oracle, throw-away local PostgreSQL 17, fake data, `/tmp` socket only | `CAL_PGHOST=<tmp socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_phase13_prerequisite_oracle.sh > oracle.tsv` | 97 lines, ~21 s; SHA-256 `ca3dfdd0e25f714b14d289d7b2f9bb2c989e4a0538926b4687878e6673a2edef` — byte-identical to `docs/common-account/phase13-prerequisite-oracle.tsv`; control `OK`; four `FAIL` rows (section 4.3) |
| 7 | the external files are what the evidence table says | for each entry of `phase13-migration-dag.json` → `external`: `git rev-parse <commit>:<path>` | all 7 git blob ids match the pinned ones |
| 8 | tools of this machine (finding F-4 and F-5) | `command -v docker`; `ls supabase/config.toml` | `docker: not found`; `ls: supabase/config.toml: No such file or directory` |
| 9 | F4 #243 preflight on its exact head, clean environment (a detached scratch checkout, read-only; the script reads local files and `git show HEAD:` only and uses no network) | `git worktree add --detach <scratch> 60e4a4c059a9d7304e5a48a7b3219ab801e822ae`; in `apps/social-mobile`: `env -i PATH="$PATH" HOME="$HOME" node scripts/postona-sandbox-preflight.mjs; echo "exit=$?"` and `node --test tests/postona-sandbox-preflight.test.mjs` | output below; its own tests: 15 passed, 0 failed |

Output of check 9 (`exit=1`):

```
FAIL DATA_SOURCE_SUPABASE (unset (mock))
FAIL SANDBOX_DECLARED
FAIL SANDBOX_NOT_PRODUCTION
FAIL URL_NOT_PRODUCTION (missing)
FAIL URL_IS_DECLARED_SANDBOX
PASS ENV_FILES_CONSISTENT
PASS ENV_FILES_NO_MOCK
FAIL KEY_IS_PUBLISHABLE
FAIL REDIRECTS_DECLARED (missing: kabumori-social://auth-callback,kabumori-social://oauth-callback)
FAIL END_FLAG_LOCAL_ONLY (end flow disabled in this checkout (nothing to test))
PASS OTHER_GATES_OFF
FAIL OWNER_SIGNOFF
FAIL SIDE_EFFECTS_ATTESTED
PREFLIGHT: REFUSED (10 failing)
```

What was **not** run, on purpose: any managed or production access, `supabase link` / `db push` / the CLI against a project, the
inventory SQL against any database (the pinned query was only compared by digest; its first evaluation on a real catalog is
PG2a), any Edge function, any OAuth / X / Threads / Apple / Google / AI / mail call, any EAS build, any merge or deploy. The
checks above prove that the plan is consistent with this checkout and that its pins can fail; they do **not** prove any managed
behaviour (section 8 lists those as managed-only).

## 14. Open questions (nothing here is inferred)

| id | question | owner | how it is answered |
| --- | --- | --- | --- |
| Q-1 | does a hosted Auth accept an exact redirect entry when the flow id is appended? | managed | AS-A, first sign-up |
| Q-2 | which repository migrations are applied in production besides P1 / P2, and which production versions are not in the repository? | production (read) | A1 plus the history table, under the same approval |
| Q-3 | who created `brands` / `social_accounts` / `social_account_oauth_states`, with which columns? | production (read) | A1 / A2; never inferred |
| Q-4 | are `pg_cron` / `pg_net` enabled by default in a new hosted project? | managed | extension inventory on creation (CA-5) |
| Q-5 | does a refresh advance `amr[].timestamp`? | managed | M14 |
| Q-6 | can a local Supabase stack replace the hosted project for PG5 / PG6? | owner (Docker) | D-3 |
| Q-7 | which other objects does the chain need at **run** time (late-bound bodies)? | managed / model | the M-steps; the oracle covers apply time only |
| Q-8 | what exactly does the stand-in answer, and who reviews it? | F3 / G3 (contract), F5 (pin) | D-2 |
