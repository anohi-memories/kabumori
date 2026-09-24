# Codex Task 2

- task_id: kabumori-pr21-branding-eas-preflight-final-review-20260924
- owner: codex
- slot: codex-2
- status: ready
- next_owner: codex
- priority: medium
- recommended_model: Luna（高）
- purpose: K1 PASS済みPR #21を、Expo identity安全性・production env preflight・release-readiness記述の正確性の観点で軽量独立レビューする。原則review-only、必要ならPR #21範囲の最小修正のみ。

## Target

PR #21
- branch: `claude1/release-branding-eas-preflight`
- reviewed implementation head: `db5143fe399df25902739f4c60a07af712c3743a`
- state: open / unmerged

## Review scope

1. Fresh fetch origin/main and PR #21.
2. Confirm no unreviewed semantic drift.
3. Verify `expo.name -> かぶモリ` does not alter:
   - slug
   - scheme
   - ios.bundleIdentifier
   - EAS projectId/linkage
   - Auth/recovery deep-link behavior.
4. Audit `scripts/verify-production-env.mjs`:
   - exact required variables
   - validation correctness
   - no secret logging
   - no remote mutation
   - fail-closed behavior
   - consistency with app's own URL normalization.
5. Review documented claim that missing Supabase public env values crash at launch.
6. Verify A1/A1b icon/splash/AnimatedSplashOverlay findings against source.
7. Confirm no official Kabumori artwork was overlooked in-repo.
8. Verify RELEASE_READINESS.md does not overstate source-complete status.
9. Re-run focused tests/checks.

## Required checks

- relevant app/release tests
- production-env verifier tests
- src TypeScript if feasible
- Expo config/export smoke if feasible
- git diff --check
- production mutation=0

## Fix policy

If concrete issue found:
- only minimal changes inside PR #21 files/tests/docs
- do not generate artwork
- do not touch G2/report files
- do not touch X/admin/MIC files
- do not deploy or mutate EAS/Netlify/Supabase/App Store settings

## Forbidden

- merge PR #21
- EAS production build
- EAS remote env mutation
- Netlify deploy/domain mutation
- Supabase Auth/SMTP change
- App Store Connect/TestFlight action
- DB/migration changes

## Completion / C2

Report:
- verdict PASS / PASS-WITH-FIX / FAIL
- fresh main + PR head
- findings by severity
- identity/linkage assessment
- env preflight assessment
- icon/splash/A1b factual assessment
- exact changed files if any
- tests/checks
- whether PR #21 is safe to merge
- remaining operator actions
- production mutation=0

When complete:
- status -> review_required
- next_owner -> chatgpt
- update .agent/CODEX_REPORT_2.md
- STOP for C2.
