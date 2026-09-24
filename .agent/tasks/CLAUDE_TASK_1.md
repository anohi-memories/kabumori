# Claude Task 1

- task_id: kabumori-mobile-recovery-pr17-merge-and-postmerge-verify-20260924
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（高）
- purpose: K1 PASS + C1 Auth/security review PASS済みのPR #17を、fresh mainとの競合・意味差分を確認したうえでmainへmergeし、main上で回帰確認を行う。かぶモリnativeアプリPRのためVercel checkはmerge blockerとして扱わない。

## Review handoff

G1/K1:
- real iPhone recovery deep-link PASS
- password reset PASS
- new-password re-login PASS
- in-app account deletion PASS
- disposable account cascade PASS

H1/C1:
- result: PASS
- one P2 classifier issue was found and minimally fixed
- reviewed PR head: `b3798aa6be82b6a29d8d2dcf21ca27fb19ef5f50`
- 98 tests PASS / 0 fail
- mobile src TypeScript: 0 errors
- Expo web export: PASS / 10 routes
- git diff --check: PASS
- no auth/session weakening
- no token/password logging or persistence
- production mutation: 0
- C1 assessment: PR #17 is safe to merge from Auth/security perspective

## Kabumori hosting policy — mandatory

Kabumori native app:
- Expo / React Native
- EAS / TestFlight / App Store
- Backend: Supabase
- real-device verification: iPhone
- Vercel is not used for normal native-app development

Kabumori future Web:
- Preview: Netlify
- Production: Netlify
- Vercel is generally not used

Therefore:
- do NOT wait for or retry Vercel for PR #17
- Vercel deployment-rate-limit failure is irrelevant to this native PR's merge decision
- do not create a Netlify Expo Web Preview as part of this task

## Mandatory startup

1. Use an independent worktree/checkout.
2. Read `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK, and H1 C1 report.
3. Fresh fetch `origin/main`.
4. Fetch/read PR #17 and verify head is still `b3798aa6be82b6a29d8d2dcf21ca27fb19ef5f50` unless a newer explicitly reviewed head exists.
5. Compare PR #17 against fresh main.
6. Confirm no overlapping changes in:
   - `src/app/+native-intent.tsx`
   - `src/lib/password-recovery.ts`
   - `tests/app/recovery-routing_test.ts`
7. If semantic conflict or unreviewed change exists, STOP and report it. Do not auto-resolve an Auth/security semantic conflict.

## Merge

If fresh checks are clean:
- merge PR #17 into main using the verified reviewed head
- Vercel check failure must not block this native merge
- do not trigger or modify Vercel configuration
- do not deploy any Web application

## Post-merge verification

After merge, fresh-fetch/read `origin/main` and verify:
- PR #17 is merged/closed
- the three reviewed source/test files match the accepted reviewed content
- no unrelated mobile/Auth source was changed by the merge

Run on merged main:
- `deno test --no-check --no-lock --allow-read tests/app/ supabase/functions/account-delete/`
- mobile `src/` TypeScript check
- `git diff --check`
- appropriate Expo route/export smoke check if it can be run without production secrets

Do not repeat destructive real-device account E2E unless a new regression is found. The full real-device E2E was already accepted by K1.

## Forbidden

- Vercel retry/bypass/config changes
- Netlify setup
- Supabase Auth Site URL changes
- SMTP/email-template changes
- DB migration/RPC/DDL/DML
- account-delete Edge Function changes
- unrelated app feature changes
- X/admin/MIC work
- production user mutation
- new disposable account creation

## Production mutation budget

0, excluding the normal GitHub merge itself. No backend/config/deploy mutation.

## Completion / K1

When complete:
- status -> review_required
- next_owner -> chatgpt
- append Report with:
  - fresh main SHA before merge
  - verified PR head
  - conflict/drift findings
  - merge result + merge SHA
  - post-merge origin/main SHA
  - exact tests/counts
  - post-merge file verification
  - Vercel explicitly ignored as irrelevant to native merge
  - production/backend mutation=0
  - remaining release blockers outside this PR:
    - custom SMTP
    - reachable Auth confirmation/recovery redirect/Site URL
    - privacy / terms / support Web URLs
- STOP for K1.
