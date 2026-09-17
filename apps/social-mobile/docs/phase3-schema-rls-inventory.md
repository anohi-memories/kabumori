# Phase 3 schema / RLS inventory

監査日: 2026-09-17 JST
対象: Supabase project `wsmznyzcvmuitkglfeuj`
方式: Supabase metadata/APIのread-only確認、checked-in migration/source確認。DB write、migration、RLS変更、grant変更、RPC変更は実施していない。

## Productionで確認できた関係

| resource | 主キー/主な列 | tenant relation | RLS / mobile read |
| --- | --- | --- | --- |
| `public.brands` | `id`, `display_name`, `is_active`, `publish_mode`, `code_profile_key` | root tenant table | RLS enabled。authenticated grant/policyなし（service_roleのみ確認）→ mobile不可 |
| `public.social_accounts` | `id`, `brand_id`, `platform`, `handle`, `platform_user_id`, `publish_enabled`, `connection_status`, Vault secret id列 | `brand_id → brands.id` | RLS enabled。authenticated grant/policyなし（service_roleのみ確認）→ mobile不可 |
| `public.scheduled_posts` | `id`, `schedule_date`, `post_type`, `slot_no`, `scheduled_for`, `status`, `attempt_count`, `brand_id` | `brand_id → brands.id` | RLS enabled。authenticated SELECT grantはあるがpolicyは`private.is_admin()`のみ→一般mobile user不可 |
| `public.post_execution_logs` | `scheduled_post_id`, `post_type`, `status`, `x_post_id`, `message`, `created_at`, `brand_id`ほか | `brand_id → brands.id`, scheduled FK | RLS enabled。authenticated SELECTは`private.is_admin()`のみ→一般mobile user不可 |
| `public.posting_windows` | `post_type`, `slot_no`, `start_time`, `end_time`, `timezone`, `is_active`, `brand_id` | `brand_id → brands.id` | RLS enabled。authenticated SELECT/UPDATE grantはあるがpolicyはadmin-only |
| `public.posting_blackouts` | `name`, `start_time`, `end_time`, `timezone`, `is_active` | global | RLS enabled。authenticated SELECT policyはadmin-only |
| settings | `morning_report_settings`, `close_report_settings`, `important_news_monitor_settings`, `useful_tip_schedule_settings` | 一部`brand_id` | RLS enabled。dashboard/admin向け。mobile Phase 3では直接読まない |
| user-owned resources | `profiles`, `tracked_stocks`, `alert_settings`, `notifications`, `device_push_tokens`, `personalized_reports`, `alert_category_settings` | `auth.users.id`/`profiles.id` | authenticated + `auth.uid()`のown-row policyを確認。social operations tenantとは別モデル |

`scheduled_posts`のproduction列には`generated_text`はなく、投稿本文は別の実行ログ/生成テーブルを辿る必要がある。mobileのPhase 2 adapterは本文を推測せず空値とし、production readがblockedなら表示しない。

## Auth → ownership判定

現時点の結論は **D: `auth.users.id`からbrand/workspace/accountへ直接結ぶmembership/owner relationは確認できない**。

- `profiles.id → auth.users.id` は存在し、個人向けテーブルはown-row RLSで保護されている。
- `brands`/`social_accounts`/`scheduled_posts`は`brand_id` FKで相互には結ばれるが、`auth.users`またはmembership tableへのFKは確認できない。
- `admin_users.user_id → auth.users.id` と `private.is_admin()` は管理画面用のadmin境界であり、social mobileのtenant membershipを表さない。
- production metadataで`brands`/`social_accounts`へのauthenticated grant/policyは確認できず、`scheduled_posts`/logs等もadmin-only policyである。

従って、publishable/anon key + authenticated sessionのmobileから、ブランド横断を防ぎつつ直接読む安全な経路は現状ない。client-side `eq('brand_id', ...)`だけで解決してはならない。

## RPC / SECURITY DEFINER

`private.is_admin()`は`SECURITY DEFINER`、empty `search_path`、authenticated EXECUTEを確認した。`get_my_important_stock_news(integer)`もSECURITY DEFINER/empty `search_path`/authenticated EXECUTEだが、これは個人向け重要ニュース用であり、brands/social accountsのtenant read RPCではない。今回mobile向けRPCは作成・変更していない。

## Mobile domain mapping（候補）

| mobile model | source | transform / gap | 判定 |
| --- | --- | --- | --- |
| `Workspace` | `brands.id`, `display_name`, `publish_mode` | planはDB列がなくplaceholder。`brand_id='kabumori'`に限定する候補 | blocked until RLS/membership |
| `SocialAccount` | `social_accounts.id`, `platform`, `handle`, `connection_status`, `publish_enabled` | voice/avatarは別設定が必要。Vault secret列は絶対に選択しない | blocked until RLS/membership |
| `PlannedPost` | `scheduled_posts.id`, `scheduled_for`, `post_type`, `status`, `brand_id` | account FKがなく、本文列もない。statusはpending/running/succeeded/failed→domain statusへ変換 | blocked until tenant policy; account/text gap |
| `PostOrigin` | post_type/statusからの推定 | 正本origin列なし。AI生成等を断定しない | placeholder only |
| `UsageSummary` / `PlanTier` | confirmed sourceなし | plan/usage table・brand entitlement relationが未確認 | unavailable |

## 最小のPhase 4提案（未適用）

1. `brand_memberships`（`brand_id`, `user_id`, `role`, `created_at`, unique `(brand_id,user_id)`、両FK）を追加し、必要なら`social_account_memberships`はbrand membershipから導出する。
2. brands/social_accounts/scheduled_posts/logs/settingsのSELECT policyを`to authenticated using (exists membership for auth.uid() and row.brand_id)`で分離する。UPDATE/INSERTは別policyにし、`WITH CHECK`でbrand reassignmentを防ぐ。
3. mobileはtenant-scoped read RPCまたは直接SELECTのどちらか一方に統一する。RPCを採用する場合はprivate/non-exposed schemaまたは明示的なauthenticated EXECUTE、empty search_path、関数内の`auth.uid()` membership checkを必須にする。SECURITY DEFINERを単なるRLS回避目的で追加しない。
4. `scheduled_posts`へ`social_account_id`と本文の正本参照（または安全なread view）を追加するかを、既存投稿経路と整合させて別C2承認で決める。
5. production適用前にdisposable DBでpolicy matrix（member/non-member/admin/anon、brand A/B、read/write）をテストし、mobile adapterの`ready/blocked/unavailable`を再確認する。

## Current decision

`EXPO_PUBLIC_DATA_SOURCE=mock`を既定のまま維持する。Supabase sourceをproductionでONにしてはならない。現状のadapterは実在production列（`brand_id`を含む）だけを選択し、permission/schema mismatchを区別して、ownership/RLSが証明できない場合はblocked/unavailableで停止する。
