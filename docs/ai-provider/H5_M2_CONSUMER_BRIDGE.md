# H5 M2 — typed Claude consumer bridge (source only, MERGE/ACTIVATION HOLD)

Task `common-ai-h5-claude-multimodel-consumer-bridge-m2-20261014`; Codex臨時実装 / Sol（高）. Exact parent F6 Draft PR187 `a7e1d3f3f6b3812e9b8b0c0f7c29835e25505d6b` is unchanged. This PR adds only `supabase/functions/_shared/ai_consumer_bridge/**` and this guide. Existing Opus morning/close generation, F2/F8/F9/F1/POSTONA and the provider implementation/ledger policies remain untouched. No live feature is connected; no native env/fetch, route/serve, credential/default transport or automatic provider/model fallback is added.

## API / actual F6 integration

`createConsumerBridge(version, features, deps).execute(credential, request)` calls public F6 `defineAnthropicModelPolicies`, `resolveModelChoice`, `modelPolicyRequest`, `validateAiRequest`, `executeWithModelPolicy` and its catalog/schema/cost helpers through `../ai_provider/mod.ts`. It does not duplicate provider/model resolution/SDK/retry logic. Models are selected by a registered role; caller options can only narrow the allowed policy, never supply an unapproved model/provider or raise timeout/cost/output cap.

Server-owned `ConsumerFeature`: id, revision, F6 policy (role/application/feature/allowed model aliases/efforts/output/attempt timeout/retry limit), systemInstructions, named JSON schema, maxInputBytes/maxResultBytes (1..65536), maxTotalCostUsd (>0 and <=1 estimate), deadlineMs (1000..60000 milliseconds), **mandatory** validateFacts(payload,input). Register only after the owning feature approves prompt/schema/rights/quality/budget. Revision must change when Fact logic changes; never accept registrations/prompt/system role/tenant/limits from HTTP or user metadata.

Request envelope:

```ts
{feature:"offline.news.severity", operationId:"synthetic_run_1",
 input:"Synthetic outage drill; evidence synthetic-1.",
 selection:{maxOutputTokens:64, effort:"low"}} // optional selection; no userId/subject/role/provider
```

`credential` is opaque to the bridge. `deps.authorize(credential,feature)` is a **trusted server-owned verifier** returning `{subject:{kind:"user",userId,brandId},expiresAtMs}` from verified Auth/ownership, or `{subject:{kind:"system"},expiresAtMs}` for an authorized scheduled job. Anonymous/expired/foreign/unauthorized feature must return null. This library is NOT an authentication implementation and never grants system authority by parsing request claims. Subject IDs must follow F6's UUID contract; POSTONA non-UUID brand identifiers require an owner-approved attribution mapping, not coerced IDs. Verification occurs for each invocation including cached-result reads; ongoing revocation/freeze must be fenced by the consumer/ledger integration before a live call.

`deps.provider` requires explicit injected fetch and secret reader plus a budget guard implementing reserve/markSent/settle/release. No default native fetch/env is used. Live use must bind this to the reviewed shared ledger, scoped to the role/application/feature and verified subject; fake in-memory guards are NOT a monthly/global budget. Cost of all possible attempts is checked against the feature's total ceiling before key/reservation/send; F6 checks its per-attempt cap, reserves and confirms each send, settles usage/unknown holds, and only retries transient failures within deadline. Never combine this with caller/SDK retries or automatic semantic regeneration. Estimated costs derive from the pinned catalog, not provider invoices/current credit balances; unusual usage above the bound returns UNKNOWN rather than pretending a hard billing guarantee.

Results: success `{ok:true,data:<schema+Fact validated JSON>,audit}`; refusal `{ok:false,code:<fixed BridgeCode>,audit|null}`. Audit contains only callId, tenantTag hash, feature, registered role/model/policyVersion, attempts, estimatedCostUsd and measured/includes_upper_bound/no_request basis. No credential, raw provider body/message, prompt, operationId, user/brand ID or schema failure detail appears in audit/errors. A transport deadline retains a conservative sent-attempt upper cost, not fictitious zero/no_request. Hooks receive frozen copies; audit failure cannot alter outcomes. Domain payload privacy/rights remains the owning schema/Fact validator's responsibility.

## Durable idempotency port (required before live use)

`ConsumerCallStore.claim({key,tenantTag,fingerprint})` is atomic across workers; complete compares owner+identity. Key is SHA256(application + canonical verified subject + feature + operationId), independent of caller-supplied identity. Fingerprint also binds policy/revision/model/effort/output/schema/prompt/input and all limits. Reusing an operation with changed input/schema/policy/limits is CONTENT_DRIFT, **not** another charge. Distinct user/brand/system scopes cannot share results. Concurrent claims yield IN_PROGRESS; settled result is revalidated on read. Never release/take over a possibly sent UNKNOWN claim by TTL, and never reset provider `(callId,attempt)` entries to authorize replay. Operator reconciliation is separate.

