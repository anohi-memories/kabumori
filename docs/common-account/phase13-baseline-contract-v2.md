# Phase 13 (F5) — baseline contract v2: `public.ensure_my_profile()`, `public.social_accounts.platform` and `auth.uid()`

Status: **source-only; nothing was run against a managed or production system.** The only database used is a throw-away local
PostgreSQL 17 with fake data. No production schema-only inventory was taken, no Supabase project was created, no migration was
applied outside that local database, no OAuth / SNS / AI / mail / HTTP call was made, nothing was merged or deployed. Production
is **NO_GO**; `managed_auth_delete` and `IDP_PREPAUSE_BLOCKED` stay BLOCKED; every release gate stays OFF.

TASK `common-account-f5-phase13-baseline-contract-extend-20261017` (G4 approved D-1 on 2026-10-17). It implements decision **D-1**
of `docs/common-account/phase13-postona-disposable-supabase-architecture.md`: extend the Phase 12 baseline contract and the safe
export specification **before** any production read is requested, so that the one production read that will eventually be
authorized (PG2a) is also the last one.

Evidence labels (as in the architecture plan): **[O]** observed in this checkout, **[R]** recorded in the repository's coordination
files, **[D]** derived by this phase's tools (reproducible with the commands in section 7), **[A]** assumption needing external
confirmation, **[U]** unknown — never inferred.

## 1. What changed, in one table

