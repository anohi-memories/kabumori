# POSTONA personal (plan A): the workspace and session rules, and what each consumer checks today (source-only)

Status: **source-only investigation + one static evidence check.**
- No SQL, migration, RPC, Edge, app or consumer file changed. Nothing applied anywhere; no managed or production connection (not even
  read-only).
- It decides none of the user's open policies (section 7). Production **NO_GO**.
- It does not make PR #457 (independent review open, H3 stopped) reviewed or passed, and does not resume that review.
- TASK `common-account-g5-personal-workspace-session-consumer-contract-matrix-20261025` (Issue #320, G5-01 generation, task 32, completion K5).
- New files only:
  - this document;
  - `supabase/tests/g5_32_consumer_contract_evidence_check.py` (reads pinned git objects only; section 8).

Labels:
- **[V]** VERIFIED in source at the pinned commit (product code or a named Draft candidate; which one is stated).
- **[M]** MOCK_ONLY: only a test, a model, a fake or a document asserts it. A mock PASS is **not** an implementation.
- **[N]** NOT_IMPLEMENTED: the source shows the check is absent.
- **[P]** PROPOSED by G5 (not decided, not built).
- **[U]** UNKNOWN / NOT_VERIFIED.
- **[PENDING]** a user policy; options only (section 7).

Pinned commits (every path:line below is at one of them):

| Name | Commit | What |
| --- | --- | --- |
| main | `0c42933ca5030ab31a56267529430d0473d9b155` | origin/main (unchanged since 2026-10-20) |
| G5S | `21a5cad4b71de63265db8517da93c6efc60cdde8` | G5 stack head, PR #457: R1 `001`, R0 `002`, SV `003`, W1, the owner epoch |
| D1 | `c9f726e9bea8dece62c12f6cfd7872890ae3b5ad` | PR #494: R0 / R1 / SV strict `is_anonymous` (H4 PASS_SOURCE_FOCUSED) |
| T13S | `1c3b16a75e9fe6230af913eb720376ab34566356` | PR #489: T13 + S2-1 (H4 PASS_SOURCE_FOCUSED) |
| G3 | `f34aab9714f5d4f11388609262d5f64cdcce5ed9` | PR #392, G3's reservation candidates (X `001`–`006`, Threads `007`). G3-28 / G3-29 (#493 `3760e987`, #495 `6c50497c`), #466 and #463 add docs and offline QA only |
| G4 | `85d3891a7587a7566579a793083f540952664fa6` | PR #491 (G4-36), on PR #484 (G4-35). The X Edge and X migrations are byte-identical to main |
| G6 | `e0bdad4dccb44ba59b3520c9ba154cad2809f0cb` | PR #496 (G6-18), on PR #492 (G6-17); the Gateway source is the same at both |

Short names: `R1` = `001_authorization_verdict.sql`, `R0` = `002_bootstrap_verdict.sql`, `SV` = `003_session_verdict.sql`
(all under `supabase/candidates/common_account_authorization_verdict/`); `XB` = main's live X begin
`supabase/migrations/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql`.

## 1. Plan A: what stays, and how one personal workspace is chosen

### 1.1 Protected as they are (no change proposed)

| Object | Role in plan A | Where |
| --- | --- | --- |
| `auth.users`, `auth.sessions` | the person and the live session (GoTrue owns them; G5 only reads) | R1 / R0 / SV session stage; T13 step 3 |
| `public.brands`, `public.brand_memberships` | the workspace and its owner. The personal workspace id is `'u_' \|\| substr(md5(user_id), 1, 24)`, kind `social_mobile_user_v1` | `XB:39` @main; `R0:157` @G5S |
| `public.service_entitlements` (`x_autopost`) | the service switch | R1 / R0 / T13 |
| the brand owner epoch + `common_accounts.lifecycle_version` | `g5oe:<epoch>:<lifecycle_version>` in R1's allow (`R1:287`); W1 compares the bound pair (`R1:330`) | G5S. The epoch history guard is PR #457 (**not independently reviewed**) |

### 1.2 The cases, and what each place does with them

| Case | R0 (begin verdict) @G5S | R1 (per-brand verdict) @G5S | main X begin `XB` | G4 Threads provisioner @G4 | G3 X create @G3 |
| --- | --- | --- | --- | --- | --- |
| C0: no workspace yet | allow (absent) [V] | — (no brand to ask about) | creates `u_<md5>` + owner row (`XB:39-45`) [V] | creates it [V candidate] | `ACCOUNT_NOT_FOUND` [V candidate] |
| C1: exactly the own `u_`, sole owner, kind `social_mobile_user_v1` | allow [V] | allow with `g5oe` [V] | reuses it [V] | uses it [V candidate] | allowed [V candidate] |
| C2: the own id exists with another kind | deny `OWN_WORKSPACE_CONFLICT` (`R0:209`) [V] | deny `WORKSPACE_KIND_UNSUPPORTED` (`R1:271-272`) [V] | `on conflict (id) do nothing`, then inserts the caller as owner (`XB:40-45`) [V]. **Joins a row it did not create** | refused [V candidate] | allowed if an owner row exists [V candidate] |
| C3: the own id exists, owned by someone else, or the caller is only a member | `OWN_WORKSPACE_CONFLICT` (`R0:211`) [V]; owner count ≠ 1 → unknown `WORKSPACE_OWNER_UNKNOWN` (`R0:210`) | deny / unknown [V] | same join path as C2 when the caller owns nothing else [V] | refused [V candidate] | co-owners allowed (#493 W1–W3) [V candidate] |
| C4: the caller owns exactly one **other** brand (legacy / shared) and no `u_` | **allow** (only `u_` is looked at) [V] | for that brand: deny `WORKSPACE_KIND_UNSUPPORTED` unless kind `social_mobile_user_v1` [V] | **reuses that brand** whatever its kind or other members (`XB:34-37`) [V] | refused (`WORKSPACE_CONFLICT`) [V candidate] | allowed if the account row points there [V candidate] |
| C5: owns two or more brands | allow if `u_` absent or own [V] | per brand [V] | `SOCIAL_MOBILE_MULTIPLE_OWNED_BRANDS_UNSUPPORTED` (`XB:31`) [V] | refused [V candidate] | allowed per account row [V candidate] |
| C6: account `deleting` / locked, service not active | deny [V] | deny [V] | not checked [N] | via T13 [V candidate] | via `service_state_refusal` (G5 body not in that tree) [U] |

**Finding (unchanged since G5-23 S1-F1, now with every place side by side):** C2, C3 and C4 get different answers in different places.
- The live X begin (main) is the most permissive: it joins a row under the derived id it did not create (C2 / C3), and reuses any single owned
  brand (C4).
- R0 lets C4 through, because it looks only at `u_`. So an R0 allow is **not** evidence for the workspace the X begin will choose.
- G4's Threads provisioner already applies the strict rule ("the own `u_`, and owns no other brand"). G3's X create allows co-owners.

## 2. The G5 gates after D1 and S2-1 (delta from G5-26 §1)

| Gate | Anonymous / missing `is_anonymous` | Session revoked / expired | Owner epoch | Entitlement | Workspace | State |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | refused unless the JSON boolean `false` / per-claim `'false'` (`D1 002…:175, :179`) | `SESSION_REVOKED` / `SESSION_EXPIRED` | `g5oe` in the allow | `x_autopost` active | the requested brand: owner, kind, sole owner | D1 candidate, H4 PASS (source) |
| R0 | same (D1) | same | null (begin only) | same | `u_` absent or exactly own (not C4) | same |
| SV | same (D1 `:458`) | `'SESSION_REVOKED'` / `'SESSION_EXPIRED'` (`SV:130`) | none | none | none | candidate; owner-only (`SV:133`); **install needs the owner-epoch exposure helper (`SV:46`)** |
| T13 | refused unless a proven false (`T13S 001…:126`) | refused after the locks | none (W1 compares) | `x_autopost` active, locked | none | S2-1 candidate, H4 PASS (source) |
| W1 | — (worker, no session) | — | the bound pair must equal the live pair | `x_autopost` | the brand's sole owner | G5S candidate |

**None of these is on main** (the evidence check confirms: no `common_account_authorization_verdict` or `account_lifecycle_session_verdict`
in main's migrations).

## 3. What each consumer checks today

A [V] marked "candidate" is real SQL / TypeScript in an **unapplied Draft PR**. Nothing in this table is live except the main X flow.

### 3.1 G4 — X begin and callback (live on main), Threads callback (candidate)

| Item | X begin / callback (main = G4) | Threads begin / consume / complete (G4, candidate; Edge hard-disabled, no API grant `postona_threads_oauth_workspace_candidate.sql:347`) |
| --- | --- | --- |
| G5 gate | none: GoTrue `/auth/v1/user` (`oauth_logic.ts:54`) + `auth.uid()` (`XB:15`) [N] | T13 first (`…workspace_candidate.sql:191`) [V candidate]. The suite's T13 is a **mock** (`postona_threads_oauth_mock_t13_fixture.sql:7`) [M] |
| Anonymous / missing claim | no `is_anonymous` anywhere in the X Edge or `XB` [N] | the reviewed T13 lets it through; S2-1 (T13S) refuses it once applied [V candidate, not wired] |
| Session revoked / expired | only indirect: GoTrue user lookup at begin and at callback [N] | via T13 (real T13 not in that tree) [M] |
| Epoch / reconnect / ABA | oauth_state row only (hash, initiator, single use, 10 min). A reconnect does not invalidate older states [N for the epoch] | `g5oe` recorded at begin, compared at complete: `THREADS_BINDING_OWNER_EPOCH_CHANGED` (`001_threads_binding_epoch.sql:280`) [V candidate] |
| Entitlement | not read (`XB`: no `service_entitlements`) [N] | via T13 [M in that tree] |
| Workspace | section 1.2 (C2 / C3 / C4 permissive) [V] | strict rule [V candidate] |

### 3.2 G3 — reservations (all candidate, PR #392; main has none)

| Operation | G5 gate | Anonymous | Session | Epoch / ABA | Entitlement | Workspace |
| --- | --- | --- | --- | --- | --- | --- |
| X create | `auth.uid()` + `service_state_refusal` [V candidate] | Edge refuses only `is_anonymous === true` (`supabase_auth.ts:60`); a **missing claim passes** [N for missing] | Edge GoTrue lookup only; no `session_id` passed to the DB [N] | no `g5oe` anywhere in X (`postona_x_reservations/`) [N] | `service_state_refusal` [U depth] | brand of the chosen account + an owner row; co-owners allowed [V candidate] |
| X claim / send (worker) | `service_state_refusal`, `row_publishable` [V candidate] | n/a (no session) | not re-checked [N] | A→B→A re-claimed (#493 W4, #495 E2–E4) [N] | at send [V call; G5 internals U] | live owner row [V candidate] |
| X single post | **T13** (`006_postona_x_single_post_live_fence.sql:111`) [V candidate] | passes until S2-1 [N] | via T13 [V candidate] | none [N] | via T13 | sole owner [V candidate] |
| X / Threads cancel, receipt, readback | `auth.uid()` + row owner only [V candidate] | [N] | [N] (#463 D1–D5, #466 S01–S06: 42 X entry points) | none [N] | none | row `user_id` |
| Threads create | **R1** (`007…:230`) [V candidate] | via R1 (D1 strict once applied) | via R1 | `g5oe` bound on the row [V candidate] | via R1 | `brand_owner(brand) = user` |
| Threads claim / send | **W1** [V candidate] | n/a | not re-checked [N] | bound pair via W1 [V candidate] | via W1 | via W1 |

No G3 candidate calls SV yet (absent in both trees); #463 asks for it.

### 3.3 G6 — AI Gateway (candidate, not wired; main has no `supabase/ai_gateway/`)

| Item | What it does | Label |
| --- | --- | --- |
| Call path | `POST /rest/v1/rpc/common_account_authorization_verdict` with the caller's JWT; constructed only in tests | [V candidate], exercised by fakes [M] |
| v1 parsing | exactly the 8 RPC keys (`g5_rpc_transport.ts:19`), `v = 1`, deny `reason` by `TOKEN` (`authority_port.ts:54`), `g5oe` shape (`:57`), `scope` and `subject` shape | [V candidate] |
| Anonymous / session | none of its own: relies on R1; refuses `session.state ≠ active`; re-asks R1 right before send (`gateway.ts:343`) | relies on R1 [V candidate] |
| Epoch / ABA | the generation hash includes `g5oe`; a different token at the recheck refuses. An exact A→B→A token cannot recur **only if** the G5 epoch is monotonic (PR #285 design; history guard PR #457, unreviewed) | [V candidate] + [U] |
| Entitlement | any allowed entitlement in the plan allowlist; the plan itself is a business decision | [V mechanism], value [M] |
| Workspace | `p_brand_id` = a client slug matching `^[a-z][a-z0-9_]{1,40}$` (the `u_<24 hex>` id fits); R1 decides ownership | [V candidate] |

### 3.4 The gaps, by condition

| Condition | Where it is **not** stopped today (source) | Closed by |
| --- | --- | --- |
| Anonymous, claim present | main X begin; G3 cancel / receipt / readback; reviewed T13 (so G3 X single post, G4 Threads) | S2-1 (T13S) for T13 callers; R1 / SV (D1) for theirs; X begin needs a G5 gate first |
| Anonymous, **claim missing** | the same, plus G3's X Edge (`=== true` only) | D1 + S2-1 (already strict). The G3 Edge check is G3's |
| Revoked / expired session | main X begin (indirect only); every G3 cancel / receipt / X entry point; workers by design | S2-2 (section 5) for user calls. Workers: PENDING (section 7, P-4) |
| Stale epoch / reconnect / ABA | main X (oauth_state only); G3 X (no `g5oe`) | G3 X `g5oe` + W1 (needs PR #457 review); G4 X: the S2-3 rule + a connection epoch (G4's) |
| Entitlement ended | main X begin | T13 or R0 / R1 at the begin |
| Workspace C2 / C3 / C4 | main X begin; R0 (C4); G3 X create (co-owners) | S2-3 (section 4) |

## 4. S1-F1: the minimal workspace interface (S2-3) [P]

**`private.postona_personal_workspace_eligibility(p_user uuid) returns text`**

| Aspect | Proposal |
| --- | --- |
| Input | the person's id, **only** from `auth.uid()` inside the calling owner-owned function (R0, a begin RPC, a create RPC). Never a client value. A NULL input raises. |
| Output | `'absent'` (C0), `'own'` (C1), or a refusal code. `OWN_WORKSPACE_CONFLICT`: C2, C3, C4, C5 (any owned brand other than the own `u_`, any non-owner role on it, a wrong kind). `WORKSPACE_OWNER_UNKNOWN`: the owner count of the own id is not 1. An unreadable fact **raises**; never `'own'`. |
| Shape | STABLE, SECURITY DEFINER, `search_path = ''`, `row_security = off`, owned by the lifecycle owner, no grant (owner-only). The same install rules as G5-08 / G5-28 / G5-31: every row visible, exact ACL, no API role reaching the owner, the full attribute baseline, `is not true` checks. |
| Callers | R0 calls it, mapping every refusal to its **existing** v1 deny / unknown reasons, so no v2 is needed. G4's X begin and G3's X create call it before creating or choosing a workspace. G4's Threads provisioner can switch to it; its rule is the same. |
| Fail-closed | Anything but `'absent'` / `'own'` means no begin, no create and no workspace row. `'absent'` lets a begin create the `u_` row only with `on conflict` treated as a refusal, never as a join. |
| Owners | G5: the predicate and R0's amendment. G4: the X begin wiring. G3: the X create wiring. |
| Depends on | nothing new: `brands`, `brand_memberships` and the derived id. No dependency on the owner-epoch chain, so PR #457 is not needed. |
| Negative cases (for its suite) | C2–C5 each refused; a member who is not owner; two owners on `u_`; a brand that only *looks* like `u_` (another user's hash); a NULL user; RLS hiding a membership row (must raise, G5-08); a drifted function (G5-28 / G5-31 shape guards); R0 before vs after (C4 turns from allow to `OWN_WORKSPACE_CONFLICT`). |
| Open | C4 / C5 people (legacy or shared brands) are **refused** by this rule. Whether they get a migration path is **[PENDING] P-1**. A refusal is the fail-closed default, not a policy decision. |

## 5. S2-2: the minimal session-only gate [P]

**`private.postona_personal_session() returns text`** — SV's subject and session stages (with D1's strict claim), and its **own** install
checks.

| Aspect | Proposal |
| --- | --- |
| Why not SV as is | SV's install refuses without the owner-epoch exposure helper (`SV:46`), part of the PR #285 → #303 → #457 chain, which is still under independent review. The person-facing reads and cancels (G3 #463) should not wait for it. |
| Input | none (claims, `auth.uid()`, `auth.users`, `auth.sessions`). |
| Output | `'active'` \| `'AUTH_REQUIRED'` \| `'SESSION_REVOKED'` \| `'SESSION_EXPIRED'`. An unreadable fact raises. `ACCOUNT_BANNED` is added **only** if the user approves the ban meaning ([PENDING] P-3); until then the ban is not read, as today. |
| Shape | STABLE, definer, `search_path = ''`, `row_security = off`, owner-only. Install: owner, row visibility of `auth.users` / `auth.sessions`, `auth.sessions` shape, ACL over the role graph, attribute baseline, `is not true`. **No** owner-epoch helper. |
| Consumers | owner-owned VOLATILE READ COMMITTED RPCs that call it **first**, in the same statement as their read / lock (G5-11 consumer contract C-1–C-5). G3: Threads cancel / receipt, the X `get` / `list` / `cancel` / readback entry points (#463, #466). Not for writers: writers keep T13, which also checks the account and the service. |
| Fail-closed | Anything but `'active'` touches no row; the RPC maps the code to 401 and changes nothing. |
| Owners | G5: the gate. G3: the wiring. The Edge must forward the verified JWT unchanged, `session_id` and `is_anonymous` included (G3 #463 AC-7; H5 / G4 transport for Threads). |
| Negative cases | missing / null / string `is_anonymous`; `role` anon; `sub` ≠ `auth.uid()`; no `session_id`; revoked, expired, another person's session; RLS hiding a session row (raise); drifted function. It must answer the same as SV for every claim set (byte-for-byte comparison, as G5-27). |
| Not covered | a worker has no session. Whether a later sign-out or revocation stops posts that were already scheduled is **[PENDING] P-4**. G5 does not decide it. Today W1 checks the account, the service and the owner epoch, not the session. |

**Order:** S2-3 and S2-2 are independent of each other and of PR #457. Both keep the v1 wire, the owner epoch, T13, R1 and W1 as they are.
Neither removes a check.

## 6. Next steps, by who can do them

### 6.1 G5-only source work (needs a TASK and an independent Codex Sol (high) review each)

1. **S2-3 eligibility + R0 amendment**: an isolated candidate and its PG17 suite. Run the old R0 first to reproduce C4's allow. This closes
   S1-F1 at the G5 side and unblocks G4's X begin alignment. Highest priority: the live X begin is the most permissive place.
2. **S2-2 personal session gate**: an isolated candidate, its suite, and a comparison with SV. It unblocks G3's cancel / receipt / X entry
   points without PR #457.
3. **The shared negative-case table** of sections 4–5, as expectations G3 / G4 / G6 can import (answers G4 #491 Q7 / Q9). G5 does not adopt
   G4's model rows until each is checked against the predicate.

### 6.2 Depends on another slot

| Step | Owner | Needs from G5 |
| --- | --- | --- |
| X begin: call T13 (or R0) first, then the S2-3 rule. Stop joining on `on conflict`. | G4 (G4-35 Q4 names G3 or G4) | 6.1-1 |
| X `g5oe` binding at create + W1 at claim / send; "no epoch ⇒ no send" for old rows | G3 | PR #457 independent review (H3) |
| cancel / receipt / X entry points call S2-2 first; Edge forwards `session_id` and `is_anonymous` | G3 | 6.1-2 |
| X Edge: refuse a missing `is_anonymous`, not only `true` | G3 | none; it matches D1 |
| AI Gateway: a compatibility test against D1's R1 answers (an anonymous caller is now a deny) | G6 | none (D1 source) |
| Threads transport forwards the verified claims unchanged | G4 / H5 | none (S2-1 refuses otherwise) |

### 6.3 Before production (not possible in source)

- The managed GoTrue claim set: is `is_anonymous` always present, and is anonymous sign-in enabled? [U]
- Managed function attributes, owners, ACLs and RLS: G5-18 read-only gates G0–G6, run only with the user's approval.
- PR #457 independent review. The Data API grant change of 2026-10-30 (G5-12 rule).
- A real TRANSFORM path: not constructible here [U].

## 7. User policies left open [PENDING] (options for #299, not choices)

| # | Question | Options (none chosen) | Effect until decided |
| --- | --- | --- | --- |
| P-1 | People with a legacy / shared workspace (C4 / C5) | (a) personal only: they are refused; (b) a one-time move to their own `u_`; (c) an explicit opt-in for a single-owner legacy brand | S2-3 refuses them (fail closed) |
| P-2 | Read / cancel / receipt after a stop (locked, service ended) | (a) allowed with a live session (S2-2 only); (b) refused like a write | SV / S2-2 answer about the session only; consumers that need more call R1 / T13 |
| P-3 | Meaning of locked vs banned (`banned_until`) | (a) banned = locked for every gate; (b) banned only stops sign-in (GoTrue), gates unchanged | not read anywhere (G5-26 D4) |
| P-4 | Sign-out local vs global, and scheduled posts after a sign-out / revocation | (a) keep posting (the account and service decide); (b) a global sign-out cancels pending reservations; (c) ask the person | workers do not check the session |
| P-5 | Retention / deletion of bodies, audit rows, receipts, drafts | (owner of the retention TASK) | unchanged |

## 8. What was checked (and what was not)

- **Static evidence check** `supabase/tests/g5_32_consumer_contract_evidence_check.py`. It reads every pinned path:line above with
  `git show <sha>:<path>`:
  - 32 cited lines contain their token;
  - 11 absence claims are whole-file / whole-tree searches that found nothing (for example: no `is_anonymous` in main's X begin, the G4 X
    Edge or the G6 Gateway; no session verdict and no `g5oe` in G3's X candidates; no G5 verdict in main's migrations);
  - plus a control that the checker can fail.

  Result: **44 / 44 PASS**. The consumer rows of section 3 came from a read of the three trees and were then pinned by this check. One cited
  line was wrong in that read and was corrected before the check passed.
- Not run: any product test, any PG17 suite (no SQL changed), any managed / production read, any real OAuth / JWT / Edge.
- NOT_VERIFIED:
  - the real T13, R1 and SV inside the G3 / G4 / G6 trees (they carry mocks or call ports);
  - the G5 body of `service_state_refusal`;
  - the managed claim set;
  - the consumers' runtime behaviour.
