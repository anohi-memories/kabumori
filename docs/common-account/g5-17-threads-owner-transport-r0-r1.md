# G5-17: R0 / R1 / T13 from G4's owner-only Threads transport — answers to G4's three questions

Status: **read-only answer + isolated PG17 proofs.** No G5 SQL, grant, migration or G4 / H5 file is changed; G4's design (Draft PR #428) is not
decided by G5. Production is **NO_GO**.

- TASK `common-account-g5-g4-threads-r0-r1-owner-transport-interface-readonly-20261022` (Issue #320, G5-01 generation, task 17, completion K5).
- The question: G4's COORDINATION on Issue #320 (comment 6329602523), from G4's task `postona-g4-pr124-pr405-complete-owner-only-activation-contract-design-20261022`,
  design Draft PR #428 `docs/postona/threads-complete-owner-only-contract-20261022.md` (head `c305152dcc355c9f6fd5d5699b15c03ec36cf67b`): option C — the
  Threads connection RPCs (PR #124) and G4's entry (PR #405) are granted to **no API role**; only H5's owner transport (PR #139 line) calls them, as the
  owner, READ COMMITTED, with the verified person's `sub` and `session_id` as transaction-local claims; begin = `begin_social_mobile_threads_oauth_connection`
  (T13 inside) -> G5 R1's two numbers -> G4 `record_state_generation` -> H5 `remember` -> COMMIT.
- G5 sources answered from (this stack): R1 / W1 / W2 / GC `supabase/candidates/common_account_authorization_verdict/001_authorization_verdict.sql`
  (PR #351 -> #358 -> #371 -> #399); R0 `002_bootstrap_verdict.sql` (PR #383 -> #399); T13 = P3b's `private.account_lifecycle_assert_active_service_write`
  (`supabase/migrations/20261010051938_common_account_service_write_guard.sql`, F5 chain); the owner epoch (PR #303).
- New G5-owned files: this document, `supabase/tests/common_account_owner_transport_pg_{run.sh,test.ts}`,
  `supabase/preflight/managed_disposable/g5_17_owner_transport_doc_test.ts`.

Evidence labels: **[S]** read from the source named; **[D]** derived by this task's PG17 test; **[U]** NOT_VERIFIED.

## 1. Answers

| # | G4 asks | Answer |
| --- | --- | --- |
| Q1 | Can the owner transport call R1 inside the begin transaction and get the two numbers? Name, role, claims, lock order? | **Yes** [D]. `public.common_account_authorization_verdict('postona', 'threads_connect', <workspace id>)`, called **as the owner role** (the function owner holds EXECUTE; no API grant is used). It reads the claims (section 2), sees the workspace, membership and owner-epoch row that begin wrote earlier **in the same transaction**, and its allow carries `owner_epoch = 'g5oe:<epoch>:<lifecycle_version>'` — the same numbers the transaction sees. R1 takes **no lock and writes nothing**; T13 -> begin -> R1 -> `record_state_generation` -> `remember` -> COMMIT adds no lock edge from G5. Because T13 holds the account and entitlement rows `FOR UPDATE` to COMMIT, no lifecycle change can commit between R1 and COMMIT: the pair is still current at COMMIT [D]. |
| Q2 | R0 (first connection, no brand): before or inside begin, by whom, without the authenticated grant? | `public.common_account_bootstrap_verdict('postona', 'threads_connect_bootstrap')`, **as the first statement of the same begin transaction**, before T13 and before begin writes anything, by the owner transport as the owner role; **no authenticated grant needed** [D]. R0 is advisory (no lock): its value is a clean early refusal with distinct reasons and no write. Safety does not depend on it in this one-transaction design: without R0, a pre-claimed workspace still ends with R1 `unknown WORKSPACE_OWNER_UNKNOWN` and the ROLLBACK removes the second owner main's begin added [D]. G5 recommends keeping R0 first. |
| Q3 | Does granting the Threads RPCs to no API role contradict R0 / R1 / T13? | **No — provided the transport's database role is the role that owns R0 / R1 / T13** (G5's lifecycle owner). Then the owner executes all three; T13 is already owner-only; R0 / R1 keep their `authenticated` EXECUTE for the PostgREST path, which option C simply does not use [D]. **If the transport runs as a different role**, that role has no EXECUTE on any of the three [D] and would need a reviewed G5 change (section 4). Who owns which function in production is [U]. |

## 2. The contract the transport must keep

| # | Rule | Why / evidence |
| --- | --- | --- |
| T-1 | Connect as the owner role of G5's R0 / R1 / T13; not a superuser; no API role a member of it (H5's own check) | EXECUTE [D]; PR #303's exposure rule |
| T-2 | One READ COMMITTED transaction per operation; R0 first, then T13 (via begin), then R1 as **its own statement** after begin | R1 is STABLE: its statement's snapshot must follow begin's writes [S] |
| T-3 | Set the claims as **JSON only** (`request.jwt.claims`), transaction-local: `sub`, `role: "authenticated"` (the claim, not the database role), `session_id`, `is_anonymous: false` | R0 / R1 / T13 read the per-claim settings FIRST; a per-claim `sub` mixed with JSON claims is refused (`AUTH_REQUIRED`) [D] |
| T-4 | `sub` and `session_id` come from the token GoTrue verified (G5-09 `edgeClaimsForDb`) | without `session_id`, R0 / R1 answer `AUTH_REQUIRED` and T13 raises [D] |
| T-5 | Any R0 / R1 answer other than `allow`, and any T13 exception: raise, ROLLBACK, nothing remembered | refusals inside the transaction leave nothing [D] |
| T-6 | Parse `owner_epoch` strictly: `g5oe:` + two positive integers (epoch, lifecycle_version); store both; W1 / W2 compare both for equality | the allow token [S]; W1 accepts the pair after COMMIT and refuses it after a later lifecycle change (`SERVICE_GENERATION_CHANGED`) [D] |
| T-7 | R1's feature for the Threads connection is `threads_connect` (service `x_autopost`, brand required, the caller its single owner, kind `social_mobile_user_v1`, owner epoch present); R0's is `threads_connect_bootstrap` | R1 / R0 feature lists [S] |

## 3. What the proofs show (`common_account_owner_transport_pg_test.ts`)

| Proof | Result [D] |
| --- | --- |
| one transaction as the owner role: R0 -> T13 -> begin -> R1 | R0 allow; T13 passes; begin creates the server-derived workspace; R1 allow with scope `threads_connect` / the workspace and `owner_epoch` equal to `g5oe:<epoch>:<lifecycle_version>` read in the same snapshot; W1 `active` for the pair after COMMIT |
| the pair at COMMIT | a lifecycle change (starting Kabumori) waits behind T13's locks until the begin transaction ends; afterwards W1 answers `SERVICE_GENERATION_CHANGED` for the old pair |
| refusals | an ended service: R0 `SERVICE_NOT_ACTIVE`, T13 raises `SERVICE_NOT_ACTIVE`, no workspace written; a pre-claimed workspace: R0 `OWN_WORKSPACE_CONFLICT`; without R0, R1 `unknown WORKSPACE_OWNER_UNKNOWN` and the ROLLBACK leaves only the other person's ownership |
| roles | owner: R0 / R1 / T13 executable; `authenticated`: R0 / R1 only; anon / service_role: none; another role: none; the owner is not a superuser and no API role is its member |
| claims | no `session_id`: R0 `AUTH_REQUIRED`, T13 raises; a per-claim `sub` mixed with JSON claims: `AUTH_REQUIRED` |

main's X begin RPC stands in for the Threads begin (PR #124 is not in this tree); the real H5 transport, G4's Threads RPCs and the managed roles are [U].

## 4. Follow-ups (proposals; no other slot's TASK is changed)

| Owner | Item | Review |
| --- | --- | --- |
| G4 | use section 2 as the G5 side of option C; keep R1 after begin (it also refuses the second-owner case of G5-07 inside the transaction); note the transport role must be G5's lifecycle owner | G4's own design review |
| H5 (owner transport) | JSON-only claims from the verified token (T-3 / T-4); strict token parsing (T-6) | H5's TASK when assigned |
| G5 (only if the transport role differs from the lifecycle owner) | an explicit EXECUTE grant on R0 / R1 / T13 to that one role, with G5's install postconditions (exact `proacl`, role graph, PR #303 exposure) amended, PG17 proofs, no API role reaching it | Codex Sol (high); production approval |
| — | `authenticated`'s EXECUTE on R0 / R1 stays for the PostgREST path; removing it is not needed for option C | — |

## 5. NOT_VERIFIED

The production owner of G5's functions and of G4's Threads RPCs; H5's real transport; G4's Threads begin / complete (PR #124) and entry (PR #405) in
the same transaction; PostgREST; managed claims delivery. A sign-out committed after R1's statement in the same transaction is not seen by R1 (G5-11's
residual window) — T13 holds no `auth.sessions` lock.

## 6. Data API (unchanged, recorded because the TASK asks)

G3 and G6 still have no assigned Data API inventory TASK as of this document (G5-16 section 14.1); the 2026-10-27 date stays at risk until the
担当ちゃ / 総合指令 assign them. This task does not change that work.

## 7. Tests and what was executed

All commands ran in `/Users/yuya/Developer/kabumori-g5-17` (a clean worktree stacked on PR #429) against a throw-away local PostgreSQL 17.11
(`listen_addresses` empty, a Unix socket under `/private/tmp`, fake data, deleted at the end). No managed system, credential or network request.

| # | Check | Result |
| --- | --- | --- |
| 1 | `CAL_PGHOST=… CAL_PGPORT=… CAL_PGSUPER=… bash supabase/tests/common_account_owner_transport_pg_run.sh` | **6 tests** passed, 0 failed (three consecutive runs) |
| 2 | regression, PG17: session verdict, R0, R1, G5-01, G5-02, owner epoch, base tables, D-2, Data API | session verdict 13, R0 13, R1 15, G5-01 10, G5-02 5, owner epoch 19, base tables 5, D-2 4, Data API 6 — all passed |
| 3 | regression, pure, and the whole harness incl. the document tests | pure 42 passed; the whole harness **265 passed**, 0 failed (260 of PR #429 + 5 new) |
| 4 | type-check, lint, shell, whitespace; no G5 SQL / migration changed | `deno check --no-config`: no error; `deno lint --no-config`: no problem; `bash -n`, `git diff --check`: clean; `supabase/migrations` and `supabase/candidates`: unchanged |
