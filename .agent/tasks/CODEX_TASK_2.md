# Codex Task 2

- task_id: social-mobile-app-phase5-production-membership-rls-rollout-20260918
- owner: codex
- slot: codex-2
- status: done
- next_owner: none
- priority: urgent
- recommended_model: Sol High
- c2_result: PASS
- c2_reviewed_at: 2026-09-18 JST
- completed_at: 2026-09-18 JST
- purpose: Phase 4でdisposable DB実証までPASSした `brand_memberships` + tenant RLS candidateを、productionへ最小・可逆・検証可能な形で安全に反映する。blind `supabase db push`は禁止し、preflight → exact candidate apply → postflight → admin互換確認 → rollback readinessまでを実施する。実ユーザーmembership投入とmobile data source ONは、対象が一意に安全確認できる場合のみcanaryとして行い、曖昧なら行わずC2へ返す。

## C2 review — 2026-09-18

**BLOCKED — production apply未実施のためPhase 5は未完了。**

確認済み:
- exact production preflightはPASS。
- approved candidateは `supabase/migrations/20260918120000_social_mobile_brand_memberships.sql`、SHA-256 `a74e70c42d0b10bd773dd614c70f59e807e6b08a8da90afaa05dee2fd09321fd`。
- `public.brands.id` / operational `brand_id`型・FK、対象tableのRLS、既存admin policies、`private.is_admin()`、candidate policy衝突なし、`brand_memberships`未存在をread-onlyで確認。
- `supabase_apply_migration` は本番DDL/RLS/grant操作を高リスクとして拒否。tool-recognized explicit approvalが不足していると判断された。
- `supabase_execute_sql` 等の迂回経路は使っていない。これは正しい安全停止。
- production DB/schema/RLS/grant/migration/auth/Cron/settings/deploy/Storage/AI/SNS/Push変更0。
- canary membership 0件、mobile data sourceはmockのまま。
- commit `227af897a5bd80eeca7f988341d12281af0feda9` を確認し、TASK/REPORT更新内容と整合。

### C2 decision

Phase 5の設計・preflightには新たな技術blockerは見つからないが、**本番apply・postflight・admin runtime compatibility・rollback readinessの本番確認が未実施**なのでPASSにはしない。

次に進める条件:
1. exact candidate migrationだけを適用できる、ツール側で認識可能な明示承認済みproduction DDL経路を確保する。
2. indirect SQL workaround / blind `db push` / migration history repairは使わない。
3. apply後にpostflight、既存admin経路確認、rollback readinessを実施する。
4. canary membershipは対象user/brandが一意・明示的に確認できる場合のみ1件まで。曖昧なら0件のまま。
5. `EXPO_PUBLIC_DATA_SOURCE=supabase` は実Auth/mobile read QAまでOFF維持。

ユーザーがSupabase Dashboardの stock-x-autopost / main / PRODUCTION で、approved candidate SQL全文を手動実行し、Dashboard上で "Success. No rows returned" を確認した。これをproduction apply完了のユーザー確認として扱い、slotをreadyへ戻す。次のH2では再applyせず、read-only postflight / admin compatibility / rollback readiness確認から再開する。migration historyへの記録有無もread-onlyで確認し、手動SQL実行だった場合は履歴を捏造・repairしない。canary membershipは引き続き対象が一意でなければ0件。

## Approved basis

Phase 4 C2 PASS済み:
- candidate migration: `supabase/migrations/20260918120000_social_mobile_brand_memberships.sql`
- implementation source commit: `c40c96cb66c72c671a145ebdbee2a941c648b6bb`
- disposable PostgreSQL 16でmigration apply PASS
- policy matrix PASS
- anon/non-member 0 row
- brand A/B cross-tenant leakage 0
- existing global admin compatibility PASS
- authenticated mobile membership write denial PASS
- rollback/read-back PASS
- production mutationはこれまで0

## Important stop rule

preflightでschema/policy/parallel conflictが1つでも想定外なら、production writeは0のままSTOPする。
canary対象が曖昧ならmembershipを推測投入しない。


## Final C2 decision — 2026-09-18

PASS.

確認済み:
- ユーザーが Supabase Dashboard の stock-x-autopost / main / PRODUCTION で approved candidate SQL を手動実行し、成功を確認。
- H2 postflightで `brand_memberships` の列・PK・FK・role CHECK・RLS・row count 0をread-back。
- social mobile candidate policy 6件が存在。
- authenticated は membership SELECT可、INSERT/UPDATE/DELETE不可。
- 既存 admin_* policy は保持され、`private.is_admin()` も SECURITY DEFINER / empty search_path のまま。
- 既存 operational data の意図しない変更なし。post_execution_logs増加は自然runtime活動。
- rollback readiness確認済み。正常なためrollbackは未実行。
- canary membershipは0件。user/brand mappingが一意になるまで推測投入しない。
- `EXPO_PUBLIC_DATA_SOURCE=supabase` はOFFのまま。実Auth/mobile read QAは次Phase。
- manual Dashboard applyのため migration historyには今回versionが記録されていない。今回TASKではrepair/reconcileしない。この差異は今後のmigration運用上の既知事項として扱う。

Codex slot 2は完了。次Phaseは実Auth/mobile read QAと、必要なら一意に確認できるcanary membership設定を行う。
