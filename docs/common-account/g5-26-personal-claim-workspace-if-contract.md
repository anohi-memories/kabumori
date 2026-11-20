# POSTONA personal authorization — the claim / session / workspace interface across R0, R1, SV and T13 (source-only)

Status: **documentation only.**
- No SQL, DDL, RPC, Auth, Edge, app or existing document changed.
- No managed or production connection (not even read-only); no PostgreSQL run.
- Production **NO_GO**.
- Every "proposal" is for the 担当ちゃ / the user / the owners to decide; G5 decides no other owner's TASK.

- TASK `common-account-g5-personal-session-claim-r0-r1-sv-compat-contract-20261023` (Issue #320, G5-01 generation, task 26, completion K5).
- Inputs:
  - H4's focused review of PR #483: `PASS_SOURCE_FOCUSED`, Issue #331 comments 6367775700 / ACCEPT 6367813367;
  - the command's triage (Issue #320 comment 6367584235);
  - G4-35's S1-F1 contract (PR #484, head `69409c7900ad7c9a4cff7924dd1ea221e2c4c733`, `docs/postona/s1-f1-personal-workspace-oauth-contract-20261023.md`, read only; its §6 asks G5 Q1–Q3);
  - the G5-23 S1 contract (PR #477).
- G3 (#318) and G6 (#321) are idle; G4-35 is active and is **not** overwritten here: this document only answers it.

Labels: **[K]** known from source at the pin; **[P]** proposal; **[open]** undecided by the user / command; **[U]** managed / production NOT_VERIFIED.

| Pin | Commit | What |
| --- | --- | --- |
| main | `0c42933ca5030ab31a56267529430d0473d9b155` | live migrations (X begin, lifecycle Phase 1–3a) |
| G5S | `21a5cad4b71de63265db8517da93c6efc60cdde8` | PR #457 head: R1 / W1 / W2 (`001_authorization_verdict.sql`), R0 (`002_bootstrap_verdict.sql`), SV (`003_session_verdict.sql`), owner epoch — **independent review not done** |
| T13R | `76b50e1e03f82faaa3460bab1603afa8fef3ce44` | the reviewed T13 (`20261010051938_common_account_service_write_guard.sql`) |
| P483 | `9d7399047affcac44649aeb7d204be3a609dc528` | PR #483 head: T13 with the S2-1 anonymous refusal (`001_t13_anonymous_refusal.sql`) — **H4 PASS_SOURCE_FOCUSED** |
| G6 | `bc407f6574dc929b73ab19931532807030cf0ffa` | PR #431: `authority_port.ts`, `g5_rpc_transport.ts` |

## 1. Source matrix: how each gate reads the person [K]

| Aspect | R1 (G5S `001…`) | R0 (G5S `002…`) | SV (G5S `003…`) | T13 reviewed (T13R) | T13 + S2-1 (P483) |
| --- | --- | --- | --- | --- | --- |
| Claim source and priority | per-claim `request.jwt.claim.sub` first, else `request.jwt.claims` (JSON object) — L163-L179 | same — L125-L140 | same — L91-L106 | same — L74, L94-L107 | same |
| `sub` / `session_id` format | lowercase-hex UUID regex — L182 | same — L143 | same — L109 | `::uuid` cast (also accepts upper case, braces) — L111; cast failure → `ACCOUNT_LIFECYCLE_AUTH_REQUIRED` | same as T13R |
| `role` | `authenticated` — L183 | same — L144 | same — L110 | `authenticated` — L116 | same |
| `sub = auth.uid()` | yes — L184 | yes — L145 | yes — L111 | yes — L116-L117 | yes |
| `is_anonymous` per-claim | missing / empty → `false` (allowed) — L167 | same — L129 | same — L95 | **not read** | **must be exactly `'false'`**; missing / empty → refused — L93 |
| `is_anonymous` JSON | missing / JSON null → `false` (allowed); boolean true, a string (even `"false"`), a number → refused — L179 | same — L140 | same — L106 | **not read** | **must be the boolean `false`** (`jsonb_typeof` check); missing / null / string / number / object → refused — L104 |
| Answer when the subject fails | v1 deny `AUTH_REQUIRED`, subject `system` | v1 deny `AUTH_REQUIRED` | `'AUTH_REQUIRED'` | raise `ACCOUNT_LIFECYCLE_AUTH_REQUIRED` (42501) before any lock | same, anonymous included — L116-L117 |
| Login exists | `auth.users` row — L208, L230 | same | same — L121, L127 | no direct read; the live session row cascades with the login | same |
| Session live | `auth.sessions` by id **and** user_id, `not_after` null or future; `SESSION_REVOKED` / `SESSION_EXPIRED` with a hashed ref | same | same, returns the code | same predicate **after** the locks — L154; any failure → `ACCOUNT_LIFECYCLE_AUTH_REQUIRED` | same |
| Account `locked` | deny `ACCOUNT_LOCKED` | deny `ACCOUNT_LOCKED` | **not checked** (session-only by design) | raise `ACCOUNT_LOCKED` — L133 | same |
| GoTrue ban (`banned_until`) / soft delete (`deleted_at`) | **not read** | not read | not read | not read | not read |
| Service states (x_autopost) | provisioning → pending; suspended / ended / deleting → deny with their reasons | same | not checked | anything but `active` → `SERVICE_NOT_ACTIVE` (deleting → `SERVICE_DELETION_IN_PROGRESS`) — L147 | same |
| Workspace | the requested brand: member, owner, kind `social_mobile_user_v1`, single owner | the person's own `u_<md5>` only (absent or exactly theirs) — L157, L209-L211 | none | none | none |
| Owner epoch | allow carries `g5oe:<epoch>:<lifecycle_version>` | null (begin only) | none | none (W1 compares) | none |
| Isolation / locks | STABLE, one statement, no lock | same | same | VOLATILE, READ COMMITTED only (L85), I1 locks | same |
| Output | v1 wire (8 keys; the Edge adds 2 times) | v1 wire, `owner_epoch` null | text | raise / nothing | raise / nothing |

## 2. The differences, classified

| # | Difference | Class | Proposal |
| --- | --- | --- | --- |
| D1 | A missing / null / empty `is_anonymous`: T13 (P483) refuses, R0 / R1 / SV allow | **[K]**; whether a valid managed token can lack the claim is **[U]** (GoTrue's reference lists it as always present; H4 named it NOT_VERIFIED) | [P] Align R0 / R1 / SV with P483 in **one** G5 source TASK: the same two lines as P483; own suites, mutants; Codex Sol (high). It is **v1-compatible**: the answer stays `deny AUTH_REQUIRED`, no new key or reason. If the 担当ちゃ prefers, record the difference as accepted instead; then T13 stays the stricter gate. |
| D2 | `sub` / `session_id`: regex (lowercase) in R0 / R1 / SV vs a `::uuid` cast in T13 | [K]; GoTrue issues lowercase ids [U] | [P] Low priority: when D1's TASK touches T13 again, use the same regex in T13 so that every gate refuses the same strings. Not urgent: the cast only accepts more spellings of the same id, and `auth.uid()` must still equal it. |
| D3 | Revoked vs expired: distinguished by R0 / R1 / SV, a single `ACCOUNT_LIFECYCLE_AUTH_REQUIRED` in T13 | [K] | Keep: T13 raises inside a writer, and the consumer maps it to 401 (G5-24 doc §3). No change. |
| D4 | GoTrue ban / soft delete read nowhere | [K] the gap; its meaning is **[open]** (S1 §1: locked / banned) | [P] Decide the meaning first. Then add `ACCOUNT_BANNED` as a v1 **deny** reason. A new deny reason is v1-compatible, because G6 passes any deny reason through as deny. |
| D5 | `locked`: R0 / R1 / T13 refuse; SV does not | [K], by design (SV answers only "is the session live" so that read / cancel can work after a stop) | Whether a locked person may read / cancel is **[open]** (S1). Until decided, consumers that need it call R1 / T13, not SV. |
| D6 | Service `provisioning`: R0 / R1 → `pending`; T13 → `SERVICE_NOT_ACTIVE` | [K] | Keep: a writer must not write while provisioning; the person-facing verdict says "wait". |

## 3. What PR #483's PASS covers, and what it does not

- **Covered** (H4, PASS_SOURCE_FOCUSED, PG17 7 / 7, 12 / 12 mutants, PR #480's P2 reproduced and closed): T13's anonymous and unproven-claim
  refusal before any lock, the same OID / ACL / shape, install and rollback guards.
- **Not covered:**
  - R0 / R1 / SV (D1);
  - real G3 / G4 consumers;
  - the managed GoTrue / PostgREST claim set;
  - the owner-epoch candidate;
  - anything of PR #457 (its independent review is **not done**);
  - production.
- **Not production approval:** the PASS is a source-focused review result.

## 4. Cross-owner dependencies and mismatches

| Consumer | Uses | Current state | Mismatch / risk | Owner of the fix |
| --- | --- | --- | --- | --- |
| G3 X reservations (P7 readback / cancel, 43 X entry points) | SV (planned), P4 binding | SV not wired; X entry points have no session contract ([R] PR #466) | SV still allows a missing claim (D1). SV's install depends on the owner-epoch helper (S1 / S2-2). | G5: D1 + S2-2. G3: wiring (its own TASK; G3 is idle) |
| G4 live X begin `begin_social_mobile_x_oauth_connection` (main `20260922003101…:L15-L21`) | `auth.uid()` only | no session-live, role or anonymous check; reuses any single owned brand (S1-F1) | an anonymous or revoked-session caller with a valid JWT is not refused there; R0's allow and the begin's workspace can differ | G4 / G3 (G4-35 is mapping it). G5 provides R0 / T13 / the workspace predicate. |
| G4 Threads begin / consume / complete (PR #124) | T13 first, the provisioner | candidate | inherits S2-1 when applied; needs is_anonymous **boolean false** in the claims it forwards (H5 transport, Q2 below) | G4 / H5 |
| G6 AI authority (`authority_port.ts`, `g5_rpc_transport.ts` at G6) | R1 over REST | candidate, not wired | none in the wire. D1's alignment narrows R1 only by an existing reason. The RPC keys (8) match `RPC_WIRE_KEYS` (L19); the times are stamped by the transport. | G6 (idle): a compatibility test when assigned |
| G1 / G2 app enrollment and sign-out | `start_*` / `reactivate_*`, `signOut` | main | sign-out scope and drafts are **[open]** (S1) | user decision, then G1 / G2 |

## 5. The wire: v1 stays; when a v2 would be needed [P]

**Everything proposed here stays v1:**
- D1 alignment → an existing deny reason;
- D4 `ACCOUNT_BANNED` → a new **deny** reason (G6's parser passes any deny reason matching its `TOKEN` (`authority_port.ts@G6` L54) through as a deny, L103-L104);
- the S1-F1 workspace rule in R0 → the existing `OWN_WORKSPACE_CONFLICT`;
- the S2-4 usage projection → a **separate** advisory RPC, not R1.

**A v2 is needed only if any of these changes:**
- the keys;
- the meaning of `decision`;
- the `g5oe:` token;
- the entitlement strings;
- a new **allow-path** condition that G6 must check;
- the session object.

**The v2 plan, if ever needed (not implemented):**
1. A new function `common_account_authorization_verdict_v2` next to v1, never replacing v1 in place.
2. G6 accepts `v: 1` or `v: 2` per answer by exact key sets, and never mixes them within one request / recheck pair: the recheck must have the same `v`.
3. A deny on v2 never falls back to v1.
4. The callers switch over; v1 is removed only after zero callers are proven.

**Negative tests for that plan:**
- a v2 answer to a v1 parser;
- a v1 recheck after a v2 verdict;
- extra or missing keys;
- an allow with a reason;
- a `g5oe` in the wrong shape;
- a v2 deny with a v1 fallback attempt.

Each must end as unknown / deny with nothing sent.

## 6. Handoff (for the 担当ちゃ to route as COORDINATION; not posted by this task)

### 6.1 To G4 (#319) — answers to G4-35 PR #484 §6 (G5's proposals, not decisions)

| G4's question | G5's answer [P] | Decided / open / v2 | Owner | Tests G4 should carry |
| --- | --- | --- | --- | --- |
| Q1 Will G5 offer the §4.1 rule as an owner-only predicate, and add "owns no other brand" to R0? | **Yes, proposed** for a G5 S2 TASK: `private.postona_personal_workspace_eligibility(uuid)`, with R0 amended to call it. The answer stays `OWN_WORKSPACE_CONFLICT`. | proposal; needs a TASK + Sol | G5 | the §1.1 table of PR #484 run against R0, the X begin and the provisioner, with one answer per row |
| Q2 After S2-1, does T13 conflict with H5's JSON-only claims? | No, if the transport forwards the **verified** claims unchanged, `is_anonymous` included. If it drops or rewrites the claim, T13 (P483) **refuses** (fail closed). | decided by P483's PASS (source); the managed claim set is [U] | G4 / H5 | a forwarded token with `is_anonymous: false` → passes; a token without it → `ACCOUNT_LIFECYCLE_AUTH_REQUIRED`; `true` → refused |
| Q3 Does the X begin use R0? | [P] Yes, for the **first** connection's begin only, as Threads does. An R0 allow authorizes the begin only: the code exchange and posts stay behind R1 + a recheck. But **not before** the X begin adopts the §4.1 rule; until then R0's allow is not evidence for the begin's workspace (S1-F1). | proposal | G4 / G3 (X begin), G5 (R0) | an R0 allow followed by a begin for a person who owns another brand → both refuse after the change |

**Extra items for G4:**
- The live X begin checks only `auth.uid()`: no session-live, role or anonymous check. It should call T13 first (F3's candidate guard does), and so inherit S2-1. **Decided:** none. **Open:** who owns the change (G4-35 Q4).

### 6.2 To G6 (#321, idle — for when it is assigned)

| Item | Status |
| --- | --- |
| R1's v1 wire (8 keys + 2 times), reasons, `g5oe:` token, `["postona:x_autopost"]`, the session ref | **unchanged** by every G5 proposal here (decided) |
| D1 alignment (missing claim → `AUTH_REQUIRED`) | v1-compatible; open until the 担当ちゃ decides D1 |
| A possible `ACCOUNT_BANNED` deny reason | v1-compatible; open (meaning undecided) |
| v2 | not needed now; plan and negative tests in section 5 |
| Tests G6 should add when assigned | a transport answer for a token without `is_anonymous` → deny `AUTH_REQUIRED` (after D1), never allow; an unknown deny reason → deny; the existing 36-case allow-tampering matrix kept |

## 7. Negative test plan (for the follow-up TASKs; NOT_RUN here)

| Case | R0 / R1 | SV | T13 (P483) | Expected |
| --- | --- | --- | --- | --- |
| no claims / broken JSON / role anon | deny `AUTH_REQUIRED` | `AUTH_REQUIRED` | raise | refused, nothing read |
| `is_anonymous: true` (JSON / per-claim) | deny | `AUTH_REQUIRED` | raise | refused |
| claim missing / null / empty | today allow → after D1 deny | today `active` → after D1 `AUTH_REQUIRED` | raise (P483) | refused after D1 |
| claim `"false"` string / `1` / `{}` | deny | `AUTH_REQUIRED` | raise | refused |
| uppercase UUID `sub` | deny | `AUTH_REQUIRED` | today allowed if it equals `auth.uid()` → after D2 raise | same answer everywhere |
| another person's session; revoked; expired; deleted login | deny with the session code | the code | raise | refused |
| locked | deny | **[open]** | raise | per the decision |
| banned | **[open]** | **[open]** | **[open]** | per the decision |
| provisioning / suspended / ended / deleting | pending / deny | n/a | raise | no write |
| owns another brand / shared `u_` / foreign kind / two owners | R0 conflict / unknown (after Q1 also "owns another") | n/a | n/a | the same answer as the X begin and the provisioner |
| a v2 answer to a v1 parser (if ever) | — | — | — | unknown, nothing sent |

## 8. Undecided by the user (not fixed here)

The following stay **[open]**:
- retention and deletion of bodies, audit rows, receipts and drafts;
- receipt / cancel after a stop;
- sign-out local vs global;
- the meaning of locked and banned;
- existing shared / multi-owner workspaces.

They are collected on #299.

## 9. What was checked

| Check | Result |
| --- | --- |
| Every `L…` reference above was read at its pin with `git show` | see the REPORT (script output) |
| Only this new file | `git diff --name-only origin/main` |
| Secret-shaped strings, URLs, unfinished markers | none |
