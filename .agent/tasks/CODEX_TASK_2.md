# Codex Task 2

- task_id: social-mobile-app-phase2-auth-data-20260917
- owner: codex
- slot: codex-2
- status: done
- next_owner: none
- priority: high
- completed_at: 2026-09-17 JST
- c2_result: PASS

## Completion summary

`apps/social-mobile` Phase 2 の Auth/data boundary をC2 PASSとする。

- implementation commit: `fb83c1568b3e8060dfc87a6bb01fc51dca455ca0`
- Supabase client foundation、AuthProvider、session restore、Sign In/Out、active account contextを実装
- `SocialOperationsRepository` を維持し、mock / Supabase adapter selectionを分離
- env missing / auth missing / permission-RLS / backend unavailableを明示状態として扱い、mockへの黙ったfallbackはしない
- client側にservice_role / DB password / OAuth secret等を埋め込まない設計を維持
- typecheck PASS / lint PASS / Expo Web export・route resolution PASS / `git diff --check` PASS
- production DB/schema/migration/RLS/RPC/OAuth/Vault/SNS API/Storage/AI/Push変更 0、deploy 0、実投稿 0

## C2 decision

PASS。Phase 2の目的である「安全なAuth/session境界と実バックエンドadapter候補」は成立している。

ただし、production `brands` / `social_accounts` / `scheduled_posts` のtenant ownership・RLS・安全なbrand relationは未証明。したがって `EXPO_PUBLIC_DATA_SOURCE=supabase` を本番有効化するのはまだ不可。

## Next

Codex slot 2 は空き。
次フェーズでは、production変更なしのread-only schema/RLS inventoryを先に完了し、必要なownership/membership/RLS/migration案を確定してからproduction data接続を判断する。