The port is intentionally not a new database/RPC here (task forbids DB changes). Consumers must supply approved durable storage/TTL-retention/reconciliation and the existing shared ledger before activation. `FakeStore`/`FakeLedger` occur only in `_test.ts`; no production class pretends in-memory state is cross-instance durable. If complete returns lost/unknown, return UNKNOWN even if provider succeeded; a new explicit operation requires consumer approval, not an automatic retry. Late provider settlement may still update the existing ledger; no second result write/replay is started by bridge timeout.

## Two offline examples / tests

`offline_samples_test.ts` demonstrates synthetic severity classification via the registered F6 `anthropic.haiku@2026-10` alias and synthetic summary via `anthropic.sonnet@2026-10`. Alias→API ID resolution and cost math come from PR187; IDs/prices are not invented/updated here. Availability against the real provider is NOT_RUN, and MODEL_UNAVAILABLE does not trigger Opus/OpenAI fallback. No third-party article text is used or sent.

Run `bash supabase/functions/_shared/ai_consumer_bridge/offline_run.sh`. It denies native network and real API-key env permissions, uses explicit dummy readers/mock fetch, and **scrubs child-process** API key/auth token/base URL/webhook/custom-header defaults without printing values. Two empty SDK optional env slots are allowed because SDK0.132.1 reads them even when API key/authToken/baseURL/logLevel are explicit. `deno check/lint --config .../deno.json` use a scoped lockfile; no F6 lock/dependency file is changed. Tests cover mappings, narrowing/invalid override, tenant/cache tampering, pre-network budget/cost denial, deterministic cross-instance fake claims, retries/timeout/unknown, schema/Fact validation, immutable audit/redaction and unwired runtime imports. No managed Auth/ledger/real monthly concurrency or quality/device claim is inferred.

## F6 handoff / precise merge blockers (do not widen here)

Independent offline evidence: exact PR187 baseline policy+isolation = 19 PASS / 0 FAIL; H5 candidate policy+isolation = 16 PASS / 3 FAIL (policy 11 PASS; isolation 5 PASS / 3 FAIL). H5 bridge+own isolation = 27 PASS / 0 FAIL. The three unchanged F6 failures are the exact named-import allowlist, deployable-source reachability allowlist, and widening mutation test. These are merge blockers, not ignored test failures. Native network was denied for these runs, with SDK optional env defaults scrubbed in child processes.

1. PR187's **unchanged** `ai_provider/isolation_test.ts` allows direct/reachable imports only from the market report handler. New H5 imports through public mod.ts are intentionally visible to that guard; the provider isolation test must currently FAIL. H5 did not hide/rewrite the imports or weaken F6 tests. F6 must review a bounded allowlist for exact bridge/types/tests references; no additional live consumer/index/SDK/key-name access is authorized. After F6-owned correction, rerun baseline/provider/H5 isolation and confirm no deployable function reaches the bridge except separately approved future consumers. Until then source can be reviewed but **do not merge/activate**.
2. SDK0.132.1 unconditionally reads optional custom-header defaults and defaults webhook key. Deny-env execution fails before mocked send; sanitized offline child env succeeds. F6 owns SDK construction and should evaluate suppressing optional defaults/containing environment overrides. H5 neither patched SDK/F6 nor granted global env access. Production runtime environment hygiene requires separate proof; this report does not claim completely env-independent SDK execution.
3. Real authorization/tenant attribution, durable caller claim storage, shared ledger permissions/recovery/monthly ceilings and caller-approved content rights/quality are not provisioned or changed by this library. No migration/grant/secret/deploy/paid call/feature switch was performed.

## Later integration by owners (new TASK, not this PR)

| Owner | Later approved attachment | Before activation |
| --- | --- | --- |
| F8 / F9 | severity or summary selection, not the live monitor in this task | lawful synthetic/approved input, quality set, precision/coverage floor and role cost ceiling |
| F1 | verified user/tenant Q&A consumer | Auth/ownership/rate limits, no unapproved PII or prompt trust, Fact/structured-answer validator |
| F2 | separate additional report role only if requested | existing Opus morning/close remain unchanged; verified report/Fact parity and explicit migration decision |
| POSTONA | server-only approved role | own permissions/tenant UUID attribution; never substitute connection/publish consent or existing credential authority |

Sequence: C5 source review → exact F6 isolation/env handoff → owning feature TASK + budget-policy/quality/cost approval → durable claim/shared ledger + verified attribution → deny-net integration/mutations → separately authorized smallest paid pilot/limit/stop rules → operator deploy/readback. Rollback disables only the newly approved consumer wiring; does not change existing Opus primary generation or silently fall back to another provider. Keep sent/unknown ledger/claim evidence during rollback. No merge/deploy/pilot approval is conveyed by offline PASS.

Supabase skill informed local import isolation/pin+lock and no runtime/default-secret effects; [official dependency guidance](https://supabase.com/docs/guides/functions/dependencies) consulted. The [current TLS cipher deprecation](https://supabase.com/changelog/cbc-tls-ciphers-deprecated) affects future HTTP clients; this task makes no live HTTP connection or TLS setting change.
