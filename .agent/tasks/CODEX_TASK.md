# Codex Task — CURRENT TASK

- task_id: x-social-mobile-pr76-publish-toggle-review-20261002
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: highest
- recommended_model: Sol（高）
- type: focused review / posting-permission security boundary
- target_pr: 76
- target_head: a59a89e9c585fb6e780e1af2ecc898c830f5524e
- production_mutation_allowed: false

## Purpose

PR #76 の「アカウント単位の自動投稿 ON/OFF」実装を独立レビューする。

これは単なるUIレビューではない。
`social_accounts.publish_enabled` を変更し、将来のX自動投稿を許可/停止する**投稿権限境界**なので、Auth・tenant isolation・CAS・TOCTOU・実行時publish guardとの整合まで確認する。

**merge / deploy / production toggle / DB mutation / X API / Vault mutation / Auth mutationは禁止。**

## Mandatory startup / isolation

1. Read PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / ACTIVE_TASK.
2. Read G4 current TASK + Report for `x-social-mobile-publish-toggle-v1-20261002`.
3. Use independent H1 worktree/checkout.
4. Fresh fetch `origin/main` and PR #76 exact head `a59a89e9c585fb6e780e1af2ecc898c830f5524e`.
5. STOP if PR head differs.
6. Confirm fresh base-to-main overlap for the 10 PR files. K4 found main ahead by 5 with overlap 0; re-check independently.
7. Do not touch G3 AI-consult files/worktree or H2 common-account preproduction work.

## Reviewed candidate facts to verify, not assume

PR #76 reports:
- new authenticated Edge Function `social-mobile-publish-setting`
- request exactly `social_account_id / desired_enabled / expected_current_enabled`
- service-side exact account lookup -> server-derived brand id
- caller identity verified through Auth
- membership checked for exact brand
- owner/admin only
- ON strict prerequisites
- OFF remains possible for authorized owner/admin even when connection/brand state is degraded
- CAS/expected-state semantics
- exact write body only `publish_enabled`
- no migration / RLS / grant change
- no X API / Vault plaintext / scheduler mutation
- source tests PASS
- no production deploy.

Independently prove or reject each of these.

## Gate A — authentication and tenant isolation

Verify:
1. Missing/invalid JWT is rejected.
2. User identity is derived from verified Auth result, never request body.
3. Client cannot supply/override `brand_id`.
4. Social account lookup returns the account's authoritative `brand_id`.
5. Membership check binds the authenticated user to that exact brand.
6. Cross-brand account ids cannot be toggled.
7. account-not-found vs foreign-account behavior does not leak useful tenant existence.
8. service-role use is strictly server-side and does not accidentally turn client input into an unrestricted admin write.
9. viewer/member are denied; owner/admin only unless repository policy clearly proves another role is intended.
10. Auth/JWT/service-role/Vault references are not logged or returned.

Try concrete adversarial cases:
- valid user + foreign account id
- valid membership in brand A + account in brand B
- same user multiple memberships
- missing membership
- viewer/member
- spoofed brand_id extra field
- malformed/duplicate/oversized JSON
- non-POST / wrong content type.

## Gate B — ON safety

For `false -> true`, verify all source-of-truth prerequisites and their exact production semantics:

- platform X
- brand exists
- brand active
- brand publish_mode live
- connection state is truly the state accepted by the runtime posting pipeline
- platform_user_id / verified_at requirements match real runtime assumptions
- required access/refresh Vault **references** are present
- connection error state blocks
- stale expected state blocks
- account busy/lifecycle interactions fail closed where applicable.

Do not accept a condition merely because tests encode it; compare to the actual posting pipeline / `assertBrandPublishAllowed` / token loading / account selection path.

### Critical TOCTOU review

G4 already disclosed that brand `is_active/publish_mode` are checked before the PATCH but are not part of the PATCH predicate.

Determine whether this is safe enough because the actual publishing pipeline re-checks those brand conditions before any X write.

- If runtime publish guard definitively re-checks brand active/live before every post and cannot be bypassed by this toggle, document why residual race is non-publishing.
- If not, mark blocker and propose the smallest safe source correction.
- Also inspect account connection/readiness races and ensure the PATCH predicate actually closes those.

## Gate C — OFF safety

For `true -> false`:
- authorized owner/admin must be able to disable even when connection credentials are missing/degraded or brand is inactive.
- OFF must not depend on Vault readability/validity.
- no X revoke.
- no token deletion.
- no scheduled post/history deletion.
- no Auth/common-account mutation.
- exact state conflict still respected.

Check that fail-safe OFF cannot be accidentally prevented by an ON-only prerequisite.

## Gate D — CAS / concurrency

Verify:
- expected_current_enabled is mandatory boolean.
- read mismatch -> 409/no mutation.
- conditional update binds exact id + authoritative brand + expected current state.
- zero updated rows are never blindly reported success.
- race between read and write returns stale or prerequisite failure.
- duplicate taps cannot create contradictory state.
- same-state/idempotent request behavior is truthful.
- response cannot say ON/OFF unless exact requested account/value is confirmed.

Try concurrent counterexamples in unit/fake PostgREST harness where possible.

## Gate E — exact mutation boundary

Prove candidate can mutate only the intended setting.

Review all HTTP calls and write bodies:
- only `social_accounts.publish_enabled` may be patched
- no connection_status
- no verified_at
- no platform_user_id
- no oauth refs
- no Vault
- no brands
- no memberships
- no scheduled_posts
- no post_execution_logs
- no content settings/persona
- no Auth/common account.

Inspect whether database triggers on social_accounts cause additional relevant side effects. Read-only production catalog inspection is allowed if needed; production mutation is not.

Review the decision not to touch `updated_at`:
- confirm current pipeline meaning of updated_at/lease and whether leaving it unchanged is correct.
- if DB trigger updates it anyway, document actual behavior.

## Gate F — Edge Function exposure/config

Verify:
- function JWT verification is actually ON under repository/Supabase config, not merely assumed.
- service key/provider credentials stay server-side.
- no overly broad CORS/exposure issue if relevant to current client.
- error codes are bounded/safe.
- raw PostgREST/provider errors are not reflected to client.
- no sensitive request/response body logging.
- method/content-type/body-size validation is real.

## Gate G — client truthfulness

Review account-detail UI/hook:
- ON requires explicit confirmation.
- cancel makes zero request.
- OFF wording does not imply revoke/delete.
- loading blocks double tap.
- stale/error reload behavior is safe.
- mock preview cannot mutate.
- disconnected OFF account cannot request ON.
- degraded ON account can still request OFF.
- exact selected account id/state is sent.
- success only shown after server-confirmed exact account/value.
- G3 consultation/content settings are untouched.
- no accidental coupling of `approvalMode` with `publish_enabled`.

UI aesthetics are out of scope.

## Tests / independent verification

Run at minimum:
- PR's Edge logic/http tests
- Deno check
- full social-mobile tests
- typecheck/lint
- diff check
- secret scan
- relevant existing X publish-guard/token-loader tests
- any focused adversarial tests needed for the findings above.

If a defect is found and the correction is genuinely bounded/safe, H1 may make a **small review fix** on an H1-owned branch, but:
- preserve original PR head evidence
- add regression first where practical
- do not merge
- do not deploy
- do not alter DB schema/migration/RLS/grants.
If correction requires architecture or migration, STOP and report CHANGES REQUIRED.

## Production safety

Allowed:
- source review
- local tests
- read-only production catalog/schema/config checks if needed.

Forbidden:
- Edge Function deploy
- production publish toggle
- production row mutation
- real X API/post/auth/revoke
- Vault mutation
- Auth mutation
- migration/backfill/Cron change.

## Report

Append to `.agent/CODEX_REPORT.md` without erasing history:

