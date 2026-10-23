# POSTONA personal authorization — S1 contract design (plan A, source-only)

Status: **design only.** This document changes no SQL, migration, RPC, RLS, Auth, Edge, app code, grant or row; nothing was run against a managed
or production database (not even read-only); no PostgreSQL was started for it. Production stays **NO_GO**. Every "proposal" below is for the user
(or the delegate) and the owners to decide; G5 decides no other owner's ownership, TASK or risk.

- TASK `common-account-g5-postona-personal-auth-s1-contract-design-20261023` (Issue #320, G5-01 generation, task 23, completion K5).
- Direction accepted by the user (Issue #320 comment 6357269905): **plan A** — keep the `auth.users` ids and `brands` / `brand_memberships` as the
  internal personal-workspace structure; simplify only POSTONA's person-facing contract to "the person + their personal workspace + their personal
  usage state". Shared login as a product, multiple staff, ownership transfer and Miseiro integration are deferred. Plan B (user-id-direct tables)
  is on hold.
- Inputs: the investigation of 2026-10-23 (comment 6357246550) and its first version (6353893007); G3's coordination on anonymous sessions
  (6355355712). The stopped review of PR #457 (G5-22, closed administratively in 6357311594) is **not** resumed or replaced here: PR #457 stays a
  Draft whose independent review is not done.
- A new, standalone document: it edits no other file.

Evidence labels: **[M]** source on `origin/main` (not proof that it runs anywhere); **[C]** a Draft-PR candidate at the pinned commit below (not
applied); **[R]** an owner's reported measurement (not re-run here); **[P]** this document's proposal; **[U]** NOT_VERIFIED; **[open]** a question
for the user / command, deliberately not decided.

| Pin | Commit | What |
| --- | --- | --- |
| main | `0c42933ca5030ab31a56267529430d0473d9b155` | the base of this document |
| G5 stack | `21a5cad4b71de63265db8517da93c6efc60cdde8` | PR #457 head: the G5 chain migrations P3b..P10 and the candidates R0 / R1 / W1 / W2 / SV / owner epoch |
| G3 | `f34aab9714f5d4f11388609262d5f64cdcce5ed9` (PR #392), `81ea17b1f5fd47afd6e96e9f0304d4f45119b264` (PR #466), `a208ecce0fa6ca6d3eb1d11e284f009f4a464123` (PR #471) | X / Threads reservations, P7, revoked-session and deleted-user evidence |
| G4 | `c30f246409a77080cbc03aef6c4cb72b5481e125` (PR #124), `4303a159f55fbb31f8070d6a4d049401ac46408d` (PR #472) | Threads workspace + OAuth, connect fingerprint (F1), lease / custody stack |
| G6 | `bc407f6574dc929b73ab19931532807030cf0ffa` (PR #431) | the AI gateway's authority port and G5 RPC transport |

A reference `path@pin:Lnn` means line nn of that file at that pin. G4's active TASK G4-32 (PR #474, F2) and G3's active TASK G3-27 are inputs
only: nothing here pre-empts them.

## 1. Decided, proposed and open

| Item | Status |
| --- | --- |
| Plan A as the direction; plan B on hold; shared login / staff / transfer / Miseiro deferred | **decided by the user** (6357269905) |
| Session, deletion / stop, RLS / ACL, owner and connection generations, G3 idempotency and "result unknown", G4 token custody, G6 billing and ledger stay | **decided** (non-negotiable in 6357269905) |
| The personal usage state of section 3, the workspace rule of section 4.1, the S2 design of section 6 | [P] this document |
| Whether a person may still read receipts / cancel after the service is stopped or ended | **[open]** |
| How long bodies, audit rows, receipts and device drafts are kept after a stop / deletion | **[open]** |
| What `locked` and a GoTrue ban (`banned_until`) mean for read / stop | **[open]** |
| What to do with an existing shared or multi-owner workspace, and with a person active in another app | **[open]** |
| Whether POSTONA's sign-out is local or global, and its effect on Kabumori | **[open]** |
| G3 PR #370 A1 / A2 / B / C, the brand_memberships column-ACL rule (G5-19 Q1), MAINTAIN | **[open]** (unchanged by this task) |

## 2. Contract matrix (step 1)

### 2.1 Providers (G5)

| Id | Function | Where | State | EXECUTE | Session check | Reads / decides | Consumers (pinned) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | `public.common_account_authorization_verdict(app, feature, brand)` → v1 wire | `supabase/candidates/common_account_authorization_verdict/001_authorization_verdict.sql@G5S:L133` | [C] | authenticated only (L350) | JWT claims, `sub = auth.uid()`, role authenticated, **not anonymous**, live `auth.sessions` row | account, x_autopost entitlement, workspace membership / kind / single owner, owner epoch; allow carries `g5oe:<epoch>:<lifecycle_version>` and `["postona:x_autopost"]` (L283-L289) | G3 Threads `007_postona_threads_reservations.sql@G3:L230`; G6 `g5_rpc_transport.ts@G6:L18-L19` (REST RPC, strict 8 keys); G4 tests `postona_threads_credential_composition_behavior.sql@PR472:L69` |
| W1 | `private.account_lifecycle_worker_brand_verdict(brand, key, epoch, lifecycle_version)` | `001…@G5S:L295` | [C] | owner only | none (worker) | brand state + owner epoch **equal** to the bound one + lifecycle_version **equal** | G3 `007…@G3:L136`; G4 `postona_threads_credential_composition_behavior.sql@PR472:L217` (test) |
| W2 | `public.common_account_worker_brand_verdict(...)` | `001…@G5S:L341` | [C] | service_role only (L351) | none | W1 for an Edge worker's last check | G4 `threads_connect_to_send.ts@PR472:L49` (comment / plan, not wired) |
| GC | `private.account_lifecycle_generation_covered()` | `001…@G5S:L104` | [C] | owner only | — | the lifecycle_version triggers are exactly P1's | W1, install |
| R0 | `public.common_account_bootstrap_verdict(app, feature)` | `002_bootstrap_verdict.sql@G5S:L89` | [C] | authenticated only (L222) | as R1 | account + entitlement + the person's own `u_<md5>` workspace absent or exactly theirs (L157, L209-L211) | **none wired**; G4 runs it in tests (`postona_threads_connect_fingerprint_run.sh@PR472:L74`) |
| SV | `private.account_lifecycle_session_verdict()` | `003_session_verdict.sql@G5S:L77` | [C] | owner only (no grant) | as R1, nothing about account / entitlement / brand | `active` / `AUTH_REQUIRED` / `SESSION_REVOKED` / `SESSION_EXPIRED`; raises when unreadable | **none wired**; G3 P7 (PR #392) asks for it. Install depends on the owner-epoch exposure helper (L46-L50, L159) |
| T13 | `private.account_lifecycle_assert_active_service_write(user, key)` (P3b) | `supabase/migrations/20261010051938_common_account_service_write_guard.sql@G5S:L70` | [C] (G5 Draft chain, not on main) | owner only | `sub = p_user_id = auth.uid()`, role authenticated, live session (L116, L155-L156); **no `is_anonymous` check** (G3 6355355712) | locks login KEY SHARE → account → entitlement FOR UPDATE; account active, entitlement active, no open deletion | G4 `postona_threads_oauth_workspace_candidate.sql@PR124:L139,L191,L233,L270`; G3 `postona_x_oauth_t13_guard/001_x_oauth_t13_guard.sql@G3:L97,L113,L131`; G4 `postona_threads_auth_runtime/claim_candidate.sql@PR472:L50` |
| P4 | `private.account_lifecycle_service_state_refusal(user, key)` | `20261012130000_common_account_core_service_fence.sql@G5S:L109` | [C] | owner only | none (the caller names the person) | the I1 locks and the refusal code for one explicit person | G3 X `003_postona_x_resv_g5_binding.sql@G3:L53`; G4 `threads_disconnect_candidate.sql@PR472:L133` |
| P5 | `public.common_account_brand_service_state(brand, key)` / `private.account_lifecycle_assert_brand_service_active` | `20261012230000_common_account_service_brand_state.sql@G5S:L134` (service_role, L178) / `:L154` | [C] | service_role / owner | none | the workspace owner's service state | G3 `postona_x_publish_entitlement/001_x_publish_entitlement_guard.sql@G3:L148,L181`; G4 `threads_writer_lifecycle_guards_candidate.sql@PR472:L94` |
| BO | `private.account_lifecycle_brand_owner(brand)` | `20261012230000…@G5S:L78` | [C] | owner only | — | the single owner or null | G3 `007…@G3:L184`; G4 `postona_threads_binding_epoch/001_threads_binding_epoch.sql@PR472:L188`, `threads_credential_rotation_candidate.sql@PR472:L202` |
| OE | `private.account_lifecycle_brand_owner_epoch(brand)` + exposure + history guards | `supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql@G5S:L343` (getter), `:L95` (exposure), `:L153` (history triggers) | [C], independent review **not done** (PR #457) | owner only | — | monotonic per-workspace number, NULL = refuse | R1, W1, G4 `001_threads_binding_epoch.sql@PR472:L185,L269` |

### 2.2 Writers of the identity / usage facts

| Fact | Writer | Where | State |
| --- | --- | --- | --- |
| `public.common_accounts` (`status` active / deleting / locked) and `public.service_entitlements` (`kabumori` / `x_autopost`; provisioning / active / suspended / deleting / ended) | the lifecycle foundation | `supabase/migrations/20261001150000_common_account_lifecycle_foundation.sql@main:L224-L250` | [M] |
| start (creates the account if missing and the entitlement; never restarts an ended one) | `public.start_x_autopost_service()` / `start_kabumori_service()` | `20261001150000…@main:L889-L893`, grants L1480-L1481 (authenticated); session-fenced re-definitions `20261015090000_common_account_enrollment_session_fence.sql@G5S:L153,L164` | [M] / [C] |
| reactivate (from the person's own click with the version the server reported) | `public.reactivate_x_autopost_service(bigint)` | `20261006230000_common_account_service_start_intent.sql@main:L185`, grant L196; fenced `20261015090000…@G5S:L214` | [M] / [C] |
| the app's enrollment client (session-bound requests, cancel on sign-out / user switch) | `apps/social-mobile/src/domain/service-enrollment.ts@main:L1-L16, L64, L68` | — | [M] |
| service deletion (claim / provider results / finish → the entitlement ends; the other service and the account stay) | `20261013120000_common_account_service_deletion_ownership.sql@G5S:L123` (finish) and the service_role claims L257 ff. | — | [C] |
| account deletion (saga, claims, checkpoints, release gate `blocked`) | `20261001150000…@main:L1100-L1302`, `20261009120000_common_account_deletion_completion.sql@main:L186-L700` | — | [M] |
| `brand_memberships` owner row, X: reuses **exactly one owned brand of any id or kind**, refuses more than one, else creates `u_<md5>` | `public.begin_social_mobile_x_oauth_connection` | `20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql@main:L27-L31, L34-L37, L39, L43` | [M] |
| `brand_memberships` owner row, Threads: only `u_<md5>`; refuses another owned brand, a non-self-service kind, a shared workspace, a role mismatch | `private.social_mobile_ensure_personal_workspace(uuid)` (behind T13) | `postona_threads_oauth_workspace_candidate.sql@PR124:L129, L149-L150, L158, L165, L169` | [C] |
| `brand_memberships` removal | the account-deletion saga (`delete from public.brands` cascades) | `20260928160000_social_mobile_account_deletion_candidate.sql@main:L98, L518, L593` | [M] |
| owner epoch history | the owner-epoch triggers | `001_brand_owner_epoch.sql@G5S` | [C] |

**Finding S1-F1 [P].** The three personal-workspace rules disagree.
- R0 answers about `u_<md5>` only (`002…@G5S:L157`).
- X begin (main) reuses **any** single owned brand (`20260922003101…@main:L30-L31, L34-L37`).
- The Threads provisioner refuses that case (`postona_threads_oauth_workspace_candidate.sql@PR124:L149-L150`).
- Consequence: a person who owns exactly one legacy or shared brand gets an R0 allow (their `u_` workspace is absent), and the X begin then
  binds to the other brand. Section 4.1 proposes one rule.

**Finding S1-F2.** T13 does not refuse an anonymous session (G3 6355355712, [R] in G3's isolated PG17 mock). R0, R1 and SV do. Section 6 makes the
refusal part of S2.

## 3. The personal usage state (step 2) [P]

**No new table.** The state is a **projection** of facts that already exist. It is evaluated in one statement, by the same rules as R1, so it can
never disagree with the authorization.

| Input | Source |
| --- | --- |
| Session | JWT claims, `auth.users`, `auth.sessions` (as R1 / SV) |
| Account | `common_accounts.status` and an open account-deletion operation |
| Service | the `x_autopost` entitlement and an open service-deletion operation |
| Workspace | the `u_<md5>` workspace and its memberships |

| State | Definition | POSTONA person operations (R0 / R1 / T13) | Worker send (W1 / W2) | Read receipt / cancel (SV) | Who moves it |
| --- | --- | --- | --- | --- | --- |
| S-none (no session) | no / anonymous / expired / revoked / unknown-user session | refused (`AUTH_REQUIRED` / `SESSION_*`) | n/a | refused | sign-in |
| P0 not registered | no account, or no `x_autopost` entitlement | refused `ACCOUNT_NOT_FOUND` / `SERVICE_NOT_REGISTERED`; the app's start creates it | refused | allowed by SV (session only) — **[open]** whether to show anything | `start_x_autopost_service()` |
| P1 provisioning | entitlement `provisioning` | `pending` | refused | as P0 | the lifecycle |
| P2 active | account `active`, entitlement `active`, no open deletion | allowed when the workspace rule (4.1) holds | allowed when the bound pair is equal | allowed | — |
| P3 suspended | entitlement `suspended` | refused `SERVICE_SUSPENDED` | refused (`SERVICE_NOT_ACTIVE` class) | **[open]** | operator (no writer in the repository; [U]) |
| P4 ended | entitlement `ended` | refused `SERVICE_NOT_ACTIVE`; never restarted automatically | refused | **[open]** (SV would allow) | service deletion; `reactivate_x_autopost_service(version)` from the person's own click only |
| P5 deleting | service or account deletion in progress | refused `SERVICE_DELETION_IN_PROGRESS` / `ACCOUNT_DELETION_IN_PROGRESS`; no workspace (re)creation | refused | **[open]** | deletion claims / saga |
| P6 locked | account `locked` | refused `ACCOUNT_LOCKED` | refused | **[open]** | operator ([U]: no writer in the repository) |
| P7 banned | GoTrue `banned_until` in the future | **not read by G5 today [U]**: refusal relies on GoTrue not issuing tokens; proposal: also refuse in S2 | **[open]** | **[open]** | GoTrue / operator |
| P8 workspace conflict | the person owns another brand, the `u_` workspace has another member, a foreign kind, or no single owner | refused (`OWN_WORKSPACE_CONFLICT` / `WORKSPACE_OWNER_UNKNOWN`); never taken over; manual case | refused (`BRAND_ACCESS_DENIED` class) | **[open]** | operator / support only |
| P9 Kabumori only | `kabumori` entitlement active, no `x_autopost` | = P0 for POSTONA; POSTONA never touches Kabumori's entitlement or data | n/a | as P0 | POSTONA start adds only `x_autopost` |

**Fail-closed rules:**
- An unreadable or unexpected fact is `unknown`, never allow (R1 already does this, `001…@G5S:L242-L280`).
- An unknown brand and another person's brand give the same answer.
- A dependency failure means nothing is sent.
- Operator-only transitions are listed as such: no person-facing path moves P3, P6, P7 or P8.

**Re-creation and ABA [P].**
- Deleting and re-creating the same `auth.users` id never makes an old allow valid again:
  - the lifecycle_version and the owner epoch move;
  - the history is kept;
  - the bound pair is compared for equality.
- An old token (an expired session) is refused by the session check.
- A resend after a stop is refused at the worker's last check.
- A result left uncertain stays uncertain (G3).

## 4. Consumer contracts and follow-up TASKs per owner (step 3)

### 4.1 The personal-workspace rule (all writers) [P]

**One rule** for "the person's own workspace", the strictest already written (PR #124's):
- Its id is `u_` || substr(md5(user), 1, 24).
- Its kind is `social_mobile_user_v1`.
- Exactly one membership: the caller as `owner`.
- The person owns **no other** brand.

Anything else is P8 and refuses. Nothing is taken over or moved.

Proposal:
- G5 provides it as an owner-only predicate in S2. R0 already embeds the same idea.
- Each writer adopts it in its **own** TASK: X begin (G3 / G4), the Threads provisioner (G4).
- Until then, the X begin's "reuse any single owned brand" is a known divergence (S1-F1), and must not be enabled for new people without that fix.

### 4.2 G3 (reservations, single posts, deletion of reservations)

| Contract | Required [P] | Evidence / gap |
| --- | --- | --- |
| Every person-facing RPC (create, cancel, receipt, readback) checks a **live non-anonymous session first**, before touching a row, and re-authorizes inside the row statement (G5-11 C1..C5) | X: 43 entry points without the session contract ([R] PR #466); Threads: P7 cancel / receipt skip the session ([R] PR #392) | S2 makes SV installable without the owner-epoch coupling (section 6). The consumers wire it in G3 TASKs. |
| Create / post: R1 (Threads) or the P4 binding (X) with the operation's feature; worker: W1 equality of the bound pair | `007…@G3:L230, L136`; `003_postona_x_resv_g5_binding.sql@G3:L53` | X has no owner-epoch binding today. A G3 TASK should decide whether X reservations bind the pair like Threads. |
| Deleted person | B1-B4 stop the send ([R] PR #471); 8 residues (bodies, audit, old-token readback) open | Retention is **[open]** (G3-27 is writing the decision material). |
| Tests | revoked session readback; an old token after sign-out; a resend after a stop; delete → re-create with the same id; owner A → B → A; anonymous (an authenticated role!) | listed in section 7 |

**Follow-up TASK (G3).** Wire SV (or the S2 personal session gate) into every person-facing X / Threads RPC, readback included; adopt 4.1 in the X
begin; decide the X pair binding. Codex Sol (high) review of the SQL.

### 4.3 G4 (OAuth state, token custody, connection generation)

| Contract | Required [P] |
| --- | --- |
| begin / consume / complete | T13 first (with the S2 anonymous refusal). R0 only for the first connection's begin. Never re-use the begin allow for the code exchange or a post. |
| Generations | The owner epoch (who owns), the lifecycle_version (which service generation) and the connection / token generation (which credential) stay three separate counters. None is replaced by a time or a constant. |
| Custody | After a reconnect, never re-use an old token. F1 is closed in isolation ([R] PR #472). F2 (a direct Vault write) is **open** (G4-32 PR #474, active). H5 transport and claims are open. |
| Tests | user switch while the browser waits; a late callback after sign-out; a token refresh across a stop; a reconnect after delete → re-create; the same `now()` races G4 already pins |

**Follow-up TASK (G4).** Adopt 4.1 in the Threads provisioner (already the rule) and in the X begin (jointly with G3: the X OAuth RPCs are
F3 / G3 + G4). Add the S2 anonymous refusal to its T13 tests. Keep G4-32's F2 design as the input; nothing here pre-empts it.

### 4.4 G6 (authority, AI plan and budget, ledger)

| Contract | Required [P] |
| --- | --- |
| Wire | R1's v1 wire **unchanged**: 8 keys (`g5_rpc_transport.ts@G6:L19`), reasons, `g5oe:` token, `["postona:x_autopost"]`. G6 converts strictly: anything unexpected is unknown. |
| Recheck | the fresh verdict right before each provider attempt with the same credential (`authority_port.ts@G6:L27-L33`) |
| Independent safety | owner-held / RC guards, dedupe, ledger recovery and erase order stay G6's. A personal usage state is **not** an AI plan or budget. |
| Change rule | any change of meaning → a v2 wire with a G6 compatibility suite; no mixing of v1 / v2, no fallback to an older path on a deny |

**Follow-up TASK (G6), only when G6 is assigned again** (G6 is idle; not started automatically): a compatibility test that the S2 projection never
changes R1's v1 answer.

### 4.5 G1 / G2 (the app)

| Contract | Required [P] |
| --- | --- |
| Enrollment | Keep `service-enrollment.ts`'s rules (`@main:L7-L16`): one atomic server call; requests bound to the token's session; cancelled on sign-out / user switch; reactivate only from the person's click with the reported version. |
| Sign-out | The app has both a local and a default sign-out (`auth-provider.tsx@main:L285, L347`; `auth-client-flows.ts@main:L77`). Whether POSTONA's sign-out is local or global is **[open]**: a global one ends Kabumori's sessions of the same person too. |
| Drafts | G1's request (Issue #320 comment 6283895174: a plain-text AsyncStorage draft, removed only on the next visit) is still unanswered. The answer needs the sign-out decision above and is proposed as a G5 + G1 TASK. Not decided here. |
| Late answers | an answer arriving after sign-out / user switch is dropped (G2-39 is testing display isolation) |

## 5. What stays exactly as it is (plan A invariants)

- **Unchanged identifiers:** `auth.users` ids, `brands.id` / `brand_id`, `social_account_id`, FKs, RLS policies, the membership table.
- **No automatic disposal:** `common_accounts`, `service_entitlements`, the owner-epoch triggers and history, the lifecycle triggers, the deletion
  saga. Nothing is dropped, disabled or bypassed first.
- **Wire and generations:** the R1 v1 wire and its `g5oe:` token; W1 / W2 equality of the bound pair; the I1 lock order (login → account →
  service → workspace).
- **No new grants:** no new grant to `anon`, `authenticated`, `service_role` or PUBLIC beyond what each future candidate states and proves.

## 6. Minimal S2 source candidate (design for a later TASK) [P]

**Scope:**
- New G5-owned files only, in a new directory (for example `supabase/candidates/postona_personal_auth/`).
- Existing G5 files change only where a row below says "amend", in the same reviewed TASK.
- Isolated PG17 proof with fake data. Independent Codex Sol (high) review.

| # | Piece | Design | Why |
| --- | --- | --- | --- |
| S2-1 | **Anonymous refusal in T13** (amend `20261010051938…`) | `is_anonymous` read like R1 (per-claim setting, else JSON claims; missing = false). True → `ACCOUNT_LIFECYCLE_AUTH_REQUIRED`, before any lock. | S1-F2; smallest change; every T13 consumer inherits it |
| S2-2 | **Personal session gate** `private.postona_personal_session()` | SV's subject and session stages plus a GoTrue ban check (`auth.users.banned_until > now()` → `ACCOUNT_BANNED`, **if the user approves P7's meaning**). Owner-only; no grant; VOLATILE consumers. It has its **own** install checks: owner, ACL over the role graph, row visibility of `auth.users` / `auth.sessions`, claims shape. It does not depend on the owner-epoch exposure helper, which removes 003's coupling (`003…@G5S:L46-L50`). | G3 / G4 need a session-only gate that installs without PR #457 |
| S2-3 | **Workspace eligibility** `private.postona_personal_workspace_eligibility(uuid)` | `absent` / `own` / a fixed conflict code (the 4.1 rule). Owner-only, STABLE, read-only. R0 is amended to call it; writers adopt it in their TASKs. | S1-F1 |
| S2-4 | **Personal usage projection** `public.postona_personal_usage_state()` | v1 object `{v:1, state: P0..P8, lifecycle_version, reactivatable}` for the signed-in person, from the same facts in one statement. **Advisory only:** never an authorization; R1 / T13 / W1 still decide. `authenticated` EXECUTE only, behind S2-2. | UX simplification without a second source of truth |

**Safety gates of the S2 TASK:**
- **Rollback:** drop only the new functions and revert the amended T13 / R0 bodies to their reviewed text. No row, id, epoch, history, receipt or
  ledger is touched. A consumer is unwired before its provider is removed.
- **Negative tests:** section 7 in full, the old HEAD reproducing each gap first (G3's anonymous case, S1-F1).
- **ACL:**
  - every API role, PUBLIC, indirect and NOINHERIT memberships;
  - table, column and system-column ACLs on what the new functions read;
  - TRIGGER / REFERENCES / MAINTAIN;
  - default privileges;
  - definer owner and `search_path`, RLS / FORCE RLS.
- **Mixed clients:** an old app (start / reactivate, R1 directly) and a new app (S2-4) see the same decisions. A v1 consumer (G6) sees byte-identical
  R1 answers before and after.
- **No entitlement removal and no trigger removal** in S2. Plan B stays on hold.

**Why plan B is on hold:**
- Moving every table to user-id keys touches all of these: X / Threads connections, reservation FKs and receipts, the deletion saga, RLS, and
  G6's `brand_ref` / call keys / ledger.
- That risks re-keyed ids and double-processed ledger rows.
- If ever revisited, it needs its own proof: a 1:1 mapping that keeps `brand_id`, isolation of shared / multi-owner rows, FK / RLS equivalence,
  old-client compatibility, full-row reconciliation and rollback.

## 7. Test plan for S2 and the consumer TASKs [P]

| Area | Cases | Expected |
| --- | --- | --- |
| Session | own; another person; unknown id; forged `sub`; another session; **anonymous (authenticated role)**; expired; revoked; deleted user; banned; broken claims | refused, nothing read or changed, nothing sent, no secret or body in the answer |
| Usage state | P0 → start; P4 never auto-restarted; reactivate with a stale version; P5 no workspace re-creation; P9 Kabumori untouched; X only / Threads only / reconnect | only the eligible person succeeds; everything else fails closed |
| Workspace | the person owns another brand; `u_` shared; foreign kind; no single owner | P8, never taken over |
| Time and generations | logout between snapshot and row statement; logout while waiting for a lock; owner A → B → A; delete → re-create the same id; stop → reactivate; rollback → reinstall | old allows refused; no epoch decrease or reuse |
| G3 | P7 (Threads 5 gaps, X 43 gaps) and the deletion 8 residues kept as known FAILs; each fix reproduces on the old HEAD first | sends B1-B4 still stop; 401 / 404 identical; no resend of an uncertain result |
| G4 | F1 reuse; F2 direct Vault write; mixed claims; H5 direct complete; an old token after reconnect | F2 / H5 remain explicit known gaps until G4's fix |
| G6 | v1 / v2; TTL / scope / epoch / entitlement tampering; G5 timeout; idempotency; lost response; RC / held-owner ABA; forget → reclaim; erase | unknown / invalid → nothing sent, no double charge |
| ACL | as section 6 | nothing reachable beyond the stated grant |
| Rollback / mixing | partial failure, lock timeout, concurrent install; old and new clients; old reservations; late callbacks; token refresh; user switch; restored device drafts | no stale allow, no lost uncertain result |

## 8. Proposed TASK order (each registered by the 担当ちゃ; none starts from this document)

1. **G5 S2** (Opus 5.5 high; independent Sol high): S2-1..S2-4 as new isolated candidates and their PG17 suite. Its inputs:
   - the [open] answers for P3 / P4 / P6 / P7 read-stop;
   - the user's decision on the ban check.
2. **G3** session wiring (4.2) and the X begin rule (4.1, with G4). This follows G3-27's retention decision.
3. **G4** adopts 4.1 and the S2-1 tests. This follows G4-32 (F2).
4. **G1 / G2**:
   - the sign-out scope and the draft answer (4.5), after the user decides local / global;
   - display isolation as G2-39 tests it.
5. **G6**: the v1 compatibility test (4.4), only when G6 is assigned.
6. **Later, separately approved:** the managed read-only audit (G5-18 gates) and any production window. Not before the reviews above.

Each SQL TASK needs an independent Codex Sol (high) review before it counts. PR #457's own independent review is a separate, still-open gate:
nothing in this document makes PR #457 reviewed, passed or obsolete.

## 9. NOT_VERIFIED and limits

- **Managed facts:** the real roles, grants, default privileges, `auth.sessions` / `auth.users` shapes, GoTrue's ban and session behaviour, the
  PostgREST claims delivery, which migrations are applied.
- **Code paths without a writer:** the operator paths for `suspended` and `locked` (no writer in the repository).
- **Not executed here:** every [R] result; nothing was re-run.
- **A window the DB cannot close:** a sign-out between a statement's snapshot and an external HTTP start. The S2 TASK must state the accepted
  window and the handling of sent / uncertain results (as the investigation notes). No lock on `auth.sessions` is proposed.

## 10. What was checked for this document

| Check | Result |
| --- | --- |
| Every `path@pin:Lnn` reference above resolves at its pin and the cited line holds the cited function / text (`git show <pin>:<path>`) | checked by a local script (`git show` only, no network, no DB); results in the REPORT |
| No file other than this one changed | `git diff --name-only origin/main` |
| Secret-shaped strings, project hosts, URLs | none in this document |
| Labels | every row marked [M] / [C] / [R] / [P] / [U] / [open] |
