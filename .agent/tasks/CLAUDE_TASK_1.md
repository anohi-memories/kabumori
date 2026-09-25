# Claude Task 1

- task_id: kabumori-branded-launch-screen-20260925
- owner: claude
- slot: claude-1
- status: in_progress
- next_owner: claude
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
