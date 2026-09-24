# Claude Task 1

- task_id: kabumori-release-pr18-merge-postmerge-verify-20260924
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（高）
- purpose: K1実装PASS + H1/C1レビューPASS済みのPR #18を、fresh mainとの競合とreviewed headの一致を確認したうえでmainへmergeし、post-merge検証を行う。

## Accepted review state

- PR #18 current reviewed head: `6f3277639bc19fb1f420cd0e771c1d77f6d23519`
- H1 result: PASS after minimal privacy/data-flow corrections
- focused review tests: 17 passed / 0 failed
- production mutation: 0
- no remaining P1/P2 finding in scope

## Hosting policy

- Kabumori native: Expo/EAS/TestFlight/App Store
- Kabumori Web Preview: Netlify
- Kabumori Web Production: Netlify
- Vercel is not used for Kabumori Web
- therefore Vercel build-rate-limit failure must not block this merge

## Mandatory startup

1. Use independent worktree/checkout.
2. Read PROJECT_RULES.md, .agent/ORCHESTRATION.md, .agent/CURRENT_STATE.md, this TASK, and H1/C1 report.
3. Fresh fetch origin/main.
4. Fetch PR #18 and verify head remains exactly `6f3277639bc19fb1f420cd0e771c1d77f6d23519`.
5. Compare PR #18 against fresh main.
6. Confirm no semantic conflict or unexpected overlap with G2/PR #19.
7. If reviewed head changed or semantic conflict exists, STOP and report; do not auto-resolve legal/privacy semantics.

## Merge

If clean:
- merge PR #18 into main pinned to reviewed head
- do not retry or configure Vercel
- do not deploy Netlify
- do not change DNS/Auth/SMTP/EAS/App Store Connect

## Post-merge verification

On fresh origin/main after merge:
- PR #18 is merged/closed
- reviewed legal/public Web files are present
- native legal links point through centralized config
- eas production autoIncrement is present
- no unrelated G2 report files changed through merge

Run appropriate checks:
- focused public-web/legal-links/settings tests
- git diff --check
- TypeScript/static check if dependencies permit
- local public Web build with dummy operator values
- Expo export smoke if possible without production secrets

## Forbidden

- Netlify production deploy
- DNS mutation
- Supabase Auth config
- SMTP config
- EAS production build
- TestFlight/App Store submission
- DB/migration changes
- G2/PR #19 edits
- X/admin/MIC work

## Production mutation budget

0, excluding normal GitHub merge.

## Completion / K1

When complete:
- status -> review_required
- next_owner -> chatgpt
- Report must include:
  - fresh main before merge
  - verified reviewed head
  - drift/conflict result
  - merge result + merge SHA
  - post-merge main SHA
  - exact checks/tests
  - confirmation Vercel ignored per Kabumori hosting policy
  - production mutation=0
  - remaining release blockers
  - recommended next G1 release task
- STOP for K1.
