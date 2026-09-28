# Claude Task 3

- task_id: x-social-mobile-account-lifecycle-release-phase4-20260928
- owner: claude
- slot: claude-3
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Opus5.5（高）
- purpose: Auth Phase 3の次として、公開前に必要なアカウント管理・アカウント削除・プライバシー/法務導線を棚卸しし、安全なsource/UI設計を実装する。production user deletionやAuth設定変更は行わない。

## Accepted source

- Auth Phase 3 PR #50 merged to main as `ff46c397018a215c53b091feaae86076b37489a7`
- Phase 3 verdict: PASS
- no additional review required for Phase 3
- production_mutation=0

## Mandatory startup

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - latest G3 Phase 3 report
2. Independent G3 worktree/checkout.
3. Fresh fetch `origin/main`; branch from latest main including PR #50.
4. Read current official Apple App Review / account deletion / Sign in with Apple guidance and current Supabase Auth docs before making lifecycle decisions.
5. Confirm no overlap with G4 posting/backend files.
6. Read current schema/Edge/Auth code to identify what user-owned data would need deletion or retention.
7. If safe deletion requires a new privileged backend boundary, implement source-only candidate and mark independent review mandatory; do not deploy.

## Product goal

A signed-in user should have a truthful account/security area that explains:
- current login methods
- password/security actions
- X posting connection remains separate
- privacy policy / terms links if configured
- how account deletion works
- what will be deleted vs retained
- what is still unavailable before production setup

No fake deletion success.

## Scope A — release compliance inventory

Inventory current source and identify:
- account deletion availability
- privacy policy URL/config
- terms URL/config
- support/contact entry
- Sign in with Apple implications if social login is offered
- data categories linked to the authenticated user/workspace
- tables/storage/credentials that would need delete/anonymize/retain handling
- whether deletion can be self-service safely today

Document source-supported facts only; do not invent legal text or retention policy.

## Scope B — account/security UX

Extend the existing account/login-methods/security area where appropriate.

Possible user-facing entries:
- login methods
- password reset
- posting-X connection link
- privacy policy
- terms
- support/contact
- account deletion

Rules:
- missing URLs/config => show unavailable/setup-pending truthfully or omit according to product UX
- no hard-coded placeholder URLs presented as real
- no provider token/secret exposure
- no unlink unless already safe and explicit

## Scope C — account deletion contract design

Determine the safest architecture for self-service account deletion.

Requirements:
- authenticated exact-user binding
- re-authentication / recent-auth requirement where appropriate
- exact workspace/ownership handling
- do not delete another user's workspace/data
- explicitly handle multi-member workspace edge cases
- revoke/disable posting capability before destructive deletion where needed
- clean or revoke X posting credentials/Vault references safely
- define what happens to scheduled posts/history/logs
- define idempotency/retry behavior
- audit/log outcome without secrets
- fail closed on partial/ambiguous state

Prefer an Edge Function / server-side privileged boundary over exposing service_role or privileged DML to the client.

No production deploy.

## Scope D — source-only candidate implementation

If the deletion architecture is clear and can be implemented safely:
- add source-only server boundary
- add client request flow with explicit confirmation
- do not actually execute against production
- add tests using local/fake/disposable data

If the schema/ownership contract is not clear enough:
- do not force an implementation
- produce a precise blocker report and only implement the non-destructive UX/config pieces

## Scope E — privacy/terms config

Create a safe configuration layer for:
- privacy policy URL
- terms URL
- support URL/contact

Validation:
- https only for web URLs
- no secrets
- invalid/missing => unavailable, never guessed
- operator diagnostics may show status codes/booleans, not sensitive values

Do not write policy text unless an existing canonical policy exists in repo/project sources.

## G4 separation

Do not modify:
- post body/edit backend
- post detail interaction
- dispatcher RPCs
- post execution logs access
- posting retry/regenerate/approve UI

If overlap is unavoidable, STOP and report exact file/reason.

## Tests

Add focused tests for:
- config validation
- account deletion exact-user binding
- reauth/recent-auth gate if implemented
- multi-member workspace denial/handling
- posting authority/credential cleanup ordering
- idempotent repeated deletion request
- no raw token/secret exposure
- no cross-user/cross-workspace deletion
- truthful unavailable UI when backend/config missing

Run:
- full social-mobile tests
- data-view tests
- typecheck
- lint
- Expo web + iOS export
- relevant Edge/DB tests if candidate backend added
- git diff --check
- secret scan

## Production constraints

Do NOT:
- delete a real user
- delete production data
- deploy deletion Edge Function
- mutate production DB/RLS/RPC/Auth
- change provider console config
- change redirect allowlist/SMTP
- make a real X post
- expose service_role

production_mutation=0.

## Review policy

- If only UI/config/docs changes are made and no new privileged deletion boundary is introduced: no automatic independent review.
- If a new account-deletion Edge/RPC/privileged data boundary is added: independent review is mandatory before merge/deploy.
- Codex capacity is constrained; use a separate-room Claude **Opus5.5（高）** reviewer in an independent worktree first.

## Completion / K3

Report:
- release compliance inventory
- account/security UX changes
- privacy/terms/support config design
- exact deletion architecture
- whether deletion backend candidate was implemented
- data cleanup/retention assumptions explicitly marked
- changed_files
- tests
- production_mutation=0
- G4 overlap
- whether independent review is actually required
- recommended next release step

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.