- task_id
- verdict: PASS / PASS-WITH-FIX / FAIL
- reviewed exact head
- findings severity
- Auth/tenant isolation result
- ON prerequisite result
- brand TOCTOU analysis
- OFF fail-safe result
- CAS/concurrency result
- exact mutation-boundary result
- Edge config/JWT result
- client truthfulness result
- tests/adversarial checks
- any changed_files + fix commit
- production read/mutation
- real X operations
- remaining risks
- merge recommendation
- deployment/E2E recommendation
- safety checks.

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for C1.

Recommended model: **Sol（高）**.

## H1 completion — 2026-10-02 JST

- verdict: **FAIL / CHANGES REQUIRED**; PR #76 merge/deploy HOLD.
- reviewed exact head: `a59a89e9c585fb6e780e1af2ecc898c830f5524e`; candidate runtime is unchanged, no source fix or other-slot branch write.
- blockers: membership revocation/demotion races still permit the service-role update; brand active/live TOCTOU is not made non-publishing by the actual cached runtime guard. Additional P2 findings: foreign-brand no-match reread, nonempty identity/readiness mismatch, unpinned client ON confirmation/preview transition.
- independent verification: Edge 37/37, mobile 134/134, domain 22/22; mobile typecheck/lint and target runtime check/lint PASS; relevant X tests 48/48 with --no-check. Seven scratch HTTP/runtime proofs and two client proofs executed; these prove counterexamples, not fixed behavior.
- verification limits: relevant X checked run fails on two pre-existing type errors; candidate test-directory Deno lint fails on five require-await test-helper warnings. Production catalog reads were attempted twice but permission-review deadlines returned no catalog evidence; no production write/deploy/X operation.
- architecture/transaction-boundary correction is outside the no-migration/no-RPC-change authority; STOP for C1. Detailed findings, reproduction schedules and recommendations appended to `.agent/CODEX_REPORT.md`.
- next recommendation: **C1, 推薦モデル：Sol（高）**; separately scope G4 corrective work. This H1 does not allocate G4 or authorize DB/runtime/production changes.

---

# Codex Task

- task_id: common-account-pr70-readiness-authorization-rereview-20261002
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: highest
- recommended_model: Sol（高）
- type: focused rereview / lifecycle readiness authorization / migration security
- target: PR #70 exact head `47a2ed6a1635177ba82004eace4bddb42d9d53e3`
- previous_head: `eebe9405d758e0c120f9e6f1a70cdb1e973a0855`
- production_mutation_allowed: false

## Purpose

PR #70第2是正headを独立再レビューする。

今回の中心は、「Phase 1にenforcing guardを置かず、durable readiness authorizationとinvalidation contractだけを提供する」という責任分離が本当にtruthfulか、そして前回H1の新4 findings / 7 adverse casesが実際に塞がっているか。

**merge / production apply / backfill / deploy / Auth / Storage / OAuth / Vault mutationは禁止。**

## Mandatory startup / isolation

1. PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / ACTIVE_TASK を読む。
2. G5 current TASK/Report、前回H1 corrective rereview report、Final C1を読む。
3. H1専用worktree/checkout。
4. fresh origin/main と PR #70 exact head `47a2ed6a1635177ba82004eace4bddb42d9d53e3` を取得。head差異ならSTOP。
5. base-to-main changed filesを再確認。PRの8ファイルとの実ファイル競合があればSTOP。
6. 他slot/PRのbranch・TASK・未commit変更へ触れない。

## First gate — responsibility truthfulness

最初に以下を確認。

- candidateに `DELETE FROM auth.users` がない。
- candidateにStorage/Vault/provider destructive SQLがない。
- account deletionの「completed」をPhase 1が主張しない。
- Phase 1に**enforcing deletion guardが存在しない**。
- Auth cascade triggerは観測/shadowのみで、blockerを再構築してauthorizeしない。
- current Kabumori hard-deleteは安全化されていないと明記されている。
- actual managed deletionはfuture orchestrator:
  - recent reauth
  - session revoke / stale JWT handling
  - Apple revoke
  - X posting authorization revoke
  - Vault purge
  - Storage API cleanup/re-enumeration
  - final prepare/revalidation
  - Auth Admin API delete
  - post-delete read-back/audit/retry
  の責務として残る。
- unwired producerが残る間、Phase 1のreadinessをそのままmanaged Auth deleteの安全保証として扱わない。

責任分離が曖昧ならFAIL。

## Re-run prior resolved blockers

前回までの6 blockersが再発していないことを確認：
1. no SQL Auth delete / false Storage completion
2. absent preview stale after backfill
3. backfill vs lifecycle lock
4. admin X consumer backfill exclusion
5. exact FK preflight
6. affirmative fail-closed rollback

## Re-run latest seven adverse cases

### A. Late admin blocker
- ready後にadmin stateを加える。
- read model/prepareがstale/blockerを検出する。
- Phase 1 guardが「authorize」しないことを確認。
- cascade orderingが変わってもobserver triggerの判断が安全性保証として使われていないことを確認。

### B. Late foreign/internal X membership
- ready後のforeign/shared/internal membershipでauthorization/readinessが再評価時にstaleになる。
- post-cascade table visibilityに依存しない設計か。

### C. Cascade order
- admin/membership行がcommon triggerより先に消える順序と、見える順序の両方。
- trigger output/behaviorがauthorize decisionではないため順序依存で安全性主張が変わらないこと。

### D. Built-in requirement row removal
- normal maintenanceでは拒否。
- corruption/drift fixtureでも prepare/read model/rollback が fail closed。

### E. New always-required checkpoint
- requirement epochが進む。
- old ready stateがstale。
- prepareは新要件を要求。

### F. Late Apple identity
- old ready stateがstale。
- apple_revocation requirementを新たに要求。
- old authorization bindingだけでは通らない。

### G. Built-in semantic weakening
exact contract:
- session_revocation = always
- storage_cleanup = always
- apple_revocation = apple_identity

名前だけ同じで意味を弱めた場合、prepare/read/rollbackがfail closed。

### H. Entitlement ownership transfer
- `user_id` / `service_key` direct UPDATEが拒否されること。
- rejected transferでsource/destination lifecycle versionが不整合にならないこと。
- legitimate service moveはend/delete + new startというcontractがtruthfulか。

## Durable readiness authorization review

特に深く確認：

- ready stateがどのtableに保存され、Auth cascadeより先に消えないか。
- bound values:
  - lifecycle version
  - requirement epoch
  - required checkpoint set
  が十分か。
- `authorization_problems` が current blocker / managed requirement / ownership probe をtruthfully再評価するか。
- read modelの none / valid / stale が誤解を招かないか。
- prepareがstale readyを取り消し/cleanupへ戻すか。
- checkpoint clear / requirement change / lifecycle version changeでreadinessが確実にstaleになるか。
- ready row自体の存在と「deleteして安全」の意味を混同していないか。

## Invalidation inventory review

G5のinventory全行を読む。

少なくとも：
- entitlement writes
- account status/version
- backfill
- checkpoint requirement registry
- settings/integration state
- checkpoint clear
- admin membership
- X membership/workspace state
- Kabumori profile creation
- Apple identity
- Storage ownership
- login deletion

各行について：
- writer
- Phase 1で捕捉するか
- version/epochで自動無効化するか
- 再評価のみか
- 未配線ならenforceが存在しない理由
が整合しているか。

**「再評価のみ」のproducerを残したまま、将来の削除安全をPhase 1単体で保証していないこと**が重要。

## Checkpoint registry / settings

- built-in semantic immutability
- extension row追加/削除でrequirement epoch更新
- missing/corrupt built-in contract fail closed
- settingsはshadow以外を受け付けない
- settings missing/corruptでdelete observerがfail closedするか
- settings/integration transitionがready stateへ与える影響
- rollbackがbuilt-in exact semantics、operation/use evidence、dependencyを肯定的に確認するか

## Observer trigger review

