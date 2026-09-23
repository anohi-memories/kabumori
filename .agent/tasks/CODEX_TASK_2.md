# Codex Task 2

- task_id: social-mobile-app-phase19-live-vault-reader-architecture-and-disposable-proof-20260923
- owner: codex
- slot: codex-2
- status: done
- next_owner: none
- priority: high
- recommended_model: Luna
- purpose: Phase18 C2 PASS後、live plaintext access-token readerの実装方式を決定し、productionには触れずsource candidate + disposable proofまで行う。service-role-only server adapterとnarrow SECURITY DEFINER RPCを比較し、最小権限・tenant binding・secret非露出の観点から1方式を選ぶ。production deploy / live Vault read / real X history callはまだ禁止。

## Goal

Phase19で決めるのは、
**history-learning serverが本人の接続済みX access tokenを実際に読む時の唯一のlive実装方式**。

候補:
1. Edge Function内部のservice-role-only Vault adapter
2. dedicated narrow SECURITY DEFINER RPC

比較だけで終わらず、選択した方式のsource candidateとdisposable proofまで作る。

## Mandatory fresh start

H2開始時:
1. `git fetch origin main`
2. fresh `origin/main`
3. `.agent/ORCHESTRATION.md`
4. `.agent/CURRENT_STATE.md`
5. this TASK
6. `.agent/CODEX_REPORT_2.md`
7. 他3slot overlap確認

他slotがsocial-mobile OAuth/Vault/history-learning migration/RPC/Functionを触っていればSTOP。

## Model policy

- **Lunaで開始**
- Solは、2方式のsecurity semanticsに具体的な曖昧さが残り、Vault ACL / service-role blast radius / SECURITY DEFINER ownership checkを安全に裁定できない場合だけ
- 比較、source candidate、disposable proof、testsはLuna

## Scope A — architecture decision

以下を明示比較:
- attack surface
- client exposure
- tenant/account binding
- Vault plaintext exposure surface
- service-role blast radius
- RPC ACL complexity
- `auth.uid()` reliability
- search_path / SECURITY DEFINER risk
- migration requirement
- rollback simplicity
- observability / token logging risk
- compatibility with Phase16/18 call order
- refresh-token exclusion
- future token-refresh needs

### Decision rule

Prefer the design with:
- fewer client-callable secret surfaces
- fewer DB privileges exposed to authenticated role
- simplest proof that account binding happens before secret read
- no generic secret lookup
- no refresh-token path
- smallest production mutation

If service-role-only adapter wins:
- service role must stay Edge/server only
- mobile never receives service-role key
- adapter accepts trusted account binding, not arbitrary secret ref from client
- Vault query must be single access-secret lookup after account authorization
- no generic reusable "read any secret" export to public handlers

If RPC wins:
- fixed search_path
- exact owner/account checks inside RPC
- public/anon denied
- minimal EXECUTE grant
- no arbitrary secret input
- access-only
- disposable ACL proof mandatory

Report the rejected option and why.

## Scope B — source candidate for chosen design

Implement the chosen live-reader candidate behind an injectable interface.

Required:
- Phase16 Auth -> owner membership -> workspace -> exactly-one verified account -> platform id checks remain before plaintext read
- no client-controlled secret ref
- no refresh token access
- no arbitrary Vault secret access
- no admin/global fallback
- no token persistence
- no token logging
- token never appears in HTTP response
- provider error paths do not echo token
- default production history-learning entrypoint remains disabled

If service-role adapter:
- dedicated module with narrow function, e.g. "read access token for trusted bound account"
- do not expose raw Supabase admin client or generic Vault read helper to handler callers
- server environment lookup remains source candidate only; no real production secret wiring

If RPC:
- create migration candidate only; do not apply production

## Scope C — disposable proof

Use fake-only disposable PostgreSQL/Supabase-like environment.

Prove chosen implementation contract:
- owner A -> verified account A -> access token A
- user A cannot reach B token
- viewer/non-owner denied
- pending/unverified denied
- missing platform id/ref denied
- forged account id/ref ineffective
- refresh ref cannot be selected
- arbitrary secret cannot be selected
- multiple X accounts fail closed
- missing/deleted secret fails closed
- plaintext read occurs after ownership/account verification
- token absent from client response/log capture
- rollback/cleanup leaves no proof object/fixture

If service-role adapter is chosen, explicitly model that DB privilege is broad but application interface is narrow, and test the narrow adapter cannot be parameterized into arbitrary secret reads.

## Scope D — history-learning integration candidate

