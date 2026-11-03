# H5 Threads authenticated runtime candidate — SOURCE ONLY

Task `postona-threads-oauth-runtime-bridge-h5-20261011`; recommendation Sol（高）.
Stack parent: immutable PR135 `e38788d6677082138f0990453c7d2f00549666d0`, itself on PR124 `c30f246409a77080cbc03aef6c4cb72b5481e125`.
No production apply, OAuth, Auth, Vault, grants, credentials, deploy, provider calls or merge is authorized here.
`THREADS_CONNECT_PREREQUISITES_MET=false` remains unchanged. The new Edge entry returns 503 and is not wired to mobile or a live router. **This does not yet connect a real account.**

## Readiness / authority

| Component | Source / local evidence | Live readiness |
|---|---|---|
| Actor | SDK-compatible `getClaims(jwt)` signature verification plus `getUser(jwt)`; matching non-anonymous authenticated sub/session/expiry; sealed principal | NOT_VERIFIED against real GoTrue/session policy |
| Callback | Exact configured HTTPS origin/path, strict query, CSRF hash, authenticated same app session | App registration, HTTPS universal/app link and mobile forwarding not implemented here; G4 coordination required |
| Durable claim | New SQL owner-only attempts + permanent code-hash tombstones; commit before exchange, no takeover | Candidate NOT_APPLIED; review required |
| Owner transport | New dedicated SQL connection adapter, non-super parent owner, no API-role membership; verified local claims, T13/session locking | BLOCKED: no approved owner credential/connection route; production owner migration method, Auth SELECT/UPDATE lock privileges and G5 T13 must be resolved independently. No positive grants supplied |
| Completion | PR118 exchange/profile validators, >2^53 identity preservation, PR124 attestation/Vault RPC, outcome in same transaction | Parent candidates/T13/Vault key provisioning NOT_LIVE_VERIFIED |
| Disconnect/delete | H5 evidence DTO only, no executor | G5 T10 fence/cleanup/provider proof remains required |
| Manual publish | Receipt only, publishEnabled false | G4 must independently authorize actor/session/account and manual consent each time; no publish implementation here |

## Callback and secrets

Register one exact HTTPS redirect per target; no wildcard. Meta returns code/state to that URL. The app's approved universal-link handler (or reviewed same-origin return page) must forward the exact URL to a server route **with its own current Supabase bearer**, never with userId or a service key. A logged-out browser callback cannot write credentials. Different session/account must restart OAuth. Do not log callback URLs, authorization headers, SQL parameters or provider request URLs (the inherited long-token exchange uses server-only secret query parameters).

