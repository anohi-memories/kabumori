# Claude Task 3

- task_id: x-social-mobile-account-deletion-onboarding-entry-fix-20260930
- owner: claude
- slot: claude-3
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（高）
- purpose: Stage 2 E2Eで発見した release blocker をUIだけで修正する。オンボーディング未完了でもユーザーがアカウント削除画面へ到達できるようにする。

## Context

Stage 2 production E2E was stopped before any destructive action because:
- onboarding incomplete states currently hide the main app
- those states expose logout only
- account deletion has no reachable entry
- therefore never-connected / failed-connect users cannot self-delete

Production mutation during blocked E2E: 0.

## Scope

Modify only the social-mobile client UI/navigation needed so that account deletion is reachable from all onboarding-incomplete states, including:
- X connection pending
- reconnect required
- connection error
- indeterminate onboarding state
- first-account notice / equivalent pre-home states

Requirements:
- add a clear "アカウントの削除" entry to the relevant onboarding shell/state UI
- deletion route must be reachable without completing X onboarding
- preserve existing recent-auth / confirmation / session-pinning deletion protections
- preserve existing login/onboarding behavior otherwise
- do not weaken or bypass server gates
- do not change migration, Edge Function, RPC, Vault, Auth provider config, X OAuth backend, or production settings

## UX constraints

- destructive action must not look like the primary CTA
- entry should be discoverable but visually secondary
- copy should remain truthful when deletion feature flag is disabled
- if the flag is disabled, route/entry behavior must not falsely imply deletion is live
- support both web and native routing as currently structured

## Tests required

Add/adjust tests proving:
1. never-connected onboarding state exposes deletion entry
2. reconnect/error/indeterminate states expose deletion entry
3. route opens account deletion screen without Home access
4. feature-disabled behavior remains truthful
5. existing onboarding/login tests remain green
6. deletion client tests/session pinning remain green

Run:
- social-mobile tests
- typecheck
- lint
- Expo web export
- Expo iOS export
- git diff --check
- secret scan

## Production constraints

No:
- production DB changes
- Edge deploy
- Auth/Vault/X/Apple mutation
- real account deletion
- feature activation
- provider console changes

production_mutation=0.

## Completion / K3

Report:
- PASS / FAIL
- changed_files
- exact UI states covered
- route behavior
- tests
- commit/push/PR
- production_mutation=0
- whether Stage 2 E2E can resume

Then status -> review_required, next_owner -> chatgpt, STOP for K3.
