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


## C2 review — 2026-09-18

**BLOCKED / INCOMPLETE — Phase 6はまだPASSにしない。**

確認できたこと:
- productionでauth user=1、admin_users=1、profile=1、brands=3、social_accounts=2、brand_memberships=0をread-only確認。
- user↔brandの明示的ownership relationが無く、canary membershipを推測投入しなかった判断は正しい。
- no-membership stateは設計上 fail-closed で、adapterもmembership 0件時に blocked/no-workspace を返す。
- production mutation 0。auth/OAuth/Vault/X/Push/Cron/AI/Storage/課金変更0。
- static policy contract 5/5 PASS、git diff --check PASS。

未完了:
1. 実authenticated sessionでのtenant read QA未実施。
2. cross-tenant leakage 0をproduction Auth sessionで未実証。
3. mobile authenticated write denialを実sessionで未実証。
4. local/devのSupabase data source実動作QA未実施。
5. typecheck / lint / Expo export未実行（isolated worktreeに依存関係なし）。
6. canary membershipは0件で、正当なuser↔brand mappingがまだ確定していない。

次に進める条件:
- 正当なuser↔brand mappingをユーザーまたは既存運用情報から明示的に確定する。
- そのuserで正規Auth sessionを用意し、実RLS read QAを行う。
- 依存関係が入ったlocal/dev環境でadapter QA、typecheck、lint、Expo exportを完走する。
- canaryは一意性が確定した場合のみ1件。推測投入禁止。
- production default `EXPO_PUBLIC_DATA_SOURCE=supabase` は引き続きOFF。

このslotは `review_required` のまま維持する。


## User-approved canary mapping — 2026-09-18

ユーザー承認により、Phase 6のcanary対象を以下で明示確定する。

- auth user: productionで確認済みの唯一のAuth user（Reportへ個人識別子は記録しない）
- brand: `ai_salaryman_lab`
- role: `viewer`
- purpose: 実Auth/RLS/mobile read QA専用のcanary
- scope: `brand_memberships` 1件のみ
- expectation:
  - canary userは `ai_salaryman_lab` のtenant dataのみread可
  - `kabumori` / `mio` は0件
  - membership writeはmobile authenticatedでは不可
  - service_roleをmobileへ渡さない
  - production default `EXPO_PUBLIC_DATA_SOURCE=supabase` はまだONにしない

このcanaryはテスト用。QA完了後、継続利用の正当性が未確定なら1件だけrollbackし、row count 0へ戻す。
H2は再applyやschema変更をせず、このcanary 1件のinsert → 実Auth/RLS QA → mobile adapter QA → rollback判断だけを行う。


## Canary inserted — 2026-09-18

User explicitly approved proceeding with the Phase 6 test.

Production target:
- Supabase project: stock-x-autopost
- auth user: the only current Auth user (identifier not recorded here)
- brand: `ai_salaryman_lab`
- role: `viewer`

Execution:
- first guarded SQL attempt failed before mutation because `min(uuid)` is unsupported; production mutation from that attempt = 0.
- corrected guarded SQL rechecked exactly one Auth user, active `ai_salaryman_lab`, and empty `brand_memberships` before insert.
- inserted exactly one canary membership.
- read-back: `ai_salaryman_lab / viewer / membership_count=1`.

Next H2:
- DO NOT insert another membership.
- perform actual Auth/RLS/mobile runtime QA using the existing single canary.
- verify canary sees only ai_salaryman_lab, kabumori/mio are 0, authenticated membership writes remain denied, adapter states are correct, and production default data source stays mock.
- after QA, because this row is test-only, rollback only this canary unless C2 explicitly decides to preserve it.
