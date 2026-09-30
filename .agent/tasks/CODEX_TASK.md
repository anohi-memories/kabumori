# Codex Task

- task_id: x-social-mobile-pr63-native-data-source-auth-ux-review-20260930
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: high
- recommended_model: Luna（高）
- target: PR #63 head `5f2eae26bb1ee60c2bd7c7885c06816e86e8d852`

## Purpose

Focused pre-merge review of the Stage 2 release-blocker fixes for native real-vs-mock data selection and Auth/deletion UX.

## Verify

1. Native data-source selection
- Expo public env values are accessed in a bundle-safe static form
- intended `supabase` mode selects the real repository on native
- explicit preview/mock remains available
- invalid or incomplete configuration blocks truthfully instead of silently falling back to mock
- repository selection and provider initial state cannot disagree
- no production-only secret/service_role is exposed

2. Account deletion completion UX
- web gets visible truthful completion feedback after confirmed deletion
- full deletion vs social-only deletion wording matches actual behavior
- failure does not show false success
- native behavior remains intact
- recent-auth, typed confirmation, exact user/session pinning and deletion backend are unchanged

3. Signup feedback
- duplicate same-tick submission is prevented
- success message appears only after actual success
- cooldown cannot falsely mask failure
- accessibility/status behavior is reasonable
- no Auth policy/provider behavior was changed

4. Scope / regressions
- no DB/RLS/RPC/migration/Edge/Vault/X/Apple/production setting change
- no overlap with G3 account-deletion backend ownership beyond UI/data-selection source
- tests are sufficient for the changed boundaries
- Expo web/iOS export remains valid
- no secret leakage

## Production

No deploy, no real X connect/revoke, no real user deletion, no provider mutation.
production_mutation=0.

## Completion / C1

Report PASS/FAIL, exact reviewed head, findings/fixes if any, tests, cross-platform data-source behavior, Auth/deletion UX safety, and whether PR #63 is safe to merge so native E3 can resume.


## H1 result — 2026-09-30

- result: PASS on exact PR #63 head `5f2eae26bb1ee60c2bd7c7885c06816e86e8d852`; source merge is safe; production mutation 0.
- Full findings and verification are in `.agent/CODEX_REPORT.md` under this task_id.
- next_owner: chatgpt (C1).
