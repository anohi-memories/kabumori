# Claude Task 3

- task_id: x-social-mobile-auth-release-readiness-phase3-20260928
- owner: claude
- slot: claude-3
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Opus5.5（高）
- purpose: mainへmerge済みのmulti-provider Auth Phase 2を土台に、アプリ公開前に必要なAuth/アカウント設定のリリース準備を進める。production provider設定そのものは変更せず、実機E2Eへ進めるためのsource/UI/config validation/運用手順を完成させる。

## Source / accepted state

- accepted PR #47 head: `ed5f8b7890e538593dba369dd85cb99a12b27242`
- merged main: `fbddef2535b82bf4775c2e4fddb93eeefb8c638a`
- Final C1: PASS-WITH-FIX
- no further H1 review required absent a concrete discrepancy

## Mandatory startup

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - latest relevant C1/H1 Auth report
2. Use an independent G3 worktree/checkout.
3. Fresh fetch `origin/main`; branch from current accepted main.
4. Read current Supabase/Auth/Expo documentation/skill as needed.
5. Confirm no overlap with G4. G4 owns posting/schedule/history/post-detail interaction work.
6. Stop if a required change would touch G4-owned files or production Auth/provider configuration.

## Product goal

A normal user should be able to understand and manage:
- how they sign in
- which login providers are available
- which providers are still setup-pending
- how password recovery works
- how to add/link another login method
- whether X login and X posting connection are separate
- what action is needed when a provider is not production-ready

Do not fake provider readiness.

## Scope A — Auth/account settings UX

Inventory the current account/login-methods/settings screens and implement the narrow missing UX needed for release readiness.

At minimum:
- show current signed-in identity/email safely
- show linked login methods from authenticated Supabase identity state
- clearly distinguish:
  - X login method
  - X posting-account connection
- expose password recovery entry where appropriate
- expose explicit provider-linking entry only where the Phase 2 safe path already exists
- show provider unavailable/setup-pending states truthfully
- never display provider access/refresh tokens
- never use user_metadata as authorization

Do not add unlink unless the backend/product contract is already safe and explicit. If not, leave it out and report.

## Scope B — App/deep-link configuration readiness

Audit source config for:
- app scheme
- auth callback route
- password recovery callback
- PKCE `sb_flow_id`
- iOS bundle identifier requirement
- Apple native login/linking requirements
- Google/X browser OAuth redirect assumptions
- email confirmation/recovery redirects

Implement only source/config validation that is safe without touching production consoles.

Requirements:
- fail closed when required build config is missing
- no fake “ready” status
- clear diagnostics suitable for operator/development use without exposing secrets
- no hard-coded production secret/client secret

If an exact bundle identifier or external console value cannot be derived safely, do not invent it; document the operator gate.

## Scope C — Release-readiness diagnostics

Create a small deterministic readiness layer that can answer, per provider:
- enabled in Supabase: yes/no/unknown
- required local build config present: yes/no
- source path implemented: yes/no
- real-device E2E verified: false unless actually verified
- usable now: yes/no

Keep “configured” separate from “verified”.

UI may present a user-friendly version, while detailed diagnostics stay developer/operator-only.

## Scope D — E2E execution checklist

Update docs with exact future manual gates for:
- Email signup/login
- email confirmation
- password recovery
- X app login
- Google login
- Apple login
- explicit provider linking
- user-switch/recovery negative cases
- simultaneous PKCE flows
- X login != posting-X confirmation

For each gate include:
- prerequisite config
- exact user action
- expected result
- failure/rollback observation
- whether it mutates production configuration

No production console mutation in this task.

## Preserve accepted Auth boundaries

Do not regress:
- provider-link URL provenance validation
- duplicate callback shared real outcome
- strict `sb_flow_id` handling
- neutral email-signup enumeration behavior
- provider credentials stripped from persistence/context
- exact-user/session recovery binding
- strict callback parsing
- exact-user onboarding isolation
- fail-closed provider readiness
- X login != posting-X/Vault
- Apple nonce behavior
- no client service_role
- no name/handle merge
- no raw provider/server error leakage

## File ownership / G4 separation

G3 may own:
- auth/provider/session/login-method/account-security related files
- auth callback/deep-link config helpers
- app config validation needed for Auth
- Auth docs/tests

G3 must NOT edit G4-owned posting interaction surfaces unless strictly unavoidable:
- posting draft/editor/approval UI
- schedule/history/post detail interaction flow
- retry/post action UI
- posting preview/regenerate components

If overlap is needed, STOP and report exact file/reason.

## Tests

Run and preserve:
- full `apps/social-mobile` test suite
- data-view tests
- typecheck
- lint
- Expo web export
- Expo iOS export
- git diff --check
- added-line/new-file secret scan

Add focused tests for any new readiness/account settings logic.

## Production constraints

Do NOT:
- enable/disable Supabase Auth providers
- edit redirect allowlist
- change SMTP/templates
- edit Apple/Google/X developer consoles
- add production secrets
- deploy production Auth changes
- apply DB migrations
- activate Stage 3B
- make a real X post

production_mutation=0.

## Review policy

Do not request Codex review automatically.
This is source/UI/config-readiness work after a completed Auth boundary review.

If a genuinely new high-risk Auth/security boundary is introduced, report it at K3.
If independent review is needed while Codex capacity is constrained, recommend a separate Claude review first.

## Completion / K3

Report:
- exact branch/head
- user-facing account/Auth UX added
- provider readiness model
- app/deep-link config findings
- exact remaining operator/console gates
- changed_files
- tests
- production_mutation=0
- any G4 overlap
- whether any new high-risk boundary was introduced
- recommended next release step

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.
