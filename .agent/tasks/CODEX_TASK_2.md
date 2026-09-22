# Codex Task 2

- task_id: social-mobile-app-phase17-disposable-vault-token-boundary-proof-20260922
- owner: codex
- slot: codex-2
- status: ready
- next_owner: codex
- priority: high
- recommended_model: Luna
- purpose: Phase16 C2 PASS済みのserver-side X history-learning adapterについて、本番Vault/Xを触らずに、access-token取得境界・tenant ownership・account binding・fail-closed挙動をdisposable Supabase/PostgreSQL環境で実証する。production deploy / production Vault read / real X history call / live publishはまだ禁止。

## Product goal

「過去の自分のX投稿を読んで覚えて」を本番へ進める前に、
**本人の接続済みXアカウントのaccess tokenだけを、server-sideで安全に取得できること**
を使い捨て環境で証明する。

このPhaseでは実X APIは呼ばない。
目的は Vault/RLS/token境界の安全性証明。

## Mandatory fresh start

H2開始時:
1. `git fetch origin main`
2. fresh `origin/main`
3. `.agent/ORCHESTRATION.md`
4. `.agent/CURRENT_STATE.md`
5. this TASK
6. `.agent/CODEX_REPORT_2.md`
7. 他3slot overlap確認

latest TASK statusだけを開始判断に使う。
他slotが同じmigration/RPC/Vault helper/Edge Functionを触っていればSTOP。

## Model policy

- **Lunaで開始・継続**
- Solは、Vault ACL / SECURITY DEFINER / RLS / token-read ownership boundaryに具体的矛盾が出てLunaで安全に解けない場合のみ
- disposable DB setup、read-back、tests、通常source修正はLuna

## Scope A — current token-storage architecture audit

Read-only source/metadata audit:
- `social_accounts` の access-token / refresh-token secret reference columns
- existing OAuth completion RPC / Vault write path
- existing Vault schemas/functions/ACL
- any existing helper that reads Vault token values
- service_role/admin-only paths
- general-user Auth/RLS boundary

Reportに明記:
1. token refを保持する正本column
2. Vault secret valueを読める既存path
3. そのpathを一般ユーザーhistory-learningに再利用可能か
4. reusableでない場合、最小のdedicated internal contract案

**generic client-callable secret readerは禁止。**

## Scope B — narrow token-read contract candidate

必要ならsource candidateを追加してよい。

要求:
- input authorityは server-resolved account id / verified account binding のみ
- clientから secret ref を自由入力させない
- Auth user / owner membership / account ownership / identity_verified を確認
- accountに紐づく access-token secret refだけ読む
- refresh tokenは読まない
- 他brand/account tokenは読めない
- admin/global token fallbackなし
- secret valueをresponse bodyへ返すpublic RPCは禁止
- token valueはhistory-learning server process内だけで使用する想定

Preferred:
- dedicated SECURITY DEFINER RPC or internal DB helper if and only if necessary
- execute ACLを最小化
- search_path固定
- caller-supplied UUID/text injectionで他secretを選べない
- service_role-only helperをmobile userへ直接開放しない

## Scope C — disposable Supabase proof

使い捨てSupabase/PostgreSQL環境を用意する。

必要な最小fixture:
- Auth user A
- Auth user B
- workspace/brand A
- workspace/brand B
- owner memberships
- X account A / B
- Aは identity_verified + platform_user_id + access-token secret ref
- Bも別token
-必要なら pending/unverified account fixture
- disposable Vault secrets with fake non-production token values only

**本番tokenや本番secretをコピーしない。**

## Scope D — proof cases

最低限実証:

### Positive
1. user A -> own workspace A -> verified X account A
2. server resolves account A
3. only access-token secret A can be read internally
4. history adapter receives token A
5. fake/mocked X fetch can be invoked with token A
6. token itself is not returned to client result

### Negative
- user A cannot read workspace B token
- user B cannot read A token
- viewer/non-owner denied
- unverified/pending X account denied
- missing platform_user_id denied
- missing access-token ref denied
- forged account id ignored/denied
- forged secret ref ignored/denied
- refresh-token ref cannot be selected
- arbitrary Vault secret cannot be selected
- multiple X accounts ambiguity fails closed
- deleted/missing Vault secret fails closed
- token value does not appear in logs/client response/test report

## Scope E — call-order proof

