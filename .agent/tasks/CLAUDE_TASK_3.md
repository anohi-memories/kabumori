# Claude Task 3

- task_id: x-social-mobile-auth-phase2-bundled-correction-20260928
- owner: claude
- slot: claude-3
- status: ready
- next_owner: claude
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: C1 FAILとなったPR #47 multi-provider Auth Phase 2を、H1で再現されたAuth境界の不具合をまとめて1回で修正する。個別パッチをばら撒かず、callback/PKCE/linking/recovery/provider-session/onboarding/provider-readinessを整合した一つの設計として修正する。

## Source

- PR #47 reviewed head: `7bda196147a749431774fba915a86d41bf43dc5d`
- H1 verdict: FAIL
- production mutation: 0
- accepted Phase 1 is already on main:
  - PR #42 -> `f0cac1505184a2abd9c9d504142012a1be999cf3`
  - PR #44 -> `7870d10170d31e0a6b78ab245f4e9152a3628f00`

## Mandatory startup

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - latest H1 section in `.agent/CODEX_REPORT.md`
2. Independent G3 worktree/checkout.
3. Fresh fetch `origin/main` and PR #47 exact head.
4. Read current Supabase skill.
5. Re-check current Supabase changelog/docs for:
   - identity linking
   - exchangeCodeForSession / flowId
   - mobile PKCE/deep linking
   - password recovery
   - Apple / Google / X social login
6. Preserve all unrelated main changes and G4 files.

## Must fix — bundled Auth correction

### 1. Provider linking URL handling

Current shared browser helper rejects the external authorization URL returned by `linkIdentity()`.

Required:
- distinguish sign-in initiation URL provenance from authenticated identity-linking redirect URL provenance
- validate only expected secure schemes/hosts/provider destinations
- do not simply remove URL validation
- preserve exact authenticated-user binding
- no external arbitrary URL open

### 2. Duplicate callback false-success race

Current duplicate-code Set returns success before the first exchange completes.

Required:
- share the actual in-flight result/promise/outcome
- duplicate delivery must resolve to the same real result, never an unconditional success sentinel
- cover both code and token-hash callback paths where applicable
- lifecycle must clear safely across cancellation/failure/restart boundaries
- prevent double exchange while keeping truthful UI outcome

### 3. Preserve and validate `sb_flow_id`

Required:
- parser retains documented flow ID
- strict validation
- pass `flowId` to `exchangeCodeForSession`
- concurrent flow A/B tests
- stale/malformed/mismatched flow IDs fail closed
- no fallback to wrong latest verifier

### 4. Email signup enumeration

Required:
- identical neutral successful UX for new-address and obfuscated existing-address no-session responses
- duplicate-address/server variants must not restore enumeration
- no raw provider/server distinction shown

### 5. Provider credential persistence policy

H1 proved SDK session persistence can include provider access/refresh fields in AsyncStorage.

Required:
- define the intended storage policy explicitly
- persist only what is necessary for Supabase app session/PKCE restoration
- provider OAuth access/refresh fields must not be stored in plaintext AsyncStorage or exposed in React context/logs
- do not break Supabase session restore
- behavioral tests must verify actual storage payload, not regex source scans
- app-auth provider credentials must never become posting-X credentials

### 6. Password recovery exact-user/session binding

Required:
- recovery context bound to intended user/session/flow
- invalidate on incompatible SIGNED_IN/user switch/session switch
- recheck immediately before updateUser
- restart/callback overlap/user-switch tests
- no boolean-only global recovery mode

### 7. Exact callback parsing

Required:
- reject credentials/userinfo in callback authority
- reject unexpected port
- reject duplicate/conflicting code/token_hash/type/sb_flow_id values across query/fragment
- only documented allowed fields
- preserve rejection of posting callback, foreign scheme/host/path and implicit-token-only returns
- malformed/ambiguous callback must fail closed

## Also fix H1 continuation/readiness gaps

### New-account notice / onboarding continuation

- do not drop duplicate/new-account notice solely because 30 minutes elapsed if no workspace/ack exists
- define explicit acknowledgment/progress semantics
- session/user switch must invalidate stale onboarding state
- tests must prove exact-user progress isolation

### Provider availability truthfulness

- Email UI must respect current provider/email/signup-disabled settings
- do not present a provider as ready merely because `external.*` is enabled if client-required config is absent
- source may distinguish:
  - provider enabled in Supabase
  - local/client config present
  - fully E2E verified (must remain false until later real-device gate)
- no fake readiness

### Apple linking path

H1 noted current explicit linking uses browser flow even on iOS.

Required:
- decide and document native-vs-browser linking path
- if browser linking retained, surface exact Services ID/secret config gate
- if native linking implemented, prove it preserves explicit identity-linking semantics
- do not claim native sign-in config automatically covers linking

## Preserve already-correct boundaries

Do NOT regress:
- X app-login != posting-X
- posting uses only `x-oauth-connect-user` + Vault path
- no client service_role
- no user_metadata authorization
- no merge by display name/handle
- Apple nonce behavior
- fixed messages/no raw provider errors
- Phase 1 session/login/logout behavior
- exact workspace/account fail-closed rules
- G4 Home/posting/history files

## Required tests

Recreate H1's seven negative probes as durable product tests where practical.

At minimum prove:
1. linkIdentity returned provider URL is accepted only when valid.
2. malicious/unexpected external URL is rejected.
3. duplicate callback gets same real failed/successful outcome as original.
4. concurrent PKCE flows select correct verifier by flowId.
5. malformed/stale/duplicate/conflicting flow IDs/params rejected.
6. new/existing email signup no-session messages indistinguishable.
7. provider access/refresh fields not persisted to plaintext storage/context.
8. Supabase app session restore still works.
9. recovery A -> login B invalidates recovery.
10. recovery exact-user/session succeeds only for bound user/session.
11. user-switch clears stale onboarding/new-account state.
12. provider/email disabled/config-missing UI fails closed.
13. X login remains separate from posting X.
14. existing password login/logout/session restore regressions.
15. Apple native nonce regression.
16. no secret/service_role/provider token logging.

Run:
- full `npm test`
- data-view tests
- typecheck
- lint
- Expo web + iOS export
- git diff --check
- secret scan

## Production constraints

- no provider enablement/disablement
- no redirect allowlist mutation
- no SMTP/template change
- no Apple/Google/X developer-console mutation
- no DB migration
- no Stage 3B activation
- no real X post
- production_mutation=0

## Completion / K3

Report:
- exact fixed PR #47 head
- each H1 finding => fix/result
- storage policy
- recovery binding design
- callback/flowId design
- linking design
- onboarding/user-switch behavior
- provider-readiness behavior
- changed_files
- tests
- remaining console/device gates
- production_mutation=0
- whether ready for one final focused H1 acceptance pass

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

## Report

- pending
