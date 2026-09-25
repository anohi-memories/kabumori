# Claude Task 1

- task_id: kabumori-pr31-icon-merge-postmerge-verify-20260925
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
- priority: medium
- recommended_model: Sonnet5（中）
- purpose: K1 PASS済みPR #31をfresh main確認後にmergeし、承認済みアイコンがmain上で正しく参照されることをpost-merge検証する。EAS/TestFlightはまだ実施しない。

## Accepted K1 state

PR #31:
- branch: `claude1/approved-app-icon-integration`
- reviewed head: `8939ce9f2f829cbfb042cadd92760f4e67ce8cc9`
- mergeable: true
- changed files:
  - `assets/branding/kabumori-icon-master-2026-09-25.png`
  - `assets/images/icon.png`
  - `app.json`
  - `tests/app/app-icon_test.ts`

Approved asset:
- source: user-approved `アイコン.png`
- source 1254x1254 RGB opaque
- sha256 `31eda5379951b3d8f69676add4add33ecea6d799a48545ef076bd6235949a3f8`
- derived app icon 1024x1024 RGB opaque
- no redraw / recolor / AI regeneration

Verified before K1:
- 126/126 tests
- src TypeScript 0
- expo config resolves icon + ios.icon to `./assets/images/icon.png`
- real expo prebuild produced matching 1024x1024 no-alpha AppIcon
- Expo web export 10 routes
- git diff --check PASS
- Splash / AnimatedSplashOverlay / expo-logo untouched
- production mutation 0

## Mandatory startup

1. Independent worktree.
2. Read PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / this TASK.
3. Fresh fetch origin/main and PR #31.
4. Verify PR head exactly `8939ce9f2f829cbfb042cadd92760f4e67ce8cc9`.
5. Confirm no semantic drift or file conflict.
6. Confirm G2 still only touches personalized-reports.
7. If PR head changed or non-trivial conflict exists, STOP.

## Merge

If unchanged and conflict-free:
- merge PR #31
- fresh fetch main
- record merge SHA

## Post-merge verification

On merged main verify:
- exact master asset exists
- `assets/images/icon.png` is 1024x1024, opaque, no alpha
- `expo.icon` and `expo.ios.icon` point to `./assets/images/icon.png`
- Expo template icon path is no longer referenced by app icon config
- Splash config unchanged
- AnimatedSplashOverlay source unchanged
- `assets/images/expo-logo.png` unchanged
- bundleIdentifier / slug / scheme / projectId unchanged
- G2/personalized-reports files untouched

Run:
- app/icon tests
- scoped app/release tests
- src TypeScript
- `npx expo config --json`
- Expo prebuild validation if safe/clean
- Expo web export
- git diff --check

Clean any generated native/prebuild artifacts before completion.

## Forbidden

- EAS build
- TestFlight upload
- App Store Connect mutation
- credentials/env mutation
- Splash/overlay changes
- production deploy
- DB/Supabase/X/admin/MIC changes

## Completion / K1

Report:
- fresh main before merge
- verified PR head
- conflict/drift result
- merge SHA
- post-merge test results
- icon config read-back
- asset dimensions/alpha
- Splash/overlay unchanged
- production mutation=0
- whether repo is ready for separately authorized iPhone/TestFlight build

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K1.
