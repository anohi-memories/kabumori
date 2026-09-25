# Claude Task 1

- task_id: kabumori-branded-launch-screen-20260925
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sonnet5（高）
- purpose: ユーザー決定「かぶモリ専用の起動画面を作る」に基づき、Expoテンプレのnative splash / AnimatedSplashOverlayを、既存の承認済みかぶモリアイコンを使ったブランド起動画面へ置き換える。新しい画像生成は行わない。

## User decision

User explicitly decided:
- **dedicated Kabumori launch screen will be created**
- do not keep the Expo template launch experience
- do not generate a new AI artwork as part of this task
- use the already approved Kabumori branding/icon as the visual source for this first implementation
- final visual acceptance will happen on actual iPhone/TestFlight and can be refined later

## Approved source asset

Use only the already merged approved artwork:
- `assets/branding/kabumori-icon-master-2026-09-25.png`
- approved source sha256: `31eda5379951b3d8f69676add4add33ecea6d799a48545ef076bd6235949a3f8`
- installed icon: `assets/images/icon.png` (1024x1024, RGB opaque)

Do not redraw, regenerate, recolor, or substitute another logo.

## Goal

Replace the remaining Expo-template startup experience with a coherent Kabumori-branded launch flow:

1. native/static splash
2. in-app AnimatedSplashOverlay
3. remove Expo logo / blue-template visual references from normal app launch

The visual should be intentionally simple for the first real-device pass:
- light cream / soft warm background compatible with the approved icon
- approved Kabumori icon/logo centered
- optional text `かぶモリ` only if it improves continuity
- subtle, restrained fade/scale animation
- no busy illustration
- no new tagline unless already present in approved product copy
- no green-theme lock beyond what the approved icon naturally uses

## Mandatory startup

1. Use an independent worktree.
2. Read PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / this TASK.
3. Fresh fetch origin/main.
4. Confirm G2 remains done and personalized-reports is out of scope.
5. Confirm no G4/admin overlap.
6. Verify approved icon asset sha before editing.
7. Inspect current:
   - app.json expo-splash-screen config
   - assets/images/splash-icon.png
   - src/components/animated-icon.tsx
   - src/app/_layout.tsx
   - assets/images/expo-logo.png usage
8. If any other active slot is editing the same startup files, STOP.

## Implementation

### A. Native/static splash

Replace Expo-template splash presentation.

Preferred implementation:
- use approved Kabumori icon asset or a deterministic derivative of it
- use a light cream / warm neutral background that visually matches the icon
- preserve correct aspect ratio
- no baked rounded-corner tricks
- no Expo logo
- no blue Expo-template background

If Expo splash asset constraints require a dedicated derivative:
- derive deterministically from the approved icon/master
- no generative modification
- document exact dimensions and derivation

### B. AnimatedSplashOverlay

Replace current Expo-logo animation with Kabumori branding.

Requirements:
- use approved icon/logo source
- simple fade / slight scale / gentle reveal
- short enough that it does not make startup feel slower
- respect reduced-motion accessibility if the app already exposes it or React Native accessibility API makes this straightforward
- overlay must disappear reliably after app initialization
- no new network dependency
- no font download dependency
- no user-data dependency
- no blocking of auth/session initialization

### C. Remove template references

Normal launch must no longer render:
- `assets/images/expo-logo.png`
- Expo blue startup background
- Expo template mark

Do not delete unrelated assets if they are used elsewhere.
If `expo-logo.png` becomes truly unused, it may be removed only after confirming all references are gone.

### D. Tests

Add/update tests that assert:
- splash config references Kabumori asset
- Expo template splash asset/path is not referenced by launch config
- AnimatedSplashOverlay references Kabumori asset, not expo-logo
- no normal-launch Expo template reference remains
- approved icon/master sha is unchanged
- bundleIdentifier/slug/scheme/projectId remain unchanged

## Scope / forbidden

Allowed:
- app.json splash config
- splash asset(s)
- src/components/animated-icon.tsx
- narrowly related startup tests
- removal of truly unused Expo launch asset after reference proof

Do not touch:
- app icon itself
- personalized-reports
- Supabase
- Auth
- Netlify
- X/admin
- DB/schema/RPC
- EAS credentials
- TestFlight/App Store
- production env

Do not run a production EAS build in this task.

## Verification

Run:
- targeted startup/splash tests
- full app tests
- src TypeScript
- `npx expo config --json`
- real `expo prebuild --platform ios --no-install --clean` if safe in isolated worktree
- inspect generated iOS splash/AppIcon references
- Expo web export
- git diff --check