Auth/common cascade triggerについて：
- authorizeしない
- admin/membership/identity stateを見て安全判定しない
- cascade順序に依存しない
- open operationのlogin_removed観測はtruthfulか
- settings missing/non-shadowでfail closedする設計が既存shadow導入と矛盾しないか
- raw subject/user data cleanup semanticsが監査要件と矛盾しないか

## ACL / RLS / SECURITY DEFINER

再確認：
- new tables RLS
- intended self SELECTのみ
- client arbitrary writesなし
- service_role table direct grantsなし
- RPC EXECUTE最小
- PUBLIC/anon leakなし
- empty search_path / schema qualification
- metadata/user_metadataによるauthorizationなし
- observer/readiness private objectsがclientから露出しない

## Exact preflight / rollback

前回acceptedしたexact FK/type/delete-action/validation/deferrability/helper signature checksを維持。

追加object/trigger/functionについてもpreflightが十分か。

rollback:
- shadow exact state
- built-in exact semantics
- integration/use evidenceなし
- operation/readiness/extension registry等の存在条件
- downstream dependencyなし
- one transaction / partial teardownなし

## Required independent tests

最低限再実行：
- `supabase/tests/common_account_lifecycle_run.sh`
- `supabase/tests/common_account_lifecycle_mutations.sh`
- `supabase/tests/social_mobile_account_deletion_run.sh`
- migration source invariants
- `bash -n`
- relevant lint/static checks
- `git diff --check`

G5 reported:
- lifecycle 20 PASS
- mutation 45/45 detected
- social deletion 8 PASS
- migration invariants 10 PASS

鵜呑みにせず独立確認。

Mutation suite:
- generic FAILだけでなく intended invariant matcherか。
- latest 7 adverse casesとold 6 blockersのmutation/fixtureが本当に狙った欠陥を検出するか。

必要ならscratch-only adverse probesを追加してよい。PR/sourceへ追加fixする場合はfix authorityに従う。

## Fix authority

小さく決定的なPR #70 scope内P1/P2/P3なら failing test -> minimal fix -> rerun可。

以下はG5へCHANGES REQUIRED：
- lifecycle/readiness contract変更
- enforcing strategy追加
- managed Auth/Storage/provider orchestrator実装
- existing creator/deleter wiring
- broad schema/ACL architecture変更
- production-specific repair

## Production gate

このH1がPASSしてもproduction applyは承認しない。

production前に別途必須：
- **Sol（極高）**
- disposable actual Supabase project proof
- exact production catalog/read-only preflight
- migration-history/version collision
- role/ACL/PostgREST behavior
- Storage/GoTrue/session/API behavior
- backfill dry-run/parity
- explicit approval

## Completion / C1

`.agent/CODEX_REPORT.md`へappend。

必須：
- PASS / PASS-WITH-FIX / FAIL
- exact original/final head
- old six blockers disposition
- latest seven adverse cases disposition
- responsibility-boundary verdict
- durable readiness authorization verdict
- invalidation inventory verdict
- checkpoint/settings verdict
- observer trigger verdict
- ACL/RLS/preflight/rollback verdict
- independent test evidence
- changed_files
- production_mutation=0
- merge recommendation
- remaining Phase 2/3 obligations
- Sol（極高）pre-production gate
- next recommendation

完了時 status -> review_required / next_owner -> chatgpt / STOP for C1.

## H1 completion — 2026-10-02 JST

- result: **PASS-WITH-FIX** for reviewed source plus H1's bounded correction; not approval to merge the unchanged PR head.
- original PR #70 head: `47a2ed6a1635177ba82004eace4bddb42d9d53e3`; final verified candidate: `aa4d2d425d1d7c432d43c9ecfb8e978a40b80a65` on H1-only branch `codex/h1-pr70-readiness-review-20261002`. G5/PR source branch untouched.
- responsibility gate PASS: no managed Auth/Storage/Vault write, no account-completed claim, no enforcing Auth deletion mode; unwired producers are evaluation-only and Phase 2/3 prerequisites are explicit.
- old six blockers and latest seven adverse cases: independently verified resolved. Durable version/epoch/set binding, built-in exact semantics, ownership-transfer refusal, ACL/preflight/rollback PASS in the local model.
- new P2 fixed: direct common-row deletion while Auth remains falsely recorded `login_removed` and scrubbed user_id. Failing regression -> seven-line identity-existence check -> regression/mutation rerun. Real shadow Auth cascades remain allowed; this is observation integrity, not deletion authorization.
- independent verification: original 20 lifecycle PASS / 45 mutations DETECTED; final 20 lifecycle PASS / 46 mutations DETECTED; existing social deletion 8 PASS; invariants 10 PASS; syntax/lint/diff PASS. Additional cascade probe measured both visible/gone admin orders with identical unverified observations; Storage SELECT denial fails closed.
- H1 fix published to its own branch only; no PR merge/update or main runtime change. C1 must decide incorporation of the exact fix before PR #70 merge; do not merge original `47a2ed6` unchanged.
- production read/mutation=0; real X operations=0. Owned fake probe DB removed and own cluster stopped; detailed evidence appended to `.agent/CODEX_REPORT.md`.
- next: **C1, 推薦モデル：Sol（高）**. Separate **Sol（極高）** pre-production review + actual disposable Supabase proof + exact production preflight/history/roles/API checks + explicit approval remain mandatory. H1 STOP after report synchronization.


## Final C1 — PR #70 readiness authorization

- verdict: **PASS-WITH-FIX / accepted**.
- assigned reviewed head: `47a2ed6a1635177ba82004eace4bddb42d9d53e3`.
- H1 bounded fix candidate: `aa4d2d425d1d7c432d43c9ecfb8e978a40b80a65`, exactly one commit atop the assigned head.
- accepted bounded fix: direct owner-maintenance deletion of `common_accounts` no longer falsely records `login_removed` while the Auth parent still exists; actual Auth cascade observation remains shadow/unverified and does not authorize deletion.
- independent final evidence accepted:
  - lifecycle runner 20 PASS
  - mutation suite 46/46 detected
  - social-mobile deletion 8 PASS
  - migration invariants 10 PASS
  - old six blockers resolved
  - latest seven adverse cases resolved
  - responsibility boundary remains no-enforce / no-managed-Auth-delete in Phase 1
- PR #70 branch was fast-forwarded to exact reviewed fix `aa4d2d425d1d7c432d43c9ecfb8e978a40b80a65`; fresh main overlap = 0 files; PR checks completed successfully/neutral as expected.
- PR #70 merged by ChatGPT.
- merge/main SHA: `44121914b035e22380a4ca1bd8252a42713a2bbf`.
- production mutation/read from H1/C1: 0.
- **This merge does not apply the Supabase migration, run backfill, enable any guard, alter Auth/Storage/OAuth/Vault, or authorize production rollout.**
- next: independent H2 pre-production gate `common-account-pr70-preproduction-gate-20261002`, recommended **Sol（極高）**.

---

## Previous completed H1 task history — preserved below

# Codex Task

- task_id: common-account-pr70-corrective-rereview-20261001
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: highest
- recommended_model: Sol（高）
- type: focused rereview / Auth lifecycle / migration security
- target: PR #70 exact head `eebe9405d758e0c120f9e6f1a70cdb1e973a0855`
- previous_failed_head: `89cf128bd9219897806b2b641cce4866f6e16c52`
- production_mutation_allowed: false

## Purpose

PR #70 corrective headを再レビューし、前回H1が再現した6 blockersが本当に解消され、Phase 1の責任が「additive lifecycle foundation」に安全に縮小されたか確認する。

**merge / production apply / backfill / deploy / Auth/Storage/OAuth/Vault mutationは禁止。**

## Mandatory startup

1. PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / G5 corrective TASK+Report / prior H1 PR #70 FAIL report / Final C1を読む。
2. H1専用の独立worktree/checkout。
3. fresh origin/main と PR #70 exact head `eebe9405d758e0c120f9e6f1a70cdb1e973a0855` を取得。headが違えばSTOP。
4. base-to-main changed filesを再確認し、PR runtime/test/docとの競合があればSTOP。
5. G4 PR #65など他slot/PRへ触れない。

