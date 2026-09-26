# Claude Task 1

- task_id: kabumori-onboarding-icon-integration-20260926
- owner: claude
- slot: claude-1
- status: done
- next_owner: none
- priority: high
- recommended_model: Sonnet5（高）
- purpose: ユーザー確定の新しい「かぶモリ」正式アプリアイコンと、3枚のオンボーディング正本画像をExpo/React Nativeアプリへ安全に統合する。native splashは短い起動ブリッジとして新アイコンへ更新し、その後に初回のみ3画面オンボーディングを表示する。

## User decision / visual source of truth

User approved the visual work as final. Do not redesign or regenerate any artwork in this task.

Final approved source assets are expected as user-provided local files:

1. app icon source
   - expected filename: `a_clean_glossy_modern_app_icon_style_illustratio.png`
   - expected size: 1254x1254
   - expected mode: RGB
   - expected sha256: `6b083c5156332665a1354199f824bc7590a05d79ec2fe1608ae286425ffd7d4e`

2. onboarding 01
   - expected filename: `1最終版_1179x2556.png`
   - expected size: 1179x2556
   - expected mode: RGB
   - expected sha256: `de0f57bd48fb15a3c3cbf11480fed2106677a6729930f57b734f881051a988fb`

3. onboarding 02
   - expected filename: `2最終版_1179x2556.png`
   - expected size: 1179x2556
   - expected mode: RGB
   - expected sha256: `2ac0fda449490867f6f0ced3f89b2023f43bdb424122c8aea8ce3aedb9b5e833`

4. onboarding 03
   - expected filename: `3最終版_1179x2556.png`
   - expected size: 1179x2556
   - expected mode: RGB
   - expected sha256: `6dbbf10caad1eb0c23a4604186ce2474fd8472649f952d4e4662411b1ec93dd6`

These hashes are part of the acceptance contract. If the files found locally do not match, STOP rather than substituting or regenerating.

## Mandatory startup / isolation

