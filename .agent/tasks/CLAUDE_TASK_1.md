# Claude Task 1

- task_id: kabumori-ios-internal-visual-qa-build-20260926
- owner: claude
- slot: claude-1
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（高）
- purpose: merged main の新正式アイコン＋3画面オンボーディングを、実際のiPhoneで確認するための **非production・内部配布EAS iOS build** を安全に作成し、インストール可能な状態まで進める。App Store提出やproductionリリースは行わない。

## User authorization

User explicitly said 「やってみよう」 after Final K1 identified the next gate as a real-iPhone visual acceptance pass.

This authorizes:
- read-only EAS/Expo/Apple provisioning preflight;
- if prerequisites are already satisfied, **one iOS internal-distribution build** for visual QA;
- normal EAS build artifacts needed for that internal build.

This does **not** authorize:
- App Store submission;
- TestFlight external distribution;
- production release;
- Supabase/Auth/DB changes;
- EAS production environment changes;
- Apple certificate/profile deletion or broad credential rotation;
- new paid service purchase.

If EAS/Apple authentication, device registration, agreement acceptance, missing env, or another operator-only action is required, STOP and report the exact single next action rather than guessing.

## Mandatory startup / slot isolation

1. Use a dedicated G1 worktree/checkout.
2. Read `PROJECT_RULES.md`, `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK, `eas.json`, and `docs/mobile-release/RELEASE_READINESS.md`.
3. Fresh fetch `origin/main`; record SHA.
4. Confirm PR #39 merge commit `08355579ef8fd89e12e6723aed4674905440016a` is contained in fresh main.
5. Confirm G2 has no overlapping startup/onboarding/app-icon edits.
6. Do not modify G3/G4/X/admin work.
7. Confirm worktree is clean before any EAS action.

## Goal

Get the current merged Kabumori native app onto the user's real iPhone for **visual QA only**, with the minimum-risk build path.

Preferred path:
- iOS `preview` internal distribution if it can install directly on the registered device and launch as a normal standalone build.

Fallback:
- iOS `development` internal build only if preview is unsuitable and the reason is documented.

Do not choose the `production` profile merely for convenience.

## Read-only preflight first

Before building, inspect without exposing secrets:

- EAS CLI login/account/project linkage;
- `eas.json` profile definitions;
- Expo app identity;
- whether required build-time public variables are available for the chosen nonproduction profile:
  - `EXPO_PUBLIC_SUPABASE_URL`
  - `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
  - `EXPO_PUBLIC_KABUMORI_WEB_URL`
- iOS signing/provisioning status;
- whether the user's iPhone is already registered for internal distribution;
- any Apple Developer agreement or credential blocker.

Only report env **presence/absence**, never values.

If the chosen internal profile lacks required runtime env and the app would fail to start, STOP. Do not silently substitute production secrets or change EAS production env.

## Build

If all preflight gates pass:

1. Use current fresh main; no feature-code changes expected.
2. Run one iOS internal build using the safest suitable nonproduction profile.
3. Do not submit to App Store Connect/TestFlight.
4. Capture:
   - profile used;
   - build ID;
   - source commit;
   - build status;
   - install URL/QR availability (do not expose secret credentials);
   - expiration/registration constraints if EAS reports them.
5. Verify EAS built the expected bundle identifier `com.anohimemories.kabumori`.

If EAS asks for a destructive credential operation, broad certificate replacement, or ambiguous Apple account change, STOP.

## Real-iPhone acceptance checklist

Once installable, the user will perform the visual pass. Prepare a concise checklist for them to verify:

1. Home screen icon:
   - new official newspaper/chart/leaf icon;
   - not old icon/template;
   - cropping/mask looks natural.

2. Cold launch:
   - Kabumori icon splash appears;
   - no Expo logo/blue;
   - transition has no obvious flash/jump.

3. First-run onboarding:
   - 01, 02, 03 all display;
   - swipe is smooth;
   - artwork is sharp;
   - no critical text/face/CTA clipping;
   - no distortion/stretching;
   - page dots align consistently and update correctly.

4. Page 2:
   - static progress bar is acceptable;
   - no expectation of real progress.

5. Page 3:
   - tapping visible 「はじめる →」 reliably proceeds;
   - touch area visually corresponds to the artwork.

6. Relaunch:
   - onboarding does not show again after completion;
   - normal auth/app flow appears.

7. If practical, also note display on the user's actual iPhone model / screen size.

Do not mark visual acceptance PASS yourself without the user's real-device observation.

## Allowed changes

Expected source changes: none.

Allowed only if needed for build metadata and proven harmless:
- narrow nonproduction EAS config adjustment that does not affect production behavior, but STOP before making it and report why unless it is strictly mechanical and already implied by existing config.

Do not touch:
- onboarding artwork;
- app icon artwork;
- startup/auth/session semantics;
- Supabase DB/Auth;
- personalized-reports;
- X/admin;
- production EAS env;
- App Store metadata;
- Netlify/Vercel.

## Tests

Before build:
- confirm main contains Final K1 feature;
- `npx expo config --json`;
- targeted onboarding/startup tests if any local source change is made;
- if no source change, do not rerun the entire expensive suite merely for formality unless build/preflight exposes a regression.

After build:
- verify build source commit/profile/bundle identifier from EAS metadata.

## Review policy

No Codex review is needed for a no-source-change internal visual-QA build.

If any source/config change becomes necessary and it affects auth, credentials, signing, production environment, or release semantics, STOP for ChatGPT reclassification before changing it.

## Completion / K1

On completion set:
- status -> `review_required`
- next_owner -> `chatgpt`

Report:
- preflight result;
- EAS account/project check;
- chosen profile and why;
- env presence-only result;
- device-registration status;
- build ID/status/source commit;
- installability / exact user action if blocked;
- source changes (expected none);
- production mutation;
- remaining issues;
- exact real-iPhone checklist;
- next recommendation.

STOP for K1.
