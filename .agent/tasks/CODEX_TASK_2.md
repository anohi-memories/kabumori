# Codex Task 2

- task_id: social-mobile-app-phase10-production-oauth-rollout-20260920
- owner: codex
- slot: codex-2
- status: ready
- next_owner: codex
- priority: high
- recommended_model: Luna
- purpose: C2 PASS済みのgeneral-user X OAuth onboardingをproductionへ安全に導入する。対象は承認済みmigrationの本番適用と新規Edge Function x-oauth-connect-user のdeploy/postflightまで。X Developer Portalの手動設定と実X OAuth round-tripは別ゲートとして扱う。

## Approved basis

前H2 `social-mobile-app-phase9-codex-handoff-integration-20260919` はFinal C2 PASS済み。

承認済み要点:
- App login = Supabase Auth
- X OAuth = connected publishing account
- general-user flow = `x-oauth-connect-user` + authenticated-only RPCs
- state/PKCE/retry/idempotency/replay/concurrency security proof PASS
- mobile Accounts/deep-link UI candidate integrated
- exact X OAuth scope:
  - `tweet.read`
  - `users.read`
  - `tweet.write`
  - `media.write`
  - `offline.access`
- OAuth 19/19 PASS
- onboarding 8/8 PASS
- full Deno 1259/1259 PASS
- lint/typecheck/Expo export/diff-check PASS
- production mutation before this task = 0

## Mandatory startup

開始前に必ず確認:
1. `.agent/ORCHESTRATION.md`
2. `.agent/CURRENT_STATE.md`
3. this TASK
4. `.agent/CODEX_REPORT_2.md`
5. H1/G1/G2 TASK
6. fresh `origin/main`
7. production project identity read-only
8. approved migration source/hash read-only
9. production current schema/RPC/index/function metadata read-only
10. current deployed `x-oauth-connect` / related production OAuth metadata read-only

競合時STOP:
- 他slotが同じ migration/RPC/Edge Function/OAuth/Vault production設定を変更中
- fresh mainに承認済みcandidateと競合する変更がある
- production schemaがpreflight前提からdriftしている

## Production target

production Supabase project:
- project: `stock-x-autopost`
- ref: `wsmznyzcvmuitkglfeuj`
- main / PRODUCTION

対象:
1. `supabase/migrations/20260919120000_social_mobile_x_oauth_onboarding.sql`
2. `supabase/functions/x-oauth-connect-user/**`

既存admin `x-oauth-connect` は変更禁止。

## Gate A — fresh production preflight

read-onlyで確認:
- approved migration fileがmain上でC2 PASS時と同一意味
- `social_accounts(platform, platform_user_id)` unique indexがまだ無い/互換
- `social_account_oauth_states.initiated_by_user_id`の存在有無
- 新RPC3本の存在有無/シグネチャ
- current grants/RLS/admin policies
- Vault functions availability
- existing production brands/social_accounts/memberships rowsは変更対象でない
- migration history gapを再確認

重要:
- **blind `supabase db push`禁止**
- migration history repair/reconcile禁止
- repo filename timestampをproduction履歴へ無理に合わせない
- productionが既に一部適用済みならSTOPしてC2へ戻す

## Gate B — production migration apply

Gate A PASS時のみ。

適用:
- 承認済みmigration SQLを**そのまま1回だけ**安全なmigration/query経路で適用
- exact source/hashをReportへ記録
- schema/RPC/grant以外のproduction mutation禁止

post-apply read-back:
- partial UNIQUE index
- `initiated_by_user_id` FK/nullable
- new RPC signatures
- SECURITY DEFINER
- search_path
- EXECUTE:
  - authenticated = yes
  - public = no
  - anon = no
  - service_role = no
- existing admin policies/RLS unchanged
- existing admin x-oauth-connect RPC/functions unchanged
- existing brand/social_account rows unchanged

migration apply失敗時:
- workaroundや手修正をせずSTOP
- partial stateをread-only確認してReport

## Gate C — Edge Function deploy

Gate B PASS後のみ。

deploy対象:
- **`x-oauth-connect-user` only**

要件:
- approved main source only
- secretsは既存server-side environmentを参照
- service_roleをclientへ露出しない
- `verify_jwt`方針はcurrent Supabase/Auth architectureと整合させる。Function内部でuser JWTを検証する既存設計を維持し、設定変更理由をReport。
- existing `x-oauth-connect` version/source/configを変更しない