Prove ordering remains:

Auth bearer
-> auth user
-> owner membership
-> selected/owned workspace
-> exactly one verified X account
-> trusted access-token ref
-> Vault secret read
-> mocked X fetch

Vault must not be read before ownership/account checks pass.

## Scope F — cleanup / rollback proof

After proof:
- remove candidate proof objects/fixtures
- confirm no disposable test secret/table/function/fixture remains
- stop disposable Supabase with no backup
- record object-absence/read-back evidence

Do not touch production as substitute if local disposable environment fails.
If disposable environment cannot run, STOP and report exact blocker.

## Scope G — source integration

If a safe token-reader candidate is needed:
- wire Phase16 `social-mobile-history-learning` dependencies to an injectable trusted token reader contract
- default production entrypoint stays disabled
- no production env/secret wiring
- no real X network call

Do not broaden into:
- actual production history fetch
- persona persistence
- LLM conversation
- publish scheduling

## Tests / verification

Minimum:
- disposable SQL/RLS/Vault proof above
- relevant Deno tests
- Phase16 history-learning tests
- social-mobile typecheck
- lint
- Expo export only if mobile source changes
- `git diff --check`

Security assertions:
- no token in response
- no token in logs/report
- no generic Vault reader reachable by authenticated client
- no refresh token read
- no other-tenant secret read
- no production mutation

## Production boundary

Phase17 is **disposable proof + source candidate only**.

Forbidden:
- production migration/RPC/RLS/ACL change
- production Vault read/write
- production Edge Function deploy
- production X history API call
- OAuth scope/Portal change
- production settings/persona write
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
- `.agent/CODEX_REPORT_2.md` must include:
  1. current token architecture audit
  2. chosen narrow token-read design
  3. disposable fixture design
  4. positive proof
  5. negative cross-tenant/forged-ref proof
  6. call ordering
  7. ACL/RLS/search_path read-back
  8. cleanup/rollback proof
  9. changed files
  10. tests
  11. production mutation=0
  12. remaining risks
  13. next rollout proposal
- commit/push
- fresh origin/main check
- STOP for C2


## C2 review — 2026-09-22 (Phase17 disposable Vault proof)

**NOT PASS YET — implementation/safety audit is acceptable, but the required disposable Vault/RLS proof was not completed.**

Accepted:
- production was correctly not used as a substitute.
- no production mutation/Vault/X/deploy occurred.
- current token architecture audit is useful and consistent with the approved Phase16 boundary.
- the existing AI-Lab-specific token reader and generic access+refresh loader are correctly rejected as unsuitable for this general-user access-only history path.
- keeping the Phase16 default history-learning entrypoint disabled is correct.
- source/regression tests remain green.

Blocking gap:
- no disposable DB stayed running long enough to prove the required owner/account/Vault token boundary.
- therefore positive/negative tenant isolation, forged-ref rejection, access-only secret read, ACL/search_path read-back, and rollback/cleanup are still unproven.
- Phase16 injected-reader unit tests are not a substitute for this DB/Vault proof.

### Required follow-up

Continue with **Luna**.

Use a genuinely isolated disposable environment with fake-only data. Preferred order:

1. Retry a local disposable Supabase/PostgreSQL environment only if it can remain healthy.
2. If the local 2 GiB Podman host remains insufficient, use an isolated disposable Supabase preview/branch/project **only if available through the authorized tooling**, with:
   - no production data copied,
   - fake Auth/users/brands/accounts/tokens only,
   - no production secret references,
   - no production X call,
   - cleanup at the end.
3. Do not use the production project as a proof environment.
4. Do not create or use a paid/external resource if the available tooling requires a new billing commitment or user-side purchase; STOP and report that gate instead.

Required proof remains:
- owner A can reach only access token A through the narrow server-side binding
- cross-tenant A->B and B->A denied
- viewer/non-owner denied
- unverified/missing platform id/missing access ref denied
- forged account/secret refs ineffective
- refresh token and arbitrary Vault secret cannot be selected
- multiple-account ambiguity fails closed
- missing/deleted secret fails closed
- Vault read happens only after Auth -> owner membership -> workspace -> verified account
- no token in client response/log/report
- fixed search_path / minimal ACL read-back for any helper/RPC candidate
- cleanup/object absence after proof

Return \`review_required / next_owner: chatgpt\` for C2.