## First gate — architecture correction

最初に確認：

- candidate migration/runtimeに `DELETE FROM auth.users` が存在しない。
- Phase 1はaccount deletionを「managed Auth削除準備完了」までしか進めない。
- `completed` 等、Phase 1がmanaged account deletion完了を主張するstate/returnがない。
- Storage/Auth/identity/session/provider cleanupをSQLで完了したふりをしない。
- actual Auth Admin API delete / Storage API cleanup / provider revoke / session handlingはfuture orchestrator prerequisiteとして明示。
- current Kabumori legacy hard-deleteがこのPRだけでは安全化されないことがtruthfulに残っている。

この責任分離が崩れていればFAIL。

## Re-run all six prior H1 counterexamples

前回の反例を、PRにcommitされたregressionとして**独立に再実行**する。

### 1. Managed Storage/Auth completion gap
確認：
- Phase 1 candidateはAuth/Storage managed schemaへ destructive writeしない。
- Storage-owned stateがある場合、ready判定が少なくともfail closedする。
- checkpointだけでStorage cleanup済みと盲信しない。
- readyになってもloginは残る。
- Phase 1は「削除完了」を返さない。

注意：DB probeがcleanでも実Storage cleanup完了の証明にはならない。docs/return wordingが過剰保証していないか確認。

### 2. Absent preview / stale confirmation
- no common row previewのversion/epoch
- backfill/service introduction後、old preview/versionが必ずinvalid
- begin deletionがold confirmationでstartedにならない
- version triggerがRPCだけでなくdirect/operator/backfill writeでも適切に動くか

### 3. Backfill vs lock/state transition
- auth.users -> common_accounts lock order
- lock後にplan/status/versionを再評価
- concurrent locked/deleting transition後にentitlement付与されない
- reverse orderも安全
- READ COMMITTED contract / fail-closed behavior

### 4. Admin + self-service workspace
- admin userはconsumer x_autopost entitlement backfill対象外
- Kabumori entitlement semanticsとの区別
- intersection case regression

### 5. Exact FK preflight
- exact referencing column / referenced column
- expected type
- delete action
- validated
- deferrability
- helper function signature/return
- unrelated-column Auth FK counterexample must fail atomically

### 6. Rollback with missing/corrupt settings
- settings row absent => rollback拒否
- enforce/corrupt/non-shadow =>拒否
- in-flight op / downstream dependency / integration started =>拒否
- valid affirmative shadow stateだけrollback可
- guard/objectがpartial teardownされない

## New corrective areas

### Managed checkpoint registry
- built-in checkpoint欠損時fail closed
- service_role/backendが任意にfalse successを作れないか、ACLとcaller contractを確認
- checkpointはorchestrator申告でありDB検証ではないことが明確か
- Apple identity条件、Storage/session required semantics
- future extensibilityがunknown ownershipをsilent ignoreしないか

### Storage read-only probe
- SECURITY DEFINER ownerにproductionでSELECT権限が無い場合fail closedか
- expected storage schema shape違いでfail closedか
- owner/owner_id semanticsを誤解していないか
- clean probeを「cleanup complete証明」として扱っていないか

### Guard semantics
- shadowは既存hard deleteを安全化しないことが明確
- enforceはintegration not_started中に有効化できない
- delete instantでaccount deleting / ready op / ended entitlements / blockers / managed ownershipを再評価
- enforce許可 = DB-visible conditions only。provider/Storage cleanup保証ではない
- legacy X deletionの23503 handlingとの整合

### ACL / RLS / SECURITY DEFINER
- 5 new tables RLS
- self-select columns only
- client writeなし
- service_role table grantなし
- RPC EXECUTE最小権限
- PUBLIC/anon leakなし
- empty search_path + qualified objects
- user_metadata authorizationなし
- start RPC arbitrary user idなし

## Test verification

少なくとも独立再実行：
- `supabase/tests/common_account_lifecycle_run.sh`
- `supabase/tests/common_account_lifecycle_mutations.sh`
- `supabase/tests/social_mobile_account_deletion_run.sh`
- migration source invariants
- shell syntax/static checks
- `git diff --check`

G5 reported:
- lifecycle runner: 19 PASS
- mutation: 29/29 detected
- social-mobile deletion: 8 PASS
- migration invariants: 10 PASS

数字を鵜呑みにせず、可能な範囲で再現する。

mutation suiteについて、少なくとも前回6 blockersに対応するmutation/fixtureが「別の理由で偶然落ちる」だけでなく、狙ったinvariantを検出しているか見る。

## Fix authority

小さく決定的なPR #70 scope内のP1/P2/P3なら failing test -> minimal fix -> rerunを許可。

以下はG5へCHANGES REQUIRED：
- lifecycle contract変更
- managed deletion責任分離の変更
- schema/ACL architecture変更
- provider/Storage orchestrator実装追加
- client/Edge wiring追加
- production-specific repair

## Production gate

このH1がPASSしてもproduction applyは承認しない。

production前に別途必要：
- **Sol（極高）**
- disposable actual Supabase proof
- exact production catalog/preflight read-only確認
- migration-history conflict確認
- Storage/GoTrue/session/role/API境界確認
- backfill dry-run/parity
- explicit user approval

## Completion / C1

`.agent/CODEX_REPORT.md`へ新reportをappend。

必須：
- PASS / PASS-WITH-FIX / FAIL
- exact reviewed/final head
- prior six blockers disposition
- architecture responsibility verdict
- lifecycle/version/backfill verdict
- managed checkpoint/Storage probe verdict
- preflight/rollback verdict
- guard/ACL/RLS verdict
- independent test evidence
- changed_files
- production_mutation=0
- merge recommendation
- remaining prerequisites
- Sol（極高）pre-production gateの要否
- next recommendation

完了時 status -> review_required / next_owner -> chatgpt / STOP for C1.

## H1 corrective rereview completion — 2026-10-01 JST

- verdict: **FAIL / CHANGES REQUIRED**; reviewed/final PR #70 head `eebe9405d758e0c120f9e6f1a70cdb1e973a0855`, unchanged.
- architecture correction and all six prior blockers: independently verified resolved. Phase 1 no longer writes destructive Auth/Storage SQL or claims managed deletion completion.
- new P1: Auth FK cascades can erase late admin/foreign-membership blockers before the common_accounts guard checks them; local trigger instrumentation proves this valid-shape ordering misses the blocker.
- new P2: ready guard does not revalidate changed required checkpoints/Apple identity; built-in registry names can survive with unsafe requirement mappings; an operator entitlement user_id transfer bumps only the destination version.
- independent tests: lifecycle 19 PASS markers; mutation 29/29 DETECTED; existing social deletion 8 PASS; migration invariants 10/10 PASS; shell syntax/lint/diff PASS. Seven additional adverse cases reproduced; Storage SELECT-denied/type-mismatch probes fail closed.
- source/runtime fixes: none. The root delete-boundary/ready-invalidation correction requires lifecycle contract work reserved for G5, not an isolated partial PASS. H1 has not reallocated G5.
- source merge/apply/backfill/deploy: **HOLD**. No production reads or mutations during this rereview; production_mutation=0; no real X operations.
- owned fake probe database removed and local cluster stopped; production data untouched. Detailed counterexamples, scope limits and prior-six dispositions appended to `.agent/CODEX_REPORT.md`.
- next: **C1, 推薦モデル：Sol（高）**; C1 should decide a separate bounded G5 correction. Separate **Sol（極高）** pre-production review, actual disposable Supabase proof and explicit approval remain mandatory. H1 STOP after report synchronization.


## Final C1 — PR #70 corrective rereview

