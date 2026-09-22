# Codex Task 2

- task_id: social-mobile-app-phase18-production-shaped-access-token-reader-preflight-20260922
- owner: codex
- slot: codex-2
- status: ready
- next_owner: codex
- priority: high
- recommended_model: Luna
- purpose: Phase17 C2 PASS済みのdisposable access-token boundary proofを、本番Supabase Vaultの実構造に合わせたproduction-shaped internal reader candidateへ落とし込み、productionはread-only preflightだけでexact schema/ACL/RPC compatibilityを確認する。まだproduction migration/RPC deploy/Vault read/X history callは行わない。

## Goal

本番で「本人の接続済みXのaccess tokenだけをhistory-learning serverが安全に使える」ようにするため、
**最小・access-only・server-internalなtoken reader contract** を確定する。

Phase18では source candidate + production read-only preflight まで。
実token値は読まない。

## Mandatory fresh start

H2開始時:
1. `git fetch origin main`
2. fresh `origin/main`
3. `.agent/ORCHESTRATION.md`
4. `.agent/CURRENT_STATE.md`
5. this TASK
6. `.agent/CODEX_REPORT_2.md`
7. 他3slot overlap確認

他slotが同じ social-mobile OAuth/Vault migration/RPC/Function を触っていればSTOP。

## Model policy

- **Lunaで開始・継続**
- Solは、実Supabase VaultのACL/SECURITY DEFINER/search_path/ownership semanticsに具体的矛盾が見つかり、Lunaで安全に設計判断できない場合のみ
- read-only production preflight / source candidate / testsはLuna

## Scope A — production read-only preflight

Production projectは read-only metadata inspection のみ。

Confirm without selecting secret values:
- `public.social_accounts`
  - `vault_access_token_secret_id`
  - `vault_refresh_token_secret_id`
  - `platform_user_id`
  - `connection_status`
  - ownership/brand binding columns
- `brand_memberships` ownership model / RLS
- Vault schemas/views/functions actually available
- `vault.decrypted_secrets` exposure/ACL shape
- existing OAuth completion RPC definition, search_path, ACL
- any existing token-read RPC/function
- current `x-oauth-connect-user` deployment/source expectations
- QA account row has refs present (boolean/count metadata only; no secret values)

Do NOT:
- read `decrypted_secret`
- read actual access/refresh token
- change ACL/RLS/schema/RPC
- call X

Report exact object names/signatures/ACLs relevant to the design.

## Scope B — access-only internal reader design

Create source candidate for the narrowest safe contract.

Required properties:
- no generic `secret_id -> plaintext` client RPC
- no client-controlled Vault secret ref
- caller cannot choose refresh-token ref
- caller cannot choose another account's token
- ownership + verified account binding resolved before token read
- access token only
- fixed `search_path`
- least-privilege EXECUTE
- no public/anon access
- no token returned to mobile/public response
- no logs containing token
- no admin/global fallback
- no write/update capability

Preferred architecture:
- Edge Function authenticates user and resolves owned account using user JWT / trusted DB state
- internal server-side DB call reads only that resolved account's access secret
- returned plaintext remains inside server process and is passed directly to X read adapter
- refresh flow is explicitly out of scope unless later needed

If a SECURITY DEFINER RPC is used:
- name it specifically for history-learning access-token resolution
- input should be minimal and non-authoritative (prefer account id only after prior trusted resolution, or resolve account inside RPC from `auth.uid()`)
- verify account belongs to current Auth user and is `identity_verified`
- read only `vault_access_token_secret_id`
- query only the single matching Vault secret
- fixed `search_path = public, vault`
- revoke from public/anon/service_role unless there is a demonstrated reason otherwise
- grant only the exact role needed

## Scope C — migration/source candidate

If DB helper/RPC is needed, create a migration candidate only.

Requirements:
- idempotent/reviewable SQL
- explicit revoke/grant
- fixed search_path
- no migration-history repair
- no blind db push
- no production apply
- no existing admin OAuth behavior change
- no refresh-token exposure
- no generic Vault reader

If no DB helper is needed and a server-only service_role query is safer, document why and prove client cannot access it.

## Scope D — history-learning dependency wiring

Update Phase16 history-learning source candidate so the production-shaped dependency can be injected cleanly.

Keep:
- default entrypoint disabled
- no production credentials/env wiring
- no real Vault read
- no real X call

Tests should prove:
- token reader is called only after Auth/ownership/account verification
- only access-token path is referenced
- refresh token path absent
- token not exposed in response/errors/logs

## Scope E — static + disposable proof of the exact candidate

Use local/disposable PostgreSQL to apply the exact candidate SQL/contract where practical.

Prove:
- function/RPC exists with intended signature
- SECURITY DEFINER status if used
- fixed search_path
- ACL minimal
- public/anon denied
- owner/verified account positive
- cross-tenant negative
- pending/unverified negative
- forged account/ref ineffective
- refresh token cannot be selected
- arbitrary Vault secret cannot be selected
- token returned only to internal caller boundary, never public/mobile response
- rollback/cleanup

Fake secrets only.

## Scope F — rollout gate design

Prepare a clear next-step rollout plan, but DO NOT execute it.

Future rollout must be split:
1. exact migration/RPC apply (if any)
2. read-back/ACL verification
3. deploy only `social-mobile-history-learning`
4. keep live history fetch disabled by default/feature gate if possible
5. later exactly-one QA fetch with explicit consent
6. no publish enablement

## Tests

Run:
- Phase16/17 history-learning relevant Deno tests
- any new migration/static tests
- social-mobile typecheck
- lint
- Expo export only if mobile source changes
- `git diff --check`

## Production boundary

Phase18 allows **read-only production metadata preflight only**.

Forbidden:
- production migration/RPC/RLS/ACL mutation
- production Vault plaintext read
- production Edge Function deploy
- production X history API call
- production OAuth change
- production persona/settings write
- OpenAI live call
- X post/media/repost
- `publish_enabled=true`
- Cron/scheduler
- scheduled_posts
- migration-history repair/reconcile
- blind db push

Production mutation = 0.

## Completion / C2

When complete:
- status -> `review_required`
- next_owner -> `chatgpt`
- Report must include:
  1. production metadata preflight findings
  2. exact chosen access-only architecture
  3. changed files/migration candidate
  4. RPC/helper signature + search_path + ACL
  5. refresh-token exclusion proof
  6. tenant/account binding proof
  7. tests
  8. production mutation=0
  9. remaining risks
  10. exact rollout plan
- commit/push
- fresh origin/main check
- STOP for C2
