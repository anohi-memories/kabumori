# Claude Task 1

- task_id: kabumori-release-branding-eas-preflight-20260924
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（高）
- purpose: PR #18 merge後の次工程として、App Store提出前に残っている「Expoテンプレート表示」「アプリ表示名」「EAS production環境変数不足」をsource/readiness観点で解消・具体化する。Production deploy/build/config mutationは行わない。

## Context

PR #18はmainへmerge済み:
- reviewed head: `6f3277639bc19fb1f420cd0e771c1d77f6d23519`
- merge/main SHA: `a41b306de1cdf6e9c7e91ad7e22403a031650883`
- post-merge verification: 108/108 tests PASS, src tsc 0 errors, Expo export 10 routes, Web preview/production dry-run build PASS.

Remaining release blockers from prior audit:
1. app icon/splash still Expo template
2. app display name currently `kabumori`
3. EAS production needs:
   - EXPO_PUBLIC_SUPABASE_URL
   - EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY
   - EXPO_PUBLIC_KABUMORI_WEB_URL
4. Netlify public site/operator values/domain are separate later work
5. Auth Site URL/SMTP/App Store Connect/TestFlight are separate later work

## Mandatory startup

1. Use independent worktree/checkout.
2. Read PROJECT_RULES.md, .agent/ORCHESTRATION.md, .agent/CURRENT_STATE.md, this TASK.
3. Fresh fetch origin/main.
4. Confirm no overlap with G2/PR #19.
5. Audit current app.json/app.config/eas.json/assets and any existing Kabumori brand assets in-repo.

## Work scope

### A. Display name
- Confirm current Expo display name.
- If repo branding consistently uses 「かぶモリ」 and no conflicting approved product name exists, update the user-visible app display name to 「かぶモリ」.
- Do not change bundle identifier or URL scheme.

### B. Icon / splash
- Determine whether a real Kabumori icon/logo asset already exists in the repo and is suitable for App Store/native use.
- If a suitable official asset exists, wire it into Expo icon/splash configuration and remove only clearly-unused template references.
- If no suitable official asset exists, **do not invent or generate branding artwork in this TASK**. Leave source unchanged for icon/splash and report the exact asset specifications needed from the operator/designer.

### C. EAS production env preflight
- Audit how Expo/EAS reads the three required public env values.
- Ensure source/config/docs clearly define the required production variables.
- Do not hardcode real project values.
- Do not create/update EAS secrets or remote env values in this TASK.
- Add/adjust safe validation/documentation only if needed so a production build cannot silently ship without backend/legal-web configuration.

### D. Release-readiness doc
Update RELEASE_READINESS.md only for verified current facts:
- display name status
- icon/splash status
- EAS env preflight status
- exact remaining operator actions

## Tests

Run as applicable:
- relevant app/release tests
- src TypeScript
- Expo config/export smoke
- web/legal tests only if touched
- git diff --check

## Forbidden

- production EAS build
- TestFlight/App Store submission
- EAS remote env mutation
- Netlify deploy/domain mutation
- Supabase Auth/SMTP mutation
- DB/migration changes
- G2/PR #19 files
- X/admin/MIC work
- generating a new logo/icon without explicit asset/design approval

## Production mutation budget

0.

## Completion / K1

When complete:
- status -> review_required
- next_owner -> chatgpt
- Report:
  - fresh main SHA
  - display-name result
  - icon/splash audit + exact asset decision
  - EAS env preflight result
  - changed files
  - tests/checks
  - commit/push/PR status if source changed
  - production mutation=0
  - remaining operator inputs/actions
  - recommended next G1 task
- STOP for K1.
