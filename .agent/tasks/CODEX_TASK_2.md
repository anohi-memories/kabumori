# Codex Task 2

- task_id: social-mobile-app-phase6-auth-mobile-read-qa-20260918
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sol High
- purpose: Phase 5でproductionへ反映済みの `brand_memberships` + tenant RLSを使い、実Auth user / canary membership / mobile read contractを本番で最小・可逆に検証する。`EXPO_PUBLIC_DATA_SOURCE=supabase` の既定ONはまだ行わず、実ユーザー境界・cross-tenant isolation・no-membership stateを証明してから次段階へ進む。

## Approved basis

Phase 5 C2 PASS:
- production `brand_memberships` table / PK / FK / role CHECK / RLS確認済み
- social mobile candidate policy 6件確認済み
- authenticated membership SELECT可、INSERT/UPDATE/DELETE不可
- existing admin policies / `private.is_admin()` preserved
- rollback readiness確認済み
- canary membershipは0件
- `EXPO_PUBLIC_DATA_SOURCE=supabase` はOFF
- migrationはDashboard手動適用のためmigration history未記録。repair/reconcileは禁止

## Mandatory startup / safety

開始前:
1. `.agent/ORCHESTRATION.md`
2. `.agent/CURRENT_STATE.md`
3. this TASK
4. `.agent/CODEX_REPORT_2.md`
5. H1/G1/G2の現行TASK
6. fresh `origin/main`

競合:
- H1/G1/G2のschema/RPC/Function/workflowを変更しない
- `x-test-post` / market-report / daily_content_plansを変更しない
- push前fresh `origin/main`
- 既存未コミット変更は他workstream所有

## Production boundary

許可:
- production auth/user/brand/account relationのread-only確認
- `brand_memberships` への **1 user × 1 brand のcanary INSERTのみ**（下記条件を全て満たす場合）
- canary INSERT後のread-only QA
- 必要ならそのcanary membership 1件だけ削除してrollback
- `apps/social-mobile/**` のQA用最小修正・test/docs更新
- local/dev環境でSupabase sourceを明示ONにして実Auth read確認

禁止:
- auth user作成/削除/更新
- 複数membership投入
- user/brandの推測対応付け
- candidate外schema/RLS/grant/RPC変更
- migration history repair/reconcile
- blind `supabase db push`
- OAuth/Vault/token/secret変更
- X/Instagram/Threads投稿
- Cron/settings/Push/課金/Storage/AI本接続
- production app configで `EXPO_PUBLIC_DATA_SOURCE=supabase` を既定ON
- service_roleをmobileへ入れる

## Gate 1 — canary対象の一意性確認

read-onlyで以下を確認:
- production auth user候補
- brand候補
- social_accountsとの既存relation
- admin/profile/運用metadata等、正当なowner/admin関係を示す既存の明示的根拠

canary INSERT条件:
- userが一意
- brandが一意
- user↔brandの正当な対応が既存relationから明示的
- roleを最小権限で説明できる
- 個人情報やtokenをReportへ記録しない

1つでも曖昧なら:
- membership INSERT 0
- no-membership stateのread-only QAだけ行う
- blockerとしてC2へ返す
- 推測投入禁止

## Gate 2 — optional single canary membership

Gate 1全条件PASS時のみ:
- `brand_memberships` に1件だけinsert
- roleは検証目的に必要な最小権限。原則 viewer/member を優先し、owner/adminは明確な理由がない限り使わない
- insert前後のrow count / exact brand_id / user_id対応は内部確認し、Reportにはsecret/個人情報を残さない
- insert失敗時にgrant/RLSを緩めない

## Gate 3 — Auth / RLS read QA

最低限確認:
- no-membership authenticated user → membership 0 / workspace blocked
- canary user → 自分のmembershipだけread
- canary user → 自分のbrandだけread
- 他brandのbrands/social_accounts/scheduled_posts/post_execution_logs/posting_windowsは0
- client-side brand filter無しでもRLSでcross-tenant leakage 0
- membership INSERT/UPDATE/DELETEはmobile authenticated権限では不可
- Vault/OAuth/token/secret列はselectしない
- service_role非使用

可能なら実Supabase Auth session / access tokenを正規のclient pathで使う。
token値はログ/Reportへ残さない。

## Gate 4 — mobile adapter QA

`apps/social-mobile` のSupabase adapterで:
- `EXPO_PUBLIC_DATA_SOURCE=supabase` を **local/dev sessionだけ** 明示して動作確認
- signed-out → auth required
- signed-in no membership → blocked/no-workspace
- signed-in canary → tenant-scoped workspace/accounts/posts read
- permission denied / schema mismatch / unavailableの分類維持
- mockへsilent fallbackしない
- active accountはmembership許可brand配下のみ
- `scheduled_posts` の account/body/origin gapは推測表示しない

production default/envはmockのまま。

## Gate 5 — canary rollback decision

QA後:
- 次Phaseで継続利用する正当なmembershipなら保持してよいが、保持理由を明記
- 単なる試験fixtureならその1件だけ削除してread-back
- 削除後 no-membership stateへ戻ることを確認
- 他rowは触らない

## Known migration-history issue

Dashboard手動適用により `20260918120000_social_mobile_brand_memberships.sql` はmigration history未記録。
このPhaseでは:
- history repair/reconcile禁止
- `db push`禁止
- 既知事項としてReportするだけ

## Verification

最低限:
- Gate 1 identity/mapping decision
- no-membership QA PASS
- canary実施時: membership self-read PASS
- canary実施時: own brand read PASS
- cross-tenant leakage 0
- mobile authenticated write denial PASS
- adapter state QA PASS
- `npm run typecheck`
- `npm run lint`
- Expo Web export / route resolution
- `git diff --check`
- production mutationは最大canary membership 1件のみ（保持またはrollbackを明記）
- auth/OAuth/Vault/X/Push/Cron/AI/Storage/課金変更0

## Completion criteria

C2へ返す時:
1. canary user/brandを一意特定できたか
2. canaryを入れたか、0件なら理由
3. no-membership state
4. authenticated tenant read結果
5. cross-tenant leakage 0か
6. mobile write denial
7. adapter QA結果
8. canaryを保持/rollbackしたか
9. production default data sourceはOFFか
10. migration history未記録をrepairしていないか
11. 次Phaseでdata source切替に進める条件

完了時:
- `.agent/CODEX_REPORT_2.md` 先頭にPhase 6 report
- this TASK → `review_required`, `next_owner: chatgpt`
- push前fresh-check
- origin/mainへ安全にpush
- push後read-back
- STOPしてC2待ち

## Important stop rule

user↔brand mappingが一意・明示的でなければcanaryを推測投入しない。
RLS/ACLが想定外なら権限を緩めず、production mutationを最小化したままC2へ返す。
