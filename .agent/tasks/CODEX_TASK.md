# Codex Task

- task_id: x-social-mobile-auth-phase2-final-acceptance-review-20260928
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: critical
- recommended_model: Sol（高）
- purpose: PR #47 fixed headの最終Auth受け入れ確認。前回H1で再現した7件＋追加3件の修正だけをfocused regressionで確認し、merge可否を確定する。新しい広範レビューや別設計への拡張はしない。

## Review target

- PR #47 exact fixed head: `5fd483a5fc651da07d0791c68eaa557cdb201357`
- previous failed head: `7bda196147a749431774fba915a86d41bf43dc5d`

## Required focus

Reproduce/verify only these corrected boundaries:

1. provider linking accepts only valid expected external provider auth URLs and rejects malicious/unexpected URLs.
2. duplicate callback delivery shares the actual in-flight success/failure result; no false success.
3. `sb_flow_id` is preserved, strictly validated and passed to `exchangeCodeForSession`; concurrent/stale/malformed/mismatched flows fail safely.
4. email signup no-session UX does not enumerate existing accounts.
5. provider access/refresh credentials are not persisted in plaintext storage/context; Supabase app session restore still works.
6. password recovery is bound to exact user/session/flow and invalidates on incompatible user/session switch.
7. callback parser rejects malformed authority, userinfo/port, duplicate/conflicting credential params and posting callback.
8. new-account/onboarding state is exact-user scoped and survives interruption until explicit acknowledgement where appropriate.
9. provider/email readiness fails closed when provider/build config is missing; no fake ready state.
10. Apple linking path/config distinction is internally consistent.
11. X app-auth remains strictly separate from posting X `x-oauth-connect-user` + Vault path.
12. no service_role, user_metadata authorization, provider-token logging or posting-token exposure.

## Mandatory startup

- read `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK, latest G3 Report and previous H1 report section.
- independent H1 worktree.
- fresh fetch `origin/main` and exact PR #47 head.
- read current Supabase skill.
- check only current docs necessary to validate the above semantics.

## Verification

- inspect `7bda196..5fd483a` correction diff.
- run existing new Auth tests, including SDK behavior tests.
- recreate prior H1 negative probes where still useful.
- run:
  - `npm test`
  - data-view tests
  - typecheck
  - lint
  - Expo web + iOS export
  - git diff --check
  - source/secret/token scan
- verify mutation coverage where practical.

## Fix policy

- If a small, obvious source defect remains directly within one of the listed corrected boundaries, H1 may fix it on PR #47 and retest.
- If a design-level or new unrelated issue appears, report and STOP.
- Do not broaden review scope.

## Production constraints

- no provider console changes
- no redirect allowlist change
- no SMTP/template changes
- no Apple/Google/X console changes
- no DB migration
- no Stage 3B activation
- no real X post
- production_mutation=0

## Completion / C1

Report:
- PASS / PASS-WITH-FIX / FAIL
- exact reviewed/fixed PR #47 head
- prior 7 findings status
- additional 3 gaps status
- test results
- any source fix
- production_mutation=0
- whether PR #47 is ready to merge
- remaining real-device/provider-console gates only

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for C1.
