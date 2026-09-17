# Codex Task 2

- task_id: social-mobile-app-phase3-schema-rls-inventory-20260917
- owner: codex
- slot: codex-2
- status: done
- next_owner: none
- priority: high
- completed_at: 2026-09-18 JST
- c2_result: PASS

## Completion summary

`apps/social-mobile` Phase 3 の production schema / ownership / RLS read-only inventory をC2 PASSとする。

確認済み:
- production DB/schema/RLS/grant/RPCはread-only inspectionのみで、write/migration/deploy 0件
- `brands` / `social_accounts` / `scheduled_posts` / `post_execution_logs` 等の実schema・brand relationを確認
- `auth.users` → brand/workspace/account の一般ユーザー向けmembership/ownership relationは未成立
- `brands` / `social_accounts` は一般authenticated向け安全なtenant read pathがなく、`scheduled_posts`等もadmin-only policy中心
- mobile clientでclient-side `brand_id` filterだけを使ってRLS不足を補わない方針を維持
- `EXPO_PUBLIC_DATA_SOURCE=mock` を既定維持し、Supabase production data sourceはまだON禁止
- adapterはpermission/schema mismatchを分離し、ownership未証明時はfail-closedでblocked/unavailable
- `brand_memberships(user_id, brand_id, role)` を中心とするPhase 4最小案をdocsへ整理
- implementation commit: `c0de2dea8310cafbb2ec0824ebeef242d5c43d3f`
- tests: typecheck PASS / lint PASS / Expo Web export・route resolution PASS / `git diff --check` PASS
- production DB/schema/migration/RLS/RPC/grant/auth mutation/OAuth/SNS API/Storage/AI/Push変更 0

## C2 decision

PASS。Phase 3の目的である「安全に直接読めるresourceと、現時点で読んではいけないresourceの切り分け」「ownership/RLS不足の特定」「Phase 4最小設計案の確定」を満たしている。

現時点ではproduction data sourceをONにしてはならない。次フェーズは、Phase 4としてmembership/RLS設計をdisposable DBで先に検証し、policy matrixとmobile read contractが成立した後に、production migration適用を別承認で判断する。

Codex slot 2 は空き。
