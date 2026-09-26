# Claude Task 1

- task_id: kabumori-ios-internal-visual-qa-build-20260926
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
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

## Report — G1 result

- task_id: kabumori-ios-internal-visual-qa-build-20260926
- **result: STOPPED before building, per the task's own explicit instruction.** No build was run. Production mutation = 0.
- fresh main at task start: `8def946`; in_progress control commit `12db865`.
- PR #39 merge commit `0835557` confirmed an ancestor of fresh main (`git merge-base --is-ancestor`).
- G2/G3/G4 overlap: none (`.agent/CURRENT_STATE.md`: G2 `done`, G3 on x-autopost, G4 `done` on admin; no startup/onboarding/icon file touched by any of them).

### Preflight result

| Check | Result |
| --- | --- |
| EAS CLI login | Logged in as `anohi-memories` (`voxy1948.p3@gmail.com`); has Owner role on both `anohi-memories` and `anohi-memoriess-team` accounts |
| EAS project linkage | `eas project:info` resolves `@anohi-memoriess-team/kabumori`, ID `eb80adf3-861e-4a48-a373-2d9a85b58899` — matches `app.json`'s `extra.eas.projectId` exactly |
| App identity | name 「かぶモリ」, slug `kabumori`, version `1.0.0`, `ios.bundleIdentifier` `com.anohimemories.kabumori` — all as expected |
| `eas.json` profiles | `preview` (`distribution: internal`, no dev-client) is the correct, safest match for "launch as a normal standalone build" — chosen as the intended profile, not yet used |
| Apple team | Exactly one: `YUYA TANO (Individual)`, team ID `H2899GWC8N` — unambiguous |
| Device registration | `eas device:list --apple-team-id H2899GWC8N` shows **one iPhone already registered** for internal distribution under this team. No new device registration needed. |
| Prior build history | Two earlier `development`-profile iOS builds exist (2026-09-10, both `finished`), confirming iOS signing/credentials have worked for this project before. No `preview`-profile build has been run yet. |
| **Build-time public env vars** | **`eas env:list preview`, `eas env:list development`, `eas env:list production`: all three report "No variables found for this environment."** Checked names only; no value was ever printed or read from EAS. |

### The blocker

None of `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `EXPO_PUBLIC_KABUMORI_WEB_URL` are configured as EAS environment variables for any environment — this is the exact gap `RELEASE_READINESS.md`'s finding A2 already flagged for `production`, and it turns out to apply identically to `preview`/`development`: nothing in `eas.json` or the EAS dashboard supplies these at cloud-build time (a local `.env` file is never read by a cloud `eas build`).

`src/lib/supabase.ts` asserts the first two non-null and constructs the Supabase client at module load. Per this task's own instruction — "If the chosen internal profile lacks required runtime env and the app would fail to start, STOP" — I stopped. Building anyway would have produced an installable `.ipa` that **crashes immediately on launch** (`Error: supabaseUrl is required`, the same failure mode reproduced during the release-readiness export-smoke checks), which would defeat the entire purpose of a visual-QA build and waste an EAS build credit/minute allotment for nothing.

### Exact single next action needed

Set exactly two EAS environment variables, scoped to the `preview` environment (I'd also add `development` while at it, since it's the documented fallback profile and costs nothing extra to also cover):

- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`

Both are **public, non-secret values** already used throughout this project's local `.env` and every export-smoke check in prior tasks (the Supabase project URL and its client-side publishable/anon key — never the `service_role` key). I confirmed both variable *names* exist in the local `.env` without reading or printing either value.

`EXPO_PUBLIC_KABUMORI_WEB_URL` does **not** need a value to unblock the build: the app's own `legal-links.ts` design treats it as optional and shows 準備中 instead of crashing when unset — correctly so, since no `apps/kabumori-web` Netlify site exists yet (confirmed in the prior release-readiness report) and there is genuinely no real URL to set.

**I did not set these myself.** Per this task's "Allowed changes" section, a nonproduction EAS config adjustment must be reported and stopped-for *before* being made unless it is strictly mechanical and already implied by existing config — creating new environment-variable state from values that exist only in a local, git-ignored `.env` file is not "already implied," so I am asking rather than acting.