The injected Auth SDK is a server-created trusted client, not caller-provided. SDK `getClaims` must actually verify signature/issuer against the intended project, and `getUser` must use that same project. A decoded JWT is insufficient. Supabase documents these verification APIs: [getUser](https://supabase.com/docs/reference/javascript/auth-getuser), [getClaims](https://supabase.com/docs/reference/javascript/auth-getclaims). Session ID must match an extant `auth.sessions` row, with matching user and valid `not_after`, locked against deletion. [Supabase sessions](https://supabase.com/docs/guides/auth/sessions) describes timebox/inactivity enforcement: **row existence and JWT expiry alone do not prove every configured session policy**. Pilot must verify actual inactivity/timebox/signout/refresh policy; no Auth DDL or G5 edits here.

Server-only dependencies are Meta app ID/secret, attestation key matching PR124 Vault configuration, verified SDK client, and an approved dedicated non-super owner SQL route. Values are never written in source/report/client; no service-role proxy or broad EXECUTE grants. The owner is intrinsically powerful: this adapter is not a new least-privileged database role. Owner credential isolation, parameter-safe driver, TLS, egress policy, sanitized logging and request budgets are external approval blockers. Auth row-lock privileges may be unavailable to that owner; do not grant around this silently.

Existing [Meta Threads official collection](https://www.postman.com/meta/threads/documentation/dht3nzz/threads-api) and inherited PR118 contracts are the provider reference. Actual app eligibility/scopes/redirect/token response compatibility must be checked in an approved pilot. H5 does not broaden scopes, enable posting or change the inherited strict `token_type=bearer` requirement.

## Transaction and uncertainty

Begin: sealed actor → owner-role check → verified SET LOCAL claims (JSON and legacy GUCs) → T13 locks → session KEY SHARE → parent begin/workspace/state → remember → COMMIT. Begin and binding are atomic.

Claim: same T13/session preconditions → parent read-only consume → attempts FOR UPDATE → unique burned-code INSERT → mark claimed → COMMIT **acknowledged before** any code exchange. Separate workers/restarts cannot redeem that state/code twice. A code hash cannot be reused even if a PII-bearing attempt is later deleted. Pending TTL is checked; expiry never releases a burned code. No lease takeover, HTTP retry or code replay exists.

Complete: reverify the same actor/session → T13/session → workspace lock → parent state FOR UPDATE → bound claimed attempt FOR UPDATE → parent HMAC complete/account/Vault → record expiry and complete → COMMIT. Parent begin/complete preserve their own T13 checks; existing X RPCs remain untouched. SQL statement timeout 4s, lock timeout 2s; stage deadline up to 10s. A client-side deadline does not cancel every driver call: late commit is possible. Claim response loss refuses exchange; completion response loss is UNKNOWN, not rollback. Connection close failures never authorize retry. SQL rollback before COMMIT preserves pending/no-burn; after commit code remains burned.

If exchange/profile fails after claim, try recording uncertain; if even that fails, claimed is still burned. A token may already exist remotely. Never retry the code or announce remote revoke. If completion was sent, do not overwrite a potentially committed complete with uncertain. Return reconciliationRequired and restartRequired; **restart means a newly approved OAuth attempt, not reuse of the previous code**, and uncertain remote custody must be resolved first. No provider or deletion reconciliation executor is added.

## T10 / G5 and G4 handoffs

G5 must define owner-controlled T10 cleanup in its own workstream: lock lifecycle/entitlement before workspace/state/account, fence incomplete/claimed attempts during deletion, delete attempts' user/session/account/redirect/expiry metadata only after reviewed reconciliation, preserve anonymous burned-code hashes without identity, and define bounded hash retention without allowing code replay. No FK restriction is introduced on Auth deletion. Local custody absence is not confirmed_remote_revoked: `deletion_contract.ts` distinguishes these evidence fields, but evidence truth must come from G5's trusted worker, not client claims. Do not revive a discontinued service or invent a Threads entitlement; `x_autopost` is POSTONA-wide.

The G4 DTO is `{ok:true,status:"connected",provider:"threads",socialAccountId,publishEnabled:false,tokenExpiresAt}`. It is not a signed authorization capability and contains neither credentials nor trusted user claims. G4's server must obtain a fresh sealed actor/session, T13 active service, membership/ownership of that account, connected Threads identity, valid server-held expiry/custody and explicit manual posting consent. Read tokens only server-side via a separately reviewed owner route. No X token reuse; no scheduler/manual publish authority is granted by connection. Expiry demands an approved reconnect/refresh design, never publish with expired custody.

## Local verification and next approval

`deno test --no-config --no-lock supabase/candidates/postona_threads_auth_runtime/runtime_test.ts` needs no network/environment permission. `postgres_run.sh` requires an explicitly supplied disposable `/private/tmp` Unix socket and local PostgreSQL 17 admin; it creates its own fake DB/owner, never accepts remote connection URIs. It leaves evidence for inspection. Its T13/Auth/parent are **MOCK_ONLY**, so real concurrency/ACL evidence is not proof of managed Supabase behavior or parent Vault integration. `parent_integration_run.sh` builds the real parent source chain plus H5, checks unchanged parent behavior/X regression and owner begin→remember→durable claim→complete/fake Vault→outcome. It uses fake Auth/T13/Vault, not managed proof. Both runners must run alone on their dedicated cluster, never on a shared cluster; one test temporarily changes cluster-wide role membership, restored by the normal path (on interruption inspect/revoke before reusing). The cluster remains disposable and should be stopped after inspection.

Next: independent H1–H4 source/security review, G5 authority/session/T10 resolution, G4 authenticated return-path and publish integration, exact live schema/owner/role migration plan, then per-target user-approved controlled pilot. PASS in offline testing never authorizes production apply/deploy. New Edge entry remains hard-disabled even if somebody flips the inherited feature flag; wiring is a separate reviewed change.
