# G5-06: the first POSTONA X / Threads connection without a workspace — the brand-less bootstrap (source-only contract)

Status: **contract + pure reference + offline proofs. No SQL, RPC, grant or migration was created or applied; nothing is wired; no file of G1, G3, G4
or G6 was edited.** Production is **NO_GO**.

- TASK `common-account-g5-brandless-oauth-onboarding-authorization-offline-contract-20261020` (Issue #320, G5-01 generation, task 6, completion K5).
- Stacked on PR #371 (`7140e416e32bafc7ce6c0463c3821e7eac96d1f6`, H1 C1 `PASS_FOCUSED_SOURCE_REREVIEW`). R1, W1, W2 and their tests are unchanged.
- Trigger: G4's question (Issue #320 comment 6279536652) — R1 needs `p_brand_id`, but the first connection creates the workspace inside its begin
  RPC, so G4 refuses the first connection today (fail closed).
- New G5-owned paths only: this document, `supabase/candidates/common_account_postona_authz/bootstrap.ts` (reference), the tests
  `supabase/tests/common_account_g5_06_bootstrap_{test.ts,mutations.py}` and `supabase/preflight/managed_disposable/g5_06_bootstrap_doc_test.ts`.

Evidence labels: **[M]** `origin/main` `0c42933c`, **[C]** candidate in a Draft PR, **[D]** derived by a test of this task, **[A]** assumption, **[U]** NOT_VERIFIED.

## 1. Verdict

| Question | Answer |
| --- | --- |
| Can R1 serve the first connection? | **No, by design.** R1 answers for a named workspace and needs its owner epoch; before the first begin there is no workspace. Loosening R1 (a brand id that does not exist yet) would let R1 vouch for an object nobody owns. |
| The chosen design | A **separate brand-less bootstrap verdict** (feature `x_connect_bootstrap` / `threads_connect_bootstrap`): R1's person checks (verified JWT, live session, common account, `x_autopost` entitlement) plus ONE fact about the person's own, server-derived workspace — absent, or already exactly theirs. It gates only the begin. The code exchange stays behind the **brand R1 at the callback** and a **recheck right before the exchange** (G5-01 §5). |
| Is a bootstrap allow reusable elsewhere? | **No** [D]: other features (R1's, worker bindings, AI plans) refuse it — different feature, no brand, no owner epoch; R1 (unchanged) does not answer the bootstrap features at all. |
| What makes the begin safe | The begin transaction (G4 / F3 SQL) must run G5's write guard first, create the person's own workspace idempotently, then check that its owners are exactly {caller} — and roll back otherwise. Main's begin does not do the last two (section 2) — a hand-off. |
| Applied anywhere? | No. The bootstrap RPC is design only (section 6, Codex Sol (high) gate). |

## 2. Source inventory of the first connection (main `0c42933c`)

| Step | Today [M] | Candidate [C] | Missing | Owner |
| --- | --- | --- | --- | --- |
| verified principal | `x-oauth-connect-user` resolves the caller with `GET /auth/v1/user`; production `verify_jwt=false` for this function (2026-10-17 snapshot) | G4 PR #353 / #355: phase `begin` asks a G5 port with brand null; port unconnected -> 503 | a G5 answer for "no workspace yet" | G4 (Edge), G5 (answer) |
| session / account / entitlement | not checked by begin, consume or complete | G5 P3b guard `private.account_lifecycle_assert_active_service_write` (person + live session + account + entitlement under locks) | the begin and complete RPCs calling it | G5 (guard), G4 / F3 (callers) |
| workspace before begin | none for a first-time person | — | — | — |
| workspace creation | `begin_social_mobile_x_oauth_connection` (`20260922003101:27-46`): counts the caller's owned brands; with none, derives `u_` + md5(user)[:24] (`:39`), `insert brands ... on conflict do nothing` (`:42`), `insert brand_memberships (…,'owner') ... on conflict do nothing` (`:45`) — **no check afterwards** that the caller is the single owner: if the derived id already exists with another owner the caller becomes a SECOND owner; if the caller is already a non-owner member there, nothing is inserted and begin continues | — | the post-creation owner check + rollback | G4 / F3 |
| serialization with POSTONA deletion | `social_mobile_account_deletion_guard` (`20260928160000:119-150`) takes the per-workspace advisory lock on every workspace / membership INSERT and refuses while a POSTONA deletion tombstone exists | — | — | G3 / F3 |
| serialization with the common-account deletion (退会) / service end | none in begin | P3b guard (locks the login, the account, the entitlement) | the call | G5 / G4 |
| state | single-use row with `initiated_by_user_id` (`:70`); consume checks the initiator (`20260919120000:182`) | — | the owner epoch / lifecycle_version seen at begin (G4 noted: no column) | G4 / F3 |
| callback, before the code exchange | exchange BEFORE the ownership recheck (main `oauth_logic.ts:271` vs `:279`) | G4 PR #353: recheck before the exchange | the brand R1 at the callback + `guardIrreversible` | G4 |
| complete | owner re-joined `FOR UPDATE` (`20260919120000:245-246`) | — | P3b guard in the same transaction | G4 / F3 |

## 3. Options weighed (threat model)

| Option | What it trusts | Rejected because / chosen because |
| --- | --- | --- |
| A. **Brand-less bootstrap verdict + brand R1 at the callback** (chosen) | the JWT subject; G5's facts; the server-derived workspace id | nothing the client names is trusted; the irreversible step still needs a brand R1 and a recheck; the bootstrap opens no other feature |
| B. R1 accepts the derived id before the workspace exists | a not-yet-existing object | R1 would answer for a workspace no one owns (no owner, no epoch) — breaks R1's contract and its consumers' assumptions |
| C. Create the workspace at sign-up / enrollment | that every POSTONA person wants a workspace | changes F5 enrollment and every app path; a workspace per enrollment without a connection; larger blast radius |
| D. No G5 check at begin, only at the callback | nothing at begin | a person under 退会 or without the service could still create a workspace and a state (main's begin today) |

Threats and where each is stopped [D unless noted]: self-declared user id or brand (not parameters; a brand id in a bootstrap request is
`BRAND_NOT_EXPECTED`); 退会 / service end / freeze / signed out (bootstrap; again by P3b inside begin; again by the callback's R1 and the recheck);
another person's same-named workspace or the caller as a mere member there (bootstrap `OWN_WORKSPACE_CONFLICT`; begin's own check rolls back);
two owners (`WORKSPACE_OWNER_UNKNOWN`); two devices racing (one workspace, one owner: idempotent creation); a callback by someone else (consume's
initiator check); an expired or replayed state (single-use, 10 minutes [M]); A -> B -> A or an entitlement end / restart during the round trip (the
recheck's generation); G5 unreachable (no exchange); a bootstrap allow replayed for posting, workers or AI (refused).

## 4. The contract

**R0 — the bootstrap verdict** (design; the reference is `bootstrapVerdict` in `bootstrap.ts`):

- Question: `{app: 'postona', feature: 'x_connect_bootstrap' | 'threads_connect_bootstrap'}` — no brand (a brand id is refused), no person (the
  subject is the JWT's, exactly as R1 / G5-02 §3.3).
- Answer: the G5-01 8-key wire; `scope.brand_slug` null, `owner_epoch` null, `entitlements` the scope app's active ones; allow lives 60 s, a refusal is
  born expired. Codes: `FEATURE_NOT_ENABLED` (not a bootstrap feature), R1's person codes, plus `BRAND_NOT_EXPECTED`, `OWN_WORKSPACE_CONFLICT`,
  `OWN_WORKSPACE_UNREADABLE`, `WORKSPACE_OWNER_UNKNOWN`.
- Facts (one statement): R1's person facts, and the person's own workspace looked up by the id the server derives from the subject
  (`public.social_mobile_account_deletion_workspace(user)` [M `20260928160000:98-100`]): absent -> allow; exactly theirs (user workspace, single
  owner = caller, caller's role owner) -> allow; anything else -> refuse.
- What an allow authorises: running the begin RPC once, now. It authorises no exchange, no post, no worker binding, no AI call; it is not stored as
  authority (the begin transaction re-checks with P3b under locks).

**The begin transaction** (G4 / F3 SQL; the reference is `beginCreateWorkspace`):

1. First: G5's write guard `private.account_lifecycle_assert_active_service_write(auth.uid(), 'x_autopost')` (F5 P3b) — the person, a live session,
   account and entitlement active, under the I1 lock order; READ COMMITTED.
2. Derive the workspace id from `auth.uid()` on the server; never from the request.
3. Create it idempotently (`on conflict do nothing` for the brand and the caller's owner row is fine).
4. Then check: the workspace is a user workspace and its owners are exactly {caller} with the caller's role `owner`; otherwise raise (the whole
   transaction rolls back — nothing is joined, no state is created).
5. Create the single-use state (initiator, 10 minutes). Recommended (schema change, G4 / F3 TASK): store the owner epoch and lifecycle_version the
   callback's first R1 must equal, so a change during the round trip is visible even before the recheck.

**The callback** (G4): consume (single-use, initiator = caller, not expired) -> brand R1 (`x_connect` / `threads_connect`, the state's workspace) as
the first verdict -> `guardIrreversible` (fresh R1 with the same generation right before the exchange) -> exchange once -> complete RPC (P3b guard +
owner `FOR UPDATE` + single-use claim in one transaction). A refusal at any step exchanges nothing.

**Failure, rollback, cleanup.** A refused begin leaves nothing (one transaction). A refused callback leaves an unused or consumed state that expires;
the created workspace stays, owned by the caller and empty, and is removed by the existing deletion paths. If the exchange happened and complete
refuses, the tokens are dropped in memory and the grant at the provider stays (revocation at the provider is G4's; Threads has no app-side revoke).

## 5. R1 versus W1 / W2: what each consumer must recheck (the coverage asymmetry of PR #371)

- **W1 / W2** check, on every call, that the service generation is moved by exactly F5 P1's triggers (`private.account_lifecycle_generation_covered()`).
  **R1 does not**: its owner epoch consults the owner-epoch coverage (PR #303), but its `lifecycle_version` half is taken as is. So R1 must not be
  described as guaranteeing the worker's generation fence.
- **OAuth consumers (G4)** rely on: R1 at the callback + the recheck (same generation) + P3b inside complete (locks, no counter needed). P3b does not
  depend on `lifecycle_version`, so the asymmetry does not weaken the connect path.
- **Workers (G3 / G4)** rely on W1 / W2 (equal pair + coverage). A reservation bound from an R1 token while the P1 triggers had drifted would only be
  dispatched once the triggers are exact again AND the pair still matches.
- **History gap (L-6 class).** A table owner or superuser who disables or replaces a P1 trigger and later restores it leaves a window whose changes
  never moved the counter; the coverage check cannot see the past. Operator rule: after any such maintenance, treat every binding made before it as
  stale (the reservations' owners re-confirm), as PR #303 L-6 asks for the owner epoch.

## 6. Next TASK candidates (not implemented here)

| Candidate | Owner | Paths | Gate |
| --- | --- | --- | --- |
| R0 SQL: `public.common_account_bootstrap_verdict(p_app text, p_feature text) -> jsonb`, EXECUTE `authenticated` only, STABLE definer, one statement, the facts of §4 | G5 | `supabase/candidates/common_account_authorization_verdict/` (a second file) + PG17 suite | **Codex Sol (high)** before any apply |
| begin: P3b guard first + post-creation owner check + rollback; complete: P3b guard; optional state columns (owner epoch, lifecycle_version at begin) | G4 / F3 (begin / complete SQL), G5 (guard is already a candidate) | the X onboarding migration successor; the Threads begin | Codex Sol (high); a migration |
| G4 port mapping: phase `begin` -> R0; phase `pre_exchange` -> brand R1 via `guardIrreversible` | G4 | `supabase/functions/x-oauth-connect-user/`, Threads entry | G4's review |
| The manual-post draft on the device (G1 request, Issue #320 comment 6283895174) | G5 (shared Auth provider) + G1 | `apps/social-mobile/src/providers/auth-provider.tsx` (signOut hook), draft storage | see §8 |

## 7. Interface notice to G4 (sent once; earlier notices not repeated)

The bootstrap features, the begin transaction's five steps, the callback order and the codes of §4, and that R0 is design only (the next G5 TASK). G4's
`XConnectAuthorizationPort` phase `begin` maps to R0; phase `pre_exchange` to the brand R1. Until R0 exists G4's fail-closed behaviour stays correct.

## 8. G1's draft-storage request (recorded, not changed)

G1 (Issue #320 comment 6283895174) stores the manual X post draft for up to 24 hours in plain AsyncStorage under
`postona.manual-publish.draft.v1:<userId>`; a sign-out cannot remove it at once (the sign-out lives in the shared Auth provider). Assessment:
**privacy-relevant, low to medium** — the body text of an unsent post stays on the device in plain text until the next visit or 24 hours, readable by
anyone with access to the unlocked device or a backup; no token or consent is stored; a different user or session does not restore it (G1's offline
checks). Recommendation for a separate G5 Auth / Storage TASK: option A (a narrow post-sign-out hook in the shared provider that removes exactly
that key prefix for the signed-out user, best effort, never blocking sign-out) first; option B (SecureStore) only if drafts must survive sign-out,
which the current product does not need. Until then "24 hours, plain text, session mark" is an accepted interim only if the G5 担当ちゃ says so.

## 9. Tests (offline; exact results in section 11)

- **Bootstrap suite** `common_account_g5_06_bootstrap_test.ts` (no network permission): the allow's wire; R1's person checks; the own-workspace rule
  (another owner, the caller as admin, two owners, another kind, a self-contradicting reader); no brand / no person in the request; non-reuse (R1's
  features, worker binding, R1 itself, AI plans); the whole flow with counting mocks — first connection, reconnect, two devices racing, refusals
  before creation (退会, service end, signed out, a pre-claimed workspace rolled back, 退会 between the bootstrap and the begin transaction) and refusals
  of the exchange after begin (another person's callback, an expired state, G5 down, 退会 / service end / sign-out / A -> B -> A / lifecycle change
  between the callback's verdict and the exchange, a second owner before the callback).
- **Mutation check** `common_account_g5_06_bootstrap_mutations.py` over `bootstrap.ts`.
- **Document test** `supabase/preflight/managed_disposable/g5_06_bootstrap_doc_test.ts`.

## 10. Re-run

```bash
deno test --no-config --no-check supabase/tests/common_account_g5_06_bootstrap_test.ts
python3 supabase/tests/common_account_g5_06_bootstrap_mutations.py <repository root>
deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/g5_06_bootstrap_doc_test.ts
```

## 11. What was executed for this document

All commands ran in `/Users/yuya/Developer/kabumori-g5-06` (a clean worktree stacked on PR #371). The bootstrap work is pure (no database, no
network); the regressions of the stack ran on a throw-away local PostgreSQL 17.11 (`/private/tmp` socket, fake data, deleted at the end). Every cited
main `path:line` was re-checked against `origin/main` `0c42933c`.

| # | Check | Command | Result |
| --- | --- | --- | --- |
| 1 | the bootstrap suite (no network permission) | `deno test --no-config --no-check supabase/tests/common_account_g5_06_bootstrap_test.ts` | **9 tests** passed, 0 failed |
| 2 | mutation check of `bootstrap.ts` | `python3 supabase/tests/common_account_g5_06_bootstrap_mutations.py <repository root>` | control PASS, **16/16 detected**, 0 invalid (two survivors of the first run handled: a self-contradicting reader case added; the "any feature" mutant is equivalent -- decide() refuses an unmapped feature with the same code -- and is recorded in the script, not run) |
| 3 | regression, pure | G5-01 (13) + G5-02 model (11) + this suite (9) in one run | 33 passed |
| 4 | regression, PG17 | `common_account_authorization_verdict_pg_run.sh` (15), `common_account_g5_01_authz_pg_run.sh` (10), `common_account_g5_02_rpc_preconditions_pg_run.sh` (5), `common_account_owner_epoch_run.sh` (19) | all passed |
| 5 | the whole harness incl. this document's test | `deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/` | **205 passed**, 0 failed (200 of PR #371 + 5 new) |
| 6 | type-check, lint | `deno check --no-config` (the models, this suite, the harness); `deno lint --no-config` | no error; `Checked 52 files` |

Not run, on purpose: any SQL / RPC for R0, any change to the begin / complete SQL or G4's Edge, any managed access, any real OAuth.