Wire chosen live-reader candidate into a **disabled production dependency factory** or equivalent source-only factory.

Important:
- default deployed behavior remains disabled
- no real env secret required to run tests
- no production Vault call
- no X network call
- no mobile network activation

Tests:
- disabled factory cannot read token
- chosen factory ordering is fixed
- X fetch receives token only internally
- response never contains token/ref

## Scope E — exact next rollout gate

Prepare but do not execute.

Next production gate should specify exact allowed mutations:
- if service-role adapter: deploy only history-learning Function with exact env requirements, but real fetch still gated OFF until C2
- if RPC: exact migration/RPC apply + ACL read-back first, then Function deploy separately
- exactly-one QA real Vault read/history fetch must remain later and require explicit user consent
- no publish enablement

## Tests

Run:
- new chosen-adapter tests
- Phase16/18 history-learning tests
- relevant static/security tests
- social-mobile typecheck
- lint
- Expo export only if mobile source changes
- `git diff --check`

## Production boundary

Phase19 is **source candidate + disposable proof only**.

Forbidden:
- production migration/RPC/RLS/ACL mutation
- production Vault plaintext read
- production service-role secret read
- production Edge deploy
- production X history call
- OAuth change
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
- Report must include:
  1. side-by-side architecture comparison
  2. chosen design and rejected design rationale
  3. exact trusted/untrusted boundary
  4. changed files
  5. disposable proof results
  6. refresh/arbitrary-secret exclusion proof
  7. token non-exposure proof
  8. tests
  9. production mutation=0
  10. exact next production rollout gate
  11. remaining risks
- commit/push
- fresh origin/main check
- STOP for C2


## Final C2 — 2026-09-23 (Phase19 live Vault reader architecture + disposable proof)

**PASS. Phase19 is complete.**

Accepted architecture:
- selected a dedicated narrow \`SECURITY DEFINER\` RPC callable only by \`service_role\`, rather than a direct generic service-role Vault adapter.
- this is effectively a server-only RPC boundary: the Edge Function remains responsible for authenticating the mobile user and resolving the trusted user/account binding, while the RPC independently rechecks ownership/account status before plaintext access.
- \`auth.uid()\` is intentionally not used inside the RPC because the RPC is called with the service-role JWT; instead, the trusted Auth user id comes from the Edge \`getUser()\` result and is revalidated against owner membership in SQL.
- the rejected direct adapter would have fewer DB objects but would place more of the Vault authorization burden solely in privileged Edge code.

Security properties accepted:
- no client-supplied Vault secret reference.
- no refresh-token selector.
- no arbitrary Vault secret selector.
- exactly-one X account / identity-verified / nonempty platform id / owner-membership checks occur before the access secret id is selected.
- only \`vault_access_token_secret_id\` is read.
- function is \`SECURITY DEFINER\` with fixed empty \`search_path\` and fully qualified object names.
- EXECUTE is revoked from public/anon/authenticated and granted only to service_role.
- database/provider errors are normalized and secret values are not embedded in error responses.
- Phase16 HTTP result still contains no token or secret reference.
- default Edge entrypoint remains disabled and does not wire the candidate factory.

Disposable proof accepted:
- exact migration candidate applied successfully in fake-only PostgreSQL proof.
- positive own-account access worked.
- cross-tenant, viewer, pending/unverified, missing platform id/ref/secret, forged account, and multiple-X cases failed closed.
- refresh-token decoy was not selectable.
- ACL / SECURITY DEFINER / search_path were read back.
- proof fixtures/function were removed and the disposable container was cleaned up.

Verification accepted:
- relevant Deno/security suites 34/34 PASS.
- \`deno check\` PASS.
- social-mobile typecheck/lint PASS.
- \`git diff --check\` PASS.
- implementation commit \`1958f9ca2925519d10018eba2e8c72fb0e246a12\` is on \`origin/main\`.
- production mutation = 0.

Important next gate:
- this PASS approves the source/migration candidate only.
- production migration/RPC apply is NOT yet authorized.
- next phase must be a narrowly scoped production rollout for this single RPC candidate, with fresh preflight, exact migration hash/read-back, ACL/search_path/owner verification, and no Vault plaintext read.
- Function deployment must remain a separate gate after the RPC rollout.
- exactly-one QA Vault read/X-history fetch remains another later gate requiring explicit consent.
- publishing remains disabled/unapproved.

Recommended model for the next rollout gate: Sol, because the next step is an actual production security-boundary mutation involving a SECURITY DEFINER RPC and Vault access path.
