# Claude Task 1

- task_id: kabumori-pr21-merge-postmerge-verify-20260924
- owner: claude
- slot: claude-1
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（高）
- purpose: K1実装PASS + H2/C2 PASS-WITH-FIX済みのPR #21を、fresh mainとの競合・reviewed head一致を確認したうえでmergeし、post-merge検証を行う。

## Accepted review state

- PR #21 original K1 head: `db5143fe399df25902739f4c60a07af712c3743a`
- H2 fix/reviewed head: `0a71f0882136aa8930cf0572033e1a0ba28c0760`
- H2 verdict: PASS-WITH-FIX
- focused verifier tests: 8/8 PASS
- scoped suite: 116/116 PASS
- production mutation: 0

## Accepted fixes

1. Production env preflight publishable-key validation hardened.
2. App Store listing name vs `expo.name` documentation corrected.
3. AnimatedSplashOverlay wording corrected to normal startup scope.

## Mandatory startup

1. Use independent worktree/checkout.
2. Read PROJECT_RULES.md, .agent/ORCHESTRATION.md, .agent/CURRENT_STATE.md, this TASK, H2/C2 report.
3. Fresh fetch origin/main.
4. Fetch PR #21 and verify head remains exactly `0a71f0882136aa8930cf0572033e1a0ba28c0760`.
5. Compare PR #21 with fresh main.
6. Confirm no overlap/conflict with G2 personalized-reports rollout work.
7. If reviewed head changed or semantic conflict exists, STOP and report.

## Merge

If clean:
- merge PR #21 pinned to reviewed head
- do not production build
- do not mutate EAS remote env
- do not deploy Netlify
- do not change Supabase/Auth/SMTP/App Store Connect

Vercel is not a Kabumori native merge gate.

## Post-merge verification

On fresh origin/main:
- PR #21 merged/closed
- `expo.name` is 「かぶモリ」
- slug/scheme/bundleIdentifier/projectId unchanged
- production-env preflight exists
- H2 key-validation fix is present
- RELEASE_READINESS wording is the reviewed version
- no icon/splash/overlay artwork changed
- no G2 report files changed

Run as feasible:
- verifier tests
- relevant app/release tests
- src TypeScript
- Expo config/export smoke
- git diff --check

## Forbidden

- production EAS build
- TestFlight/App Store submission
- EAS remote env mutation
- Netlify deploy/domain mutation
- Supabase Auth/SMTP mutation
- DB/migration changes
- artwork generation
- G2 personalized-reports changes
- X/admin/MIC work

## Production mutation budget

0, excluding normal GitHub merge.

## Completion / K1

When complete:
- status -> review_required
- next_owner -> chatgpt
- Report:
  - fresh main before merge
  - verified reviewed head
  - drift/conflict result
  - merge SHA
  - post-merge main SHA
  - exact tests/checks
  - identity/linkage confirmation
  - no artwork change confirmation
  - production mutation=0
  - remaining release blockers
  - recommended next G1 task
- STOP for K1.