post-deploy:
- ACTIVE version/read-back
- deployed source/hashがapproved sourceと一致
- unrelated Functions version不変
- no test/manual real X authorization yet

## Gate D — safe production smoke without real X OAuth

実ユーザーXアカウントを接続しない範囲のみ。

許可:
- unauthenticated requestが401/fail-closedすること
- malformed requestが安全にrejectされること
- production metadata/read-only checks

禁止:
- real OAuth authorization URLをユーザーのXアカウントで完遂
- X token exchange
- Vault token write
- social_accounts/brands/membership test fixture作成
- X API post/media upload
- synthetic production OAuth fixture
- admin production account再接続

## Manual X Developer Portal gate

本タスクではPortalを勝手に変更しない。

必要な手動設定としてReportに正確に出す:
- callback/deep-link URI: `kabumori-social://oauth-callback`
- app permission/scopesが posting/media/refresh に対応する設定
- current X app/clientとの整合

Portal設定が済んでいない場合:
- production backend rolloutまでは完了可能
- real OAuth round-tripは未実施としてSTOP

## Real OAuth round-trip gate

**このTASKでは自動実行しない。**

理由:
- 実ユーザーのX認可
- production Vault token write
- production brand/social_account ownership row作成
を伴うため。

Portal設定後、ユーザーが明示的に許可した別H2で:
- non-admin QA Auth user
- dedicated test X account
- one real OAuth round-trip
- tenant isolation/read-back
- cleanup/retain decision
を行う。

## Production forbidden

- existing `x-oauth-connect` mutation
- existing AI Lab/kabumori/mio social account mutation
- existing Vault token rotate/delete
- Cron
- X real post/media upload
- Push/AI/Storage/billing
- production default data source switch
- brand profile generation enablement
- publish_enabled=true
- manual fixture insertion
- db push / migration history repair

## Verification

最低限:
- fresh main / production preflight
- migration exact apply + read-back
- ACL/RPC/index/FK proof
- existing admin policy/RLS unchanged proof
- Edge Function deploy/read-back/source equivalence
- unrelated Function versions unchanged
- unauth fail-closed smoke
- malformed request fail-closed smoke
- production data rows untouched proof
- `git diff --check`

## Completion / C2

完了時:
- status -> `review_required`
- next_owner -> `chatgpt`
- `.agent/CODEX_REPORT_2.md`に:
  1. preflight
  2. exact migration apply result
  3. postflight ACL/RPC/index/FK
  4. exact Edge deploy version/source
  5. smoke results
  6. existing admin OAuth unchanged
  7. production row mutation summary
  8. X Developer Portal manual step
  9. real OAuth round-trip still pending
  10. rollback/recovery notes
- push前fresh origin/main
- C2待ちでSTOP


## C2 review — 2026-09-20

**NOT PASS / blocked by authorization gate — implementation is not the blocker.**

Gate A read-only preflight passed and no production mutation occurred. The production migration and Edge Function deploy were not executed because the production mutation safety gate did not recognize a sufficiently explicit user authorization for the exact schema/security rollout.

Accepted from this H2 attempt:
- fresh main / production identity / drift preflight completed.
- target unique index, nullable Auth FK column, and three new OAuth RPCs are still absent; production is not partially applied.
- duplicate live platform identity groups = 0.
- required Vault functions/schema compatibility confirmed.
- existing admin OAuth flow was snapshotted and remains unchanged.
- production row counts / identity hashes remained unchanged.
- production mutation = 0.

Required before rerun:
- obtain an explicit user authorization that clearly approves the exact production action:
  1. apply \`supabase/migrations/20260919120000_social_mobile_x_oauth_onboarding.sql\` to the production \`stock-x-autopost\` project; and
  2. deploy only the \`x-oauth-connect-user\` Edge Function.
- X Developer Portal changes, real OAuth authorization/token exchange, Vault token writes, and real X posting remain excluded.

After explicit approval:
- rerun fresh Gate A preflight;
- apply the approved migration exactly once;
- perform postflight ACL/RPC/index/FK/admin-OAuth invariants;
- deploy only \`x-oauth-connect-user\`;
- run unauthenticated/malformed fail-closed smoke;
- return \`review_required / next_owner: chatgpt\`.

No source changes are required by this C2.
