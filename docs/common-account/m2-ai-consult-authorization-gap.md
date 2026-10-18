# M2 (F5): the server-side authorization of POSTONA's AI consultation — what exists, what is missing, and the smallest safe interface

Status: **source-only evidence, contract and tests. Nothing here was run against a managed or production system, nothing was applied, no real
OpenAI / Claude / X / Threads call was made, no token or key was read.** Production is **NO_GO**; every release gate stays OFF;
`managed_auth_delete` and `IDP_PREPAUSE_BLOCKED` stay BLOCKED; `POSTONA_END_SOURCE_ENABLED` is untouched. The AI consult handler integration
stays on **HOLD** (G6 owns the handler, the AI plan and the ledger).

TASK `postona-f5-m2-ai-consult-auth-acl-owner-gap-source-design-20261018` (priority source: POSTONA 総合指令室, Issue #269 comments 6247635293 and
6247652574). It stacks on PR #275 (M1) and adds only this document, one pinned provenance file, an F5-owned local test harness and its runner. It
changes no migration, no RPC, no `SECURITY DEFINER` function, no grant, no RLS policy, no Auth or Edge code, and none of F6's / G6's, F3's, F4's or F1's files.

Evidence labels as in the M1 contract: **[O]** observed in a pinned file (`m2-ai-consult-authz-provenance.json`, re-checked by
`supabase/tests/common_account_m2_provenance_check.py`), **[D]** derived by a test of this task (section 8), **[R]** recorded in a coordination file,
**[A]** assumption, **[U]** unknown, never inferred. *Draft* = a source candidate not in the production history; *live* = on `main` and recorded as applied.

## 1. Verdict

| Question | Answer |
| --- | --- |
| Does the live consult handler ask F5 anything? | **No.** It checks the Auth user, the workspace owner row and the workspace kind, then calls OpenAI. It never reads `common_accounts` or `service_entitlements` and never names `x_autopost` (**G-1**, [O] provenance `LIVE-CONSULT-HANDLER`). A person whose POSTONA is being ended, whose account is locked or being deleted can still consult while the workspace exists. |
| Is there an existing, complete, atomic server-side API for "this JWT person, this workspace, POSTONA active, AI allowed"? | **No.** F5 owns the first three parts; the fourth (AI plan, quota, budget, dedupe, ledger) is G6's. No single callable endpoint combines session, owner, entitlement and plan. |
| Is the person's own read of the two F5 tables acceptable as the entitlement check? | **Yes, as a conditional advisory pre-check; no, as the authorization.** It is the only F5 mechanism that exists in production today (P1 and P2 are applied; the guard, the owner rule and the workspace state are P3b to P10, unapplied Drafts). It is own-row, column-limited, read-only (**[D]**), but it is blind to the login session (**G-2**) and to a freeze that has not committed (**G-3**). Details and conditions in sections 3 and 6. |
| Does `x_autopost` active allow the AI? | **No.** It is the POSTONA service registration. The AI plan, monthly quota, budget and dedupe are G6's and are independent (test `the plan is not the entitlement`). |
| Is a new RPC needed now? | **Not to start the offline integration.** A narrow read-only RPC would add session liveness, the exactly-one-owner rule and a single snapshot; it is specified in section 7 as a **proposal only** and needs an approval, a single owner and a focused Codex Sol (high) review before anyone writes it. |
| Managed / production | **NOT_VERIFIED.** No Phase 13 gate (PG1 to PG7) is opened; the PR #233 limited recheck stays a separate gate before any managed apply. |

## 2. Where each part lives, and the chain it has to form

Required chain: Edge JWT → verified user → workspace the user owns → POSTONA entitlement active and common account active → AI feature, plan, quota, budget
→ dedupe and ledger → recheck just before the provider → external provider.

