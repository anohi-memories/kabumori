# Codex Task 2

- task_id: social-mobile-app-phase4-disposable-db-proof-20260918
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sol Medium/High
- purpose: 前回Phase 4で作成した `brand_memberships` / tenant RLS candidateを、実際の隔離PostgreSQL環境へ適用してpolicy matrix・cross-tenant isolation・admin compatibility・rollbackを実証する。production DBには一切適用しない。

## Context / previous C2 decision

前回Phase 4で以下までは成立済み:
- membership/RLS設計候補
- migration candidate: `supabase/migrations/20260918120000_social_mobile_brand_memberships.sql`
- mobile contract: direct SELECT + RLS
- static contract tests 5/5 PASS
- typecheck / lint / Expo Web export / diff-check PASS
- production mutation 0

ただし必須条件だった **disposable DBへの実migration apply → policy matrix → rollback実証** が、PostgreSQL/Podman runtime不在で未実行だったためC2は全体PASSにしていない。

このTASKはその未完了部分だけを完遂する。

## Mandatory startup / safety

開始前に必ず確認:
1. `.agent/ORCHESTRATION.md`
2. `.agent/CURRENT_STATE.md`
3. this TASK
4. `.agent/CODEX_REPORT_2.md`
5. fresh `origin/main`
6. H1/G1/G2の現行TASK

並行安全:
- H1のAI Lab領域、G1のmarket-report/x-test-post/personalized-reports領域、G2領域を変更しない
- 既存未コミット変更は他workstream所有として触らない
- production projectへのwrite系commandは禁止
- push前にfresh `origin/main`再確認

## Absolute production boundary

許可:
- `/private/tmp` 等の使い捨て環境
- isolated PostgreSQL / Supabase local stack / disposable container
- fixture作成
- candidate migration apply / rollback
- local/disposable policy matrix実行
- read-only production metadata再確認（必要最小限）
- docs/test harness/TASK/Report更新

禁止:
- production DB write
- production migration/RLS/grant/RPC適用
- `supabase db push`
- migration history repair/reconcile
- production auth user作成/削除/更新
- production Edge Function deploy
- OAuth/Vault/token/secret変更
- X/Instagram/Threads投稿
- Storage/AI/Push/課金/Cron/settings変更

**production mutationは0件で完了すること。**

## Goal 1 — disposable PostgreSQL runtimeを用意

環境に既存runtimeが無ければ、productionとは切り離された方法で一時環境を用意する。

優先順:
1. 既存利用可能なlocal PostgreSQL/Supabase runtime
2. Docker/Podman等のisolated container
3. その他の使い捨てPostgreSQL runtime

条件:
- production URL/DB credentialを絶対に流用しない
- runtime準備のためにhostの恒久設定を壊さない
- runtime用ファイルはrepo本体へ不要に混ぜない
- runtime準備自体が安全にできない場合は、具体的な環境blockerをReportしてSTOP

## Goal 2 — production-compatible fixture schema

candidate migration適用前に、Phase 3で確認したproduction互換の最小fixtureを作る。

最低限:
- `auth.users`
- `public.brands`
- `public.social_accounts`
- `public.scheduled_posts`
- `public.post_execution_logs`
- `public.posting_windows`
- `private.is_admin()` 相当の既存admin path
- RLS enabled状態

型/FKはproductionで確認済みの型に合わせる。
存在しないproduction列を都合よく追加してmigrationを通さない。

## Goal 3 — candidate migration実apply

対象:
`supabase/migrations/20260918120000_social_mobile_brand_memberships.sql`

検証:
- apply成功
- `brand_memberships` table存在
- `(brand_id,user_id)` PK/unique
- `brand_id → brands.id` FK
- `user_id → auth.users.id` FK
- role check
- RLS enabled
- authenticated own-membership SELECT policy
- operational tableのtenant SELECT policy
- authenticated mobile roleへのmembership write grant無し
- 既存admin policyが削除/置換されていない

apply失敗時はcandidate SQLをproduction都合で弱めない。原因を修正可能ならcandidate側だけ直し、再applyして検証する。

## Goal 4 — policy matrixを実行

fixture:
- user A member/viewer
- user A owner/admin相当
- user B member
- authenticated non-member
- global admin相当
- anon
- service/backend相当
- brand A / brand B
- 各brand配下のsocial_accounts / scheduled_posts / logs / posting_windows

最低限期待値:
- anon → 0 row
- authenticated non-member → 0 row
- A member/viewer → Aだけread可、Bは0
- A owner/admin membership → Aだけread可
- B member → Bだけread可、Aは0
- existing global admin → 従来admin pathでA/B双方必要範囲をread可
- membership INSERT/UPDATE/DELETE → mobile authenticated roleでは不可
- client側の `.eq('brand_id', ...)` が無くてもRLSだけでcross-tenant漏洩0
- service/backend pathはfixture作成・backend責任範囲として成立

`auth.uid()`相当のclaim/session contextを各actorごとに正しく再現してテストすること。

## Goal 5 — admin compatibility

必ず確認:
- 既存 `private.is_admin()` pathをcandidateが壊していない
- admin policyとmembership policyのOR合成が期待どおり
- adminにmembership行が無くても既存admin経路が成立

admin compatibilityが崩れるならPhase 4はFAILとしてC2へ返す。

## Goal 6 — rollback proof

同じdisposable DBでcandidate追加object/policyをrollback/cleanupし、少なくとも:
- `brand_memberships`削除
- candidate policy削除
- fixture baselineの既存admin policyが残る
- candidate適用前と同等のobject/policy状態へ戻る

をread-backで確認する。

## Goal 7 — mobile read contract再確認

実policy matrixが通った結果をもとに、以下を最終確認:
- direct SELECT + RLSを採用継続してよいか
- membership 0件 → blocked/no-workspace
- active accountはmembershipで許可されたbrand配下accountのみ
- Vault/OAuth/token/secret列はselectしない
- `scheduled_posts`のaccount/body/origin gapは未解決のまま誤帰属しない
- `EXPO_PUBLIC_DATA_SOURCE=mock` default維持
- production Supabase sourceはまだONにしない

必要なら `apps/social-mobile` のtest/docsだけ修正可。production接続をONにはしない。

## Required verification

最低限:
- disposable migration apply PASS
- policy matrix PASS
- cross-tenant isolation PASS
- admin compatibility PASS
- mobile membership write denial PASS
- rollback/read-back PASS
- existing static contract test PASS
- `npm run typecheck` PASS
- `npm run lint` PASS
- Expo Web export/route resolution PASS
- `git diff --check` PASS

## Completion criteria

C2へ返す時点で明確にする:
1. 何のruntimeでdisposable proofを行ったか
2. exact migration/candidate commit
3. apply結果
4. actor × resource matrix結果
5. brand A/B横断漏洩が0か
6. admin compatibilityが成立するか
7. rollbackが実証できたか
8. production適用に残るblocker
9. production mutation 0

## Completion procedure

完了時:
- `.agent/CODEX_REPORT_2.md` 先頭にPhase 4 disposable proof reportを追加
- exact runtime / commands概略 / source base / implementation commit / tests / matrix / rollback / production mutation 0を記録
- this TASKを `status: review_required`, `next_owner: chatgpt`
- push前fresh-check
- origin/mainへ安全にpush
- push後read-back
- STOPしてC2待ち

## Decision rule

**実DBでpolicy matrix・cross-tenant isolation・admin compatibility・rollbackの全てが通るまではPhase 4完了扱いにしない。**
productionへの適用は、このTASKでは絶対に行わない。
