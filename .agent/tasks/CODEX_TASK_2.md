# Codex Task 2

- task_id: social-mobile-app-phase4-disposable-db-proof-20260918
- owner: codex
- slot: codex-2
- status: done
- next_owner: none
- priority: high
- completed_at: 2026-09-18 JST
- c2_result: PASS

## Completion summary

`apps/social-mobile` Phase 4 disposable DB proof をC2 PASSとする。

確認済み:
- productionとは無関係のPodman PostgreSQL 16 disposable runtimeで実証
- candidate migration `supabase/migrations/20260918120000_social_mobile_brand_memberships.sql` apply PASS
- `brand_memberships` PK/FK/role/RLS/policy/grant read-back PASS
- authenticated non-memberは全resource 0 row
- brand A member/viewerはAのみ、brand B memberはBのみread可能
- brand A/B cross-tenant leakage 0
- membership無しglobal adminは既存 `private.is_admin()` pathでA/B read可能
- authenticated mobile roleのmembership INSERT拒否 PASS
- rollback後 `brand_memberships` / candidate policyが消え、既存admin policy 5件が残ることをread-back確認
- static contract 5/5 PASS / typecheck PASS / lint PASS / Expo Web export PASS / `git diff --check` PASS
- production DB/schema/RLS/grant/RPC/migration/auth/OAuth/Vault/SNS/Storage/AI/Push/Cron変更 0

## C2 decision

PASS。前回C2で未完了だった「実disposable DBでのapply → policy matrix → cross-tenant isolation → admin compatibility → mobile write denial → rollback」の全必須条件を満たした。

設計上は `brand_memberships` + direct SELECT + RLS をproduction候補としてレビュー可能な状態。

ただし production にはまだ未適用。`EXPO_PUBLIC_DATA_SOURCE=supabase` もまだ既定ONにしない。

## Next

Codex slot 2 は空き。
次段階は、別承認のproduction rollout taskとして preflight → migration/RLS apply → postflight → 実membership/read確認 → rollback readiness を安全に実施するか判断する。
