# Claude Task 1

- task_id: kabumori-approved-app-icon-integration-20260925
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sonnet5（高）
- purpose: ユーザーが承認した「かぶモリ」アイコン画像を、iOS実機確認用の正式候補としてExpo/nativeへ組み込む。実機で違和感があれば後で差し替える前提。今回はアイコンだけを確実に反映し、Splash/起動Overlayは勝手に変更しない。

## User decision

ユーザー決定:
- 先ほど提示した「新聞 + 緑の上昇チャート + 葉っぱ + かぶモリ文字」の画像を、いったん正式アプリアイコン候補として採用する。
- まずiPhoneへ入れてホーム画面で確認する。
- 実機で違和感があれば後から差し替える。
- 現時点では追加のAI生成・デザイン変更をしない。

Approved source image characteristics:
- filename from user/chat: `アイコン.png`
- square source: 1254 x 1254
- fully opaque
- exact composition/color/text must be preserved
- this is the source of truth for this task

## Critical asset rule

**絶対に似た画像を再生成・描き直し・推測で再現しない。**

Claudeの作業環境から承認済み画像そのものを取得できない場合:
1. repo内を確認して、同一の承認済みsourceが存在するか探す。
2. 存在しなければsource code/configは変更せず、`USER_ASSET_REQUIRED` でSTOP。
3. 必要な配置先を明記して、ユーザーへ「承認済み `アイコン.png` をそのまま渡してください」と報告する。

別画像・Expo logo・生成画像を代用しない。

## Mandatory startup

1. Independent worktree / checkout.
2. Read:
   - PROJECT_RULES
   - .agent/ORCHESTRATION.md
   - .agent/CURRENT_STATE.md
   - this TASK
   - current Expo/app config
3. Fresh fetch origin/main.
4. Confirm G2 is limited to personalized-reports and there is no overlap with native icon/config/assets.
5. Confirm no other active slot owns the same app config/assets.
6. Preserve unrelated dirty/uncommitted work.

## Scope

Primary goal:
- replace current Expo/template **app icon** with the exact approved image
- produce deterministic native icon asset(s) required by the current Expo configuration
- make the installed iOS app display the approved icon

Allowed:
- current app icon source asset
- Expo app config fields that directly reference app icon assets
- icon-specific generated/static assets required by Expo
- narrowly scoped icon verification tests/docs

Do NOT change in this task:
- Splash artwork
- native splash config unless it is technically coupled to icon and cannot be avoided; if so STOP and report
- `AnimatedSplashOverlay`
- `assets/images/expo-logo.png`
- Yume-chan artwork
- app UI/theme/colors
- bundleIdentifier
- slug
- scheme
- projectId
- EAS credentials
- production env values
- Netlify
- Auth/SMTP
- DB/Supabase Edge Functions
- personalized-reports
- X/admin/MIC

## Image handling

If exact approved source is available:

1. Preserve an original master copy in a clear repository asset location.
2. Do not alter composition, text, colors, glow, leaf size, chart position, or newspaper design.
3. No rounded-corner mask baked into the image; iOS applies its own icon mask.
4. Convert/resize only as technically required.
5. For the 1024x1024 iOS master:
   - deterministic high-quality resize from the approved square source
   - no crop needed because source is already square
   - output must be opaque RGB/no alpha channel
   - preserve aspect ratio 1:1
6. Do not sharpen, enhance, recolor, redraw, or AI-upscale.
7. Record source and output dimensions/hash so later replacements are traceable.

## Verification

At minimum:
- inspect Expo config and current icon references
- verify no Expo template icon remains as the installed app icon path
- verify final master icon is exactly 1024x1024
- verify no alpha/transparency in final iOS icon
- verify no baked rounded corners
- run existing native/app configuration tests
- run TypeScript checks relevant to changed config if applicable
- run Expo config/prebuild/export validation appropriate to this repo
- `git diff --check`
- ensure G2/personalized-reports files untouched

If tooling can produce a local simulator/rendered icon preview without production mutation, include it, but do not treat simulator appearance as a substitute for real iPhone verification.

## Real-device gate

This task does **not** decide the icon is permanently final.

Completion means:
- code/assets are ready for the approved icon
- next release/TestFlight build can put it on an iPhone
- final visual acceptance happens after user sees it on the actual iPhone home screen

If it looks wrong on device, later replacement is allowed without reopening the design discussion from scratch.

## Production / release constraints

- no App Store submission
- no TestFlight upload unless separately authorized
- no EAS production build unless separately authorized
- no credential mutation
- no production deploy

## Completion / K1

Report:
- exact source asset used or `USER_ASSET_REQUIRED`
- source dimensions
- final icon dimensions/mode/alpha status
- changed files
- Expo config paths
- checks/tests
- commit / push / PR if created
- proof template icon is no longer used for app icon
- confirmation Splash/AnimatedSplashOverlay were untouched
- production mutation=0
- next step for iPhone/TestFlight verification

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K1.

## Report — G1 result

- task_id: kabumori-approved-app-icon-integration-20260925
- result: **source asset obtained and integrated. PR #31 is open and unmerged.** Production mutation = 0.
- fresh main at task start: `c38a7f8`; in_progress control commit `9258ab7`.

### Exact source asset used

