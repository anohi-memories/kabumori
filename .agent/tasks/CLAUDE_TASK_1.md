# Claude Task 1

- task_id: kabumori-onboarding-icon-integration-20260926
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
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