- verdict: **FAIL / CHANGES REQUIRED accepted**.
- reviewed head: `eebe9405d758e0c120f9e6f1a70cdb1e973a0855` unchanged.
- previous six blockers: **resolved and accepted**.
- new accepted blockers:
  1. P1: Auth-delete cascade ordering can remove admin / foreign membership rows before the common-account guard checks them, so delete-instant blocker revalidation is not reliable at that trigger point.
  2. P2: a previously ready operation is not invalidated when required checkpoint registry / Apple identity requirements change.
  3. P2: built-in checkpoint names can retain their names while their required semantics are corrupted.
  4. P2: direct/operator entitlement ownership transfer bumps only the destination account version, leaving the source account stale.
- production mutation/read from H1: 0.
- merge/apply/backfill/deploy: **HOLD**.
- architecture direction: preserve the accepted Phase 1 responsibility split (no managed Auth deletion). Do not make the common_accounts cascade trigger the sole correctness boundary for final Auth deletion. The future managed orchestrator must obtain durable pre-delete authorization from state that cannot be erased by Auth cascade ordering, and every readiness-relevant producer/requirement change must invalidate or revalidate that authorization.
- next owner: G5 corrective task `common-account-pr70-guard-boundary-corrective-20261002`, recommended **Opus5.5（極高）**.
- after corrective K5, focused Codex rereview required. Before any production apply, separate **Sol（極高）** gate remains mandatory.

---

## Previous completed H1 task history — preserved below

# Codex Task

- task_id: common-account-pr70-lifecycle-foundation-review-20261001
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: highest
- recommended_model: Sol（高）
- type: focused security / migration / Auth lifecycle review
- target: PR #70 exact head `89cf128bd9219897806b2b641cce4866f6e16c52`
- production_mutation_allowed: false

## Purpose

共通アカウントv1 Phase 1のadditive lifecycle foundationを独立レビューする。

PR #70は、`common_accounts`、`service_entitlements`、durable lifecycle operation、shadow backfill、lifecycle RPC、Auth削除guard、RLS/grants、race testsをsource-onlyで追加する高リスク候補。

**merge / production migration apply / backfill / deploy / Auth delete / OAuth/Vault操作は禁止。**

## Mandatory startup / isolation

1. PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / G5 Phase 1 TASK+Report / H1 prior C1を読む。
2. H1独立worktree/checkout。
3. fresh origin/main と PR #70 exact headを取得。headが変わっていたらSTOP。
4. PR #70 base以降main変更を再確認し、runtime overlap/raceがあればSTOP。
5. G4 PR #65は別workstream。G4 filesへ触れない。

## Review priorities

### A. Lifecycle serialization — 最優先

- service start vs whole-account deletionの両commit orderが本当に安全か
- auth.users row lock + common_accounts row lockのlock order
- existing `ensure_my_profile` と `begin_social_mobile_x_oauth_connection` との競合証明
- finalizeが同一transaction内でblocker再検証→Auth削除まで隙間なく行うか
- READ COMMITTED限定が妥当か、他isolationでfail closedか
- lifecycle_versionによる確認後変更検知
- stale/retry/idempotency
- deadlock possibilityとdocumented single-transaction assumption
- advisory/row lockが外部Saga stepを原子的に扱ったふりをしていないか

race testが本当に欠陥を検知するか、mutation evidenceも確認する。

### B. SQLによる Auth user deletion

特に深く確認：

- Supabase/GoTrue管理下の `auth.users` をSQLでDELETEすることの妥当性
- auth schema ownership/trigger/FK/session/identity/storage等との整合
- existing X finalizeとの類似だけを根拠に安全扱いしていないか
- delete failure時のtransaction rollback/fail-closed
- session/JWT invalidation assumptions
- future provider/Apple revoke ordering
- production apply前に必要な実Supabase disposable proof

必要なら「SQL deleteはsource candidateとして不採用、Edge/common orchestrator経由へ変更」などをCHANGES REQUIREDとして返す。

### C. Auth deletion guard trigger

- shadow / enforce semantics
- settings row missing時のfail-closed
- cascade時のtrigger behavior
- legitimate service-only cleanupを誤blockしないか
- existing X deletion sagaが23503を期待通り扱えるか（sourceで証明）
- bypass path / owner role / SECURITY DEFINERからの削除
- trigger disable/replica role等の考慮
- rollback時にenforce状態を安全に扱うか

### D. RLS / grants / SECURITY DEFINER

- exposed public tablesはRLS enabledか
- authenticatedはself SELECTのみか
- source/legacy_evidence等の列制限
- client INSERT/UPDATE/DELETE/TRUNCATE不可
- PUBLIC/anon/authenticated/service_roleの不要grantが残らないか
- service_role table grantなし + RPC-onlyが実運用可能か
- SECURITY DEFINERのfixed search_path
- function EXECUTE PUBLIC revoke ordering
- helper/private schema exposure
- auth.uid() ownership checks
- user-controlled metadataをauthorizationに使っていないか

### E. Backfill rules

- common_accounts 1:1 with Auth users
- Kabumori legacy profileをactive候補にすることの曖昧性をsourceで保持しているか
- X entitlementがself-service user workspace ownerだけか
- admin/internal workspace除外
- Auth-only users
- no email-based merge
- existing rowsを上書きしない/idempotent
- locked/deleting accountへ誤付与しない
- sourceのmigration-history driftを悪化させない

Phase 0のproduction aggregateはreference evidenceとして使えるが、このreviewでproduction backfillはしない。

### F. Migration preflight / rollback

- exact preflight object/column/FK/function dependency check
- one transaction / partial apply防止
- version collision
- re-apply strategy
- existing repo migration-history mismatchへの耐性
- rollbackがcandidate-created objectsだけをdropするか
- downstream依存がある状態でrollbackを拒否するか
- rollback後再applyが成立するか

### G. Service lifecycle semantics

- service-only deleteは他service/Authを触らない
- whole-account deleteは全service cleanup完了までfinalize不可
- admin/shared/unknown/unregistered footprint fail closed
- X posting OAuth authorizationとlogin identityを混同しない
- Apple revoke checkpointはwhole-account flowだけの責任として妥当か
- current X deletion scopeのprofiles proxyをこのPRがまだ切り替えていないことが明確か
- current Kabumori hard-deleteがこのPRだけでは安全にならないと明示されているか

## Required verification

PR #70 reported evidenceを鵜呑みにせず再実行/検査：

- `supabase/tests/common_account_lifecycle_run.sh`
- behavior tests
- two-session race tests
- rollback/reapply
- mutation tests or equivalent defect-detection validation
- `social_mobile_account_deletion_run.sh`
- migration source invariants
- SQL lint/static checks where available
- `git diff --check`
- schema diff / ACL inspection

可能なら disposable Supabase/PostgreSQL環境で、role/trigger/search_path/SQLSTATE挙動を追加検証。

実productionへのwrite/apply/deleteは禁止。

## Fix authority

小さく決定的なP1/P2/P3でPR #70 scope内なら failing test -> minimal fix -> rerun を許可。

ただし以下はG5へCHANGES REQUIREDで返す：

- architecture変更
- Auth削除方式の根本変更
- lifecycle contract変更
- schema/role modelの大幅変更
- production-specific migration repair
- client/Edge wiring追加

## Completion / C1

`.agent/CODEX_REPORT.md` に新規reportをappend。

必須：

- PASS / PASS-WITH-FIX / FAIL
- exact original/final head
- findings severity
- lifecycle serialization verdict
- SQL Auth deletion verdict
- guard trigger verdict
- ACL/RLS/SECURITY DEFINER verdict
- backfill/preflight/rollback verdict
- test evidence
- changed_files
- production mutation=0
- merge recommendation
- prerequisites before any production apply
- whether **Sol（極高）** pre-production review is required
- next recommendation

完了時 status -> review_required / next_owner -> chatgpt / STOP for C1.

## H1 completion — 2026-10-01 JST

