# Codex Task 2

- task_id: social-mobile-app-phase22-live-history-dependency-gate-default-off-20260923
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: GPT-6 Sol Medium
- purpose: Phase21 C2 PASS後、production `social-mobile-history-learning` にlive dependency wiringを追加する。ただしserver-only feature gateはdefault OFFのままdeployし、実Vault plaintext read・access-token RPC invocation・real X history fetchはまだ一切発生させない。

## Goal

Production Functionに「将来ONにできるlive wiring」を実装するが、
**このPhaseでは必ずOFFのまま**にする。

実装対象:
- Auth user resolution
- owner membership / workspace / verified X account reads
- dedicated access-token RPC reader
- X history fetch adapter

ただし entrypoint では server-only feature gate が true の時だけ live dependencies を構築する。

Default/production value = OFF.

## Mandatory fresh start

H2開始時:
1. `git fetch origin main`
2. fresh `origin/main`
3. `.agent/ORCHESTRATION.md`
4. `.agent/CURRENT_STATE.md`
5. this TASK
6. `.agent/CODEX_REPORT_2.md`
7. Phase20 RPC production metadata read-back
8. Phase21 deployed runtime source read-back
9. other-slot overlap check

If another slot touches `social-mobile-history-learning`, its shared reader modules, the access-token RPC, or related production env/config, STOP.

## Model policy

Use **GPT-6 Sol Medium**.

Raise effort only for a concrete blocker involving:
- Supabase Function secret/env semantics
- service-role credential boundary
- bearer-auth validation
- feature-gate fail-closed behavior
- RPC/Vault access control

## Scope A — live dependency factory implementation

Implement production-shaped dependencies for:
- `readAuthUser`
- `readOwnerMemberships`
- `readWorkspace`
- `readXAccounts`
- `readAccessToken` via existing dedicated RPC adapter
- `fetchXPage` via existing X read adapter

Required authority order:
1. request must include explicit consent
2. Supabase Auth validates bearer and yields user id
3. owner memberships resolved for that user
4. requested/sole workspace validated
5. workspace ownership rechecked
6. exactly one verified X account resolved
7. dedicated RPC receives only trusted user/account binding
8. only then may an access token be read
9. only then may X history be fetched

No client-supplied:
- user id
- social account id
- platform user id
- Vault secret id/ref
- access token
- refresh token

## Scope B — server-only feature gate

Introduce one explicit gate, e.g.
`SOCIAL_MOBILE_HISTORY_LIVE_ENABLED`.

Rules:
- absent => OFF
- empty => OFF
- unknown value => OFF
- only exact documented truthy value may enable
- gate evaluated server-side only
- mobile cannot override it
- request body/query/header cannot override it
- OFF path must use disabled dependencies and fail closed before RPC/X
- do not log secret/env values

Document exact accepted value.

## Scope C — server-only credentials

Live factory may require:
- project URL
- service-role key

Rules:
- service-role key is read only inside Function runtime when gate is ON
- no key in source/test fixtures/reports
- no mobile exposure
- no response exposure
- missing key while gate ON => fail closed with normalized safe error
- no fallback to anon/publishable key for RPC
- no direct generic Vault query; use only approved dedicated RPC

Do not create/rotate/change production service-role credentials.

## Scope D — source tests

Add tests proving:
- default gate OFF
- missing env OFF
- malformed env OFF
- request cannot force gate ON
- OFF path never calls RPC/X
- ON factory creation fails closed if server config missing
- client identity values are ignored/not accepted
- auth -> owner -> workspace -> account -> token -> X order
- refresh token never referenced
- response/log-safe behavior
- max 50 posts / 2 pages remains
- raw post bodies are not persisted
- proposal remains unconfirmed

## Scope E — production preflight

Read-only:
- Phase20 RPC still exact and service_role-only
- Phase21 Function ACTIVE and byte-matches approved disabled source
- check current Function secret/config metadata only as permitted; do not retrieve actual secret values
- determine whether required standard Supabase runtime env vars are automatically available
- determine safe method for feature-gate env configuration

If feature-gate configuration would require an unsafe/manual secret mutation path or cannot be proven default-OFF, STOP.

## Scope F — production deploy

Deploy only `social-mobile-history-learning`.

Allowed:
- source update with gated live wiring
- server-only feature flag configuration set explicitly OFF if needed

Preferred:
- design so absence of the flag is OFF, avoiding extra production config mutation if possible

Must preserve:
- `verify_jwt=true` unless a concrete technical incompatibility is proven and separately reported before changing
- no DB/RPC/migration changes

## Scope G — post-deploy proof

Read back runtime source and metadata.

Prove:
- Function ACTIVE
- expected new version
- `verify_jwt=true`
- live factory exists
- entrypoint chooses live factory only when server-only gate is exactly ON
- production gate is OFF / absent and therefore fail-closed
- no request-controlled bypass
- unrelated Functions unchanged

## Scope H — safe smoke

Only safe requests that cannot reach live dependencies.

Allowed:
- unauthenticated GET/POST rejected by gateway
- OPTIONS if useful
- any test only when gate is confirmed OFF and no real-user bearer is used

Forbidden:
- real QA bearer with explicit consent
- real workspace/account
- service-role invocation
- real access-token RPC
- Vault plaintext
- X history API

## Forbidden

- turning the live gate ON
- invoking `read_social_mobile_history_access_token`
- reading Vault plaintext
- calling X history API
- persisting persona
- storing raw history
- OpenAI live call
- OAuth changes
- publish/media/repost
- `publish_enabled=true`
- Cron/scheduler
- DB migration/RPC/RLS/ACL changes
- secret rotation
- unrelated Function deploy

## Production mutation budget

Allowed:
- one `social-mobile-history-learning` Function deploy/update
- optionally one feature-gate config write only if required, and it must be OFF

Everything else mutation = 0.

## Completion / C2

When complete:
- status -> `review_required`
- next_owner -> `chatgpt`
- update `.agent/CODEX_REPORT_2.md`

Report must include:
1. fresh source commit
2. exact gate name/accepted ON value/default behavior
3. live dependency implementation summary
4. auth/tenant/account authority order
5. service-role boundary proof
6. tests
7. production preflight
8. deploy version
9. verify_jwt value
10. runtime source read-back
11. proof gate is OFF/absent in production
12. safe smoke
13. access-token RPC calls = 0
14. Vault plaintext reads = 0
15. X history calls = 0
16. persona/raw-history writes = 0
17. unrelated production mutation = 0
18. remaining risks
19. exact next gate recommendation
20. commit/push/fresh origin verification

Then STOP for C2.

## Next gate after PASS

Phase23 only after C2 PASS:
- exactly-one QA history-learning run
- dedicated QA Auth user + already-linked safe test X account only
- user explicit consent immediately before run
- one real access-token RPC/Vault read + bounded X history fetch
- no publish
- no persona persistence unless separately approved
