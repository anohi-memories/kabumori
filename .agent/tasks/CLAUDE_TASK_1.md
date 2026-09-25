# Claude Task 1

- task_id: kabumori-approved-app-icon-integration-20260925
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
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