- verdict: **FAIL / CHANGES REQUIRED**; review completed, source merge/apply/deploy HOLD.
- original/final PR #70 head: `89cf128bd9219897806b2b641cce4866f6e16c52` (unchanged).
- P1: SQL Auth finalization can report completed with Storage-owned metadata remaining; ownership is not protected by an Auth FK. No production deletion was performed.
- P2: backfill preserves version 1 for newly created accounts with new service entitlements, accepting an old empty preview; a two-session backfill can grant an active entitlement after an operator lock commits; admin + self-service-owner is not actually excluded.
- P2: preflight accepts an unrelated-column Auth FK instead of the required user binding; rollback removes the effective-enforce guard when its settings row is missing.
- independently rerun after reset: lifecycle runner 16 checks PASS, existing social deletion runner 8 checks PASS, migration invariants 10/10 PASS, bash syntax / invariant lint / diff checks PASS. Removing the common row lock in a scratch-only mutation is detected by race 7. Six additional safety counterexamples reproduced; standard suites do not cover them.
- runtime/source fixes: none. Correcting managed Auth/Storage deletion and backfill/confirmation serialization requires the lifecycle contract work explicitly reserved for G5, not a partial safety claim.
- production mutation=0; read-only catalog metadata only. Real disposable Supabase GoTrue/PostgREST/Storage proof is still required; local PostgreSQL is not that proof.
- full findings, reproduction recipes, limits and delivery evidence appended to `.agent/CODEX_REPORT.md`; prior reports and other slots preserved.
- next: **C1, 推薦モデル：Sol（高）**. After a separately assigned G5 correction, repeat focused review; **Sol（極高） pre-production review required** before any production apply. This completion does not allocate G5 or authorize production. H1 STOP.


## Final C1 — PR #70 lifecycle foundation

- verdict: **FAIL / CHANGES REQUIRED accepted**.
- reviewed source head: `89cf128bd9219897806b2b641cce4866f6e16c52`; unchanged by H1.
- merge/apply/deploy: **HOLD**.
- accepted blockers:
  1. SQL Auth DELETE can report completion while Storage-owned state remains; Phase 1 must not claim managed-account destruction safety.
  2. absent-account preview version can remain valid after backfill adds service entitlement.
  3. backfill can grant entitlement after a concurrent account lock/state change.
  4. admin + self-service workspace intersection can receive x_autopost entitlement.
  5. FK preflight validates table-level FK existence instead of exact invariant-bearing columns.
  6. rollback can remove the guard when lifecycle settings row is missing even though runtime treats missing as enforce.
- accepted approach: do **not** patch the SQL hard-delete path incrementally. Narrow Phase 1 to additive lifecycle/entitlement/serialization foundation and move actual managed Auth destruction to a later common-account orchestrator/integration phase.
- production mutation from H1: 0.
- current production corruption: not established.
- next owner: G5 corrective task `common-account-pr70-corrective-lifecycle-foundation-20261001`, recommended **Opus5.5（極高）**.
- after corrective K5, repeat focused Codex review. Before any production apply, separate **Sol（極高）** review remains mandatory.

---

## Previous completed H1 task history — preserved below

# Codex Task

- task_id: common-account-kabumori-delete-cross-service-safety-review-20261001
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: highest
- recommended_model: Sol（高）
- type: security review / bug fix / Auth deletion boundary
- target: fresh origin/main; existing production-deployed Kabumori account deletion source
- production_mutation_allowed: false

## Purpose

共通アカウントv1 Phase 0（G5）のread-only inventoryで確認された、既存Kabumori account deletionのcross-service lifecycle riskを独立レビューする。

現在のKabumori deletionは共有Supabase Auth userをhard deleteする一方、X自動投稿側のworkspace / posting authorization / Vault credential / admin ownershipを認識しない。現時点で両service利用者は0人だが、共通ID導入後にそのまま残すと一サービスの退会が他serviceへ影響する。

このTASKでは、まずsource/securityレビューを行い、**小さく安全で決定的な暫定fail-closed修正が可能なら source + tests まで実施してよい**。production deployはしない。

## Mandatory startup / isolation

1. PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / G5 Final K5 + Reportを読む。
2. H1専用の独立worktree/checkoutを使用。
3. fresh origin/mainを取得。
4. G3はsocial-mobile account deletion UI、G4はX posting OAuth account-switchを扱っている。G3/G4のbranch/files/PRを変更・merge・rebase/resetしない。
5. pending PRのchanged filesを確認し、Kabumori account-delete scopeと競合があればSTOP。

## Facts from G5 to independently verify

- production Kabumori account-delete is ACTIVE and verify_jwt=true.
- source path hard-deletes the authenticated Supabase Auth user.
- shared Auth hard delete cascades at least to Kabumori profile data, admin membership, X membership/OAuth-state references, while X workspace/social account/Vault credential can remain because they are not directly Auth-owned.
- X authorization revoke is not performed by Kabumori deletion.
- X social-mobile deletion has stronger cross-service/admin guards and service-specific cleanup, but must not be copied blindly.
- current production population has no user simultaneously classified as Kabumori + user-facing X workspace owner, so this is a latent boundary defect rather than evidence of an already-corrupted shared user.

Treat these as G5 findings to verify, not assumptions to silently trust.

## Review questions

1. Is the Kabumori hard-delete path actually reachable from current client UI and production deployment?
2. Exactly which shared/cross-service rows cascade or remain orphaned if Auth user is deleted?
3. Can an admin account currently delete itself through the Kabumori path?
4. What is the smallest safe interim guard before common-account orchestrator exists?
5. Should the interim path fail closed when any of the following exist:
   - admin ownership
   - X/social-mobile user-facing membership/workspace ownership
   - active/pending posting OAuth state or other service footprint
   - any other shared-account evidence found in source/production metadata
6. Does the interim correction preserve legitimate Kabumori-only account deletion?
7. Is server-side reauthentication/session freshness already adequate, or is a separate issue required? Do not expand into a large auth redesign in this TASK.
8. What regression tests prove “Kabumori-only may delete” and “other-service/admin footprint cannot be hard-deleted here”?

## Fix authority

Allowed only if review shows a bounded source-only fix:

- modify Kabumori account-delete Edge Function and narrowly related tests/docs
- add a server-side fail-closed pre-delete ownership/other-service guard using existing schema
- preserve current JWT verification and Auth ownership
- return a truthful non-success error requiring common-account/service-specific lifecycle handling
- add regression tests

Do not introduce common_accounts/service_entitlements yet.
Do not create/apply migrations or RLS changes in this TASK.

If safe correction requires schema migration, new lifecycle orchestrator, provider revoke redesign, or broad cross-service semantics, **do not implement**; report CHANGES REQUIRED for G5 Phase 1.

## Forbidden

- production deploy
- production DB write
- migration apply
- Auth user create/update/delete
- identity link/unlink
- X OAuth authorize/revoke
- Vault secret read/write/delete
- account deletion execution
- real X operations
- feature flag / Cron / secret / provider setting changes
- G3/G4 source changes
- common-account Phase 1 schema implementation

Read-only production metadata checks are permitted only if already available through safe authorized tooling; never expose PII/secrets.

## Required verification

At minimum:

- inspect account-delete source and client entry path
- inspect current FK/cascade ownership relevant to cross-service deletion
- focused account-delete tests
- static/type/lint/diff checks appropriate to changed scope
- tests for Kabumori-only allowed path if behavior preserved
- tests for admin and X-service footprint blocked path if implemented
- confirm no X revoke/Vault mutation is introduced into Kabumori service-only path
- confirm production mutation = 0

## Completion / C1

Append a new report to `.agent/CODEX_REPORT.md`.

Report:

- PASS / PASS-WITH-FIX / FAIL
- exact reviewed main/head and final head if source changed
- confirmed risk and affected boundaries
- findings by severity
- interim guard decision
- changed_files
- tests
- production mutation = 0
- whether source is safe to merge
- whether any production deploy is recommended/held
- what remains for G5 common-account Phase 1
- next recommendation