| Object | Needed by (explicit preflight in the chain file) | What the file checks | What contract v2 requires | Origin of the object |
| --- | --- | --- | --- | --- |
| `public.ensure_my_profile()` | P4 `20261012130000_common_account_core_service_fence.sql` — `COMMON_ACCOUNT_CORE_FENCE_PREFLIGHT_ENSURE_MY_PROFILE_SHAPE` | exists with **no argument**, returns **uuid**, **invoker rights** (not security definer) | the same three facts (read out of the file), as a *function shape* — **only until P4 has run** (P4 replaces the function, see 2.4); the fingerprint keeps the attributes the chain leaves alone (kind, language, volatility, owner, return type, search_path, ACL); a body that mentions cron / net / vault / a URL / a host is refused outright | **repository_created** by `20260924100000_ensure_my_profile.sql` [D]; P4 and P9 later replace it; production's copy was recorded as identical to the reviewed source on 2026-10-07 [R, `docs/common-account/phase2-production-apply.md`] |
| `public.social_accounts.platform` | P6 `20261013120000_common_account_service_deletion_ownership.sql` — `COMMON_ACCOUNT_SERVICE_OWNERSHIP_PREFLIGHT_SHAPE` | the column exists (not dropped) | exists **and has type `text`** (stricter than the file: the repository's only statement of the type, see 2.2); nullability, default and generated-ness are in the fingerprint | **unknown baseline**: `public.social_accounts` is altered by migrations but created by none [D]; its production DDL is outside the repository [R, `docs/postona/multi-social-phase1.md:43`] |
| `auth.uid()` | P3b `20261010051938_common_account_service_write_guard.sql` and P4 — `COMMON_ACCOUNT_WRITE_GUARD_PREFLIGHT_FOUNDATION_MISSING`, `COMMON_ACCOUNT_CORE_FENCE_PREFLIGHT_FOUNDATION_MISSING` | exists | exists, is an ordinary function, **returns uuid**; owner, body and ACL are *not* in the fingerprint (the managed platform's own business) | **platform_managed**: created by Supabase, never by this repository |

How they were found: the first two by the Phase 13 prerequisite oracle (one baseline object removed at a time, then the chain
applied); the third by a **static audit** of every chain preflight (`supabase/preflight/managed_disposable/chain_preflight_audit.ts`),
which independently re-finds all three under the Phase 12 contract and nothing under v2. `auth.uid()` was not asked for by the TASK;
it is the same class (a baseline object a chain file refuses without) and is cheaper to add now than to discover after the production
read. It is listed separately so G4 can veto it.

## 2. How the contract is built

### 2.1 Code map (all F5-owned, all pure, none connects to anything)

| File (under `supabase/preflight/managed_disposable/`) | Role in contract v2 |
| --- | --- |
| `baseline_requirements.ts` | `extractRequirements` (Phase 1 lists, unchanged) + `extractChainPrerequisites` (reads P4, P3b, P6) + `buildRequirements` (the whole contract, `contractVersion: 2`). A preflight that no longer has the expected form is an **error**, never an empty list; a requirement the preflights name but `EXPECTATIONS` does not know is an **error** (a type is never guessed). |
| `inventory.ts` | `checkRequirements` gains `FUNCTION_KIND`, `FUNCTION_SHAPE`, `FUNCTION_MENTIONS`, `PLATFORM_FUNCTION_MISSING`, `PLATFORM_FUNCTION_SHAPE`, `CONTRACT_VERSION` and is chain-progress aware (`chainMarkersPresent`); `contractSubset` carries the new objects; `verifyInventory` checks the subset **and** the full lines; `shown()` keeps echoed values out of messages. |
| `lock.ts`, `plan.lock.json` | the lock embeds the v2 requirements; a lock without `contractVersion: 2` is refused by every verdict (`CONTRACT_VERSION`), so a stale lock can never be read as the current contract. |
| `baseline_report.ts`, `provenance.ts`, `baseline_provenance.json` | provenance of the new objects (classes above); `public.social_accounts.platform` joins the **unknown columns** (7 now). |
| `chain_preflight_audit.ts` | the static audit; a regression guard (`uncovered()` must stay empty). |
| `inventory_fixtures.ts` | the synthetic inventory provides the v2 objects. |
| `plan.ts` | G3b wording only; the check itself is `verifyInventory` (unchanged entry point). |

**Not changed:** the inventory query `inventory/schema_inventory.sql` (SHA-256 `93b1ca05e381989c342aa1add93e7ab710d6b69110b758151fb131fc8d5926cb`,
the same as in Phase 12 — it already emits function lines for every non-extension function, including `auth.uid()`), the 10-file
allow-list of the chain, the 110 excluded migrations, the scanner, the runner, the guard. Nothing enables Cron or net HTTP.

### 2.2 Evidence for what no chain file states

| Statement | Evidence | Strength |
| --- | --- | --- |
| `social_accounts.platform` is `text` | `supabase/migrations/20261007150000_postona_social_accounts_multi_provider.sql` lists the production shape it expects: `'platform | text | not null | ''x''::text |  | default'` [O]; P6's own code uses it as a text key (`jsonb_object_agg`, `jsonb_agg ... order by`) [O] | repository expectation; **deliberately stricter than P6**. If production differs (say `varchar`), G3b STOPs with `COLUMN_TYPE` and the owner decides — a loud STOP, not a guess. |
| `auth.uid()` returns uuid | `supabase/migrations/20260924100000_ensure_my_profile.sql` assigns it to a uuid variable [O]; **observed on the local database**: without it P1 stops with `function auth.uid() does not exist`, returning text it stops with `operator does not exist: text = uuid` (cases C08, C09 below) [D] | apply-time need, first refused by **P1**, explicitly checked by P3b and P4 |

The `EXPECTATIONS` table in `baseline_requirements.ts` carries the evidence phrase; a test searches the named file for it.

### 2.3 What the repository says about each object's DDL, defaults, grants and dependencies

Everything here is read from files [O]; nothing is a production fact. The contract does **not** depend on the rows marked "manifest only".

| Object | DDL, defaults and grants known from the repository | Dependencies | Manifest only (the owner reads it in the inventory, the digest does not pin it) |
| --- | --- | --- | --- |
| `public.ensure_my_profile()` | `supabase/migrations/20260924100000_ensure_my_profile.sql`: `returns uuid`, `language plpgsql`, `volatile`, `security invoker`, `set search_path = ''`; reads `auth.uid()`, raises `42501 AUTHENTICATION_REQUIRED` when it is null, then `insert into public.profiles (id) … on conflict (id) do nothing`; `revoke all … from public, anon, authenticated, service_role; grant execute … to authenticated`. P4 later replaces it by a definer wrapper of the Phase 2 start and re-grants only `authenticated`; P9 pins the md5 of that **post-P4** body (chain state, not baseline). | `public.profiles(id)` uuid (contract), `auth.uid()` (contract v2), the caller's insert privilege and RLS on `public.profiles` (invoker rights) | the `profiles_insert_own` / `profiles_select_own` policies the file's comment names |
| `public.social_accounts.platform` | no creating DDL in the repository. `supabase/migrations/20261007150000_postona_social_accounts_multi_provider.sql` (a G4 migration, **not** in the chain) states the production shape it expects before it runs: column `platform text not null default 'x'::text`, `CHECK ((platform = 'x'::text))`, `UNIQUE (brand_id, platform)`, a unique index on `(platform, platform_user_id) WHERE (platform_user_id IS NOT NULL)`. `supabase/migrations/20260924023133_x_autopost_phase1b_account_bound_queue.sql` adds `UNIQUE (id, brand_id, platform)` but is marked "SOURCE CANDIDATE ONLY. Do not apply", and G4's expected list does not contain it. | the table `public.social_accounts` and `brand_id` (contract) | the constraints and indexes above; whether either migration is applied in production is **[U]** (the contract needs only the column) |
| `auth.uid()` | Supabase's own function; the repository's fixtures define a stand-in (`returns uuid`, `stable`) | none | owner, body, ACL (platform version) |

### 2.4 The chain REPLACES `ensure_my_profile()`: why the read-back must stay re-runnable (found by the Phase 11 model run)

P4 (`create or replace function public.ensure_my_profile()`) turns the legacy bootstrap into a security-definer wrapper of the Phase 2
start, and P9 replaces it again. A first version of contract v2 fingerprinted the whole function line; the existing Phase 11 model
run then failed with "the contract digest is the same before and after the chain" — and the same flaw would have blocked the
documented one-file-per-invocation operation, where G3b is re-run before **every** chain file (J1 V1 R2). The final design:

- while P4's marker function `private.account_lifecycle_service_state_refusal(uuid,text)` does **not** exist, the baseline shape is
  strict (no argument, `uuid`, invoker rights — what P4 refuses without);
- once it exists the function is **chain-owned**: its security mode and body are the chain's (P4's own preflight and P9's md5 pin
  verify them), so only kind, return type and "does not reach out" still stop;
- the fingerprint keeps only what the chain leaves alone (kind, language, volatility, owner, return type, search_path, ACL), so the
  digest is **the same before and after every chain file** (cases K01–K10 below);
- the body is therefore not baseline drift that matters (P4 overwrites it); a body that mentions cron / net / vault / a URL / a
  Supabase host is refused outright instead (`FUNCTION_MENTIONS`), and the A2 export is scanned for the same things.

The marker and the replacement are recorded in `EXPECTATIONS.functionReplacements` with their evidence phrase; a P4 that no longer
replaces the function, or a replacement without a recorded marker, is an error.

## 3. What stays unknown (needs the separately authorized catalog read, never inferred)

| Unknown | Why it cannot be settled from the repository | Settled by |
| --- | --- | --- |
| Production's `social_accounts.platform` nullability, default, CHECK and unique constraints | `social_accounts` has no creating DDL in the repository; the G4 preflight and the multi-social note describe an *expected* state | PG2a (the inventory lines `column`, `constraint`, `index`) — the fingerprint pins nullability and default, the manifest shows the constraints |
| Whether the repository's alterations of `social_accounts` (`20260924023133`, `20261007150000`) are applied in production | `20260924023133` is marked a source candidate and G4's `20261007150000` expects a pre-state without it [O]; neither is in the chain | PG2a (`constraint` / `index` lines); the contract needs only the column |
| Whether production's `ensure_my_profile()` still is the reviewed source today | recorded identical on 2026-10-07 [R]; nothing newer; its body hash is deliberately **not** in the fingerprint (P4 overwrites it) | PG2a (`function` line: body hash, ACL, owner) — read by the owner in the manifest |
| `auth.uid()` on the managed platform | Supabase's own object; only its return type is contract | PG2a for production; the disposable project's own inventory (G3b) for the test project |
| That the applying role can EXECUTE `auth.uid()` | P3b checks `has_function_privilege(current_user, 'auth.uid()', 'EXECUTE')` [O]; the inventory shows ACLs, not the applier | the chain apply itself (P3b refuses); stated as a **non-inventory** condition |
| `storage.objects.bucket_id` / `.name` (P3a) | P3a reads them inside a function body and answers `unknown_shape` when absent (fail-closed, run time) | the managed M-steps (Q-7) |
| Column-level grants on any required column | the fingerprint takes the relation ACL, not column ACLs (a Phase 12 design choice, unchanged) | the manifest (full inventory), read by the owner |

Missing, retyped, reshaped or moved objects are STOPs; **nothing is repaired or synthesised** to make a baseline pass.

## 4. The safe export (A1 / A2) after this change

- **A1** (read-only catalog inventory, `inventory/schema_inventory.sql`) is byte-identical to Phase 12. What contract v2 reads from
  it: the `function` lines `public.ensure_my_profile()` and `auth.uid()`, the `column` line `public.social_accounts.platform`, the
  `relation` and `constraint` lines of Phase 12. Redaction is unchanged: every stored expression is a masked shape plus a SHA-256, a
  function body is a hash, a length and five booleans; no row, no secret, no setting value.
- **A2** (the baseline DDL export for the disposable project) must now additionally contain, reviewed and trimmed by a human:
  `public.ensure_my_profile()` (**with** its definition), the column `public.social_accounts.platform` inside the `social_accounts`
  table definition, and nothing for `auth.uid()` (the disposable project is a managed project and has its own). The same rules: no
  trigger, cron, host, URL, Vault reference or literal; zero blocking scanner findings; its SHA-256 is recorded.
- **Acceptance** is unchanged in shape: the owner approves one 64-hex contract digest after reading the manifest; G3b recomputes it
  on the disposable project **after** A2 is applied and compares. Contract v2 digests differ from every Phase 12 digest (the subset
  has three more items), so **a Phase 12 digest can never be approved or passed by mistake** (tested).
- **Model digests** (reproducibility only; these are digests of the *fake local* baseline, **not** of production, and no production
  digest exists yet): fixture world `b6cc41f5dea461c7e46292e912439d059e30b5925042a0a699f2baa5d47c0270` (90 contract items; Phase 12: 87), replay world
  `f8c0ece8beab2975294623f9f31de52a4dec829ad254ef7bb00913dcdc3b14b8` (60 items; Phase 12: 58), from `baseline_provenance.json`.

### STOP conditions added

| Code | Raised when |
| --- | --- |
| `FUNCTION_MISSING` | `public.ensure_my_profile()` (exact name and no argument) is absent — an overload with an argument, or a copy in another schema, does not count |
| `FUNCTION_KIND` | it is a procedure / aggregate / window function |
| `FUNCTION_SHAPE` | it does not return `uuid`; or, **while P4's marker function does not exist**, it is a security definer |
| `FUNCTION_MENTIONS` | its body mentions cron / net / vault / a URL / a Supabase host (flags only: a body is never read) |
| `COLUMN_MISSING` / `COLUMN_TYPE` | `public.social_accounts.platform` is absent / not `text` |
| `PLATFORM_FUNCTION_MISSING` / `PLATFORM_FUNCTION_SHAPE` | `auth.uid()` is absent / not an ordinary function returning `uuid` |
| `CONTRACT_VERSION` | the requirements (a lock) are not contract version 2 |
| *drift* (digest differs) | anything inside the fingerprint changed: owner, ACL, volatility, language, search_path of `ensure_my_profile()`; nullability, default, generatedness of `platform`; ACL / RLS of the tables. **Not** drift: the body and security mode of `ensure_my_profile()` (the chain overwrites them), anything about `auth.uid()` beyond kind and return type |

Messages name objects and codes only; a value read from the inventory is shown only if it is a short identifier-like token that is
not secret-shaped (`shown()`), otherwise `<not shown>`.

## 5. Tests

### 5.1 Fail-before / pass-after on a real local PostgreSQL 17 (`supabase/tests/common_account_phase13_contract_extension_run.sh`)

The runner extracts the **Phase 12 code unchanged** from the base commit (`git archive`), builds the Phase 11 model baseline,
makes a copy per case, mutates it, runs the real read-only inventory query on it, **and applies the chain P1..P10 to it** for the
real answer. Two questions per case: **SELF** ("production itself looks like this": the digest of this very inventory is the
approved one, so only the *requirement* check can fire — this is the gap) and **DRIFT** ("the approved digest is the control's":
only the fingerprint can fire).

| Case | Mutation | Chain (real) | SELF Phase 12 | SELF v2 | DRIFT v2 |
| --- | --- | --- | --- | --- | --- |
| C00 | none (control) | OK | PASS | PASS | PASS |
| C01 | `ensure_my_profile()` dropped | **FAIL P4** `…ENSURE_MY_PROFILE_SHAPE` | **PASS (gap)** | **STOP** `FUNCTION_MISSING` | STOP |
| C02 | returns `bigint` | FAIL P4 | PASS (gap) | STOP `FUNCTION_SHAPE` | STOP |
| C03 | `security definer` | FAIL P4 | PASS (gap) | STOP `FUNCTION_SHAPE` | STOP |
| C04 | only `ensure_my_profile(uuid)` exists | FAIL P4 | PASS (gap) | STOP `FUNCTION_MISSING` | STOP |
| C05 | moved to schema `private` | FAIL P4 | PASS (gap) | STOP `FUNCTION_MISSING` | STOP |
| C06 | `social_accounts.platform` dropped | **FAIL P6** `…OWNERSHIP_PREFLIGHT_SHAPE` | PASS (gap) | STOP `COLUMN_MISSING` | STOP |
| C07 | `platform` is `varchar(16)` | OK (stricter on purpose) | PASS | STOP `COLUMN_TYPE` | STOP |
| C08 | `auth.uid()` dropped | **FAIL P1** `function auth.uid() does not exist` | PASS (gap) | STOP `PLATFORM_FUNCTION_MISSING` | STOP |
| C09 | `auth.uid()` returns `text` | FAIL P1 `operator does not exist: text = uuid` | PASS (gap) | STOP `PLATFORM_FUNCTION_SHAPE` | STOP |
| C10 | `ensure_my_profile()` executable by `anon` | OK | PASS | PASS | **STOP (drift)**, Phase 12 PASS |
| C11 | `ensure_my_profile()` body replaced (same shape, language, volatility, search_path: only the body hash differs) | OK | PASS | PASS | PASS — deliberately not fingerprinted (P4 overwrites it) |
| C12 | `social_accounts` readable by `authenticator` | OK | PASS | PASS | STOP, Phase 12 STOP (unchanged) |
| C13 | `platform` loses NOT NULL | OK | PASS | PASS | **STOP (drift)**, Phase 12 PASS |
| C14 | a key-shaped function name is planted | OK | STOP (secret) | STOP (secret) | no verdict echoes it |
| C15 | Phase 1 helper `…deletion_subject` dropped | FAIL P1 | STOP | STOP | unchanged invariant |
| C18 | `ensure_my_profile()` language changed to `sql` (a stable attribute) | OK | PASS | PASS | **STOP (drift)**, Phase 12 PASS |
| C19 | `ensure_my_profile()` body mentions a URL (flag only) | OK | PASS | **STOP** `FUNCTION_MENTIONS` | STOP |
| K01–K10 | the **unmodified** baseline with the chain applied through P1, P2, P3a, P3b, P4, P5, P6, P8, P9, P10 (the read-back before the next file) | OK | PASS | PASS | **PASS with the same digest** after every prefix |

Eight cases (C01–C06, C08, C09) are the **real gap**: the chain refuses, the Phase 12 gate passed its own digest. In every case where
a chain file refuses, contract v2 has already stopped (asserted). K01–K10 prove the property section 2.4 exists for: the baseline
read-back can be re-run before every chain file.

### 5.2 Offline unit tests (`baseline_contract_v2_test.ts`, 14 tests + the existing suites)

Extraction follows the text (changed return type / security flag / argument count / list of columns / removed check each change or
break the requirement and never produce an empty list); the check matrix above at logic level, including overloads and a copy in
another schema; the logic-level fail-before / pass-after; a stale or future contract version is refused everywhere; the fingerprint
(11 inside changes STOP; the body of `ensure_my_profile()`, a platform function's own details and unrelated changes do not); the chain-progress behaviour of 2.4; hostile or misleading content (key-shaped name, smuggled
attribute, unmasked literal, non-hash hash, duplicate line, network-mentioning body) is refused **without echoing the value**; the
static audit (clean under v2, three gaps under the Phase 12 coverage, and a *new* baseline object in a future preflight is
reported).

## 6. Conditional dependencies and gates (nothing here is started)

### 6.1 D-2: the inert X-saga preview stand-in — F3/G3 must confirm the contract first

F5 does **not** implement or alter anything F3-owned (legacy X cleanup, reservation, posting, revoke, any production endpoint).
This is a **proposal only**, for F3/G3 to accept, change or reject (the contract is theirs; F5 would only pin the accepted bytes):

- name: `social-mobile-account-delete` (the name `account-delete` calls), deployed from a directory **outside** the repository's Edge
  functions directory, so that it never shadows the real source `account-delete` imports from;
- `verify_jwt` ON; accepts only `{"action":"preview"}` and `{"action":"delete", "confirmation", "expected_scope":"social_only"}`;
  everything else `400 ACTION_REQUIRED`;
- `preview` → `200 {"ok":true,"scope":"social_only","state":"none"}`; `delete` → the saga's success shape **only** for a person with
  no X workspace, otherwise `409 SCOPE_CHANGED`; it imports nothing, reads no secret, calls no URL;
- open for F3/G3: what it answers for a POSTONA-only person (no Kabumori profile) given the known R2′ limitation of the real saga.

### 6.2 D-3: the hosted disposable project stays a design

No project is created, no paid action taken, no credential stored, no data copied, no deployment. The options and cost assumptions
(CA-1…CA-6) stay in the architecture plan (section 6).

### 6.3 The Phase 12 #233 limited P2×4 recheck is a future gate, not an automatic review

PG1 of the architecture plan stands. **Scope note:** this change edits `inventory.ts` (`contractSubset`, `checkRequirements`,
`shown()`), which the recheck's "inventory input vetting" boundary covers, so the PG1 reviewer should include these three
additions (about 40 lines) and `baseline_requirements.ts` (new). Nothing else changes the recheck's scope.

## 7. What was executed (offline; exact commands and outputs are in section 9)

All commands ran in `/Users/yuya/Developer/kabumori-f5-d1` (a clean worktree stacked on PR #250). The only database is a throw-away
local PostgreSQL 17.11 (`listen_addresses` empty, Unix socket under `/private/tmp`, fake data, deleted at the end); every runner
refuses a host that is not a `/tmp` socket directory. No network, no credential, no managed project.

| # | Check | Command | Result |
| --- | --- | --- | --- |
| 1 | contract v2 unit tests | `deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/baseline_contract_v2_test.ts` | 14 passed, 0 failed |
| 2 | the whole harness suite (existing tests included) | `deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/` | 115 passed, 0 failed (101 before this change + 14) |
| 3 | type-check and lint | `deno check --no-config supabase/preflight/managed_disposable/*.ts`; `deno lint --no-config supabase/preflight/managed_disposable/` | no error; `Checked 30 files`, no problem |
| 4 | the Phase 13 DAG evidence is current | `deno run --no-config --no-check --allow-read supabase/preflight/managed_disposable/architecture_dag.ts --check` | `the DAG json and the generated tables are current` |
| 5 | **fail-before / pass-after on the real base code** (section 5.1) | `CAL_PGHOST=<tmp socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_phase13_contract_extension_run.sh` | 53 `PASS` lines, 0 `FAIL`, `P13_CONTRACT_PROOF|ALL|PASS`; `P13_CONTRACT_GAP|…: C01,C02,C03,C04,C05,C06,C08,C09` |
| 6 | the provenance report is current | `bash supabase/tests/common_account_phase12_baseline_report_run.sh` (same variables) | `provenance report is current: unknown relations=3 columns=7` |
| 7 | the Phase 12 inventory proof (query unchanged, planted values) | `bash supabase/tests/common_account_phase12_inventory_run.sh` | `P12_INVENTORY_ALL_PASS` (57 assertions) |
| 8 | the Phase 11 model run (full plan over the fake GoTrue / PostgREST and the local database) | `bash supabase/tests/common_account_phase11_model_run.sh` | `7 passed`, `PHASE11_MODEL_ALL_PASS` — this is the run that exposed the first design (2.4) |
| 9 | mutation check of contract v2 | `python3 supabase/tests/common_account_phase13_contract_mutations.py <repo root>` (+ the socket variables) | control PASS, **35/35 mutants detected**, 0 invalid |
| 10 | the three older mutation scripts still work and still detect everything (their scratch copy now also holds `docs/`, `.agent/`, `apps/social-mobile`, `supabase/functions`) | `common_account_phase12_inventory_mutations.py`, `common_account_phase12_scanner_mutations.py`, `common_account_phase11_harness_mutations.py` | **66/66**, **37/37**, **49/49** detected, control PASS each |

Not run, on purpose: any managed or production access; the inventory query against anything but the local fake worlds; the
prerequisite oracle (its inputs — the model baseline and the chain files — are unchanged by this task; its evidence file
`docs/common-account/phase13-prerequisite-oracle.tsv` stands).

## 8. GO / NO_GO and the next approvals

| Gate | State after this change | What would open it |
| --- | --- | --- |
| Contract v2 as source | **source candidate complete; G4/ChatGPT to evaluate** | evaluation of this PR |
| PG1 restricted #233 recheck (+ the three additions above) | NO_GO (not requested) | "J1 may review exactly the boundaries of section 10.3 of the Phase 13 architecture plan, plus `contractSubset` / `checkRequirements` / `shown()` and `baseline_requirements.ts` of Phase 13 contract v2" |
| PG2a production catalog inventory (A1) | NO_GO — not requested | PG1 PASS, then the copy-ready approval in the architecture plan (the pinned query digest above) |
| PG2b baseline DDL export (A2, now with `ensure_my_profile()` and `platform`) | NO_GO | PG2a done and read by the owner |
| PG3 owner approval of the contract digest | NO_GO — no production digest exists | PG2a + PG2b |
| PG4 disposable project, PG5 deployment, PG6 managed smoke, PG7 iPhone, PG8 other auth stages, PG9 production | NO_GO | unchanged from the architecture plan |

## 9. Handoff to POSTONA G4 (copyable)

- **Branch / PR:** stacked on Phase 13 PR #250 (`2a626cd49f55611258c7695f0b84cb2a917d4595`, itself on #233 `499a9e1fac595064fbc3928725be8907db1b692b`); protected PRs unchanged.
- **Done (source only):** contract v2 (3 objects), lock and provenance regenerated, static audit, local PostgreSQL fail-before / pass-after on the real base code, unit tests, docs.
- **Unknown (needs PG2a):** section 3.
- **Requests:** (1) G4: evaluate; veto `auth.uid()` if unwanted (it is isolated in `EXPECTATIONS.platformFunctions` and `platformFunctions`); (2) F3/G3: the stand-in contract (6.1); (3) when the owner is ready: PG1, then PG2a / PG2b.
- **Safety boundaries kept:** no production or managed access, no inventory, no project, no migration outside the local fake database, no OAuth / SNS / AI / mail / HTTP, no F3 / F4 / F6 / H5 write, no force push, no merge, no deploy.