| # | Part | Owner | Live handler today ([O], `supabase/functions/social-mobile-consult/logic.ts`) | F5 source | State |
| --- | --- | --- | --- | --- | --- |
| 1 | JWT → verified user | Edge (G6) + Auth | `bearerToken` → `getUser` (`/auth/v1/user`, :198) | — | live; session handling of `/auth/v1/user` is managed-only [U] |
| 2 | request selector | G6 | `parseConsultRequest` (:137): only `brand_id`, `message`, `history`; unknown keys refused; `BRAND_ID_RE` | — | live |
| 3 | workspace the user owns | G6 reads, RLS decides | `assertOwnedSocialMobileWorkspace` (:237): the user's JWT reads `brand_memberships` (`role=owner`) and `brands.code_profile_key`; no service role in this function | `private.account_lifecycle_brand_owner(text)` (exactly one owner of a user workspace) | membership RLS is in `20260918120000` (self-select); `brands` has a member-select policy there, its own DDL is outside the repository [U] |
| 4 | POSTONA entitlement + common account | F5 | **absent** | tables `public.common_accounts`, `public.service_entitlements` with column grants and own-row RLS (P1); `private.account_lifecycle_assert_active_service_write` (P3b); `private.account_lifecycle_service_state_refusal` (P4); `private.account_lifecycle_service_state_readonly`, `public.common_account_brand_service_state` (P5) | P1 and P2 **live**; P3b to P10 **Draft, unapplied** |
| 5 | AI feature / plan / quota / budget | G6 | **absent** (the handler only logs token counts) | — | F6 PR #273 models it offline |
| 6 | dedupe + ledger | G6 | **absent** | — | F6 PR #249 / #273, unapplied |
| 7 | recheck before the provider | G6 (reads F5) | **absent** | any of the F5 reads, again | — |
| 8 | provider call | G6 | `callOpenAiConsultModel` (:474), one call, 25 s | — | live |

## 3. What a person's own read of the F5 tables proves — and what it does not

P1 (`20261001150000`, applied 2026-10-06 [R]) revokes everything from `public`, `anon`, `authenticated` and `service_role` on both tables, enables RLS, then grants
`authenticated` **column-level** SELECT only — `common_accounts(user_id, status, lifecycle_version, created_at, updated_at)` and
`service_entitlements(user_id, service_key, status, activated_at, ended_at, updated_at)` — with policies `common_accounts_select_own` and
`service_entitlements_select_own` (`auth.uid() = user_id`). Proven on the real SQL (**[D]**, test `what the person's role can read of F5's tables`):

| Property | Result |
| --- | --- |
| a person reads their own row | yes (one `common_accounts` row, their `service_entitlements` rows) |
| another person's row | invisible (0 rows) |
| `source`, `legacy_evidence`; `select *` on the entitlements | permission denied (not granted) |
| insert, update, delete | permission denied |
| `anon` | no access |
| **`service_role`** | **no direct table access** (revoked): a service_role handler cannot read these tables; it can only call F5's definer functions |
| the `private` schema (operations table) | closed |
| the visible status follows the lifecycle | `begin_service_deletion` sets the entitlement to `deleting` in the same function that records the operation; account deletion sets the account to `deleting` the same way (P1 :987, :1138); the committed read and F5's `service_state_readonly` **agree on six lifecycle states** (test `the two reads and F5's own state agree`) |

What it does **not** prove — each is a gap with a test:

| # | Gap | Evidence |
| --- | --- | --- |
| **G-1** | The live handler never asks. | [O] provenance (the file names none of `service_entitlements`, `common_accounts`, `x_autopost`, `account_lifecycle`) |
| **G-2** | **The read is blind to the login session.** RLS compares `auth.uid()` with the row; a signed-out person whose access token has not expired passes the read, while F5's T13 guard answers `ACCOUNT_LIFECYCLE_AUTH_REQUIRED`. Only `/auth/v1/user` (managed behaviour [U]) can catch it in the Edge. | [D] `GAP: the entitlement read does not know about sessions` |
| **G-3** | **The read is not ordered with a freeze.** An uncommitted freeze is invisible to a plain read (it still says `active`); the T13 guard waits for it and answers busy after about 3 s. After the commit the read refuses. | [D] `GAP: a freeze that has not committed is invisible` |
| **G-4** | The two reads (`common_accounts`, `service_entitlements`) are two requests, so two snapshots; combined with AND they fail closed, but a change between them is possible. A single request that embeds one table in the other would give one snapshot; PostgREST's behaviour is managed-only and not tested here. | [O] the F6 seam reads two tables; [U] embedding |
| **G-5** | The owner rules differ. The live handler asks "is the caller *an* owner"; F5's rule asks "is there *exactly one* owner". With two owners both consult; F5's rule gives no owner (`WORKSPACE_OWNER_UNKNOWN`). | [D] `the two reads and F5's own state agree … owner rules differ` |
| **G-6** | **service_role is a confused deputy** if it trusts a client-supplied brand: `common_account_brand_service_state(brand)` answers for any brand. Ownership must be proven first, with the person's own role. | [D] `service_role is a confused deputy` |
| **G-7** | `x_autopost` active is not an AI decision. | [D] `the plan is not the entitlement` |
| **G-8** | **No database lock spans the provider call.** A state change after the last read cannot stop the call in flight; it can only be recorded as it happened. | [D] `RECHECK … in-flight limit`; M1-F3 |
| **G-9** | The `brands` table's own DDL and RLS are outside the repository; the model assumes RLS on, with the member-select policy. | [O] `20260918120000`; [A] |
| **G-10** | P3b to P10 are unapplied: in production today only P1 / P2 objects exist. The T13 guard, the owner rule and the workspace state do not exist there. | [R] `docs/common-account/phase13-postona-disposable-supabase-architecture.md` §5 |

