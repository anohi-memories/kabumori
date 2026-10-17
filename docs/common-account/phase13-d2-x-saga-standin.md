# Phase 13 (F5) — D-2: the X saga stand-in of the validation harness (testing-only, side-effect-free)

Status: **source-only.** The only database is a throw-away local PostgreSQL 17 with fake data. No production or managed Supabase access, no
schema-only inventory, no project, no OAuth / X / Threads / Instagram call, no real revoke or purge, no Vault read, no booking write, no
e-mail, no paid AI, no external HTTP, no merge, no deploy, no force push. Production is **NO_GO**; `managed_auth_delete` and
`IDP_PREPAUSE_BLOCKED` stay BLOCKED; every release gate stays OFF; `POSTONA_END_SOURCE_ENABLED` is not touched.

TASK `common-account-f5-phase13-d2-x-saga-inert-standin-harness-20261017` (G4 `D-2_IMPLEMENTATION_GO`; F3/G3 `PASS_CONTRACT_REVIEW`: substitute
**solely at the F5 validation harness dependency boundary**; never modify real X cleanup or change what a genuine `XCleanupOutcome` `done` means).
Stacked on PR #254 (`503a6ca85ebd6f1482b530f6025074b930d7f944`); F3, F4, F6, H5, G-slot files and every protected PR are unchanged.

Evidence labels (as in the architecture plan): **[O]** observed in this checkout, **[D]** derived by this phase's tools (commands in section 7),
**[A]** assumption, **[U]** unknown — never inferred.

## 1. What it is, and where it plugs in

`POSTONA service-exit` = `account-delete`'s `withdraw_postona`: F5's own orchestration (owner lease and fence in SQL, provider results, snapshot
acknowledgement, the entitlement ended only by the owner) with **F3's X saga** in the middle. Everything F5 owns can be validated on a synthetic
database; the saga cannot (it holds the X revoke call, Vault and the reservations). The stand-in answers, in memory, the three questions F5 asks of the saga:

| Seam (F5 harness side) | Production meaning | Stand-in |
| --- | --- | --- |
| `LifecycleDeps.x.preview` / `.run` (`syntheticXCleaner`) | the saga's read-only preview and its run | scripted simulated answers |
| `LifecycleDeps.rpc('ack_x_unconfirmed')` (`withStandInAck`) | F3's `social_mobile_account_deletion_x_unconfirmed_ack` | the stand-in's own synthetic acknowledgement; every other RPC passes through untouched |
| the fake network route `/functions/v1/social-mobile-account-delete` and the acknowledgement RPC (`sagaResponder`, `ackResponder`) | the same two, as HTTP | JSON in the saga's shape, **plus** a `stand_in` marker; production `http.ts` (`xResultOf`, the RPC mapping) stays in the loop |

Files (all F5-owned, new, under `supabase/preflight/managed_disposable/x_saga_standin/`): `standin.ts` (the engine, pure, imports nothing),
`harness.ts` (the adapters; imports **types only** from production), `tripwire.ts` (runtime tripwires, test support), `exclusion.ts` (the static
production-exclusion check) and their tests; plus `supabase/tests/common_account_phase13_d2_standin_run.sh` / `…_test.ts` (database-backed) and
`…_mutations.py`. **Nothing under `supabase/functions/`, no migration, no F3/F4/F6/H5 file was edited** (section 7, diff scope).

It is **not** a deployed Edge function. The earlier proposal (baseline contract v2 document, 6.1) of an inert function named like the saga is superseded:
a function deployed to a managed project cannot be reached by harness-side injection, and a deployable double would be a new production-adjacent
artifact. Consequence: this stand-in validates F5's orchestration on the **local synthetic tier**; managed M12 stays NOT_VERIFIED (section 6).

## 2. The result types (test-only)

```ts
type XStandInResult =
  | { kind: 'simulated'; scenario: 'clean' | 'blocked' | 'in_progress' | 'reconciliation_required' | 'failed';
      effects_performed: false; remote_x_verified: false; production_usable: false; facts: { reason?; unconfirmedPosts?; unconfirmedSnapshot? } }
  | { kind: 'stand_in_disabled' };
```

