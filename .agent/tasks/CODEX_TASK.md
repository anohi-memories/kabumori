# Codex Task

- task_id: x-social-mobile-auth-phase2-final-acceptance-review-20260928
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
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

## H1 final acceptance — 2026-09-28

- **PASS-WITH-FIX**. Initial fixed head `5fd483a5fc651da07d0791c68eaa557cdb201357`; accepted PR #47 head after the permitted small H1 correction: `ed5f8b7890e538593dba369dd85cb99a12b27242`.
- Prior seven findings and three continuation/readiness/Apple-linking gaps pass focused source acceptance. H1 tightened cached callback flow/type binding and in-flight retention, recovery-action context pinning, and provider authorize paths; added six durable regression tests.
- Final mobile tests 43/43 + data-view 14/14, typecheck/lint, Web+iOS export, diff/secret checks PASS; four H1 in-memory mutations detected. Real provider/device E2E remains a separately authorized gate.
- Source correction pushed to PR #47; final exact head read back OPEN/MERGEABLE with Vercel/Netlify Preview SUCCESS. No merge, production deploy/config/DB/OAuth/X mutation; `production_mutation=0`.
- Ready for C1 and normal source merge decision at the accepted head. Full report: latest final-acceptance section of `.agent/CODEX_REPORT.md`. STOP for C1; no further review loop without a concrete discrepancy/new assignment.


## Final C1 — Auth Phase 2 final acceptance

Verdict: **PASS-WITH-FIX**.

- accepted PR #47 head: `ed5f8b7890e538593dba369dd85cb99a12b27242`.
- H1 applied one small bounded correction commit and re-ran the focused acceptance suite.
- prior seven findings and additional onboarding/readiness/Apple-linking gaps are accepted at source level.
- final tests: mobile 43/43, data-view 14/14, typecheck/lint, Expo web+iOS export, diff/secret checks PASS.
- X app-auth remains separate from posting-X/Vault.
- provider credentials are not persisted in plaintext app storage/context under the accepted policy.
- production_mutation=0 during review.
- PR #47 merged after C1 at merge commit `fbddef2535b82bf4775c2e4fddb93eeefb8c638a`.
- remaining gates are real-device/provider-console configuration/E2E only.
