# POSTONA Threads — connect → manual publish → result, one local path (G4-02 #11, 2026-11-06)

task_id: `postona-g4-gen2-11-threads-connect-manual-publish-gated-local-e2e-integration-20261106` (Issue #561). Stacked on PR #648.

**Status:**
- Local only. No real Threads, Meta, OAuth, Vault, managed Supabase, deploy or paid API.
- Every gate stays as in source (`THREADS_MANUAL_PUBLISH_PREREQUISITES_MET = false`, `THREADS_MANUAL_PUBLISH_UI_ENABLED = false`, the connect entry's static gate, the disconnect gate). Tests open them in the test world only.
- Production stays NO_GO.

## 1. What existed: no rebuild

| Piece | Where (all in this stack) | Used as is |
| --- | --- | --- |
| Connect: app hooks → Edge entry → G4 composition → H5 runtime → G4 bridge → SQL | PR #251 / #263 lineage → #568 … #613 | yes, unchanged |
| Manual publish Edge (`social-mobile-threads-publish`: logic, attested store, getUser) | PR #140 lineage | yes, unchanged |
| Publish + release SQL (begin, release, record, permission, state; nonce, attestation, one open attempt) | `postona_threads_publish/` | yes, unchanged |
| Disconnect SQL + Edge; G4 credential verdict (what G3 dispatch binds to) | `postona_threads_disconnect/`, `postona_g4_credential_verdict/001` | yes, unchanged |
| App publish hook `use-threads-manual-publish.ts` | app | yes, unchanged (no G1 screen change) |
| The PG17 world and the connect e2e (19 scenarios, two G5 profiles) | `postona_g4_threads_person_session_run.sh` `G4T_APP_FLOW=1` | extended |

PR #251's and #263's heads are ancestors of this branch (`git merge-base --is-ancestor`). Nothing of them is rewritten.

**What was missing:** connect and manual publish had never run as one path. The connect e2e already installed the publish SQL, but no scenario posted. Each publish proof used its own fixture accounts.

## 2. The delta

### 2.1 One path, measured: e2e scenarios 20–30

The scenarios are in `apps/social-mobile/tests/threads-connect-product-flow.e2e.mjs`.

**What runs, in order:**
1. A person connects through the real flow.
2. The app's real publish hook calls the publish Edge, served over 127.0.0.1 HTTP.
3. The Edge calls the attested RPCs on the PG17 world.
4. The release hands out the token the connect stored.
5. A fake Threads publish API (containers, publish, read-back, listing) counts every write.

**What is fake:** Threads, PostgREST (a psql bridge) and GoTrue. The Edge's fetch refuses and records every other host: `denied` = 0 in all scenarios.

| # | Scenario | Measured (both G5 profiles) |
| --- | --- | --- |
| 20 | Connect → consent → post | `consent_required` → `ready` → `published`, with the permalink read back. 1 container + 1 publish, made with the connect's token, as F's Threads user |
| 21 | Two taps + replay of the same request | The 2nd tap sends nothing. The replay answers `replayed` with the same attempt. Still 1 post |
| 22 | Container not ready | `container_created`, the card shows `busy`. A 2nd post gets 409 `PUBLISH_IN_PROGRESS`. Resume publishes once |
| 23 | Threads refuses the container (definite) | `failed` with a fixed code, 0 publish, the card is `ready` again |
| 24 | Publish answer lost (Threads did post) | `uncertain` is kept. Resume does not resend. Reconcile is read-only and gives `published` with the permalink. Still 1 publish |
| 25 | Another person / no token / expired JWT / anon key | 404 `ACCOUNT_NOT_FOUND` (publish and state); 401 ×3; 0 provider calls. The other person's card shows `unavailable` |
| 26 | Account stopped (N1 SYNTHETIC) | 409 `CONNECTION_NOT_VERIFIED`, 0 calls. The verdict says `NOT_VERIFIED`. The app maps the stop to `needs_attention` → `reconnect`. **N8:** a real reconnect resets the row to `identity_verified`, clears the error code, and posting works again |
| 27 | Credential expiring in 1 min / service ended (SYNTHETIC) | 409 `CREDENTIALS_EXPIRED`; 403 `SERVICE_NOT_ACTIVE`; 0 calls |
| 28 | Disconnect while the outcome is unknown | `stopped` / `PUBLISH_IN_FLIGHT`: the row and the evidence are kept, and a new post is refused. After reconcile the disconnect goes through. Reconnect brings back the same deterministic id (`sa_` + md5(workspace:threads)) as a new row: 0 old attempts, consent asked again, then posts |
| 29 | Entry as in source (gate closed) | 503 `THREADS_PUBLISH_DISABLED` for publish / account_state / set_permission over HTTP, 0 calls. The app as built shows `release_disabled` and sends 0 requests |
| 30 | **Manual publish vs the G4 credential verdict** | See 2.2 |

**Totals per profile:** 8 containers, 7 publishes, 21 reads, 7 posts, 0 denied.

### 2.2 The defect found and fixed (fail-before → pass-after)

Before this task, the same account could be refused for a scheduled post (G3, through the verdict) and accepted for a manual one:

| SYNTHETIC state (account still `identity_verified`) | Verdict (G3 dispatch) | Manual publish **before** | Manual publish **after** |
| --- | --- | --- | --- |
| a. `last_connection_error_code` set (a refresh failure, or what N1 may record) | `CONNECTION_ERROR` | **posted** | `CONNECTION_NOT_VERIFIED` |
| b. No G4 binding (a row verified by a path that skipped G4's reviewed connect bridge) | `NOT_BOUND` | **posted** | `CONNECTION_NOT_VERIFIED` |
| c. Custody names another credential | `CREDENTIAL_MISSING` | refused only by accident (`CREDENTIALS_EXPIRED`) | `CREDENTIALS_MISSING` |
| d. Reconcile of an unknown post while (a) holds | — | `published` | `published` (read-backs are not gated) |

**Fix:** `supabase/candidates/postona_g4_threads_manual_publish_verdict/001_manual_publish_requires_credential_verdict.sql` (G4-owned, plus a rollback).
- **What it changes:** the body of `public.threads_manual_publish_authorize(uuid,text,boolean)` only. It is the release candidate's body (md5 `8e97121f…`) plus one call to `postona_g4_credential.threads_publish_credential_verdict`.
  - The call is made for **write steps** only (begin, create_container, check_container, publish).
  - It runs after the credential-presence check and before the expiry check.
- **What it does not change:** owner, SECURITY DEFINER, empty `search_path` and ACL (owner only, checked). No table, column, trigger, RLS, grant or Vault object.

**The runner proves it** (`G4T_APP_FLOW=1`, stage "G4-02 #11"):
- **(a) Fail-before:** the e2e on the stack without 001 fails scenario 30 only. With 001, both profiles pass 30/30.
- **(b) Install checks:** install works; a second run refuses `ALREADY_APPLIED`; the ACL is unchanged; the rollback restores md5 `8e97121f`; install works again.
- **(b) Refusals:** rollback before install; no verdict; authorize body not the pinned one; run as a superuser.
- **(c) Mutant:** "the verdict also gates read-backs" is caught by scenario 30 (the unknown post would be stranded).

### 2.3 PR #648's N1 corrected

N1's example stop status `reauth_required` is refused by the table's CHECK. The allowed statuses are unconnected, authorization_pending, connected, identity_verified and failed (measured in scenario 26). So the stop N1 can write without a schema change is `failed` + `last_connection_error_code = 'THREADS_DEAUTHORIZED'`. Every reader refuses it:
- manual publish: `CONNECTION_NOT_VERIFIED`;
- the verdict: `NOT_VERIFIED`;
- the app: `reconnect`.

A real reconnect clears it (N8 holds). The PR #648 doc is corrected in place.

### 2.4 The deployable entry as a process

`supabase/tests/postona_g4_threads_publish_process_gate_run.sh` starts the unchanged `social-mobile-threads-publish/index.ts`:
- `DENO_SERVE_ADDRESS` = 127.0.0.1:18472, the only network permission;
- **no `--allow-env`**.

**Result: 7/7.**
- publish / account_state / set_permission / reconcile / no-token: 503 `THREADS_PUBLISH_DISABLED`;
- OPTIONS 204;
- nothing printed except Deno's "Listening on" line.

**Negative control** (gate forced on, restored at once): 6 FAIL. The entry reaches the environment, Deno refuses it, and the process answers 500 and prints 30 lines. Clean rerun: 7/7.

## 3. Measured

| Suite | Result |
| --- | --- |
| App product-flow e2e, profile full | **30/30** (19 earlier + 11 new) |
| App product-flow e2e, profile personal | **30/30** |
| Fail-before (personal, without 001) | scenario 30 only fails (measured row 2.2 "before") |
| Install / refusal / rollback checks of 001 | 5/5 runner lines (rollback before install; install + ALREADY_APPLIED + ACL + rollback + reinstall; no verdict; unpinned body; superuser) |
| Mutants | 001 read-back mutant caught by 30. The earlier g5pv completion mutant is still caught by 8 / 18 / 19 |
| `G4T_VERDICT=1`, `G4T_BRIDGE_FLOW=1` (the stack now includes 001) | `G4T_VERDICT_ALL_PASS`, `G4T_BRIDGE_FLOW_ALL_PASS` |
| Publish `index.ts` process gate | 7/7; negative control 6 FAIL → restored 7/7 |
| Offline Deno Threads suites (`_shared/social/threads_*`, publish / disconnect / meta-callback Edges, callback contract) | 217/217 + entry / composition with `threads-oauth-connect-user/deno.json` 14/14 |
| App unit tests: threads-connect, ios-return, disconnect, manual-publish | 65/65 |
| `deno lint` / `deno check` (Edge child), `node --check`, `bash -n` | clean |

**NOT_RUN / NOT_VERIFIED:**
- Real Threads / Meta: the publish API shapes are this stack's contract (`threads_publish_contract.ts`), not re-verified against Meta.
- Real OAuth / token exchange; managed Supabase; real PostgREST / GoTrue (fakes here: the JWT `exp` is checked by the fakes, not by real services).
- A real device; G3's scheduler / Worker; a durable Meta callback store (PR #648 N1).

## 4. Flags: where each stays

| Flag / gate | In source | Opened here |
| --- | --- | --- |
| `THREADS_MANUAL_PUBLISH_PREREQUISITES_MET` (Edge) | `false` | the test calls the inner handler; the source entry is also served (scenario 29) |
| `THREADS_MANUAL_PUBLISH_UI_ENABLED` (app) | `false` | the hook gets `releaseEnabled: true` in the test; scenario 29 uses the source value |
| Connect entry static gate / `THREADS_CONNECT_ENABLE_ENV` | closed | the test Edge child's `/open/` route (as before) |
| `threads_disconnect_gate_open()` | false | replaced in the TEST world only (scenario 14, as before) |
| `THREADS_META_CALLBACKS_ENABLED` (PR #648) | `false` | not touched |

## 5. Before any real provider (each step its own approval)

1. **Central / G5:** adopt 001 with the publish stack, after the verdict 001 is reviewed. Nothing applies it today.
2. **Meta app settings** (callback URLs, the human-readable status page N2b), then the **durable callback store N1** (central STOP: schema / grants / shared state). The stop it writes must be `failed` + error code (2.3).
3. **G5 lifecycle:** the personal MVP profile in production; T10 deletion consumes the callback requests.
4. **G1:** the publish card mounted on the Accounts screen behind `THREADS_MANUAL_PUBLISH_UI_ENABLED`, plus the callback URL and associated domains. G4 changed no screen.
5. **G3:** Threads reservations / Worker. Scheduled Threads posts are not built. The verdict is already the shared rule, and manual publish now obeys it too.
6. A non-production Meta app: real connect, one real post, deauthorize. Only then a reviewed gate change.

## 6. Ownership and overlaps

- **Changed paths:** all G4-owned (the e2e, the test Edge child's DB-name guard, the runner, the new candidate, the process runner, the docs).
- **Open-PR overlap:** only this stack's ancestors (#523 … #648) and G1's MVP local RC Draft PR #635. #635 merged G4 #617 and carries the e2e / runner files as of #617. Adopting this task there is G1's re-merge; G4 did not touch #635.
- **Not changed:** G3, G5, H5 and G1 files; shared `social_accounts`; RLS; grants; Vault.