## 4. Threat and failure matrix (model: Edge identity double → selector → real membership RLS → real F5 table reads → plan double → recheck → counting provider mock)

Every refusal leaves the provider counter at **0**; the permitted path calls it once and the result is the mock's `SIM-AI-REPLY` (no real AI, `effects_performed: false`).

| Threat / failure | Outcome | Test | Residual |
| --- | --- | --- | --- |
| no, invalid or expired JWT | 401 `AUTH_REQUIRED`, nothing read | `the identity doubles refuse…` | expiry is Auth's (managed) |
| signed-out session, token not expired | refused only if `/auth/v1/user` checks sessions; the F5 read alone passes | `GAP … sessions` | **G-2**: managed behaviour decides, or Option B |
| arbitrary client `user_id` | 400 `REQUEST_BODY_INVALID` (unknown key), never travels | `workspace ownership …` | none |
| foreign brand; user UUID used as a slug | 404 `OWNED_WORKSPACE_NOT_FOUND`, before the entitlement | same | none |
| zero owners / two owners | one owner row required by the handler; F5 rule: exactly one | `the two reads … owner rules differ` | **G-5** |
| locked, deleting, ended, suspended, provisioning, never started (Kabumori only), service deletion | 403 `CONSULT_NOT_ENTITLED` | `every lifecycle state…` | none for committed states |
| service deletion in progress, not yet committed | read says active; T13 says busy | `GAP … freeze` | **G-3**, **G-8** |
| unknown / unreadable entitlement | 503 `ENTITLEMENT_READ_UNAVAILABLE` (fail closed) | model; F6 PR #273 | managed PostgREST mapping [U] |
| RLS / column leak | other rows, `source`, `legacy_evidence`, writes, anon, service_role, private schema all denied | `what the person's role can read…` | managed ACL [U] |
| owner or entitlement changes after authorize | caught by the recheck (RLS read or F5's state read) | `RECHECK…` | **G-8** after the last read |
| no recheck | an ended service still reaches the provider | `RECHECK…` (negative control) | the recheck is required |
| service_role confused deputy | state of any brand readable by service_role; refused for the person's own role | `service_role is a confused deputy` | **G-6** |
| AI plan / quota / budget | `x_autopost` active, plan off → 429, provider 0 | `the plan is not the entitlement` | G6's |
| stale lifecycle generation | applies to the restart flow (`reactivate_*`), not to a read; not modelled for consults | — | none |
| provider in flight, lifecycle ends | cannot be cancelled; recorded as it happened (ledger, G6) | `RECHECK…` | **G-8** |

## 5. Which F5 mechanism for which caller (exact shapes, [O] M1 contract §2–3)

| Caller context | Mechanism | Grants / role | Verdict for the consult |
| --- | --- | --- | --- |
| Edge with the person's JWT (the handler's style) | read `common_accounts` and `service_entitlements` as the person (PostgREST `/rest/v1/…`) | `authenticated`, own rows, granted columns | **usable as an advisory pre-check** (section 6); available in production today |
| Edge/worker with the service key | `public.common_account_brand_service_state(brand, 'x_autopost') → text` (P5) | `service_role` only; any brand | usable for the recheck **after** ownership is proven with the person's role (G-6); Draft, unapplied |
| a definer function in the person's transaction | `private.account_lifecycle_assert_active_service_write(auth.uid(), 'x_autopost')` (P3b) | owner-only; JWT + live session; takes locks to COMMIT | the right tool for a **write** (X posting, M1); not for an AI read that precedes a long HTTP call |
| a transport that already knows the person | `private.account_lifecycle_service_state_refusal(user, 'x_autopost')` (P4) | owner-only | not for the Edge |
| the workspace owner rule | `private.account_lifecycle_brand_owner(brand)` (P5) | owner-only | not callable from the Edge; the handler uses the membership read (G-5) |

