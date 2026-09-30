# Claude Task 3

- task_id: x-social-mobile-native-data-source-and-delete-ux-fix-20260930
- owner: claude
- slot: claude-3
- status: ready
- next_owner: claude
- priority: critical
- recommended_model: Sonnet5（高）
- purpose: Stage 2 E2Eで見つかったrelease blockers D1-D3をsource-onlyで修正し、ネイティブE3再開可能な状態にする。

## Accepted Stage 2 result
- E1 PASS
- E2 PASS
- E4 PASS
- E5 PASS
- E3 BLOCKED
- existing real users/accounts were not touched
- deletion feature remains OFF

## D1 — native data source selection
Fix the native Expo data-source selection so production/release native builds do not silently fall back to mock when the intended public data-source env is set.

Requirements:
- use Expo-compatible static public env access consistent with the existing Supabase env pattern
- make repository-selection and data-provider agree on the same source
- preserve explicit mock mode for development/tests
- fail truthfully/safely for invalid or missing configuration; do not silently pretend real data is available
- do not change Supabase project, Auth, RPC, migration, Edge Function, OAuth backend, or production settings

## D2 — account deletion completion UX
- web must visibly confirm successful account deletion/social-only deletion before or while returning to login/onboarding
- do not rely only on React Native Alert for web
- preserve native behavior and existing deletion protections

## D3 — signup feedback
- web signup must show a truthful acknowledgement/in-progress/success state so repeated clicks are discouraged
- prevent accidental duplicate submission while a signup request is in flight
- do not claim email was sent unless the request actually succeeded

## Tests
Add/update tests proving:
- native production-style env selects real repository when configured
- native mock mode still works explicitly
- invalid/missing config behaves safely
- repository-selection and provider cannot disagree
- web delete completion feedback is visible
- signup has visible state + duplicate-submit protection
- existing Auth/onboarding/deletion tests remain green
- typecheck/lint
- Expo web+iOS export
- git diff --check
- secret scan

## Production constraints
No production deploy/config mutation.
No real X post/revoke.
No real user deletion.
Do not run E3 in this task.
production_mutation=0.

## Completion / K3
Report PASS/FAIL, changed_files, D1-D3 behavior, tests, commit/push/PR, production_mutation=0, and whether native E3 can resume.
Then status -> review_required, next_owner -> chatgpt, STOP for K3.