At completion: status -> review_required, next_owner -> chatgpt, STOP for C1.

## H1 completion — 2026-10-01 JST

- result: **FAIL / CHANGES REQUIRED** for the existing shared-Auth hard-delete boundary; review itself completed.
- independently confirmed production account-delete ACTIVE v8 / verify_jwt=true; both deployed source files byte-equal to reviewed main.
- P1: admin self-deletion is not guarded; X membership/OAuth-state cascades can leave workspace/social-account/posting credentials behind. No actual account deletion was performed.
- interim_guard_decision: no runtime fix. Separate read-only footprint checks followed by Auth DELETE retain a creation/deletion race. Existing X deletion acquisition writes tombstones/audit/posting state and has different service scope; copying it is not a bounded Kabumori guard.
- tests: focused 23/23 PASS; offline missing-guard/freshness probes 4/4 confirmed current behavior; targeted typecheck/runtime lint PASS. Combined test lint has five pre-existing require-await findings.
- reviewed main: startup 59108acab7c8445c169bbd05f24f10af4f120ce7; completion baseline 6e262b0b2f17386c55924f757c19abc7d48b89e8 (only G2 Report changed between them).
- runtime/source delta: 0; production mutation: 0; deploy: none. This TASK does not implement or authorize G5 Phase 1.
- full evidence / proposed acceptance tests: appended .agent/CODEX_REPORT.md section for this task_id.
- next: C1 review, then separately scope/authorize common lifecycle serialization, explicit service registration and recent reauthentication after G3/G4 conflict reconciliation. Recommendation: Sol（高）. H1 STOP.


## Final C1 — Common account deletion safety

- verdict: **FAIL / CHANGES REQUIRED accepted**.
- accepted finding: the existing Kabumori hard-delete route is not common-account-safe. Admin self-deletion and cross-service ownership/orphan risk are confirmed source/security defects.
- no runtime fix was accepted because a read-check followed by a separate Auth hard delete cannot serialize against concurrent service provisioning; a partial preflight would give false confidence.
- current production corruption was not observed; dual Kabumori+user-facing-X users were 0 at review time.
- production mutation from H1: 0.
- runtime source candidate: none.
- merge/deploy: none / HOLD.
- next step: G5 Phase 1 additive common-account/service-entitlement/lifecycle foundation, source-only. It must provide an explicit lifecycle/serialization primitive before the Kabumori hard-delete route can be considered safe.
- recommended G5 model: Opus5.5（極高）.

---

## Previous completed H1 task history — preserved below

# Codex Task

- task_id: kabumori-pr67-shared-report-v2-hard-fact-review-20261001
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: highest
- recommended_model: Sol（高）
- target: PR #67 exact head `5877045f7554cd4e089fb3b79091bf8e2bb38456`

## Purpose

PR #67 の shared market report Presentation v2 を独立レビューする。X約500字・App長文・Hard Fact / Quality WARN境界を、1つのshared fact spineを壊さず安全に成立させることを確認する。

**source/test review only**。merge / deploy / gate ON / real X post / production mutationは禁止。

## Accepted G2 evidence

- PR #67: open / mergeable=true / 27 files / +4622 -146.
- main-side 10 commits after PR base have no overlap with PR #67 runtime files.
- reported: analysis 73/73, personalized 128/128, X shared 8/8, data-packet 42/42, _shared 329/329, historical Fact-passed packet replay 8件で新Hard誤検出0, check/lint/diff PASS.
- production mutation=0; app_enabled=false / x_enabled=false.

## Mandatory startup / isolation

1. PROJECT_RULES, ORCHESTRATION, CURRENT_STATE, G2 Report, DESIGN §15 を読む。
2. H1独立worktree/checkoutを使う。G2/H2/G1/G3/G4と共有しない。
3. fresh origin/main と PR #67 exact head を取得し、headが変わっていたらSTOP。
4. H2はPR #66をreview中。H2のTASK/branch/filesを触らない。

## Review priorities

### A. Hard Fact guard — 最優先

`hard_fact_guards.ts` と `analysis_logic.ts` integrationを深く確認する。
- metric/value mismatch
- metric/session-date mismatch
- 2026-10-01 mixed-session exact regression
- reused metricが元session_dateを保持
- staleをfresh/currentとして出さない
- direction/polarity/sign/emoji inversion
- 1306をTOPIX indexと誤認しない
- unsupported causality
- fabricated metric/news/ref/entity
- broad false absence claim

False negativeだけでなくfalse positiveも見る。『理由不明』『材料が薄い』『文体弱い』は、正直に書ける限り配信停止要因にしない。

### B. Hard BLOCK vs Quality WARN / rewrite fallback

`localAnalysisCheck`, warning codes, `qualityRewriteHints`, generation flow, handler diagnostics, delivery-policy分類を確認。
最低限次をadversarial testする：
- safe original + WARN -> rewrite Hard
- safe original + WARN -> rewrite Fact fail
- gen1 Hard -> gen2 safe
- invalid output -> next generation safe
- persistent Hard
- transport 429 around quality rewrite
- sparse/no evidence

確認条件：WARNだけではcycleを落とさない。rewriteがHardなら元のsafe draftへ戻る。call loopは bounded。content regeneration / Fact-local rejection / transport retry / cron retryを混同しない。

### C. v1 backward compatibility

`_shared/market_report_packet.ts`, `market_report_story.ts` を確認。
- 保存済みv1 packetが読める
- v1 X formatterの既存挙動を壊さない
- v1 fallback storyが事実を捏造しない
- DBのschema_version checkを破らない
- migration不要という判断がJSON payload実装上正しい
- report_packet_id/content_hash semantics維持

### D. Public X contract / privacy

- rich v2 section order, exactly 3 points, optional context/news/watch
- length targetはWARNでありFact blockではない
- hard min/maxは投稿不能保護として妥当
- URL/hashtag/internal field/user portfolio漏洩なし
- X consumerが独立再分析しない
- warning telemetryがsafe postを誤blockしない
- ~500日本語文字の投稿権限/契約がsourceから証明できなければ activation prerequisite として記録する

### E. App story / personalization boundary

- App storyはshared evidenceだけで長文化
- market-wide storyは全ユーザー共通
- personalized layerはholdingsを足してもshared market facts/directionを書き換えない
- user/portfolio dataがshared packet/storyへ漏れない
- native UI未対応は別G1 taskとして残す

### F. News priority / absence claims

- broad > sector > company がdeterministic
- isolated company criticalが市場全体storyを機械的に占有しない
- company itemはkey_newsやMy Portfolioで扱える
- category/company-code scope inferenceに明白な誤分類がない
- scoped absence（例: この銘柄の個別ニュースは確認できない）を誤blockしない
- 旧経路で出たfalse absence文はblockする

## Required verification

- market-report-analysis full suite + presentation_v2
- hard fact/date/session regressions
- handler/regeneration diagnostics
- transport retry suite
- personalized-reports full suite + shared story + absence regressions
- X shared consumer full suite
- data-packet regression
- _shared relevant/full suite if feasible
- deno check / lint / git diff --check

見つけた穴にはfocused adversarial testを追加する。

## Fix authority

小さく決定的なP1/P2/P3なら failing test -> minimal fix -> rerun を許可。PR #67 scope内だけ。
architecture変更、DB/schema/migration、model-call architecture変更、product semantics大変更が必要なら修正せず CHANGES REQUIRED でG2へ返す。

## Forbidden

- production deploy / DB write / migration / cron / gate change
- real X post / manual production cycle
- legacy X/App generator fix
- G1 native UI implementation
- important-news/API最適化変更
- H2/PR #66変更

## Completion / C1

`.agent/CODEX_REPORT.md` に新しいH1 reportを追記し、過去履歴を消さない。
reportには verdict, original/final head, findings severity, Hard-vs-WARN, mixed-session, rewrite/fallback/call budget, v1 compatibility, X privacy/output, App shared/personalized boundary, news priority/absence, tests, changed_files, production mutation=0, merge recommendation, rollout prerequisites を含める。