- The three markers are one frozen constant; there is no way to build a `simulated` result without them, and every record, report line, HTTP body
  and converted lifecycle result carries them (tests assert it in each place).
- **Disabled by default**: `disabledStandIn()` and any stand-in constructed with `armed: false` answer `stand_in_disabled`; a script does not arm it.
  Through the adapters a disabled stand-in is "unsupported" for the preview, a failure for the run, an unusable RPC for the acknowledgement.
- **Fail closed**: a script that has run out answers `failed`, never `clean`.
- **R2′ is reproduced, not fixed**: the preview scope is `social_only` only for a person with a Kabumori profile; a POSTONA-only person gets `social_and_login`
  (F3's real rule), so F5 answers `X_CLEANUP_UNSUPPORTED` before anything changes.

Scenarios (script step → what F5 does, asserted on the real handler; `W` = the lifecycle code, `D` = the database-backed run):

| Script step | Lifecycle outcome | F5 answer | State after |
| --- | --- | --- | --- |
| `clean` | `done` (simulated; **the one conversion**) | 200 `ended`, `providers.x = done` | entitlement ended **only if** F5's database finds no X footprint (a stand-in has no effect to hide behind: `SERVICE_CLEANUP_INCOMPLETE` otherwise) |
| `clean` + unconfirmed posts N | `done` + count + derived 64-hex name | the pair recorded **before** the stand-in is told; the stand-in acknowledges that exact name; the person is told the highest count | stale name → `snapshot_changed` → new pair recorded → acknowledged; after `ACK_ROUNDS` the end still tells the highest count and acknowledges nothing it did not record |
| `blocked` (booking: `UNEXPECTED_DEPENDENT_DATA`; ongoing post: `POSTING_IN_PROGRESS`) | `blocked` + reason | 409 `X_CLEANUP_BLOCKED` + reason | not ended; lease returned; resumable |
| `in_progress` | `in_progress` | 409 `X_CLEANUP_IN_PROGRESS` | F5's lease is **not** held by a busy saga; a retry takes a new lease with a higher fence |
| `reconciliation_required` (`X_REVOKE_FAILED`, …) | `failed` + reason | 502 `X_CLEANUP_FAILED` + reason | result `reconciliation_required` on record; not ended |
| `failed` | `failed` | 502 `X_CLEANUP_FAILED` | not ended |

Also covered: POSTONA-only person without a Kabumori entitlement (R2′), X not connected, Threads-connected service (no adapter → `PROVIDER_ADAPTER_MISSING`
before the saga is asked; a test adapter → Threads first, then X), other-service and common-user preservation (login, Kabumori entitlement, profile,
account, a bystander person, a future app's entitlement in the lifecycle world), a disabled stand-in.

## 3. What it cannot become

1. **No impersonation of a genuine `done`.** `standin.ts` produces no lifecycle type and contains no outcome literal; `harness.ts` holds the single
   conversion `toLifecycleResult`. Its result is frozen, registered in a `WeakSet` and tagged with a non-enumerable symbol (it never travels as a field
   the lifecycle could copy into a response). The exclusion check allows the outcome `done` exactly once in the directory and the lifecycle result
   types only in `harness.ts`.
2. **No externally consumable evidence.** The synthetic acknowledgement is answered by the stand-in and never reaches a database function; the
   test asserts that the lifecycle world's own acknowledgement RPC saw nothing. Nothing is written to F3's tables (they are not in this run).
3. **No effect at all.** The engine is pure (no network, environment, file, subprocess, dynamic import, timer, clock or randomness — static
   check E4); live tripwires (section 4) and a database observer back it up.

## 4. Structural production exclusion (not an environment flag)

`exclusion.ts` reads the repository and returns findings; `exclusion_test.ts` runs it on the real tree (no finding) and plants each violation in an
overlay (each is found):

| Rule | Checks |
| --- | --- |
| E1 | no stand-in file is reachable (value **or type** import, transitively) from any `supabase/functions/*/index.ts` entry; no file under `supabase/functions` even names the directory; the check is not vacuous (it fails if it sees no Edge entry) |
| E2 | no file under `supabase/` or `apps/` outside the directory, its runner and tests, `docs/` and `.agent*` names it |
| E3 | the runtime files import only each other and, from production, **types only** (`import type`); no value import, no external specifier (`npm:`, `node:`), no dynamic import |
| E4 | the runtime files have no network, `Deno`, environment, dynamic code, global object, timer, clock, randomness, nor Vault / OAuth / credential vocabulary in **code** (comments and strings are blanked first) |
| E5 | the outcome `done` appears exactly once (`harness.ts`); the lifecycle result types appear only in `harness.ts` |
| E6 | nothing in the directory is secret-shaped (key, JWT, connection string, URL, Supabase host) |

Runtime tripwires (`tripwire.ts`, armed around every scenario and every request; **not re-entrant**, restored in a `finally`): `fetch`, `WebSocket`,
`Deno.connect` / `connectTls` / `listen` / `listenTls`, `Deno.Command` (unless the test needs `psql`) and `Deno.env.get` of any credential-looking name
are recorded and refused. Every scenario asserts zero hits.

## 5. Zero-side-effect attestation (what was measured)

| Operation | Zero because | Evidence |
| --- | --- | --- |
| X API, any external network | no code path (E4), tripwires, and the fake network records every request: all on the synthetic origin, none unrouted | `attest()` in every database-backed test; `unrouted = []` |
| Vault | no Vault vocabulary in code (E4); the observer snapshots ten tables (`vault.secrets` and nine X-side tables: accounts, brands, memberships, scheduled posts, execution logs, publish claims, OAuth states, deletion rows, refresh state) around **every** stand-in call and finds no difference | `observerFailures = []`, `observed ≥ 1` |
| OAuth | no code path; the environment tripwire refuses credential-looking names | tripwire hits `[]` |
| booking mutation | `scheduled_posts`, `post_execution_logs`, `publish_claims`, `social_accounts`, … unchanged during every stand-in call; F3's reservation tables are not in the run | observer |
| real e-mail, paid AI | no code path; the attestation fails if any endpoint matches X / Threads / Meta / AI / mail | `attest()` |
| real revoke / purge | the engine has no effect; a "clean" with a real footprint is **refused by F5's database** | footprint test |

## 6. What this does NOT prove (NOT_VERIFIED, by name)

- a real X revoke, purge, token refresh, or the saga's own behaviour (F3's, unchanged and not run);
- any Vault read, any managed OAuth, any real Threads or Instagram call;
- **managed M12**: a deployed `account-delete` calls the saga **inside** the project; harness injection cannot reach it. It stays blocked until F3's real saga
  (or a separately approved, reviewed, deployable double) exists on the disposable project;
- **R2′** (a POSTONA-only person cannot end POSTONA alone with the real saga) — reproduced here, **not** fixed; owner F3;
- **G3 T13** (the X onboarding RPCs are not behind an entitlement guard) — untouched; owner G3;
- the **Phase 12 #233 limited P2×4 recheck** — still a future, separate gate before any real apply (not an automatic review);
- anything about production data, production Auth, Cron, Edge runtime or grants.

A harness-simulation PASS is therefore **never** a real revoke / Vault / managed-OAuth / managed-M12 PASS.

## 7. What was executed (offline; exact commands and outputs)

All commands ran in `/Users/yuya/Developer/kabumori-f5-d2` (a clean worktree stacked on PR #254). The only database is a throw-away local
PostgreSQL 17.11 (`listen_addresses` empty, Unix socket under `/private/tmp`, fake data, deleted at the end); every runner refuses a host that is not a
`/tmp` socket directory. No network, no credential, no managed project.

| # | Check | Command | Result |
| --- | --- | --- | --- |
| 1 | the stand-in, its adapters, tripwires, exclusion check and document | `deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/x_saga_standin/` | **36 passed**, 0 failed (exclusion 10, stand-in 11, lifecycle scenarios 12, document 3) |
| 2 | the whole harness suite (existing tests included) | `deno test … supabase/preflight/managed_disposable/` | **151 passed**, 0 failed (115 before + 36) |
| 3 | the production Edge function's own tests, unchanged | `deno test … supabase/functions/account-delete/` | **143 passed**, 0 failed |
| 4 | **end to end on PostgreSQL 17** (real handler, real Phase 1..10 SQL, stand-in at the network boundary) | `CAL_PGHOST=<tmp socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_phase13_d2_standin_run.sh` | **10 passed**, 0 failed (R2′; clean end + bystander + idempotency; footprint refused by the database; simulated blocks / busy saga / revoke failure with fence order; unconfirmed posts + stale snapshot; Threads-connected; lease expiry + stale owner + stale completion; busy saga never holds F5's lease; disabled; repeat runs) |
| 5 | type-check and lint | `deno check --no-config supabase/preflight/managed_disposable/*.ts supabase/preflight/managed_disposable/x_saga_standin/*.ts supabase/tests/common_account_phase13_d2_standin_test.ts`; `deno lint --no-config supabase/preflight/managed_disposable/ supabase/tests/common_account_phase13_d2_standin_test.ts` | no error; `Checked 39 files`, no problem |
| 6 | mutation check of the stand-in (38 mutants: markers, fail-closed, armed, scope rule, acknowledgement, conversion, HTTP face, tripwires, every exclusion rule) | `python3 supabase/tests/common_account_phase13_d2_mutations.py <repo root>` (+ the socket variables) | control PASS, **38/38 detected**, 0 invalid |
| 7 | earlier mutation checks still work and still detect everything | `common_account_phase13_contract_mutations.py` / `…phase12_inventory_mutations.py` / `…phase12_scanner_mutations.py` / `…phase11_harness_mutations.py` | **35/35**, **66/66**, **37/37**, **49/49** detected, control PASS each |
| 8 | earlier proofs (regression) | contract proof (`…phase13_contract_extension_run.sh`), `…phase12_inventory_run.sh`, `…phase11_model_run.sh`, `…phase12_baseline_report_run.sh`, `architecture_dag.ts --check` | `P13_CONTRACT_PROOF\|ALL\|PASS`, `P12_INVENTORY_ALL_PASS`, `PHASE11_MODEL_ALL_PASS`, `provenance report is current`, `the DAG json and the generated tables are current` |
| 9 | diff scope (targeted source change) | `git diff --cached --name-only` | 15 files, +2077 / −1: the new directory, three new files under `supabase/tests/`, the new document, two earlier documents annotated, one mutation script's tree list. **Nothing under `supabase/functions/`, `supabase/migrations/`, `apps/` or `.agent*`** (checked), no F3/F4/F6/H5 file |
| 10 | hygiene | `git diff --cached --check`; secret / project-host scan of the staged diff; scan for the one production ref the repository names; `git merge-tree --write-tree origin/main HEAD`; open PRs touching the same paths | clean; 0; 0; no conflict; only this stack |

Not run, on purpose: any managed or production access; the real saga (F3's code and SQL are not in this run); a real revoke, purge, Vault read, OAuth call;
managed M12; the Phase 12 #233 limited recheck.

## 8. Remaining issues and ownership

| Item | Owner | State |
| --- | --- | --- |
| R2′ real saga cannot end POSTONA alone for a POSTONA-only person | F3 | open; reproduced by the stand-in |
| G3 T13 entitlement guard on the X onboarding RPCs | G3 | open |
| managed M12 (real saga on the disposable project) | F3 / owner | blocked; needs a separate approval and a real or reviewed deployable double |
| Phase 12 #233 limited security recheck | J1 | future gate (PG1) |
| contract v2 unchecked against production | owner | PG2a / PG2b |
| D-3 hosted disposable project | owner | design only |

## 9. GO / NO_GO and the handoff to G4

- **Source candidate: complete** — the stand-in, its adapters, tripwires, exclusion check, tests and mutation check. G4 / ChatGPT evaluate the **source**;
  managed and production are not claimed.
- **Production: NO_GO.** **Managed M12: NOT_VERIFIED / blocked.** **Using the stand-in anywhere but a local synthetic harness: NO_GO.**
- Next requests, in order: (1) G4 evaluates this PR; (2) F3/G3 decide whether a deployable, reviewed double is wanted for managed M12 (a separate contract and
  approval; this PR deliberately does not provide one); (3) PG1 → PG2a / PG2b of the architecture plan when the owner is ready.
- Safety boundaries kept: no production or managed access, no F3/F4/F6/H5 change, no migration, no Edge change, no release flag, no force push, no merge, no deploy.