Clean generated native artifacts before completion if not tracked.

## Review policy

This is UI/branding/startup work.
Per reduced-review policy:
- no Codex review required unless a genuine auth/session/startup correctness risk is introduced
- if startup initialization semantics must change materially, STOP and report before doing so

## Completion / K1

Report:
- exact visual implementation
- changed files
- source asset hashes/dimensions
- animation behavior/duration
- proof Expo branding is gone from normal launch
- tests
- PR/head
- production mutation=0
- whether ready for first real-iPhone/TestFlight visual acceptance

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K1.

## Report — G1 result

- task_id: kabumori-branded-launch-screen-20260925
- result: **source-complete. PR #36 is open and unmerged.** Production mutation = 0; no EAS build was run.
- fresh main at task start: `e3ad303`; in_progress control commit `2724689`.
- G2/G3/G4 overlap: none (`personalized-reports` untouched; `.agent/CURRENT_STATE.md` shows G3/G4 both on x-autopost/admin work).
- Approved icon sha verified before editing: `assets/branding/kabumori-icon-master-2026-09-25.png` = `31eda5379951b3d8f69676add4add33ecea6d799a48545ef076bd6235949a3f8`, matching the task's stated value. `assets/images/icon.png` (the installed 1024×1024) confirmed 1024×1024, no alpha, unchanged.

### Exact visual implementation

Both phases of the launch experience now show the identical approved icon on the identical background, at the identical size — the same continuity property the Expo template had, just with Kabumori's own artwork:

- **Native splash** (`app.json` → `expo-splash-screen`): `image: ./assets/images/icon.png`, `backgroundColor: #eef3ed`, `imageWidth: 200`.
- **`AnimatedSplashOverlay`**: same icon (`require('@/assets/images/icon.png')`), same `#eef3ed` background (`SPLASH_BACKGROUND` constant), same 200×200 size (`SPLASH_ICON_SIZE` constant, kept equal to `imageWidth` on purpose so there is no size jump at handoff).
- No new text/tagline added — the icon's own illustration already contains 「かぶモリ」, so adding a separate label would have been redundant continuity, not additional continuity (the task's own qualifier: "only if it improves continuity").
- `#eef3ed` is not a new colour: it is `KABUMORI_COLORS.light.soft`/`accentSoft` and is already `auth-screen.tsx`'s own `safeArea` background, so the splash now matches the very next screen the user usually sees (the login form) instead of clashing with it the way Expo blue did.

### Animation behaviour / duration

- Exit animation: fade (`opacity 1 → 0`) + a gentle scale-down (`scale 1 → 0.94`), `Easing.out(Easing.cubic)`, **600ms** (unchanged duration from before — "does not make startup feel slower" was already true and stays true). The old bouncy `Easing.elastic(0.7)` exit is gone, replaced with a restrained ease-out, matching "subtle, restrained."
- The native-splash-hide handoff mechanics are unchanged: `onLayout` on the static phase-1 `View` still calls `SplashScreen.hideAsync()`, then decides the next phase.
- **Reduce Motion**: `AccessibilityInfo.isReduceMotionEnabled()` is read once on mount into a `useRef` (not `useState`) specifically so the decision made inside `onLayout`'s `.finally()` callback always sees the latest fetched value regardless of React re-render/closure timing. When Reduce Motion is on, the animated `Animated.View`/`entering` path is skipped entirely and the overlay hides instantly through the exact same `setVisible(false)` call the animated exit's finished-callback uses — chosen deliberately over Reanimated's own `.reduceMotion()` modifier, because I could not verify in this environment that a `reduceMotion`-disabled `entering` keyframe still reliably invokes `withCallback`'s finished callback, and an overlay that fails to disappear would be a worse outcome than one that disappears without a fade.
- No network dependency, no font download, no user-data dependency. `AuthGate`'s own `loading` gate (auth/session initialization) is architecturally separate and untouched — the overlay's removal timing does not depend on it and vice versa.

### Changed files (PR #36, branch `claude1/branded-launch-screen`, head `5b72e57`)

- `app.json` — 3 fields in the `expo-splash-screen` plugin config
- `src/components/animated-icon.tsx` — `AnimatedSplashOverlay` rewritten (asset, colour, size, easing, Reduce Motion); `AnimatedIcon` (dead code, nothing imports it) and its styles are untouched
- `tests/app/app-splash_test.ts` (new, 9 tests)
- `tests/app/app-icon_test.ts` — its now-obsolete "splash/overlay untouched" assertion (correct only for the prior, icon-only task) replaced with an identity-fields-unchanged pin
- `docs/mobile-release/RELEASE_READINESS.md` — A1/A1b marked done (source), Area F moved to READY, §4 item 1 rewritten around real-device acceptance