- **Not `USER_ASSET_REQUIRED`** — the exact approved file was obtained.
- The image the user pasted inline in this chat could not be received as a file I can read/copy — the harness renders it to me visually but drops no path on disk (confirmed by searching this session's whole scratch tree for any new image before and after the paste). Per this task's Critical Asset Rule, regenerating a similar image from that visual impression is explicitly forbidden, so I stopped and asked the user where the approved file was saved on their Mac, rather than guess.
- The user pointed me to `~/Desktop/アイコン.png`. I copied that file directly (`cp`), verified its sha256 matched before and after the copy (`31eda5379951b3d8f69676add4add33ecea6d799a48545ef076bd6235949a3f8`), and confirmed its properties independently with `file`/`sips` before treating it as source of truth: **1254×1254, 8-bit RGB, no alpha** — matching the task's stated approved-source characteristics exactly.
- A second file also existed on the Desktop, `アイコンん候補.png` ("icon candidate", an earlier/different file). It was **not used** — only the exact filename and content the user pointed to (`アイコン.png`) was treated as approved.

### Final icon dimensions/mode/alpha status

- Master (preserved as-is): `assets/branding/kabumori-icon-master-2026-09-25.png`, 1254×1254, RGB, no alpha, sha256 identical to the source file.
- App icon: `assets/images/icon.png`, deterministic `sips -z 1024 1024` resize, **1024×1024, RGB, no alpha**, PNG colour type 2 (truecolor, no alpha channel) confirmed by reading the PNG's own IHDR bytes. No crop was needed (source already square). No sharpening, recoloring, or AI upscaling was applied.

### Changed files (PR #31, branch `claude1/approved-app-icon-integration`, head `8939ce9`)

- `assets/branding/kabumori-icon-master-2026-09-25.png` (new) — the preserved master
- `assets/images/icon.png` (replaced) — the 1024×1024 derived icon
- `app.json` (one field) — `ios.icon`: `./assets/expo.icon` → `./assets/images/icon.png`
- `tests/app/app-icon_test.ts` (new, 4 tests)

### Expo config paths touched / resolved

- `expo.icon` — already `./assets/images/icon.png`; content now updated.
- `expo.ios.icon` — changed from the unused Icon Composer bundle path `./assets/expo.icon` to the same flat PNG. Rationale: a flat pre-rendered image cannot be decomposed into that bundle's multi-layer format without recomposing it, which would itself be a "redraw" the task forbids; pointing `ios.icon` at a plain 1024×1024 PNG is Expo's standard, well-documented path.
- `expo.plugins` → `expo-notifications`'s `icon` — already `./assets/images/icon.png`; content now updated, unchanged path.
- `assets/expo.icon` (the old Icon Composer bundle) is **left on disk, no longer referenced anywhere** — confirmed by grep across the whole tree (excluding `node_modules`) after the change.

### Checks / tests

| Check | Result |
| --- | --- |
| `deno test --no-check --no-lock --allow-read --allow-write --allow-env tests/app/ supabase/functions/account-delete/ apps/kabumori-web/build_test.ts` | **126 passed / 0 failed** (122 existing + 4 new) |
| `npx tsc --noEmit`, `src/` scope | **0 errors** |
| `npx expo config --json` | `icon` and `ios.icon` both resolve to `./assets/images/icon.png` |
| `npx expo prebuild --platform ios --no-install --clean` | Generated `ios/app/Images.xcassets/AppIcon.appiconset/App-Icon-1024x1024@1x.png`: **1024×1024, no alpha**, and visually confirmed identical to the new master (opened both; same composition, no rounded-corner mask baked in — square edge to edge, as expected since iOS applies its own mask). Byte hash differs from `assets/images/icon.png` only because Xcode's asset-pipeline re-encodes the PNG on copy; dimensions/alpha/content are identical. |
| `npx expo export --platform web`, dummy non-secret env | PASS, **10 static routes (unchanged)** |
| `git diff --check` | PASS |

**Side effect caught and discarded, not shipped:** `expo prebuild` also generated a native `ios/` directory (already gitignored, confirmed absent from `git status`) and silently rewrote `package.json`'s `android`/`ios` npm scripts from the managed-workflow form (`expo start --ios`) to the bare-workflow form (`expo run:ios`). I reverted that `package.json` change with `git checkout -- package.json` and deleted the generated `ios/`/`android`/`.expo` directories before committing — only the icon change is in the PR.

### Proof the Expo template icon is no longer used for the app icon

- `git diff --name-only` shows `app.json`'s `ios.icon` no longer references `assets/expo.icon`.
- `npx expo config --json` confirms both `icon` fields resolve to the new file.
- The generated `AppIcon.appiconset` from a real `expo prebuild` run — the same mechanism a production build uses — contains the new artwork, not the Expo template mark.
- `assets/images/icon.png` itself was replaced with the approved artwork (confirmed visually and via PNG header).

### Confirmation Splash / AnimatedSplashOverlay were untouched

- `git diff` touches no file under `src/components/animated-icon*`, and does not change `expo-splash-screen`'s config (`image: ./assets/images/splash-icon.png`, `backgroundColor: #208AEF` — both unchanged).
- `assets/images/expo-logo.png` (used by `AnimatedSplashOverlay`) was not modified.
- A test (`splash and the animated launch overlay were not touched by this task`) pins both facts.

### Production mutation = 0

No EAS build, no EAS credential/env mutation, no TestFlight upload, no App Store Connect action, no production deploy. Only local asset/config changes committed to a PR.

### Next step for iPhone/TestFlight verification

1. K1 review and merge of PR #31.
2. A separately authorized EAS build (development/internal or preview profile — not production) that installs on the real iPhone already used for the Auth/recovery E2E, so the user can see the icon on their actual home screen.
3. Per this task's Real-device gate: this integration is **not** the final visual acceptance. If the icon looks wrong on-device (e.g. scaling, mask, contrast against the iOS home-screen background), the master asset can be swapped without reopening the design discussion — the pipeline (master → `sips` resize → config) is now in place for that.