完了時: status -> review_required / next_owner -> chatgpt / STOP for C1.

## H1 completion — 2026-10-01 JST

- verdict: **PASS-WITH-FIX (source/tests)**; STOP for C1, no merge/deploy/activation.
- original head: `5877045f7554cd4e089fb3b79091bf8e2bb38456`.
- final source head, pushed to PR #67: `d6f9c9a0285920871d0ce86cc4559f9675c0ebb9`.
- corrected deterministic guard holes and false positives, malformed nested-output handling, exhausted quality-rewrite request fallback, and actual model-input news ordering; added 13 executed adversarial tests.
- analysis 86/86 (presentation 22 + H1 adversarial 13 included); personalized 128/128; data-packet 42/42; X shared consumer 8/8; `_shared` 329/329 with --no-check. Target runtime check/lint/diff PASS.
- existing `_shared` whole-suite type errors are documented separately; not a claim of a repository-wide clean typecheck.
- production mutation=0. Actual v2 model output, ~500-Japanese-character X API posting entitlement/contract, and native story UI remain rollout prerequisites. Detailed findings and limits are appended to `.agent/CODEX_REPORT.md`.


## Final C1 — PR #67

- verdict: **PASS-WITH-FIX / accepted**
- original G2 head: `5877045f7554cd4e089fb3b79091bf8e2bb38456`
- H1 reviewed/fixed final head: `d6f9c9a0285920871d0ce86cc4559f9675c0ebb9`
- H1 fixed nine demonstrated P2-class issues, including:
  - safe-original loss on quality-rewrite request failure
  - malformed nested-output parser escape
  - metric value/change/date association holes
  - stale-as-current wording
  - mixed-direction emoji escape
  - historical assertions in watch/caution escaping factual guards
  - scoped absence false positive
  - negated direction false positive
  - model-input news ordering contradicting broad-first policy
- final verification accepted:
  - market-report-analysis 86/86
  - H1 adversarial 13/13
  - personalized-reports 128/128
  - market-report-data-packet 42/42
  - X shared consumer 8/8
  - _shared 329/329 with --no-check
  - target runtime check/lint/diff PASS
- production mutation from H1: 0
- fresh-main overlap check before merge: no runtime-file overlap with PR #67.
- PR #67 final head was mergeable and was merged by ChatGPT.
- merge/main SHA: `09975d02cc81b1614818951173a94aa8677291a0`
- consumer gates remain OFF; this C1 does not authorize app/X activation.
- rollout prerequisites still include:
  - actual live-model v2 generation observation
  - actual X long-post entitlement/provider acceptance before x_enabled
  - native App story UI integration before app consumer activation

---

# Previous completed H1 task — preserved history

# Codex Task

- task_id: x-social-mobile-pr65-ephemeral-x-auth-session-review-20261001
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: high
- recommended_model: Sol（高）
- target: PR #65 exact head `e8a7785d5635096aa428899d28e629a95b7e3f31`

## Purpose

Focused pre-merge OAuth/authentication-boundary review of the iOS X posting-account connection change that requests an ephemeral/private auth session so a previously logged-in X account is not silently reused.

This is a source/security review only. Provider-side live account switching remains an operator E2E check and must not be simulated with protected production accounts.

## Verify

### 1. Expo API / platform behavior
- installed `expo-web-browser 57.0.3` actually supports `AuthSessionOpenOptions.preferEphemeralSession`
- the option is valid for `openAuthSessionAsync` and is iOS-scoped as claimed
- implementation passes `{ preferEphemeralSession: true }` only on iOS
- Android/Web behavior is not unintentionally changed
- no native rebuild/config/plugin change is required beyond the existing expo-web-browser native module already in the development build; flag uncertainty if this cannot be proven from source/package state

### 2. OAuth security invariants
- authorization URL host/protocol validation remains unchanged
- state generation/verification remains unchanged
- PKCE verifier/challenge generation remains unchanged
- callback redirect validation remains unchanged
- callback request body and ownership binding remain unchanged
- no undocumented X parameters were added
- no global cookie/browser-data clearing was introduced
- duplicate-X-account server protection is untouched
- no token/Vault/DB/Auth/server-side write path was changed

### 3. Session/account-selection semantics
- ephemeral session is an appropriate way to avoid sharing normal Safari/browser cookies for this posting-account connect flow
- wording does not overpromise that an account chooser will always appear
- reconnect path uses the same behavior
- cancellation/dismiss/retry/error handling stays truthful
- assess the caveat that the browser/provider may ignore the request, and whether the current UX copy is sufficient

### 4. Tests
Review whether the new tests prove behavior rather than only source-string shape where possible.
Run/re-run relevant:
- focused X auth-session tests
- full social-mobile test suite
- typecheck
- lint
- any safe static/export checks useful for this boundary

If a test is brittle or gives false confidence, fix only narrowly within PR scope and report the new exact head.

### 5. Scope / safety
Confirm:
- PR changes only intended client files/tests
- no overlap with G3 E3 destructive verification
- no production mutation
- no real X login/post/revoke
- no DB/RLS/RPC/migration/Edge/Vault/Auth-provider mutation
- no secret leakage

## Provider-side E2E boundary

Do NOT attempt to type X credentials, use protected production X accounts, revoke any authorization, or post to X.

The operator must separately verify on a safe disposable account/device that the iOS auth sheet no longer silently reuses the previous X session and that a different X account can be authenticated.

Codex should state whether source is safe to merge **conditional on that provider-side E2E**.

## Completion / C1

Report:
- verdict PASS / PASS-WITH-FIX / FAIL
- exact reviewed head
- findings and any fixes
- OAuth/security invariant result
- platform behavior result
- test evidence
- remaining provider-side caveat
- production mutation = 0
- whether PR #65 is source-safe to merge after operator E2E passes
- next recommendation

Then status -> review_required, next_owner -> chatgpt, STOP for C1.

## H1 completion — 2026-10-01 JST

- verdict: **PASS-WITH-FIX (tests only)**; no client runtime/security defect found.
- original reviewed head: `e8a7785d5635096aa428899d28e629a95b7e3f31`.
- final reviewed/pushed PR #65 head: `e5a66f5ba71f64b1a38d8f89faff3d0a31972949`.
- H1 replaced weak source-string assertions with executed hook/SDK-bridge tests; client behavior is byte-unchanged from the original PR head.
- focused 14/14, mobile 103/103, data-view/post-interaction 22/22, typecheck/lint/Web+iOS exports/diff checks PASS.
- source is safe to merge **after C1 and safe operator provider-side E2E pass**. Account switching on an actual device/browser remains unverified; keep merge hold.
- production_mutation=0; see `.agent/CODEX_REPORT.md` for evidence and caveats.


## Final C1

- verdict: **PASS**
- accepted PR: #65
- accepted exact head: `e5a66f5ba71f64b1a38d8f89faff3d0a31972949`
- H1 disposition: PASS-WITH-FIX (tests only). Runtime/client behavior remained unchanged from original head `e8a7785d5635096aa428899d28e629a95b7e3f31`.
- H1-only source delta from original reviewed head: exactly one test file, `apps/social-mobile/tests/x-connect-auth-session.test.mjs`.
- verification: focused 14/14, mobile 103/103, data-view/post-interaction 22/22, typecheck/lint/Web+iOS exports/diff checks PASS.
- OAuth/security invariants accepted: PKCE/state/redirect/callback/host validation/server duplicate-account protection unchanged; no undocumented provider parameter; no cookie clearing; no DB/RLS/RPC/migration/Edge/Vault/Auth-provider change.
- production mutation: 0.
- merge decision: **HOLD** until safe operator provider-side E2E confirms a different X account can authenticate without silently reusing the prior normal-browser session, including cancel/retry/reconnect behavior.
- H1 is closed and free. G4 remains review_required for the operator E2E/merge gate.
