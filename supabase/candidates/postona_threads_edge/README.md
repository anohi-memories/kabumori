# Threads OAuth Edge — offline integration candidate (H1, 2026-10-11 JST)

This is a **mock-only, unwired candidate**, not an Edge Function or a deployable
runtime adapter. It is stacked on protected Draft PR124 head
`c30f246409a77080cbc03aef6c4cb72b5481e125`. No existing PR118/124 types,
candidate SQL, X OAuth or mobile imports are modified.
`THREADS_CONNECT_PREREQUISITES_MET=false` remains authoritative; environments
cannot enable it. The explicit enabled config inside this offline factory
exercises the pure request builders only. Configuration is restricted to
reserved `.example` callback URLs and `offline_dummy_` secrets. An injected port
is still a trusted test dependency, **not** proof of a real JWT, SQL ACL or
provider.

## Ports and flow

- `MockAuthPort.verify`: resolves a verified user and session, or refuses.
  Presence of a bearer string, decoded JWT claims, user metadata or a
  caller-supplied user ID is not verification. The candidate invokes this port
  at start, callback and again before completion. No actual Supabase Auth
  adapter.
- `MockRpcPort.begin/consume/complete`: exact PR124 payload types; context comes
  only from verified subject. Begin returns the owned workspace/account; consume
  must return that same workspace, account, UUID state and exact redirect. The
  eventual RPC authority transport is **not implemented**.
- `MockAttemptPort`: remembers only state hash, subject/session, workspace and
  expiry. Atomically checks owner/session and permanently claims both state and
  code hash before any provider exchange. There is no release method. Test mocks
  share one coordinator even across separate candidate objects. This is a
  fixture contract, **not a new RPC/schema or distributed production lock**.
- `fakeHttp`: only injected fake HTTP. The existing PR118 pure adapters build
  the three requests, disallow HTTP redirect following, validate responses and
  preserve raw decimal provider IDs exactly. Only matching code-exchange and
  `/me` identities reach `completeRpcPayload` and its HMAC attestation. A dummy
  HMAC key is used; the token goes only to the injected mock completion
  boundary.
- Default raw state: 32 WebCrypto random bytes, base64url. Tests inject
  deterministic bytes only. Only the hash reaches begin. Start returns an
  authorization URL/state (necessary OAuth public data), expiry and provider,
  never token/secret/user/session/account values. Do not log even this
  URL/state.
- Callback returns a fixed success with `publishEnabled:false`, or a fixed error
  with `restartRequired:true`; no identity, credential, raw provider body, SQL
  text or thrown error is echoed. `COMPLETE_OUTCOME_UNKNOWN` requires
  **reconciliation**, not automatic callback retry/new begin. `restartRequired`
  forbids reuse of the code/state, not a claim that starting over is safe
  immediately.

## Important limitations / ownership gates

1. PR124 `consume` is a **read-only lookup**, despite its name. DB state
   consumption occurs atomically in `complete`. The added attempt/code
   coordinator prevents duplicate exchange only in the shared fake fixture. Real
   activation needs separately designed durable, cross-instance claim/outcome
   handling: authenticated session binding, code-hash retention over the
   provider's validity window, expiry/drain, worker crash recovery,
   unknown-state reconciliation, no retry after uncertain exchange. Do not wrap
   read-only consume and claim it is a production atomic exchange lease.
2. PR124 denies EXECUTE to `authenticated` AND `service_role`; unchanged RPCs
   require `auth.uid()`. Neither forwarding a user JWT nor adding a service key
   is a functioning authority bridge. A future reviewed owner-controlled
   transport/claims boundary must preserve the verified caller and attested
   provider provenance without making an untrusted completion writer reachable.
   No grants changed.
3. Begin/complete must enforce the real G5 T13 fence **in the same
   transaction**, before writes, following G5 lock order. Mock lifecycle refusal
   is not managed DB concurrency proof. Begin can already have created pending
   metadata if later coordinator setup/response fails. Never infer rollback of a
   timed-out RPC. Completion unknown can be committed or rolled back: no blind
   retry, no state release, no automatic credential cleanup. Existing
   associations are not reconciled here.
4. No real Vault adapter. Known fixture refusal/Vault failure stores no fake
   credential, while a deliberately applied-but-no-response fixture proves that
   an error can coexist with a write. Real rollback/isolation/owner/ACL/default
   grant/role inheritance/SET-role proof is still required.
5. Authenticating the callback to the **same session** is only the mock
   port/coordinator contract. A raw Meta browser redirect normally does not
   supply the app bearer header. Browser-to-app return, session handoff/cookie
   semantics, CSRF/exact redirect and native deep-link design remain unwired. Do
   not accept an arbitrary identity/body claim as a substitute for that design.
6. Phase2a-2 production schema, real G5 T13, reviewed G4 T9 workspace
   integration (including X delegation), T10 provider-aware service deletion,
   Meta app/tester/redirect/config and callback validation, HMAC/Vault key
   custody, integrated independent security review and **separate production
   approval** all remain required. Entitlements are never created/reactivated,
   posting never enabled.
7. Provider endpoints/scopes are inherited unchanged from protected PR118, not
   newly verified live. Current Meta documentation was attempted but unavailable
   to the documentation reader; Meta-owned
   [Threads API collection](https://www.postman.com/meta/threads/documentation/dht3nzz/threads-api)
   is a reference for the exchange sequence, not proof that these exact hosts
   work with this app. Host/callback/tester behavior must be reverified before
   activation. No real provider call performed.

Timeouts bound auth/RPC/coordinator/fake response/body waits; abort is advisory.
An adapter may still finish after timeout. The candidate suppresses success and
never retries/releases; it cannot undo an already dispatched SQL/HTTP operation.
There are **no logs**, network client, env reads, server entry, deployment
config, migrations, PR merge, EAS, posts, refresh, grants or secret-management
operations. Existing X security work
[Issue131](https://github.com/anohi-memories/kabumori/issues/131) remains
deferred. G3/G5/H2 code and workflow ownership are untouched.

## Offline verification

```sh
deno check --no-config --no-lock supabase/candidates/postona_threads_edge/offline_candidate.ts supabase/candidates/postona_threads_edge/offline_candidate_test.ts
deno lint supabase/candidates/postona_threads_edge/
deno test --no-config --no-lock supabase/candidates/postona_threads_edge/offline_candidate_test.ts
```

No `--allow-net`, `--allow-env` or `--allow-write` is used for the new flow
tests. Existing contract isolation regressions separately need repository-only
read permission. Permission flags do not simulate real
GoTrue/PostgREST/Vault/Meta security. Verification details/counts belong in H1
Report. The
[Supabase auth guide](https://supabase.com/docs/guides/functions/auth) requires
actual user JWT verification and distinguishes user-scoped queries from admin
access; that influenced the verified identity port, not an SDK/version/config
change. [Changelog](https://supabase.com/changelog) checked; the markdown
endpoint was unsupported and HTML used. No managed DB or SDK implementation
here.
