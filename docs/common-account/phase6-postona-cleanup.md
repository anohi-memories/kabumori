# Common account — Phase 6 (F5): ending POSTONA is one owned operation (X + Threads), and the remote grant is never "revoked" by assumption

Status: **source candidate + executable proofs; nothing applied, nothing deployed, no managed Supabase touched, no real
X/Threads/Meta call.** Production NO_GO (section 10). Stacked on F5 PR #165 (Phase 5), which is stacked on G5 PR #152
(Phase 4) and PR #121 (Phase 3b guard). No G3/F3 (X), G4/F4 (Threads) or H5 file was changed: the Threads side is proven in a
*disposable source overlay* of F4's PR #169 head, the X side is a typed contract.

## 1. The gap this closes

Before this change the deletion of **one** service had no owner. `begin_service_deletion` / `finish_service_deletion`
were callable by any holder of the service role, so a request that lost its place (crash, slow external call) could still end
`x_autopost`; POSTONA's provider cleanup had no lease to be fenced by; nothing durable said which providers were involved and
what each answered; and a "local removed, remote **not** verified revoked" answer vanished with the request. F4's Threads
cleanup (PR #169) therefore had to authorize a service deletion *without* a lease (section 8).

## 2. The end of POSTONA, one flow for both entry points

`POSTONAの利用を終了` (`withdraw_postona`) and the POSTONA step of the whole-account deletion run the same `endPostona`
(`supabase/functions/account-delete/lifecycle_logic.ts`). Order, with the reason for each:

| # | Step | Why here |
| --- | --- | --- |
| 0 | read-only preflight: login recent, account not deleting/locked, X saga preview `social_only` and not `operator_required`, provider snapshot, every connected provider has an adapter, every provider that cannot be revoked remotely is acknowledged | nothing changes when the end cannot complete (`PROVIDER_ADAPTER_MISSING`, `REMOTE_UNVERIFIED_ACK_REQUIRED`, `X_CLEANUP_UNSUPPORTED`, `X_CLEANUP_BLOCKED`) |
| 1 | `begin_service_deletion` (entitlement `deleting`; every guard now refuses the person's new writes) | closes new connections/writes first |
| 2 | `claim_service_deletion` → lease + fence (inside an account deletion it presents that deletion's own live lease) | one chain of ownership; a stale owner can no longer record or end |
| 3 | snapshot of the workspace's platforms; durable `provider_results` = `pending` for `x` and each connected platform | "which providers were involved" survives a crash |
| 4 | `acknowledge_owned_remote_unverified` (when, which providers) | the person's acceptance is on record **before** the removal that cannot be revoked remotely |
| 5 | other providers through their registered adapters (PR #152 port: ownership asked after the read, before and after the destructive call); each answer recorded | the X saga treats every social account of the workspace as X material and would send a Threads account to an operator, so Threads goes first |
| 6 | X through its own saga (`social_only`), typed outcome recorded (`done` is the saga's word) | G3/F3 owns X; not changed |
| 7 | `finish_owned_service_deletion`: owner (lease, wall clock, after the locks) + `x` present + nothing `pending/blocked/reconciliation_required` + every unverified remote grant acknowledged, then the unchanged Phase 1 footprint read-back | the database decides the end, in the transaction of the end |
| 8 | `release_service_deletion_claim` in `finally` (no-op when the end cleared it) | a failed attempt does not sit on the lease |

Any lease loss stops with nothing recorded after the loss and nothing ended. A retry resumes the **same** operation; a
settled fact is never erased by a later "not connected".

## 3. Database surface (`20261013120000_common_account_service_deletion_ownership.sql`, unapplied)

Additive: `service_deletion` operations may carry `owner_lease`/`owner_fence`; `provider_results jsonb`,
`remote_unverified_ack_at`, `remote_unverified_ack_providers` columns. All new `public.*` functions are `SECURITY DEFINER`,
`search_path = ''`, `EXECUTE` for `service_role` only; `private.*` helpers are owner-only.

| Function | Purpose |
| --- | --- |
| `claim_service_deletion(user, 'x_autopost', op, account_op?, account_lease?, seconds?)` → `acquired{lease,fence,provider_results}` / `in_progress` / `not_found` / `not_in_progress` / `lease_lost` / `blocked{reason}` | owner lease; refused while an account deletion is open unless its own live lease is presented |
| `renew_service_deletion_claim`, `release_service_deletion_claim` | extend / give back (`owned` / `lease_lost`; `released` / `not_owned`) |
| `record_owned_service_deletion_provider_result(user, svc, op, lease, provider, result)` | durable answer; `local_removed_remote_unverified` and `confirmed_remote_revoked` are sticky (only upgrade to confirmed) |
| `acknowledge_owned_remote_unverified(..., providers[])` | the person's acceptance, `x` not acknowledgeable |
| `finish_owned_service_deletion` / `abort_owned_service_deletion` | the owned end / abort (gates in step 7) |
| `finish_service_deletion` / `abort_service_deletion` (replaced) | **refuse `x_autopost`** (`OWNED_FINISH_REQUIRED` / `OWNED_ABORT_REQUIRED`); Kabumori behavior unchanged (bodies moved verbatim to private functions, md5-pinned) |
| `common_account_provider_snapshot(user)` | which platforms the person's workspace holds (read only) |
| `private.account_lifecycle_cleanup_authorized(user)` | the one predicate for provider-cleanup SQL: "a deletion of this person is in its cleanup step **and its owner's lease is live (wall clock)**" |

Lock order is unchanged: login `KEY SHARE` → `common_accounts FOR UPDATE` → `service_entitlements FOR UPDATE`
(`private.account_lifecycle_lock`). The new RPCs take exactly that, nothing else; the provider cleanup runs in its own
transaction **outside** the lifecycle locks.

## 4. Remote-unverified policy (enforced, auditable, never silently accepted)

1. **Default: fail closed.** An adapter is "can confirm the remote revoke" only if the registration says `supported`; an
   unlisted provider is `unsupported`. Threads is `unsupported` (no documented app-side revoke; F4's adapter cannot answer
   `confirmed_remote_revoked`).
2. For an unsupported provider the person must send `acknowledged_remote_unverified: ["threads"]` **in the same request**
   (the preview lists `acknowledgement_required`). Without it: `409 REMOTE_UNVERIFIED_ACK_REQUIRED`, nothing changes, not even
   a read of the provider.
3. The acknowledgement is recorded with its time **before** removal. The database refuses to end while a provider's
   `local_removed_remote_unverified` is not acknowledged (`REMOTE_UNVERIFIED_NOT_ACKNOWLEDGED`).
4. An unexpected unverified answer from a provider that was not expected to be unverified stops with
   `PROVIDER_REMOTE_UNVERIFIED` unless the operator-level `acceptRemoteUnverified` is on (default off); then it is recorded as
   acknowledged by that path, never silently.
5. The success body keeps the fact: `providers: { threads: 'local_removed_remote_unverified', x: 'done' }`,
   `remote_unverified: ['threads']`. After a crash between the removal and its record, the retry can only read "not
   connected"; the acknowledged provider is **still** reported in `remote_unverified` (SQL C-crash tests; overlay O5).
   Meta's authorization remains until the person removes it in Threads' own settings — the app copy must say so.
6. Other service entitlements are untouched (Kabumori stays `active`; other people's connections, entitlements and
   credentials are untouched — overlay O3).

## 5. Edge contract

`POST account-delete {action: 'withdraw_postona', confirmation: 'END_POSTONA_SERVICE', acknowledged_remote_unverified?: string[]}`
(recent sign-in required). Success `200 {ok:true, outcome:'ended'|'already_ended'|'not_registered', providers, remote_unverified?}`.
Errors (fixed codes): `REAUTH_REQUIRED`, `ACKNOWLEDGEMENT_INVALID`, `REMOTE_UNVERIFIED_ACK_REQUIRED{providers}`,
`PROVIDER_ADAPTER_MISSING{providers}`, `DELETION_IN_PROGRESS` (lease held by another / lost), `RECONCILIATION_REQUIRED{providers}`,
`PROVIDER_CLEANUP_BLOCKED{providers}`, `PROVIDER_REMOTE_UNVERIFIED`, `X_CLEANUP_UNSUPPORTED|IN_PROGRESS|BLOCKED|FAILED`,
`SERVICE_CLEANUP_INCOMPLETE{reasons,providers}`, `WITHDRAW_BLOCKED`, `DELETION_BLOCKED`. The whole-account `delete` takes the same
`acknowledged_remote_unverified` and returns the same `providers` / `remote_unverified`. `preview` adds `providers[]`
(`adapter: saga|registered|missing`, `remote_revoke`), `acknowledgement_required[]`, `postona_end_available`.

X (G3/F3-owned): the saga is called with the person's own token in scope `social_only` and answers a typed outcome; `scope_refused`,
`in_progress`, `blocked`, `failed` are never success, and `blocked/operator_required` stops **before** any provider is touched.
The actionable handoff to G3/F3 is section 9.3.

## 6. Registration of F4's Threads adapter (candidate, not in the build)

`supabase/functions/account-delete/provider_registry.ts` registers **nothing** today: a person with a connected Threads account is
refused before anything changes (`PROVIDER_ADAPTER_MISSING`). The reviewed replacement is
`supabase/candidates/common_account_provider_registration/provider_registry.threads.candidate.ts` (imports F4's
`createThreadsCleanupRpcStore` / `createThreadsProviderCleanupAdapter` unmodified; `remoteRevoke.threads = 'unsupported'`) and
the grant candidate `threads_cleanup_execute_grant_candidate.sql`: `EXECUTE` on exactly
`public.threads_provider_connection_state(uuid)` and `public.cleanup_threads_provider_footprint(uuid)` to `service_role` only,
refused if a function is missing, owned by someone else or already reachable; `threads_cleanup_authorized(uuid)` stays owner-only.
Before the grant the adapter's calls are refused by the database and it answers "unreadable" → `RECONCILIATION_REQUIRED`
(fail closed; overlay O1). **Apply order**: F4's cleanup candidate (corrected, 9.1) → Phase 6 migration → grant candidate +
registry replacement, each as its own reviewed step. Nothing here is applied.

## 7. Source overlay with F4 PR #169 (`supabase/tests/common_account_phase6_overlay_run.sh`)

Builds a throw-away tree from `git archive` of F4's PR #169 head `fd15430d…` (nothing checked out/merged/pushed), overlays this
branch's G5 files, PR #124's two read-only files and the registration candidate, and on a local PG17 builds the real world
(Phase 1/2/3a/3b/4/5/6, X, Phase 2a-2, PR #124, the G4 publish stack, F4's cleanup, disconnect and writer guards). It proves:

* **a. F4's own T13 behavior suite passes with Phase 6 present.**
* **b. ownership / ACL / ordering evidence** (`…_overlay_probe.sql`, exact): section 8.
* **c. grant candidate**: before → `service_role` has no `EXECUTE`; after → exactly the two functions; re-apply and a missing
  function are refused.
* **d. G5's real orchestrator + F4's real adapter/store + F4's real SQL + Phase 6 SQL** (nine tests): grant missing → fail closed,
  nothing removed, no X saga (O1); no acknowledgement → nothing changes (O2); POSTONA alone with acknowledgement → Threads and X
  accounted, Kabumori + bystander untouched, order ack → providers → X → end (O3); lease lost between read and removal → nothing
  sent, retry ends (O4); crash after the removal committed → lease blocks others, takeover completes, `remote_unverified` kept
  (O5); in-flight publish → `RECONCILIATION_REQUIRED`, person's disconnect refused, attempt record kept, settled → retry ends (O6);
  X `blocked` / `in_progress` after Threads → never ended, unverified fact kept, X done later ends (O7); whole account with
  acknowledgement (O8).
* **e. lock order, dynamically**: an admin's F4 writer waits at the owner's lifecycle rows holding no workspace row lock behind
  Phase 6's lease RPC, then is refused; mutation (F4 takes `brands FOR SHARE` first) is killed.
* **f. handoff negative reproduction** (section 8.3).

Mutations: `…_overlay_mutations.py` — 6 G5 + 1 F4-overlay mutants, all killed.

## 8. F4 PR #169: verification (yes / no)

### 8.1 Writer guard ordering and ownership/ACL — **YES**

Evidence (probe, on the overlay world; exact):

* **Ownership.** 36 functions (every F4 writer, internal decision and cleanup function, PR #124's owner-channel functions, the
  G5/F5 guards and Phase 6 functions): owner = the owner of `public.social_accounts`, **not** a superuser; `SECURITY DEFINER`
  with `search_path = ''`; no API role is a member of the owner.
* **ACL.** The person's calls (`set_threads_manual_publish_permission`, `begin_…`, `release_…`, `record_…`,
  `disconnect_threads_account`, `get_…`) → `authenticated` only. `threads_manual_publish_authorize/_fence/_owner_fence`,
  `threads_manual_publish_attestation_valid`, `threads_account_credential_expires_at`, `threads_cleanup_authorized`, PR #124's
  begin/consume/complete, `threads_provider_connection_state`, `cleanup_threads_provider_footprint` → owner only (the cleanup
  pair gets `service_role` only through the grant candidate). G5/F5 `private.*` guards → owner only. PUBLIC reaches none.
* **Ordering** (installed source positions; the caller's T13, then the owner's F5, before the first workspace/account row
  lock): `begin` caller@710 → owner decision@858 → no own row lock; `set_permission(ON)` caller@463 → owner@1058 → lock@1221;
  `authorize` owner@491 → lock@617; `release` caller@1974 → (`auth.sessions FOR SHARE`) → owner@2393 → workspace lock@2954.
  Disconnect decides with G5 first; the cleanup takes no lifecycle lock (workspace lock only).
* **Dynamic**: the lock-order race above (Phase 6's lease RPC holds the owner's lifecycle rows; the admin's writer waits there,
  holds no workspace row lock, then is refused; no deadlock).

Not a defect, recorded: two admins who are each other's workspace members can take the two people's lifecycle locks in opposite
order; the resulting deadlock/timeout is mapped by F4 to `BUSY` (retryable), never a hang. `release` takes the live session row
`FOR SHARE` before the owner's decision (documented by F4: "lifecycle, then the session, then the workspace").

### 8.2 Predicate scopes: PR #165, T13, worker, cleanup (computed per state; asserted)

| state | T13 (caller write) | F5 owner write | worker read | G5 cleanup predicate | F4 cleanup as shipped |
| --- | --- | --- | --- | --- | --- |
| active | OK | OK | `active` | no | no |
| suspended / ended | `SERVICE_NOT_ACTIVE` | same | same | no | no |
| locked | `ACCOUNT_LOCKED` | same | same | no | no |
| service deleting, no lease | `SERVICE_DELETION_IN_PROGRESS` | same | same | **no** | **yes** |
| service deleting, live lease | same | same | same | yes | yes |
| service deleting, **ended** lease | same | same | same | **no** | **yes** |
| account deleting, no lease | `ACCOUNT_DELETION_IN_PROGRESS` | same | same | no | no |
| account deleting, live lease | same | same | same | yes | yes |

T13 (caller), the F5 writer decision and the worker read **agree** in every state (the same `account_lifecycle_service_state_*`
semantics; they differ only in who is asked: the caller with a live session, the workspace owner, a service-role reader).
"May write" and "may remove" never hold together. The only disagreement is F4's own cleanup authorization (last column).

### 8.3 F4-owned correction (required before the registration; F4 file `supabase/candidates/postona_threads_cleanup/threads_provider_cleanup_candidate.sql`)

As shipped, `threads_cleanup_authorized` authorizes `service_deletion` of `x_autopost` **without** a lease: any service-role
caller can remove a person's Threads footprint under a service deletion that was begun but never claimed, or whose owner's lease
ended (negative reproduction in the runner: the footprint was removed under an ended lease). G5's orchestrator asks
`stillOwned()` immediately before the call, so G5's own path is safe; the gap is for every other holder of the credential and for
the interval after the check ("a lease check is not a lock"). Exact change (one function; keeps `current_step = 'cleanup'` for
account deletions and now needs a live lease for both kinds):

```sql
create function public.threads_cleanup_authorized(p_user_id uuid) returns boolean
language sql volatile security definer set search_path = '' as $$
  select private.account_lifecycle_cleanup_authorized(p_user_id)
$$;
```

and add `to_regprocedure('private.account_lifecycle_cleanup_authorized(uuid)')` to the candidate's preconditions (or inline the
same two conditions: `o.owner_lease is not null and o.owner_lease_expires_at > clock_timestamp()` on the `service_deletion`
branch, with no Phase 6 dependency). The runner proves the corrected function removes nothing under an ended lease. F4's
own test must change with it: its `POSTONA deletion cleanup` case (`c2`, `service_deletion` with **no** lease, expects
removal) asserts the shipped behavior and fails under the correction; with one added statement before that call — a live
`owner_lease` / `owner_lease_expires_at`, exactly what `claim_service_deletion` writes — the whole T13 suite passes (both
shown by the runner). F4's disconnect (refused while a deletion is open) needs no change.

## 9. Handoffs

1. **F4 (Threads)**: 8.3 correction; nothing else in the writer guards. After applying F4's candidates the grant candidate and
   registry replacement of section 6 are G5/F5's reviewed step. If F4 later finds an official Threads revoke endpoint, F4
   ships an adapter that can answer `confirmed_remote_revoked` and G5 flips `remoteRevoke.threads` to `supported` (the
   acknowledgement then stops being required).
2. **H5 (runtime)**: the Edge function reads the service credential for the registration; H5 owns that deploy path. No
   secret is read or printed anywhere in this change.
3. **G3/F3 (X)**: (a) the saga must refuse to run when a non-X social account is present *or* tolerate it (today it sends the
   account to an operator, which is why providers run first — please keep this contract or tell us); (b) provide a typed
   `blocked` reason for "an X post is in flight" so the app can say why (today only `blocked`/`in_progress`); (c) the saga must
   set the publish authority to `revoked` before deleting rows (PR #165 section 4 item 4); (d) the saga's `social_only` scope
   must stay refused for a workspace with another member.
4. **App owners (G1/G2 Kabumori, POSTONA)**: send `acknowledged_remote_unverified` only after showing copy that says Threads' own
   authorization remains; show `remote_unverified` after success; handle the new error codes in section 5.
5. **Coordinator**: reviews L5 before J1's independent review. Production stays NO_GO.

## 10. Production NO_GO — reasons

1. Phase 4/5/6 and the F4/H5 candidates are unapplied, unmerged drafts; the merge/apply order and a fresh-main check are open.
2. F4's cleanup candidate must carry 8.3 before Threads is registered; until then the registry registers nothing (fail closed).
3. Managed Supabase behavior unproven (PostgREST SQLSTATE mapping, Vault, `auth.sessions` privileges, Storage policy);
   no real X/Threads/Meta call was made; Threads' remote authorization cannot be revoked by this system.
4. The Auth identity-link race keeps `managed_auth_delete` blocked; `IDP_PREPAUSE_BLOCKED` stays.
5. The X saga stand-in in the overlay is not G3/F3's real saga; its typed outcomes are a contract, not proven against the
   managed service.

## 11. Run the proofs (disposable local PostgreSQL only)

```bash
export CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser>
bash supabase/tests/common_account_core_fence_run.sh                  # Phase 1..6 incl. e2e / app sections
bash supabase/tests/common_account_service_deletion_run.sh            # Phase 6 SQL: preflight, exact change, behavior, races, rollback
python3 supabase/tests/common_account_service_deletion_mutations.py   # 17 SQL mutants
bash supabase/tests/common_account_phase6_overlay_run.sh              # F4 PR #169 overlay (needs the git objects of the two SHAs)
python3 supabase/tests/common_account_phase6_overlay_mutations.py     # 6 G5 + 1 F4-overlay mutants
python3 supabase/tests/common_account_phase4_ts_mutations.py          # 19 port mutants
python3 supabase/tests/common_account_phase6_ts_mutations.py          # 15 orchestrator mutants
deno test --no-config --no-check --allow-run --allow-env --allow-read supabase/functions/account-delete/
```
