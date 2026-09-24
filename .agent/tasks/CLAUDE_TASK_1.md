# Claude Task 1

- task_id: kabumori-pr21-merge-postmerge-verify-20260924
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
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

## Report — G1 result

- task_id: kabumori-pr21-merge-postmerge-verify-20260924
- result: **PR #21 merged and verified on main.** Production mutation = 0.
- workspace: a fresh independent clone.

### Pre-merge

- fresh main before merge: `6fb1861` (in_progress control commit on `25e1d89`)
- verified PR head: exactly **`0a71f0882136aa8930cf0572033e1a0ba28c0760`**, matching the H2/C2-reviewed head.
- PR contents vs my original `db5143f`: H2's fix `0a71f08` touches `docs/mobile-release/RELEASE_READINESS.md`, `scripts/verify-production-env.mjs`, `tests/app/verify-production-env_test.ts`. Read in full:
  1. **Publishable-key validation hardened** — the previous "length ≥ 20" check would have accepted a pasted-in-by-mistake `service_role` secret key. It now accepts only `sb_publishable_...` or a legacy anon JWT (decoded and checked for `role: "anon"`), and explicitly rejects `sb_secret_...` and `service_role` JWTs. Correct and meaningfully tightens the check.
  2. **App Store listing name clarified** as separate from `expo.name` (the home-screen label), with a new checklist item to set the localized App Store product name to 「かぶモリ」.
  3. **A1b wording corrected**: the overlay renders during normal startup (after auth loading, when no recovery-link route takes precedence), not literally "every launch" — a more precise description of `src/app/_layout.tsx`'s actual control flow. A2's wording was also sharpened.
  - No change weakens anything; all three are factual corrections/hardenings.
- **Drift:** main since PR21's original base `39ea79e` gained G2's personalized-reports/report-impact rollout (`report_logic.ts`, `market_detail.ts`, `report-impact_test.ts`, etc.) and X-autopost Phase 1E credential-reader files. **All of that was already on main before this merge task started** — `git diff --name-only 6fb1861 origin/main` (excluding `.agent/*`) was empty, so there was no *new* drift during this task, and none of it overlaps PR21's 5 files.
- merge state: `MERGEABLE` / `UNSTABLE` (the same pre-existing Vercel rate-limit failure, not a Kabumori native/Web merge gate).

### Merge

- `gh pr merge 21 --merge --match-head-commit 0a71f0882136aa8930cf0572033e1a0ba28c0760`
- merge commit / post-merge `origin/main`: **`0d4ebad98a5a25e300f766600231eb60b36e5c07`**, mergedAt 2026-09-24T14:04:34Z. PR #21 state: MERGED.

### Post-merge verification (on `0d4ebad`)

- `git diff 0a71f08 0d4ebad` over the 5 PR files is **empty**: byte-identical to the H2-reviewed content.
- `git diff --name-only 6fb1861 0d4ebad` (excluding `.agent/*`) lists exactly those 5 files. No G2 report file was touched by this merge.
- **Identity/linkage confirmation:** `app.json` → `name: "かぶモリ"`, `slug: "kabumori"`, `scheme: "kabumori"`, `ios.bundleIdentifier: "com.anohimemories.kabumori"`, `extra.eas.projectId: "eb80adf3-861e-4a48-a373-2d9a85b58899"` — only `name` changed; everything else identical to before.
- **No artwork change confirmation:** `git diff --stat` from before this whole branding workstream (`25e1d89`) over `assets/` is empty, and `src/components/animated-icon.tsx` is unchanged. No icon, splash or overlay asset/source was touched.
- `deno test --no-check --no-lock --allow-read --allow-write --allow-env tests/app/ supabase/functions/account-delete/ apps/kabumori-web/build_test.ts`: **122 passed / 0 failed** (116 from this PR's scope + 6 from G2's `report-impact_test.ts`, already on main before this merge).
- `npx tsc --noEmit`, `src/` scope: **0 errors**
- `npx expo export --platform web`, dummy non-secret env: **PASS, 10 static routes (unchanged)**
- `node scripts/verify-production-env.mjs` with no env set: exits 1, reports all three variables missing — confirms the hardened script ships correctly on main.
- `git diff --check`: PASS

### Production mutation = 0

No EAS remote env/secret change, no Netlify deploy, no Supabase Auth/SMTP config, no App Store Connect action, no DB/migration change, no production build. Only the ordinary GitHub merge.

### Remaining release blockers (unchanged, now on merged main)

1. Kabumori icon, splash, and launch-overlay artwork (specs in `RELEASE_READINESS.md` §4 item 1) — still no artwork exists in the repo.
2. Decide whether to keep the separate iOS Icon Composer asset (`assets/expo.icon`) once real artwork exists.
3. EAS production environment variables (`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `EXPO_PUBLIC_KABUMORI_WEB_URL`) — verify locally first with `npm run verify-production-env`.
4. Operator legal values (`KABUMORI_OPERATOR_NAME`/`KABUMORI_SUPPORT_EMAIL`/`KABUMORI_POLICY_EFFECTIVE_DATE`) and Netlify publication of `apps/kabumori-web`.
5. Supabase Auth Site URL/redirect, custom SMTP, App Store Connect setup (including the newly-noted separate App Store listing-name field), `submit.production`, export-compliance declaration, EAS build → TestFlight → submission.

**New observation (not a blocker to this merge, flagged for K1's awareness):** G2's personalized-reports rollout already on main (`report_logic.ts`, new `market_detail.ts`) landed after PR #18's privacy-page audit. `RELEASE_READINESS.md` already carries the note "If the report generator changes what it sends, the privacy table must be updated in the same PR" — that note was not honored by G2's merge, since G2's scope was reports, not the privacy page. **Recommend a follow-up G1 task to re-audit `apps/kabumori-web/pages/privacy.html`'s OpenAI data-flow claims against the current `report_logic.ts`/`market_detail.ts`**, since the privacy page's factual accuracy is a real App Store/legal concern and G2's change may have added new data sent to OpenAI (e.g. `market_detail.ts` is new, 213 lines). This task did not read those files' current contents in detail, since they are outside this merge-only task's scope and are G2-owned; I flag it rather than assume either way.

### Recommended next G1 task

1. **Privacy-page re-audit** against G2's current `report_logic.ts`/`market_detail.ts` (see above) — should happen before Netlify publication, since publishing an inaccurate privacy policy is worse than not publishing yet.
2. Once the operator provides artwork and the three `KABUMORI_*`/domain values: wire icon/splash/overlay and publish Netlify, as two source-only steps (still no production build in either).
