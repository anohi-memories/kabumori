# Social mobile Phase 4: membership / RLS contract (candidate)

監査日: 2026-09-18 JST  
対象: Supabase project `wsmznyzcvmuitkglfeuj`  
状態: **production未適用の候補**

## 採用する境界

`auth.users.id` と `public.brands.id` を `public.brand_memberships` で結ぶ。1行は
`(brand_id, user_id)` の組み合わせで一意とし、role は `owner` / `admin` /
`member` / `viewer` の4値に限定する。メンバーシップの書込みは backend/service-role
だけに残し、mobile は本人の membership 行と所属 brand の read のみを行う。

`brands`、`social_accounts`、`scheduled_posts`、`post_execution_logs`、
`posting_windows` の SELECT policy は、対象行の `brand_id` とログイン中の
`auth.uid()` に一致する membership が存在する場合だけ許可する。既存の
`private.is_admin()` による管理者 policy は削除・置換せず、RLSのOR合成で引き続き
管理画面から読める状態を維持する。

## Production schema compatibility preflight

Phase 3のproduction metadataで以下を確認済み:

- `brands.id` は `text`。
- `social_accounts.brand_id`、`scheduled_posts.brand_id`、
  `post_execution_logs.brand_id`、`posting_windows.brand_id` は `text` で、
  `brands.id` へのFKがある。
- `auth.users.id` は UUID。
- 全対象テーブルはRLS enabled。既存admin policyは `private.is_admin()` を使う。

候補migrationはこれらを最初にassertし、欠落時は
`PHASE4_PREFLIGHT_MISSING_*` でトランザクション全体を停止する。存在しない列を
推測して部分適用しない。

## Policy matrix (期待値)

| actor | membership read | brand A row | brand B row | operational A rows | writes |
| --- | ---: | ---: | ---: | ---: | ---: |
| anon | 0 | 0 | 0 | 0 | 0 |
| authenticated non-member | 0 | 0 | 0 | 0 | 0 |
| brand A viewer/member | own A row | 1 | 0 | 1 | 0 |
| brand A owner/admin | own A row | 1 | 0 | 1 | backend only |
| brand B member | own B row | 0 | 1 | 0/1 (B only) | 0 |
| existing global admin | existing admin path | existing admin path | existing admin path | existing admin path | existing admin rules |
| service role | backend policy | backend policy | backend policy | backend policy | backend only |

匿名・非memberには行を返さない。A memberからBの行を読むことはできない。
client-side `brand_id` filterだけで境界を作らず、RLSを唯一のtenant境界とする。

## Mobile read contract

Phase 4では **直接SELECT + RLS** を採用する。membershipを先に読み、返された
`brand_id`集合だけを `brands` / `social_accounts` / `scheduled_posts` へ渡す。
membershipが0件なら `blocked/no-workspace` とし、mockへ黙ってfallbackしない。
42501は権限blocked、42P01/42703はschema unavailable、その他はunavailableとして
UIへ明示する。`EXPO_PUBLIC_DATA_SOURCE=mock` の既定値は維持する。

アプリが選択しない列:

- OAuth/Vault secret id・ciphertext、access/refresh token
- service role key、AI/X secret
- ownershipを推測するための `user_metadata`

active accountはmembershipで得たbrandに属する `social_accounts.id` だけから選択する。
現production `scheduled_posts` には `social_account_id` と本文正本がないため、
Phase 4でも `PlannedPost.accountId` / `text` は推測せず gap として扱う（adapterは
`accountId: "unknown"` とし、先頭アカウントへの誤帰属をしない）。

## Operational gap / follow-up

`scheduled_posts` は brand FKは持つが account FK・本文・origin正本を持たない。
Phase 4では列追加を行わない。既存投稿経路と衝突しない read view または detail
relation を別TASKで設計し、mobileが本文やaccountを誤って表示しないことを優先する。
plan/usage tierの安全なsourceも未確認のため unavailable とする。

## Disposable proof procedure (productionでは実行しない)

1. 隔離PostgreSQLで `supabase/migrations/20260918120000_social_mobile_brand_memberships.sql`
   を単一transactionとしてapplyする。
2. `information_schema`、`pg_constraint`、`pg_policies`、`information_schema.role_table_grants`
   でtable/FK/PK/check/RLS/grantをread-backする。
3. auth user 2名、brand A/B、各membershipと運用行をfixtureにし、
   `apps/social-mobile/docs/phase4-policy-matrix.sql` のmatrix assertionを実行する。
4. A memberがBを読めないこと、anon/non-memberが0行であること、既存admin policyが
   残ることを確認する。
5. `drop policy` と `drop table` を同一の隔離DBで実行し、migration前のobject一覧へ
   戻ったことを確認する。

disposable proofはPodman上の一時PostgreSQL 16（container `kabumori-h2-pg`、
production資格情報なし）で実施した。candidate apply、object/FK/PK/check/RLS/grant
read-back、anon/non-member/A member/B member/admin/service_role matrix、mobile
membership write拒否、rollbackをすべてPASSし、確認後containerは削除済みである。

## Rollout guardrails

- production migration / RLS / grant / RPC / Cron / settings はこのPhaseでは0。
- blind `supabase db push`、migration history repair/reconcileは禁止。
- production適用時は別C2承認でpreflight → apply → policy matrix → postflight → rollback
  手順を実施する。