1. Use a dedicated independent G1 worktree/checkout. Do not share another slot's working directory.
2. Read `PROJECT_RULES.md`, `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, and this TASK.
3. Fresh fetch `origin/main`; record starting SHA.
4. Confirm G2 is done and personalized-reports is out of scope.
5. Confirm no other active slot owns startup/onboarding files before editing.
6. Inspect current startup/auth routing before deciding the insertion point.
7. Search only reasonable user asset locations such as the repo-provided handoff area, `~/Downloads`, and `~/Desktop` for the four exact filenames above.
8. Verify exact dimensions/mode/sha256 before copying any artwork into the repo.
9. If any required asset is unavailable, STOP with `asset_input_required` and list the missing filename(s). Do not recreate them.

## Product flow

Target launch flow:

native/static splash
→ existing in-app splash handoff
→ onboarding v1 if not completed
→ existing app/auth flow

Onboarding is explanatory UI, not a real market-analysis request.

Requirements:
- onboarding appears once per installation for version v1;
- existing users without the v1 completion key may see it once after this update;
- after completion, subsequent launches skip it;
- auth/session initialization may continue normally behind the onboarding; do not couple onboarding completion to network/auth success;
- onboarding must never trap the user if local persistence fails.

Use an existing local persistence primitive already present in the app if suitable. Do not add a new heavy dependency solely for this feature without first reporting why it is necessary.

Use a versioned key such as `kabumori:onboarding:v1` or an equivalent project-consistent key.

## A. New official app icon

Replace the currently merged baseline icon with the new approved source.

Requirements:
- preserve the approved artwork exactly;
- create/install the required 1024x1024 opaque iOS/Expo asset by deterministic high-quality resize only;
- no AI redraw, recolor, compositional change, crop that changes meaning, or added text;
- keep bundle identifier / slug / scheme / projectId unchanged;
- update any icon asset integrity tests/hashes accordingly.

Also update the current short native splash / `AnimatedSplashOverlay` to use the new official icon so app icon and startup branding are consistent.

Do not turn the 3 onboarding screens into the native splash.

## B. Onboarding image assets

Store the three approved 1179x2556 images as immutable app assets using clear stable names, for example:

- `assets/onboarding/01-brand.png`
- `assets/onboarding/02-ai-analysis.png`
- `assets/onboarding/03-report.png`

The exact repo path may follow existing asset conventions, but document it.

Do not:
- regenerate;
- recompress destructively;
- alter text;
- alter faces;
- alter UI;
- recolor;
- stretch aspect ratio.

Add tests or a deterministic verifier that pins their expected dimensions and sha256 values after ingress.

## C. Three-screen onboarding behavior

Implement a 3-page horizontally swipeable/paged onboarding.

Pages:
1. brand
2. AI analysis
3. report complete

Requirements:
- use the approved images as the visual source;
- preserve aspect ratio with no geometric distortion;
- no OS status bar/time/Wi-Fi/battery graphics are baked into these approved images;
- adapt safely across supported iPhone viewport sizes without cutting critical text/faces/UI;
- use a neutral background matching the artwork if any letterboxing is required;
- no network calls to display onboarding.

### Page indicator

The final artwork intentionally has no baked-in page dots.

Render page dots natively in React Native:
- 3 dots;
- active dot dark/brand green;
- inactive dots light neutral;
- identical size/spacing/vertical position across all pages;
- update from the actual current page;
- accessibility-hidden if redundant, or expose a concise page-position label.

Do not modify the source images to add dots.

## D. Page 2 analysis-progress animation

The progress bar visible in `2最終版_1179x2556.png` is explanatory artwork, not real progress.

User approved adding a subtle native animation so the onboarding feels alive.

Implement only if it can be overlaid robustly without visibly damaging the artwork:
- cover/mask the baked bar region with a neutral patch matching the local background;
- render a native track + green indeterminate animation in the same visual position;
- use normalized/image-relative positioning so it tracks the rendered image viewport;
- use a slow restrained loop; no percentage;
- respect Reduce Motion by showing a static neutral state;
- it must not represent actual AI/network progress.

If exact overlay alignment cannot be made stable across supported device sizes without visible artifacts, keep the approved static bar and report why; do not alter the image.

## E. Page 3 CTA

The approved page 3 artwork already contains the visual `はじめる →` button.

Provide a real accessible press target aligned to that visual:
- do not duplicate the visible label;
- overlay a transparent or visually neutral `Pressable` hit target on the approved CTA region;
- accessibilityRole=`button`;
- accessibilityLabel=`はじめる`;
- adequate hit target;
- on press: persist onboarding-v1 completion, then continue into the existing app/auth flow.

Do not change the artwork just to recreate the button in code.

## F. Swiping / interaction

- horizontal paging must feel native and smooth;
- track page index deterministically;
- page 1/2 can advance by swipe;
- page 3 CTA completes;
- no accidental completion from swipe alone;
- no blocking animation longer than the user's gesture;
- handle orientation policy consistent with the current app; do not introduce new landscape support.

## G. Existing startup semantics

Preserve existing startup/auth correctness from PR #36.

Do not materially change:
- auth/session initialization semantics;
- Supabase initialization;
- routing boundaries;
- account state;
- deep-link/reset-password handling.

The onboarding layer may sit visually before the existing app flow, but must not become a new auth dependency.

If implementation requires material startup/auth semantic changes, STOP and report before proceeding.

## H. Tests / verification

At minimum verify:

1. asset integrity
   - new icon master sha/dimensions;
   - installed 1024x1024 icon is opaque and derived deterministically;
   - all three onboarding assets are exactly 1179x2556 and sha-pinned.

2. startup
   - native splash / AnimatedSplashOverlay use the new official icon;
   - Expo logo/template does not return;
   - app identity fields unchanged.

3. onboarding state
   - first run / absent v1 key shows onboarding;
   - completion persists v1 key;
   - subsequent run skips onboarding;
   - persistence failure cannot trap the user.

4. paging
   - 3 pages;
   - page index / native dots stay synchronized;
   - page 3 CTA completes only from user action.

5. accessibility
   - page 3 CTA accessible;
   - Reduce Motion behavior for page-2 progress animation;
   - no inaccessible duplicate CTA label.

6. responsive layout
   - verify at representative small and large iPhone dimensions;
   - no critical text/face/CTA clipping;
   - no image stretching.

Run:
- targeted onboarding/startup tests;
- full app tests;
- `npx tsc --noEmit` in app/src scope as currently used;
- `npx expo config --json`;
- safe iOS prebuild verification in isolated worktree if needed;
- Expo web export if part of the existing test suite;
- `git diff --check`.

Do not run a production EAS build or TestFlight submission in this task.

## Scope

Allowed:
- app icon assets/config;
- current splash asset references;
- onboarding image assets;
- onboarding components/screens/state;
- narrowly related app root/layout integration;
- local persistence for onboarding-v1;
- tests/docs directly related to this feature.

Forbidden:
- personalized-reports;
- Supabase DB/schema/RPC/Edge Functions;
- Auth policy changes;
- Netlify/Vercel;
- X/admin;
- EAS credentials;
- production environment changes;
- TestFlight/App Store submission;
- unrelated refactors.

## Review policy

This is primarily UI/asset/local-state work.

Per reduced-review policy:
- no automatic Codex review is required if scope stays within the constraints above and tests pass;
- if auth/session semantics, deep-link routing, security-sensitive persistence, or other high-risk boundaries must change, STOP and report for reclassification.

## Completion / K1

On completion:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for K1.

Report must include:
- exact asset source paths, dimensions and hashes;
- final installed app-icon hash/dimensions;
- onboarding asset repo paths;
- persistence key and first-run behavior;
- page-2 progress behavior and Reduce Motion behavior;
- page-3 CTA behavior;
- changed_files;
- tests;
- commit_hash / branch / PR;
- push state;
- deploy/build state;
- production mutation;
- remaining issues;
- real-iPhone/TestFlight visual acceptance still required or not;
- safety checks;
- next recommendation.

## Report — G1 result

- task_id: kabumori-onboarding-icon-integration-20260926
- result: **all 4 assets found, verified, and integrated. PR #39 is open and unmerged.** Production mutation = 0; no EAS build, no TestFlight.
- fresh main at task start: `f624485`; in_progress control commit `7c9979a`.
- G2/G3/G4 overlap: none (`.agent/CURRENT_STATE.md` shows G2 `done`, G3/G4 both on x-autopost/admin work; `personalized-reports` untouched).

### Exact asset source paths, dimensions, hashes

All four found at `~/Desktop` under the exact filenames the task specified. Verified with `shasum -a 256` / `file` before any copy, matching the acceptance contract exactly:

| Asset | Path found | sha256 | Dimensions |
| --- | --- | --- | --- |
| icon | `~/Desktop/a_clean_glossy_modern_app_icon_style_illustratio.png` | `6b083c51…5ffd7d4e` | 1254×1254, RGB, no alpha |
| onboarding 01 | `~/Desktop/1最終版_1179x2556.png` | `de0f57bd…881051a9` | 1179×2556, RGB |
| onboarding 02 | `~/Desktop/2最終版_1179x2556.png` | `2ac0fda4…4a8ce3ae` | 1179×2556, RGB |
| onboarding 03 | `~/Desktop/3最終版_1179x2556.png` | `6dbbf10c…d4662411` | 1179×2556, RGB |

No `asset_input_required` STOP was needed. A second, unrelated file (`アイコンん候補.png`) also existed on the Desktop — not used, since it didn't match any expected filename.

### Final installed app-icon hash/dimensions

`assets/images/icon.png`: 1024×1024, RGB, no alpha, regenerated via deterministic `sips -z 1024 1024` from the new master. No crop was needed (source already square). No AI redraw/recolor.

### Onboarding asset repo paths

`assets/onboarding/01-brand.png`, `assets/onboarding/02-ai-analysis.png`, `assets/onboarding/03-report.png` — byte-for-byte copies, hash-verified after copy too.

### Persistence key and first-run behavior

- Key: `kabumori:onboarding:v1` in AsyncStorage (already an app dependency — `src/lib/supabase.ts` uses it for the session; no new dependency added, per the task's explicit ask to report before adding one).
- First run / no key present → `completed === false` → onboarding shows.
- On page-3 CTA press → `complete()` sets local state to `true` immediately (UI proceeds without waiting) and writes `'true'` to storage best-effort.
- Subsequent launches → stored `'true'` read back → onboarding skipped.
- A storage read failure resolves to `completed = true` (fails **open**: skip onboarding, never trap the user behind a broken local store). A storage write failure is swallowed (`.catch(() => {})`); worst case is onboarding reappearing once on the next cold start, never a block.

### Page-2 progress behavior and Reduce Motion behavior

**Not implemented — deliberately, per the task's own explicit fallback.** The approved page-2 artwork's own static progress bar is kept exactly as designed, unmodified. Reasoning: overlaying a native indeterminate bar precisely aligned to the baked-in bar's position requires that alignment to be verified across every supported iPhone size, which cannot be responsibly confirmed from source alone in this environment — a misaligned patch would visibly damage approved artwork, a worse outcome than no animation. This is documented in `RELEASE_READINESS.md` with the exact reason and the reusable mechanism (`imageFractionToContainerRect`, already implemented and tested for the page-3 CTA) for a future attempt with real-device verification. Since no animation was added for page 2, there is nothing there that needs Reduce Motion handling; no other new animation was introduced in onboarding either (paging is native `ScrollView` scrolling, not a custom `Animated` transition).

### Page-3 CTA behavior

An image-relative `Pressable` (`accessibilityRole="button"`, `accessibilityLabel="はじめる"`) is positioned via `imageFractionToContainerRect()` over the approved artwork's own visible "はじめる →" button — not a re-drawn duplicate label. The fractional region (`x:0.18, y:0.787, width:0.64, height:0.056`) was measured against the actual page-3 source image and padded so the computed on-screen hit target is confirmed ≥44pt (Apple's minimum) on both a small (375×812) and large (430×932) representative iPhone size — pinned by test, verified with a negative control. Pressing it calls `onComplete` → `completeOnboarding` → the hook's `complete()`.

### Changed files (PR #39, branch `claude1/onboarding-icon-integration`, head `a781240`)

New:
- `assets/branding/kabumori-icon-master-2026-09-26.png`
- `assets/onboarding/{01-brand,02-ai-analysis,03-report}.png`
- `src/components/onboarding-screens.tsx`
- `src/hooks/use-onboarding.ts`
- `src/lib/onboarding-layout.ts`, `src/lib/onboarding-pages.ts`
- `tests/app/{onboarding-assets,onboarding-layout,onboarding-integration,use-onboarding}_test.ts`

Modified:
- `assets/images/icon.png` (new artwork)
- `src/app/_layout.tsx` (onboarding gate)
- `docs/mobile-release/RELEASE_READINESS.md` (new icon/onboarding rows, page-2 deferral note)

Removed:
- `tests/app/app-icon_test.ts` — superseded (pinned the now-old 2026-09-25 hash); its coverage (icon dims/alpha, config wiring, identity fields) is carried forward, updated to the new hash, in `onboarding-assets_test.ts`.

The 2026-09-25 icon master file itself was **not deleted**, only its test pin removed — it remains on disk as an inert historical record, consistent with this project's established precedent (`assets/expo.icon`, `splash-icon.png`).

### Tests / exact results

| Check | Result |
| --- | --- |
| `deno test --no-check --no-lock --allow-read --allow-write --allow-env tests/app/ supabase/functions/account-delete/ apps/kabumori-web/build_test.ts` | **155 passed / 0 failed** (135 before this task − 4 removed + 24 new = 155: `onboarding-layout_test.ts` 7, `onboarding-assets_test.ts` 7, `onboarding-integration_test.ts` 6, `use-onboarding_test.ts` 4) |
| `npx tsc --noEmit`, `src/` scope | **0 errors** |
| `npx expo config --json` | unaffected fields unchanged; icon/splash already correct with no config edit |
| `npx expo prebuild --platform ios --no-install --clean` | generated `AppIcon.appiconset`/`SplashScreenLogo.imageset` both visually confirmed to be the new artwork, not the prior icon |
| `npx expo export --platform web`, dummy non-secret env | PASS, **10 static routes (unchanged)**; the three onboarding `require()`s resolved cleanly (a failure there would have broken the whole export) |
| `git diff --check` | PASS |

**Negative controls run** (temporarily broke the code, confirmed the corresponding test failed, then restored and reconfirmed passing): the CTA hit-target ≥44pt assertion (shrank the fraction, test caught it), and the onboarding hook's fail-open branch (flipped `true`→`false` in the catch handler, test caught it).

**Side effect caught and discarded, not shipped:** `expo prebuild` again silently rewrote `package.json`'s `android`/`ios` npm scripts to the bare-workflow form. Reverted with `git checkout -- package.json`; generated `ios/`/`android`/`.expo/` deleted before committing — same handling as every prior task that ran a real prebuild.

### Production mutation

**0.** No EAS build, no EAS credential/env mutation, no TestFlight/App Store Connect action, no Supabase/Auth/Netlify/X/admin change, no `personalized-reports` edit, no DB/schema/RPC change.

### Remaining issues

1. Page-2 animated progress overlay not implemented (documented above and in `RELEASE_READINESS.md`, with the reusable mechanism for a future attempt).
2. The exact fractional region for the page-3 CTA (`ONBOARDING_CTA_FRACTION`) was measured from a single visual read of the source image, not pixel-picked with an image tool. It is generously padded and test-confirmed to land inside the artwork and clear the 44pt minimum on two representative sizes, but should be treated as "verified good enough to ship for review," not "pixel-perfect" — real-device visual acceptance (below) is exactly the point at which any needed nudge would be found.
3. **One design decision flagged explicitly for K1's judgment**, not silently assumed correct: the `loading` gate in `_layout.tsx` now also waits for the onboarding flag's local read (`loading || onboardingCompleted === null`) before revealing any content, to avoid a flash-then-jump UI bug. This is a change to the exact condition of an existing gate. My reasoning for why this does not materially change auth/session semantics is in the PR description and the commit message; I did not treat my own reasoning as sufficient to skip flagging it.

### Real-iPhone/TestFlight visual acceptance

**Still required, not decided by this task.** The task's own framing: "final visual acceptance will happen on actual iPhone/TestFlight and can be refined later." Everything here is source-complete and verified through a real `expo prebuild` + `expo export`, the same mechanisms a production build uses to generate/bundle assets, but none of it has been seen on an actual device.

### Safety checks

- No `personalized-reports`, Supabase DB/schema/RPC/Edge Function, Auth policy, Netlify/Vercel, X/admin, or EAS-credential file was touched (`git diff --stat` against `f624485` covers only the files listed above).
- No secret/credential value appears in any new file (assets are images; source files contain no keys).
- `git diff --check` clean; no whitespace/EOF issues.
- Auth/session initialization: unchanged except for the one flagged `loading` condition change above.
- Deep-link/reset-password handling: unchanged; the recovery-link early return in `_layout.tsx` was re-confirmed (by test) to still run before onboarding is ever considered.

### Next recommendation

1. K1 review of PR #39, with particular attention to the one flagged `loading`-gate change in section G.
2. On PASS: merge, then a separately authorized real-device build (development/internal EAS profile, not production) so the operator can see the new icon, launch screen, and onboarding flow, and confirm the page-3 CTA hit target lands correctly.
3. If page-2's animation is still wanted after that, it needs the bar's fractional region measured precisely (ideally from the design source, not a screenshot) and a real-device check before implementing the overlay — not source-only work.


## Final K1 — onboarding + icon integration

Verdict: **PASS**.

Accepted:
- PR #39 head `a781240297e66b0ed98738920cacb22940088f7d`
- merged -> `08355579ef8fd89e12e6723aed4674905440016a`
- all 4 user-approved assets matched the task's exact filename/dimension/sha256 contract before ingress
- official icon master preserved; installed app icon is 1024x1024 opaque RGB
- onboarding assets are byte-identical 1179x2556 sources
- first-run onboarding uses versioned local key `kabumori:onboarding:v1`
- 3-page horizontal paging + native page dots implemented
- page-3 visible CTA has an image-relative accessible Pressable hit target
- page-2 animated progress overlay intentionally deferred; approved static artwork retained, as explicitly allowed by the task fallback
- recovery-link precedence and existing auth/session branching remain intact
- the added `loading || onboardingCompleted === null` gate is accepted as a local presentation-read synchronization, not a material auth/session semantic change: auth initialization is still independent, no network dependency was added, and read failure fails open
- 155/155 tests PASS; src TypeScript 0 errors; Expo config/prebuild/web export/diff checks PASS
- PR head statuses: Vercel success, Netlify Deploy Preview success
- production mutation 0; no EAS build/TestFlight/App Store/Supabase/Auth/X/admin mutation
- main drift before merge touched only `.agent/` control files; PR #39 was mergeable and feature files had no cross-slot conflict
- no Codex review required under the reduced-review policy because final scope remained UI/assets/local-only state and no security/auth boundary changed

Remaining:
- real iPhone/TestFlight visual acceptance is still required
- page-3 CTA alignment should be visually checked on device
- page-2 progress animation can be reconsidered only after precise fractional measurement + real-device verification

Next gate:
- separately authorized development/internal EAS build or TestFlight-equivalent real-device pass for visual acceptance