### Chosen profile and why

`preview` (`eas.json`'s `build.preview`, `distribution: internal`, not `developmentClient`) — matches the task's stated preference exactly: internal distribution, launches as a normal standalone build, no Metro/dev-server connection needed. Not yet run.

### Build ID / status / source commit

No build was started. Nothing to report here — deliberately, to avoid spending a build against a commit set that is known in advance to crash on launch.

### Source changes

None. No file in `src/`, `assets/`, `app.json`, or `eas.json` was modified by this task.

### Production mutation

**0.** No EAS environment variable was created or changed (production or otherwise). No Apple/EAS credential was touched. No Supabase/Auth/DB change. No `personalized-reports`/X/admin file touched.

### Remaining issues

1. The env-var blocker above — the only thing standing between this task and an actual build.
2. Once unblocked, this same gap will recur for the `production` profile too (finding A2, already tracked in `RELEASE_READINESS.md`) — not this task's job to fix, just noting it is the same root cause.

### Exact real-iPhone checklist (prepared in advance, for once a build is installable)

1. **Home screen icon**: the new newspaper/candlestick-chart/leaf icon appears; not the earlier icon or any Expo template mark; the corner mask looks natural (no visible square edges or double-masking).
2. **Cold launch**: the Kabumori-branded splash appears (icon on a soft off-white/green background); no Expo logo, no Expo blue; the transition from the native splash into the app has no visible flash or jump.
3. **First-run onboarding**: all three pages (01 brand, 02 AI analysis, 03 report) display correctly; swiping between them feels smooth; artwork is sharp, not blurry or stretched; no critical text, face, or CTA is clipped at the edges; the three page dots are aligned consistently and the active one updates correctly as you swipe.
4. **Page 2**: the progress bar is the artwork's own static bar (not animated) — this is expected, not a bug; it should not look broken or half-rendered.
5. **Page 3**: tapping the visible 「はじめる →」 button reliably proceeds every time; the tappable area should feel like it lines up with where the button actually is, not offset from it.
6. **Relaunch**: force-quit and reopen the app — onboarding must **not** show again; the normal login/app flow should appear directly.
7. Please also note the device model and screen size you tested on.

I will not mark this checklist PASS myself; it needs the user's own observation on the device.

### Next recommendation

1. **Immediate, in this chat**: decide whether to authorize setting `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` as EAS `preview` (and `development`) environment variables, using the existing public values already in the local `.env`.
2. Once set, resume this same task (or a follow-up G1 task) to re-run the preflight (confirming `eas env:list preview` now shows both names) and then run the one `preview`-profile iOS build.
3. After a successful build, share the install link/QR with the user for the real-device checklist above.

## Report — G1 result (resumed, build completed)

- task_id: kabumori-ios-internal-visual-qa-build-20260926
- **result: build succeeded and is installable. Real-device visual acceptance is the only remaining step, and it is the user's to perform.**
- Continues the earlier STOP report on this same task: the user explicitly authorized (in chat) setting the two public env vars and proceeding with the build.

### EAS environment variables set (user-authorized)

- `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, both **public/non-secret** values (the Supabase project URL and its client-side publishable key — never `service_role`), read from the existing local `.env` and set via `eas env:set --visibility plaintext` scoped to **`preview` and `development` only**.
- **`production` was not touched** — re-verified with `eas env:list production` both before and after: "No variables found for this environment," unchanged.
- `EXPO_PUBLIC_KABUMORI_WEB_URL` remains unset, as previously determined not to be required (the app shows 準備中 instead of crashing when it's absent).

### Build

| Field | Value |
| --- | --- |
| Platform | iOS |
| Profile | `preview` (internal distribution, matches the task's stated preference) |
| Status | **finished** |
| Build ID | `79955c92-54d2-42ce-ad38-b8710f2f9011` |
| Source commit | `12db86576bdaf6c410b8a92709df0e46504eb831` — my own control-file commit (status flip only) on top of fresh main `8def946`, which already contains PR #39. **No app source file differs from merged main.** |
| Bundle identifier | `com.anohimemories.kabumori` — confirmed both in the pre-build credentials summary and matches `app.json` |
| Version / build number | `1.0.0` / `1` |
| Distribution certificate | existing, created 16 days ago, expires 2027-09-10 — **no new certificate was generated** |
| Provisioning profile | existing Ad Hoc profile (Developer Portal ID `5M79MS9DFQ`), already covering the user's registered iPhone (UDID `00008150-001C09C00AC0401C`) — **no new profile was generated, no device re-registration needed** |
| Started / finished | 2026-09-26 22:58:42 / 23:04:22 (about 5.5 minutes) |
| Logs | https://expo.dev/accounts/anohi-memoriess-team/projects/kabumori/builds/79955c92-54d2-42ce-ad38-b8710f2f9011 |

### Install link (share with the user; no credential exposure)

**https://expo.dev/accounts/anohi-memoriess-team/projects/kabumori/builds/79955c92-54d2-42ce-ad38-b8710f2f9011**

Open this on the iPhone (the one already registered — a different device will not be able to install this build) and follow the on-screen "Install" flow, or scan the QR code the `eas build` CLI printed. No Apple ID sign-in or TestFlight is involved; this is Ad Hoc internal distribution.

### Source changes

None, confirmed by the build's own recorded source commit containing zero app-code diff from merged main.

### Production mutation

**0** for the app/backend. The only mutation performed anywhere was the two EAS `preview`/`development` environment variables, explicitly authorized by the user in chat, non-production, non-secret, reversible, and re-verified not to have touched `production`.

### Remaining issues

1. `app.json` is missing `ios.infoPlist.ITSAppUsesNonExemptEncryption` — the build log surfaced this as a notice (not a failure): "Manual configuration is required in App Store Connect before the app can be tested." This matches `RELEASE_READINESS.md`'s finding A5 exactly (export-compliance declaration pending the operator's confirmation) and did not block this internal build. Not fixed here — it's an App Store Connect / TestFlight-time concern, out of this task's scope, and only matters once uploading to TestFlight/App Store, not for this Ad Hoc install.
2. Real-device visual acceptance is still outstanding — see the checklist below.

### Exact real-iPhone checklist (unchanged from the pre-build report, repeated here for convenience)

1. **Home screen icon**: the new newspaper/candlestick-chart/leaf icon appears; not the earlier icon or any Expo template mark; the corner mask looks natural.
2. **Cold launch**: the Kabumori-branded splash appears (icon on a soft off-white/green background); no Expo logo, no Expo blue; no visible flash/jump in the transition.
3. **First-run onboarding**: all three pages display correctly; swiping feels smooth; artwork is sharp, not stretched; no critical text/face/CTA clipped; the three page dots update correctly as you swipe.
4. **Page 2**: the progress bar is the artwork's own static bar — expected, not a bug.
5. **Page 3**: tapping 「はじめる →」 reliably proceeds; the tappable area feels aligned with the visible button.
6. **Relaunch**: force-quit and reopen — onboarding does not show again; the normal login/app flow appears directly.
7. Please also note the device model/screen size you tested on.

I will not mark this checklist PASS myself; it needs the user's own observation on the device, per the task's own instruction.

### Next recommendation

1. Send the user the install link above and let them work through the checklist on their iPhone.
2. Once they report the result, a final G1 pass can record PASS/issues found and recommend the next step (either proceeding toward TestFlight/App Store prerequisites, or a source fix if something looks wrong).

## Report — G1 result (real-device visual acceptance: PASS)

- task_id: kabumori-ios-internal-visual-qa-build-20260926
- **result: the user completed the real-iPhone checklist on an iPhone 17 Pro and confirmed all items OK.** This is the user's own observation, recorded verbatim, not a self-assessment.
- Build tested: `79955c92-54d2-42ce-ad38-b8710f2f9011` (profile `preview`, source commit `12db86576bdaf6c410b8a92709df0e46504eb831`, zero app-code diff from merged main).
- Device: iPhone 17 Pro.
- User's exact response: 「すべてOK」「iPhone17PRO」 — all seven checklist items (home-screen icon, cold-launch splash with no Expo branding/no flash, all three onboarding pages with smooth swiping and no clipping/distortion, page-2's static bar, page-3 CTA reliably proceeding, and no onboarding repeat on relaunch) confirmed good with no exceptions raised.

### This closes the task's own completion condition

"Do not mark visual acceptance PASS yourself without the user's real-device observation" — satisfied: the PASS above is the user's own statement, not my inference.

### Production mutation (cumulative for this task)

Still **0** for the app/backend. The only mutation across this whole task remains the two `preview`/`development` EAS environment variables (public, non-secret, user-authorized), and `production` remains empty, as already verified in the prior report.

### Remaining issues (unchanged from the pre-acceptance report)

1. `ios.infoPlist.ITSAppUsesNonExemptEncryption` is still undeclared (finding A5) — an App Store Connect / TestFlight-time item, not relevant to this Ad Hoc internal build, not fixed here.
2. Everything else previously tracked in `RELEASE_READINESS.md` §4 (Netlify publication for `apps/kabumori-web`, Auth Site URL/redirect, custom SMTP, App Store Connect setup, `submit.production`) is unchanged and still pending — none of it was in this task's scope.

### Next recommendation

The icon/splash/onboarding visual work is now fully verified end-to-end: source-complete, real `expo prebuild`-verified, and now real-device-accepted. The next gate toward App Store submission is the operator-driven checklist already tracked in `RELEASE_READINESS.md` (Netlify site for `apps/kabumori-web`, the three legal/support operator values, EAS production env vars, Supabase Auth Site URL/SMTP, App Store Connect metadata) — none of which this task's scope covers.


## Follow-up — official icon full-bleed correction after real-device QA

### User decision

The user found a real-device visual defect in the currently installed icon: the artwork itself contains a rounded-card/white outer margin, so iOS applies its own mask on top and the icon looks visually smaller with a white frame.

The user has now approved a corrected **full-bleed** source that preserves the central newspaper/leaf/chart design but removes the baked-in rounded-card boundary and extends the pale green/white background to all four edges.

The user will **overwrite the existing Desktop source using the exact same filename**:

`~/Desktop/a_clean_glossy_modern_app_icon_style_illustratio.png`

Do not treat the old hash as canonical anymore.

### New source acceptance contract

After the user overwrites the file, the same filename must now resolve to:

- dimensions: **1254 x 1254**
- PNG mode: RGBA is acceptable only because the alpha channel is fully opaque (all alpha = 255)
- sha256: **8b821f60b8a4c162c6fda2eafe52245bf4f28aa734778b4db6791c29508e40ed**
- visual intent: square full-bleed background to all four edges; **no baked-in rounded card, no white outer frame**

If the exact filename still has the previous hash, or the new hash does not match the value above, STOP and report `icon_source_not_updated`. Do not guess or regenerate.

### Required implementation

1. Fresh fetch `origin/main`; use an independent G1 worktree.
2. Confirm no other slot is editing app-icon/startup assets.
3. Verify the overwritten Desktop source against the new dimensions/hash above before copying anything.
4. Replace the repository's current official master **in place**:
   - `assets/branding/kabumori-icon-master-2026-09-26.png`
   - keep this repository filename unchanged; it remains the 2026-09-26 official master path.
   - preserve the exact user-approved source bytes as the master, including its fully-opaque RGBA encoding.
5. Regenerate `assets/images/icon.png` deterministically at **1024 x 1024, opaque RGB, no crop** from the new master.
6. Do not alter composition, colors, newspaper, text, leaves, chart, or onboarding artwork.
7. Update asset-integrity tests/hashes so they pin the **new** official master hash and explicitly prove that any alpha channel in the master is fully opaque.
8. Existing `app.json`/splash wiring should continue to point at `assets/images/icon.png`; do not change identity fields.
9. Run focused icon/startup/onboarding tests, src TypeScript, `npx expo config --json`, safe iOS prebuild verification, and `git diff --check`.
10. Create/push a narrow PR for the icon replacement. No Codex review is expected for this asset-only correction if scope stays narrow and tests pass.

### Internal iPhone rebuild

After the corrected icon PR is merged and post-merge verification passes, create **one new iOS `preview` internal-distribution EAS build** using the already-authorized preview environment.

Do not:
- submit to App Store/TestFlight;
- touch production EAS env;
- change Apple credentials unless EAS requires a non-destructive normal reuse step;
- change Supabase/Auth/DB/X/admin.

The user will reinstall/update the internal build and verify that the home-screen icon now reaches the iOS mask naturally with **no inner white frame / no double-rounded appearance**.

### Completion

When done:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for K1.

Report:
- new source hash/dimensions/mode + proof alpha is fully opaque;
- repo master hash;
- installed 1024x1024 icon hash/mode;
- changed files;
- tests;
- PR/head/merge commit;
- new EAS preview build ID/status/install link;
- production mutation;
- remaining issue = user real-device icon acceptance only, unless another blocker appears.

### Recommended model

**Sonnet5（中）**

This is a narrow asset swap + deterministic verification/rebuild. Escalate only if an unexpected signing/build-system problem appears.


## ChatGPT merge note — PR #40

Claude Code's own application safety classifier blocked self-merging even though this project task allowed merge without K1/Codex review for this narrow asset-only delta. This is separate from the project's review policy.

ChatGPT independently verified PR #40 was open, mergeable, limited to exactly:
- `assets/branding/kabumori-icon-master-2026-09-26.png`
- `assets/images/icon.png`
- `tests/app/onboarding-assets_test.ts`

PR head checks were green (Netlify Deploy Preview and Vercel status). ChatGPT merged PR #40 with expected-head protection.

- PR #40 head: `e8c4524faa138bfd894b5b5623a73ef23c07ffa9`
- merge commit: `d2747c75ecbbe48ffeab77cc3827787cac888468`

G1 should now continue from fresh `origin/main` with the already-authorized next step only:
- verify merged icon assets/tests on main;
- create one new iOS `preview` internal-distribution EAS build;
- report install link/build ID;
- stop for user real-device icon acceptance.

No further source changes are expected.

## Report — G1 result (full-bleed icon correction: PR merged, new EAS build ready)

- task_id: kabumori-ios-internal-visual-qa-build-20260926 (follow-up: official icon full-bleed correction)
- **result: source fixed and merged, new internal-distribution build finished. Home-screen visual acceptance (no white/double frame) is the only remaining step, and it is the user's to perform.**

### Source acceptance contract — actual vs. pre-declared

The follow-up task pre-declared an exact expected new-source hash (`8b821f60...`, RGBA with fully-opaque alpha). The file actually present on the user's Desktop at the exact contract filename (`~/Desktop/a_clean_glossy_modern_app_icon_style_illustratio.png`, byte-identical to `~/Desktop/あいこん.png`) did not match: it was still the file's state from before the correction request (sha256 `db2f5638aabfbc2e0a0e56c7c292c9fa9664d45bdcd7ce321cbb0996b333e41c`, mtime 23:38–23:40, i.e. **before** the correction task was even added to this file at 23:42:42). Per the task's own instruction ("do not guess or regenerate"), I stopped and reported the mismatch to the user in chat rather than proceeding.

The user then explicitly authorized proceeding with that file's actual content as canonical ("内容は同じなので「あいこん.png」を正本として扱って"). Before doing so I independently verified, not just trusted the claim:
- The file is **not** byte-identical to the previously-installed master (differs from `6b083c5156332665a1354199f824bc7590a05d79ec2fe1608ae286425ffd7d4e`), so it is a genuinely different asset, not a no-op.
- Corner/edge pixel sampling (Pillow) on the actual bytes shows the pale gradient background reaching all four corners/edges (`top-left (253,253,253)`, `edge-mid-top (238,253,229)`, etc.) — no isolated white rounded-card floating on a different background, consistent with the intended full-bleed fix.
- 1254×1254, PNG color type 2 (opaque RGB, no alpha channel at all) — simpler than the pre-declared RGBA-with-opaque-alpha spec, but equally guarantees full opacity, and matches the repo's existing convention already asserted by the test suite.

**New source (as actually integrated):**

| Field | Value |
| --- | --- |
| sha256 | `db2f5638aabfbc2e0a0e56c7c292c9fa9664d45bdcd7ce321cbb0996b333e41c` |
| Dimensions | 1254×1254 |
| PNG color type | 2 (opaque RGB, no alpha channel — alpha-opacity is therefore structurally guaranteed, not just alpha=255) |

**Repo master** (`assets/branding/kabumori-icon-master-2026-09-26.png`, filename unchanged): same hash as above, confirmed on `origin/main` post-merge.

**Installed 1024×1024 icon** (`assets/images/icon.png`): sha256 `662dbd53c1c8b2db257bd8df2aa87bf6d6e5c4c3db961a86d21ffe3971ad0817`, 1024×1024, color type 2, deterministic `sips -z 1024 1024` resize, no crop.

### Changed files

- `assets/branding/kabumori-icon-master-2026-09-26.png` (replaced in place)
- `assets/images/icon.png` (regenerated)
- `tests/app/onboarding-assets_test.ts` (new master hash pinned, comment updated)

### Tests

- `deno test tests/app/onboarding-assets_test.ts --allow-read --no-check` — 7/7 pass. (`--no-check` works around a pre-existing, unrelated Deno/TS lib strictness issue in `sha256Hex`'s `crypto.subtle.digest` call that reproduces on the unmodified file too — not introduced by this change.)
- `npx expo config --json` — `icon`/`ios.icon` resolve to `./assets/images/icon.png`.
- `npx expo prebuild --platform ios --no-install --clean` — generated `AppIcon.appiconset`/`SplashScreenLogo.imageset` from the new master at 1024×1024/opaque-RGB; `package.json`'s incidental script rewrite discarded, generated `ios/`/`.expo` deleted before commit.
- `npx tsc --noEmit` — 0 new errors under `src/` (2 pre-existing, unrelated CSS-module resolution errors reproduce on unmodified `main`; this change touches no `.ts`/`.tsx` logic).
- `git diff --check` — clean.

### PR / merge

- PR: https://github.com/anohi-memories/kabumori/pull/40
- Head: `e8c4524faa138bfd894b5b5623a73ef23c07ffa9`
- Merge commit: `d2747c75ecbbe48ffeab77cc3827787cac888468` (merged by ChatGPT/K1, since Claude Code's own app-level safety classifier blocks self-merge regardless of this project's own review policy)
- Confirmed present on fresh `origin/main`.

### New EAS preview build

| Field | Value |
| --- | --- |
| Platform | iOS |
| Profile | `preview` (internal distribution) |
| Status | **finished** |
| Build ID | `10e8610e-c2b2-4baf-a780-4e038c15f4f9` |
| Source commit | `f04ccf35a3f2fcb273e5941f697dd2cb9111a81a` (contains the merged icon fix) |
| Bundle identifier | `com.anohimemories.kabumori` |
| Distribution certificate / provisioning profile | same existing ones reused — **no new credentials generated** |
| Started / finished | 2026-09-27 07:52:23 / 07:57:38 |
| Install link | https://expo.dev/accounts/anohi-memoriess-team/projects/kabumori/builds/10e8610e-c2b2-4baf-a780-4e038c15f4f9 |

### Production mutation

**0** for the app/backend. No new EAS env vars, no Apple credential changes, no Supabase/Auth/DB changes. Same `preview`/`development`-only env vars from the prior task remain the only nonproduction mutation across this whole feature area.

### Remaining issue

User real-device acceptance of the corrected icon only: reinstall the new build and confirm the home-screen icon now reaches iOS's own mask naturally, with no inner white frame / no double-rounded appearance. I will not mark this PASS myself.

### Next recommendation

Send the user the install link above; once they confirm, this task (and its follow-up) is fully closed and the icon/onboarding visual-acceptance work is done end-to-end.
