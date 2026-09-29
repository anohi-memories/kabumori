# Claude Task 3

- task_id: x-social-mobile-account-deletion-onboarding-entry-fix-20260930
- owner: claude
- slot: claude-3
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（高）
- purpose: onboarding未完了でもaccount deletion画面へ到達できるよう、social-mobileのUI/navigationだけを修正する。

## Required
- X接続待ち、再接続、接続エラー、判定不能、新規アカウント案内などのonboarding未完了状態から削除導線を表示。
- Homeへ到達していなくてもaccount-deletion routeを開けること。
- 削除導線はsecondary actionとして表示。
- feature flag OFF時の表示は正直に維持。
- recent-auth、confirmation、session pinningは変更しない。

## Do not change
- migration
- Edge Function
- RPC
- Auth/Vault/X/Apple backend
- production config
- feature activation

production_mutation=0.

## Tests
- onboarding incomplete states expose deletion entry
- deletion route opens without Home
- feature-disabled behavior remains truthful
- existing onboarding/login/deletion tests
- typecheck/lint
- Expo web+iOS export
- diff check

## Completion / K3
Report changed_files, covered states, route behavior, tests, commit/push/PR, production_mutation=0, and whether Stage 2 E2E can resume.
Then status -> review_required, next_owner -> chatgpt, STOP for K3.