### Source asset hashes/dimensions

- Master (unchanged by this task): `assets/branding/kabumori-icon-master-2026-09-25.png`, 1254×1254, sha256 `31eda537…49a3f8` — re-verified, not re-copied.
- Installed icon (unchanged by this task, only newly reused as the splash image): `assets/images/icon.png`, 1024×1024, no alpha — re-verified.
- No new image file was created. The splash uses the existing 1024×1024 file directly; Expo's own `expo-splash-screen` plugin performs its native scaling to `imageWidth: 200` at prebuild time, which is exactly the same mechanism the old template config used, just pointed at a different source file and width.

### Proof Expo branding is gone from a normal launch

- `grep -rn expo-logo` and `#208AEF` inside `AnimatedSplashOverlay`'s own function body: none. (The function body was isolated with a source slice up to the next top-level `const keyframe = ...` declaration, and every assertion in `app-splash_test.ts` that checks this operates on that isolated slice, not the whole file, so it cannot accidentally pass by matching the untouched `AnimatedIcon` export below it.)
- `src/app/_layout.tsx`: contains no `expo-logo` reference (it never did directly; it only imports `AnimatedSplashOverlay`).
- A real `npx expo prebuild --platform ios --no-install --clean` regenerated the native splash assets from scratch:
  - `ios/app/Images.xcassets/SplashScreenBackground.colorset/Contents.json`: RGB `(0.9333, 0.9529, 0.9294)` = `#eef3ed` exactly.
  - `ios/app/Images.xcassets/SplashScreenLogo.imageset/image.png`: 200×200. Opened and visually confirmed it is the approved Kabumori icon (newspaper/chart/leaf/「かぶモリ」), not the Expo mark.
- `assets/images/expo-logo.png` is **not "truly unused"**, so per the task's own conditional it was not deleted: the dead, unimported `AnimatedIcon` export in the same file still references it. This is stated explicitly, not silently left ambiguous.
- `assets/images/splash-icon.png` is now unreferenced by any config but was left on disk, following the same precedent the icon-integration task set with `assets/expo.icon` (minimal diff, nothing deleted that wasn't proven safe with more confidence than "no current reference").

### Tests

| Check | Result |
| --- | --- |
| `deno test --no-check --no-lock --allow-read --allow-write --allow-env tests/app/ supabase/functions/account-delete/ apps/kabumori-web/build_test.ts` | **135 passed / 0 failed** (126 existing + 9 new) |
| `npx tsc --noEmit`, `src/` scope | **0 errors** |
| `npx expo config --json` | splash plugin config resolves to the new image/colour/width |
| `npx expo prebuild --platform ios --no-install --clean` | generated splash colorset/imageset correct, verified above |
| `npx expo export --platform web`, dummy non-secret env | PASS, **10 static routes (unchanged)** |
| `git diff --check` | PASS |

**Two assertions were verified against a real regression, not just written and trusted:** I temporarily commented out `scheduleOnRN(setVisible, false)` — the corresponding test failed; separately removed the entire Reduce-Motion branch (defaulting to the animated path always) — that test failed too. Both were then reverted and re-confirmed passing. This follows the same discipline as the earlier `ensure_my_profile` migration proof's negative control.

**Side effect caught and discarded, not shipped:** `expo prebuild` again silently rewrote `package.json`'s `android`/`ios` npm scripts to the bare-workflow form. Reverted with `git checkout -- package.json`, and the generated `ios/`/`android`/`.expo/` directories were deleted before committing — same handling as the two prior tasks that ran a real prebuild.

### Production mutation = 0

No EAS build, no EAS credential/env mutation, no TestFlight/App Store Connect action, no Supabase/Auth/Netlify/X/admin change, no `personalized-reports` edit, no DB/schema/RPC change.

### Ready for first real-iPhone/TestFlight visual acceptance?

**Yes, source-side.** The launch screen is source-complete and verified through a real `expo prebuild`, the same mechanism a production build uses to generate native assets. Per this task's own framing, this does **not** constitute final visual acceptance — that still requires the user seeing it on an actual iPhone via a separately authorized real-device build. If it needs a refinement pass after that (e.g. a dedicated splash derivative distinct from the flat app icon, or adding a wordmark), it can be revisited without redoing this decision.