## 6. Answers to F6's questions (PR #273, section 7) and the conditions

1. **Is reading the two tables directly acceptable, or should F5 provide an RPC?** The direct read is acceptable **as an advisory pre-check** (this refines, and does not contradict, the 2026-10-18 reply on Issue #266, which declined to call it *the* authorization). Conditions:
   (a) the user id comes from the Edge-verified token (`/auth/v1/user`), never from the body; (b) the read uses the **person's own JWT**, never the service key (F5 grants the service key no table access); (c) both rows exist exactly once and are `active`; any other answer or an unreadable table refuses (fail closed); (d) the workspace ownership is proven **before** anything is asked about the entitlement; (e) the same read is repeated immediately before the provider call, and the call is still not ordered with a freeze (G-8) — the result is recorded as it happened; (f) the read is accepted as blind to the session unless the Edge's `/auth/v1/user` is shown to refuse a revoked session (managed M-step) or Option B exists; (g) it is **not** an AI plan, quota or budget decision. F5 does **not** require an RPC to start the offline integration.
2. **How does the stop tie into the deletion flow (PR #264, section 3, premise B)?** Once the freeze commits, the entitlement is `deleting`, so every later consult is refused by the same read (test `every lifecycle state…`, `RECHECK…`); a call already in flight is not cancelled and is bounded by the provider timeout and the ledger's unknown-outcome rule (G6). The cleanup order of #264 (ended → no new AI authorization → wait for in-flight → erase) is consistent with this; F5 changes nothing in the deletion flow here.
3. **Real Supabase verification of the column grants and RLS?** Not done (offline). The existing managed step **M8** of the Phase 11 harness ("a token reads its own rows and only the granted columns") checks exactly this on a disposable project; it belongs to gates PG5/PG6, none of which is opened.

## 7. Interface proposal (proposal only — not created, not granted, not applied)

**Option A — no new API (recommended to start).** The consult gate = Edge identity + the person's membership read + the person's own entitlement read (conditions of section 6) + G6's plan/quota + the recheck + the provider. F5 changes nothing. Residual: G-2, G-3, G-4, G-5, G-8.

**Option B — one narrow, read-only authorization RPC.** Needed only if G6 / G4 require DB-level session liveness, the exactly-one-owner rule or a single snapshot.

| Item | Proposal |
| --- | --- |
| Name / shape | `public.postona_ai_consult_authorization(p_brand_id text) returns jsonb` — `STABLE`, `SECURITY DEFINER`, `set search_path = ''`, no writes, no locks |
| Caller | `authenticated` only (EXECUTE revoked from `public`, `anon`, `service_role`); the person's JWT is the only identity |
| Reads | `auth.uid()` and the `session_id` claim → `auth.sessions` liveness (as P3b, without locks); `private.account_lifecycle_brand_owner(p_brand_id) = auth.uid()`; `private.account_lifecycle_service_state_readonly(auth.uid(), 'x_autopost')` |
| Answer | `{ "state": "active" }` or a fixed code (`ACCOUNT_LIFECYCLE_AUTH_REQUIRED`, `NOT_WORKSPACE_OWNER`, `ACCOUNT_DELETION_IN_PROGRESS`, `ACCOUNT_LOCKED`, `SERVICE_NOT_REGISTERED`, `SERVICE_DELETION_IN_PROGRESS`, `SERVICE_NOT_ACTIVE`, …); never another person's data; input is the workspace slug only |
| Adds over Option A | session liveness at the database; the exactly-one-owner rule; one snapshot; typed codes |
| Cannot add | ordering with a freeze (no lock spans the provider call), the AI plan, the in-flight limit |
| Single owner / stack | F5 writes the SQL in a new F5-only Draft PR on top of #275 (a candidate file after P10, never in `supabase/migrations/` before approval); G6 keeps the Edge handler and calls it; no file of another slot changes |
| Review | a focused Codex Sol (high) review of the definer function, its ACL and its refusal paths, before any apply; PR #233's limited recheck stays a separate gate |
| Tests it needs | the M2 suite of this task re-pointed at the RPC (every row of section 4), ACL for `anon` / `service_role` / `authenticated`, a session revoked with an unexpired token, two owners, a foreign brand, a UUID instead of a slug |
| Status | **not created.** A new definer RPC with a grant to `authenticated` is a shared security boundary: it needs the 総合指令室's approval first. Next limited Auth specification requiring approval: this table, nothing more. |

Rejected: a lock-based "authorization lease" held across the provider call (a database lock cannot span an HTTP call); letting `service_role` call F5's owner-only private functions (F5 will not grant that); treating `x_autopost` as the AI plan.

## 8. What was run (offline; exact commands and results in section 10)

* **M2 suite** — `common_account_m2_ai_consult_authz_run.sh` runs `common_account_m2_ai_consult_authz_test.ts` over `common_account_m2_ai_consult_authz_fixture.sql`: 12 tests on a throw-away local PostgreSQL 17 (the Phase 11 model baseline, the **real** `20260918120000` membership RLS, and the real P1 to P10), with an Edge identity double, a G6 plan double and a counting provider mock. `globalThis.fetch` is replaced by a thrower.
* **Mutation check** — `common_account_m2_ai_consult_authz_mutations.py`: each rule of the real table grants, RLS, owner rule, state decision, ACL and the T13 guard is broken in a copy; the suite must fail.
* **Provenance** — `common_account_m2_provenance_check.py`: every source is the pinned blob, contains the quoted names, and the live handler still mentions none of F5's.
* **Document test** — `m2_contract_doc_test.ts`.

Source versus managed: everything here is *source / local model*. Managed-only and NOT_VERIFIED: PostgREST's role and claim mapping and `55P03`, the behaviour of `/auth/v1/user` for a revoked session, embedded-resource reads, the real `brands` RLS, GoTrue sessions, the real AI provider.

## 9. NOT_VERIFIED, owners and what happens next

| Item | Owner | Next step |
| --- | --- | --- |
| G6's handler integration (plan, quota, ledger, dedupe, recheck) | G6 / F6 | stays on HOLD until section 6 is accepted and its conditions are implemented in a source candidate |
| the behaviour of `/auth/v1/user` for a revoked session; PostgREST embedding; ACL on a hosted project | managed | M-steps of the Phase 13 plan (PG5/PG6, none opened) |
| the real `brands` RLS | outside the repository | production catalog read (PG2a, not approved) |
| Option B (the RPC) | F5, after approval | the 総合指令室 decides; Sol (high) review first |
| the PR #233 limited P2×4 recheck | independent reviewer | separate gate before any managed apply |
| AI erasure on account deletion (Issue #266 handoff) | F6 / F5 later | not part of this task; not a prerequisite of the first manual X post |
| a real AI call, a paid API | owner | not authorized |

## 10. Re-run

```bash
CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_m2_ai_consult_authz_run.sh
CAL_PGHOST=… CAL_PGPORT=… CAL_PGSUPER=… python3 supabase/tests/common_account_m2_ai_consult_authz_mutations.py <repository root>
python3 -I supabase/tests/common_account_m2_provenance_check.py
deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/m2_contract_doc_test.ts
```

## 11. What was executed for this document (offline; exact commands and results)

All commands ran in `/Users/yuya/Developer/kabumori-f5-m2` (a clean worktree stacked on PR #275) against a throw-away local PostgreSQL 17.11 (`listen_addresses` empty, a Unix socket under
`/private/tmp`, fake data, deleted at the end; every runner refuses a host that is not a `/tmp` socket directory). No managed or production system, no credential, no network request of any kind, no real AI.

| # | Check | Command | Result |
| --- | --- | --- | --- |
| 1 | **the M2 suite** on the real P1 to P10 and the real membership RLS (section 8) | `CAL_PGHOST=<tmp socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_m2_ai_consult_authz_run.sh` | **12 passed**, 0 failed |
| 2 | mutation check (14 mutants: table grants, RLS, owner rule, state decision, ACL, T13 guard, the busy mapping) | `python3 supabase/tests/common_account_m2_ai_consult_authz_mutations.py <repository root>` | control PASS, **14/14 detected**, 0 invalid |
| 3 | the cited sources are the pinned blobs, contain the quoted names, and the live handler names none of F5's | `python3 -I supabase/tests/common_account_m2_provenance_check.py` | `M2_PROVENANCE\|ALL\|PASS` (8 sources) |
| 4 | this document's claims | `deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/m2_contract_doc_test.ts` | **6 passed**, 0 failed |
| 5 | the whole harness suite, earlier tests included | `deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/` | **177 passed**, 0 failed (171 before + 6) |
| 6 | the M1 chain suite still passes on the same chain (regression) | `bash supabase/tests/common_account_m1_manual_x_publish_run.sh` | **13 passed**, 0 failed |
| 7 | the production Edge function's own tests, unchanged | `deno test --no-config --no-check --allow-read --allow-env supabase/functions/account-delete/` | **143 passed**, 0 failed |
| 8 | the live consult handler's own tests, unchanged | `deno test --no-config --no-check --allow-read --allow-env supabase/functions/social-mobile-consult/` | **26 passed**, 0 failed |
| 9 | type-check and lint | `deno check --no-config supabase/preflight/managed_disposable/*.ts supabase/preflight/managed_disposable/x_saga_standin/*.ts supabase/tests/common_account_m2_ai_consult_authz_test.ts`; `deno lint --no-config supabase/preflight/managed_disposable/ supabase/tests/common_account_m2_ai_consult_authz_test.ts` | no error; `Checked 44 files`, no problem |
| 10 | scope and hygiene | `git diff --cached --name-only`; `git diff --cached --check`; scan of the staged diff for key shapes, connection strings with a password and the one production ref; `git merge-tree --write-tree origin/main HEAD`; open PRs touching these paths | 8 files, +987 lines; nothing under `supabase/functions/`, `supabase/migrations/`, `supabase/candidates/`, `apps/` or `.agent*`; clean; 0 key shapes; 0 passworded connection strings; 0 production-ref hits; no conflict with `origin/main`; no open PR touches these paths; the heads of PRs #233, #249, #263, #264, #265, #273 and #275 are unchanged |

Not run, on purpose: any managed or production access; F6's handler seam (PR #273) and its ledger; a real AI call; Option B (it does not exist); the PR #233 limited recheck; any change to another owner's file.
