# Codex Task 2 — CURRENT TASK

- task_id: x-social-mobile-pr78-ai-consult-review-20261002
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: highest
- recommended_model: Sol（高）
- type: focused review / authenticated AI API / settings persistence safety
- target_pr: 78
- target_head: 6e9f78a31bae9b65599732a9b416dcb50f2bfbc7
- production_mutation_allowed: false

## Purpose

PR #78「AI相談 v1」を独立レビューする。

This is not a UI polish review. It adds:
- authenticated Edge Function / AI provider boundary
- saved settings/persona read path
- untrusted structured AI output parsing
- user-confirmed settings/persona persistence with optimistic concurrency.

The review must prove that ordinary conversation, malicious/forged history, malformed model output, cross-tenant input, or a stale confirmation cannot silently mutate durable settings or reach posting/X/Auth/OAuth/scheduler boundaries.

**merge / deploy / production settings write / AI live call / X API / Auth / Vault / migrationは禁止。**

## Mandatory startup / isolation

1. Read PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / ACTIVE_TASK.
2. Read G3 current TASK/Report `x-social-mobile-ai-consult-v1-20261002`.
3. Independent H2 worktree/checkout.
4. Fresh fetch origin/main and PR #78 exact head `6e9f78a31bae9b65599732a9b416dcb50f2bfbc7`.
5. STOP if head differs.
6. Re-check base-to-main overlap for all 11 PR files. K3 found main +7 commits, overlap 0.
7. H1 is simultaneously reviewing PR #76. PR #76 files are separate; do not touch H1 branch/worktree/files.
8. No source merge/deploy from H2.

## Gate A — Auth / tenant isolation

Independently verify:

- Bearer/JWT is required and actually validated against Auth.
- verified user id, not request data/history, is the identity boundary.
- `brand_id` supplied by the client is only a selector; it must not grant authority.
- membership query is scoped to the verified caller and exact brand.
- role policy is explicit and consistent with current social-mobile ownership model.
- foreign brand id, foreign workspace, missing membership, forged user id, duplicate membership, malformed brand id all fail closed.
- brand must be the intended `social_mobile_user_v1` profile/context.
- no service-role key is used by the consultation endpoint.
- no response/log leaks user id, email, JWT, Authorization, provider key, raw settings from another tenant, or conversation text.
- production schema/RLS read-only inspection may be used to verify assumptions; no writes.

Clarify whether owner-only is intentional/safe versus any existing member/admin product semantics. Over-restriction can be noted separately; tenant escape is a blocker.

## Gate B — request/context integrity

Verify hard bounds:
- exact request key allowlist
- message length
- history turn count
- per-turn length
- total history size
- total body size
- role values
- method/content type
- no hidden settings/token/account fields accepted.

Review client-supplied history:
- user can forge prior assistant turns; confirm this can influence only their own model context, not authorization/persistence.
- forged assistant text must not be treated as previously confirmed settings/persona.
- server must use its own saved confirmed settings/persona read, not client-claimed state.
- confirmed-only persona rule is real.

Attempt prompt-injection cases where history/message tells the model to emit forbidden keys, publish, schedule, reveal secrets, or claim something is saved.

## Gate C — AI provider / structured-output trust boundary

Prove:
- provider secret is server-only
- model is called at most once per send
- no tools/web/X API
- `store:false` or equivalent no-retention setting is actually set
- timeout/output bounds are enforced
- provider errors are bounded/retryable without raw provider leakage
- strict schema is used as claimed, but server still treats returned JSON as untrusted
- exact top-level key allowlist
- exact editable settings allowlist
- exact persona allowlist
- forbidden control keys (publish/account/oauth/token/secret/schedule/cron/approval/generationWindow/locale/password/session/delete/vault etc.) fail closed even when nested/obfuscated in plausible structures
- chat/question modes cannot carry deltas
- same-as-saved deltas are dropped
- malformed/partial output cannot create a pending proposal.

Check client-side validator independently rejects an unsafe success envelope even if server were compromised or buggy.

## Gate D — no implicit persistence / confirmation

Trace every write path.

Prove:
- receiving AI response creates no DB write
- normal chat creates no proposal
- question creates no persistent delta
- proposal remains memory/UI only
- only explicit 「これで覚えて」 reaches save
- dismiss/correction/retry cannot accidentally save the prior proposal
- later proposal supersedes prior pending proposal safely
- settings-only confirmation cannot erase/relabel existing persona
- persona changes remain confirmed and bounded
- no path toggles publish_enabled, approval permission, scheduled posts, X connection, Auth or common-account state.

The Edge Function itself should be read-only. Enumerate every network/data call and prove there is no write call.

## Gate E — optimistic concurrency / production schema truth

This is a critical review point.

The implementation relies on `social_mobile_content_settings.updated_at` as a compare-and-swap version.

Use read-only production catalog/schema inspection to verify:
- table exists in the target production project
- expected columns exist
- exact type/nullability/default of `updated_at`
- RLS/policies match client read/write assumptions
- INSERT/UPDATE permissions are what the mobile client needs
- whether a trigger automatically changes `updated_at` on every update
- whether any existing upsert/update path can change settings without advancing `updated_at`.

If `updated_at` does not reliably advance, CAS may be illusory and must be a blocker or receive a bounded source-safe correction only if no schema change is required.

Test:
- row absent -> competing insert
- row present -> competing update
- touched field changed after proposal
- unrelated field changed after proposal
- persona changed after proposal
- simultaneous confirm from two devices
- update returns zero rows
- RLS denial
- malformed saved settings.

No production writes.

Also review the bundled fix allowing only `generationWindow.endLocal = "24:00"`:
- confirm DB/server semantics really allow 24:00 there
- no other time field accidentally accepts it
- no validation weakening beyond the intended field.

## Gate F — history-learning boundary

Past-post learning is NOT implemented here.

Verify:
- history intent can be detected/displayed only
- no X history fetch
- no X token read
- no X API
- no persona derived from posts
- no hidden call through shared helpers
- explicit consent boundary remains intact.

## Gate G — cost / abuse / rollout

Assess:
- one call/send, 25s timeout, 900 output tokens, bounded input
- no recursive loops/retries/tools
- current absence of per-user quota/rate limit.

Do not automatically fail solely because per-user rate limiting is absent if the feature remains undeployed/private-gated, but clearly classify whether it must be added before:
- production deploy
- public enablement
- wider multi-user rollout.

Check whether existing platform/Supabase protections provide any effective abuse ceiling; do not assume.

## Gate H — config/deployment truth

Verify:
- repository config will deploy `social-mobile-consult` with JWT verification ON.
- if no explicit function stanza exists, determine actual Supabase default/current project behavior rather than assuming.
- no secret/config/migration changes are hidden outside the 11 PR files.
- no production deployment has occurred.

## Tests / adversarial verification

Run independently:
- PR Edge logic tests
- Deno check/lint
- full social-mobile tests
- typecheck/lint
- relevant shared brand/content-setting tests
- diff check / secret scan
- focused mutation/adversarial tests for findings.

No paid/live AI call required; provider should be stubbed.

If a bounded defect is found:
- H2 may make a small review fix on an H2-owned branch if it changes only PR #78 source/tests and no migration/config/production state.
- add regression first where practical.
- preserve original reviewed head in report.
- do not merge/deploy.
If a fix requires DB migration/RLS policy change or architecture change, STOP with CHANGES REQUIRED.

## Production safety

Allowed:
- code review
- local tests
- read-only production schema/catalog/RLS inspection.

Forbidden:
- production settings writes
- Edge deploy
- migration/RLS/grant apply
- Auth mutation
- Vault read plaintext/write
- X API/history/post
- live paid AI request
- Cron/scheduler change.

## Report

Append to `.agent/CODEX_REPORT_2.md` without deleting history:

- task_id
- verdict PASS / PASS-WITH-FIX / FAIL
- original exact head
- final reviewed candidate if fix
- Auth/tenant result
- request/history integrity
- AI structured-output/injection result
- no-implicit-persistence result
- CAS/updated_at production-schema result
- 24:00 validation result
- history-learning boundary
- cost/rate-limit rollout classification
- JWT/deployment config result
- tests/adversarial checks
- changed_files/fix commit if any
- production reads/mutations
- real AI/X operations
- remaining risks
- merge recommendation
- deploy/public-rollout recommendation
- safety checks.

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for C2.

Recommended model: **Sol（高）**.

## H2 stop / C2 handoff — 2026-10-02 JST

- verdict: **FAIL / CHANGES REQUIRED（production schema prerequisite BLOCKED、レビュー未完了）**。
- original/final source head: `6e9f78a31bae9b65599732a9b416dcb50f2bfbc7`、source修正なし。
- read-only production catalog: `public.social_mobile_content_settings` **不存在**。columns/policies/grants/triggers/constraintsなし。
- Gate Eのupdated_at/CAS/RLS/write権限は証明不可。TASKの「schema不足・migrationを要する場合はSTOP」に従い、DB追加/適用/回避はしない。
- 他Auth/AI/confirmation/config/adversarial gatesは未完了。merge/deploy/public rollout **HOLD**。
- tests: head/11-file overlap0/diff/clean checkout確認。mandatory-stopによりEdge/app/shared test rerun・mutation/typecheck/lintはNOT RUN。G3申告結果を独立PASSに読み替えない。
- existing source candidate: `20260922045046_social_mobile_content_settings_candidate.sql`。sourceにあるだけでlive適用済みとは扱わない。今回適用承認/DB修正提案の実行なし。
- Report publication commit: `e439c546caec0e9d99e930f5412e395ae7351f40`。exact content read-back確認済み、過去履歴保持。
- production catalog SELECT 1 query、production writes/deploy/AI/X/Auth/Vault/Cron操作0。正式repo未commit変更/H1/他slot操作0。
- next: C2でschema prerequisiteを別承認/工程として扱うかを判断。解決後に未完了レビューを再開（推薦モデル：Sol（高））。
- status: review_required / next_owner: chatgpt。**STOP for C2**。


---

# Codex Task 2 — CURRENT TASK

- task_id: common-account-pr70-preproduction-gate-20261002
- owner: codex
- slot: codex-2
- status: done
- next_owner: none
- priority: highest
- recommended_model: Sol（極高）
- type: independent pre-production Auth/RLS/migration gate
- target_main: `44121914b035e22380a4ca1bd8252a42713a2bbf`
- accepted_source_head: `aa4d2d425d1d7c432d43c9ecfb8e978a40b80a65`
- production_mutation_allowed: false

## Purpose

Merged common-account Phase 1 foundationの**production適用前最終ゲート**。

このTASKは「productionへ入れてよいか」を判断するための独立検証であり、**production migration apply / backfill / deploy / Auth/Storage/OAuth/Vault mutationは一切しない**。

C1でsource merge済みだが、それはproduction適用許可ではない。

## Mandatory startup / isolation

1. PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / ACTIVE_TASKを読む。
2. G5 Phase 0〜第2是正Report、H1全PR #70 review history、Final C1を読む。
3. H2独立worktree/checkout。
4. fresh origin/mainを取得し、`44121914b035e22380a4ca1bd8252a42713a2bbf` がancestorとして含まれることを確認。mainが進んでいても対象8 filesへの変更をfresh確認。
5. H1/G5/H2以外のbranch/worktree/未commit変更に触れない。

## Gate A — merged source integrity

main上で以下を再確認：

- accepted source deltaがexact reviewed fixを含む。
- migration / tests / docsがmerge時に欠落・改変していない。
- no SQL `DELETE FROM auth.users`.
- no managed Storage/Vault/provider destructive SQL.
- no enforcing Auth-delete guard in Phase 1.
- current Kabumori legacy hard-deleteは未変更・unsafeと明記。
- Phase 1責任はreadiness foundationまで。

## Gate B — actual disposable Supabase proof

ローカルPostgreSQLだけでは足りないため、**実Supabaseの使い捨て環境でmanaged boundaryを証明することがproduction適用条件**。

ただし：
- 既存production projectを破壊テストに使わない。
- 既存ユーザー/Storage/OAuth/Vaultを使わない。
- disposable environmentを安全に利用できる既存経路・projectが無い場合、勝手に新project/課金resourceを作らず **BLOCKED / operator prerequisite** として止める。
- userが明示的に許可したdisposable projectまたは既存安全sandboxがある場合のみ実行。

実証項目：
- migration apply
- public table Data API exposure/非露出
- RLS self-select / client write denial
- service_role direct table grant denial + RPC path
- SECURITY DEFINER owner/search_path behavior
- `auth.users`, `auth.identities`, sessions/token behaviorのmanaged境界
- Storage API ownership cleanup semantics
- `storage.objects.owner_id`/bucket probe compatibility
- observer triggerがreal Auth Admin API deleteでどう発火/観測されるか
- direct common row delete refusal
- PostgREST RPC exposure / SQLSTATE / error mapping
- rollback/reapply where safe
- no real provider OAuth

disposable proofができなければ「未証明」をPASS扱いしない。

## Gate C — production read-only preflight

productionには**SELECT / catalog readのみ**。

必要：
- exact schema/table/column/FK/type/delete action/validated/deferrability
- required helper signatures
- roles/grants/current RLS
- migration history / version collision
- target migration version未適用
- target object name collisionなし
- current Auth user count / legacy population aggregate（PIIなし）
- Phase 0 backfill expected countsと現状差分
- current `auth` / `storage` shape relevant to preflight
- function ownerが必要readを持てるか
- Data API exposure setting/behavior
- pending/open PR or main migration collision

PII/secret/token/raw user id/email/X handleをReportへ出さない。

安全なproduction read経路が自動拒否される場合は回避しない。
その場合は、ユーザー実行用の**read-only aggregate/preflight SQL**を作り、STOPして結果待ちにしてよい。

## Gate D — backfill dry-run / parity

production write禁止。

read-only/dry-runで：
- common_accounts candidate
- kabumori entitlement candidate
- x_autopost entitlement candidate
- Auth-only
- admin exclusion
- ambiguous/manual-review
- duplicate/unknown footprint
- would-create counts

Phase 0との差異を説明。
email-based mergeはしない。

## Gate E — rollout / rollback sequencing

production適用をまだしない前提で、最終runbookを検証：

1. exact preflight
2. single migration apply（`db push`不可）
3. read-back
4. backfill dry-run
5. explicit backfill approval
6. backfill apply
7. parity read-back
8. Phase 2 integration
9. Phase 3 deletion/orchestrator
10. only later any enforcing boundary

rollback:
- integration開始前のみ
- exact shadow state
- no operation/use/dependency
- built-in contract intact
- one transaction / no partial teardown

## Gate F — production safety disposition

Reportは必ず3つを分離：

1. **source merge status**
2. **migration apply readiness**
3. **backfill readiness**

PASS source ≠ apply PASS ≠ backfill PASS。

もしactual disposable Supabase proofまたはproduction read-only preflightが欠ける場合：
- source can remain merged
- production apply = HOLD
- backfill = HOLD

## Forbidden

- production INSERT/UPDATE/DELETE
- migration apply
- backfill apply
- Auth create/update/delete
- Storage mutation
- provider/OAuth revoke
- Vault mutation/read secret
- identity link/unlink
- deploy
- flag/Cron/provider settings
- real X operation
- enforcement enablement
- destructive test on production

## Required independent verification

- rerun merged local lifecycle suite
- mutation suite
- social deletion regression
- migration invariants
- diff/static checks
- actual disposable Supabase proof if authorized/safe
- production read-only preflight if authorized/safe

## Completion / C2

Append `.agent/CODEX_REPORT_2.md`.

Report:
- PASS / PARTIAL / BLOCKED / FAIL
- exact reviewed main
- source integrity verdict
- disposable Supabase proof verdict
- production preflight verdict
- backfill dry-run verdict
- migration apply readiness
- backfill readiness
- unresolved prerequisites
- production mutation = 0
- exact next operator action
- recommendation

At completion:
- status -> review_required
- next_owner -> chatgpt
- STOP for C2

No production apply is authorized by this TASK itself.

## H2 completion — 2026-10-02 JST

- result: **PARTIAL / Gate B BLOCKED（operator prerequisite）**。
- source merge: PASS。accepted `aa4d2d425d1d7c432d43c9ecfb8e978a40b80a65` の8ファイルはfresh mainでも変更なし。target merge `44121914b035e22380a4ca1bd8252a42713a2bbf` 包含。
- independent local tests: lifecycle20 PASS / mutation46 of46 DETECTED / social deletion8 PASS / migration invariants10 of10 PASS / shell-lint-diff PASS。
- production read-only: 17 tables / 26 columns / 14 FKs / 2 helper契約整合、target migration未適用・新object collisionなし。PostgREST exposure setting/APIとactual managed Auth/Storageは未証明。
- backfill readonly snapshot: accounts5 / Kabumori2 / X1 / Auth-only2 / manual-review3。Phase 0からAuth-only1件増。actual backfill0。
- actual disposable Supabase: NOT RUN。指定・承認済みsandboxがないため既存project流用/新課金resource作成はしていない。
- **migration apply HOLD / backfill HOLD**。source PASSをproduction適用許可に読み替えない。
- next prerequisite: operatorがdisposable非production Supabase環境を指定・明示承認し、managed boundary proofを行う。C2再判断後にmigration applyとbackfill applyを別々に承認。
- Report publication commit: `e27c63e0905131ac981380714a7e96738bce293f`。GitHub exact content / current task_id / old report history preservationをread-back確認。
- final freshness/source check: `f8d0ab0ca1a30a6ff8c1fdf6ba4c471c5e3bea5a`（同期前に他slotの.agent変更のみ、対象8ソース差分0）。
- code/deploy/production write/Auth/Storage/OAuth/Vault/X/OpenAI/Push変更: 0。正式repoの既存変更への操作0。他slot制御ファイル更新0。
- status: review_required / next_owner: chatgpt。**STOP for C2**（推薦モデル：Sol（極高））。



## Final C2 — Common account pre-production gate

- verdict: **PARTIAL / operator prerequisite accepted**.
- source_merge_status: **PASS / remains merged**.
- migration_apply_readiness: **HOLD**.
- backfill_readiness: **HOLD**.
- accepted evidence:
  - merged source integrity PASS
  - local lifecycle 20 PASS
  - mutation 46/46 DETECTED
  - social deletion 8 PASS
  - migration invariants 10/10 PASS
  - production read-only catalog preflight substantially PASS for required schema/FK/helper/history conditions
  - target migration not yet applied; no target object collision
  - backfill dry-run snapshot: 5 Auth/common candidates, Kabumori 2, X 1, Auth-only 2, manual-review 3
- mandatory blocker:
  - no approved disposable nonproduction Supabase environment was available, so actual GoTrue/PostgREST/Storage/managed-role proof was not run.
  - production Data API exposure/actual API behavior remains unproven.
- production mutation: **0**.
- no migration/backfill/deploy/Auth/Storage/OAuth/Vault/identity/Cron/flag operation was performed.
- exact next operator action: designate an approved disposable nonproduction Supabase project/sandbox, or separately authorize creation of one, then rerun Gate B before any production apply decision.
- existing production or unrelated Supabase projects must not be repurposed by assumption.
- H2 is closed pending operator environment decision; no automatic production action or new task is authorized.
- recommended model for resumed Gate B / final apply decision: **Sol（極高）**.

---

## Previous completed H2 task history — preserved below

# Codex Task 2

- task_id: x-ai-lab-pr66-topic-dedup-review-20261001
- owner: codex
- slot: codex-2
- status: done
- next_owner: none
- priority: high
- recommended_model: Luna（高）
- target: PR #66 exact head `4f692e4d805ccd3ee628058bb20ee6c1f62cdd6d`
- type: review / regression verification

## Purpose

Focused pre-merge review of the emergency Company AI Lab topic-deduplication fix. Verify that it actually prevents the observed same-theme repetition without introducing cross-brand behavior changes, unnecessary posting failures, or incorrect topic rotation.

This is not an Auth/security/DB migration task. Do not broaden scope.

## Review scope

Changed source paths:
- `supabase/functions/_shared/brand/ai_lab_brand_post_store.ts`
- `supabase/functions/_shared/brand/ai_lab_dev_diary_context.ts`
- `supabase/functions/_shared/brand/ai_lab_scheduled_brand_post.ts`
- `supabase/functions/_shared/brand/ai_lab_theme_guard.ts`
- `supabase/functions/_shared/brand/ai_lab_topic_dedup_test.ts`
- `supabase/functions/_shared/brand/brand_post_generator.ts`
- `supabase/functions/x-test-post/index.ts`

## Verify

1. Root-cause fix
- fresh diary is selected ahead of evergreen while actually fresh
- generic diary angles such as "調査だけの日 / コードを書かない日 / 手戻りを減らす" cannot immediately reappear through another wording
- rotation does not accidentally repeat the same unit on adjacent scheduled posts when multiple safe units exist
- one-entry diary behavior is truthful: different cuts may be reused but no fabricated "today" detail is introduced

2. Rotation counter correctness
- `countAiLabBrandPostsBefore` is read-only and correctly scoped to AI Lab + brand_post + scheduled time
- PostgREST exact-count parsing is correct for the actual request shape
- failure fallback is deterministic enough and cannot block the post
- no unrelated scheduled rows can perturb the AI Lab counter

3. Content guard / retry semantics
- maximum generation attempts are exactly bounded
- rejected drafts cannot be published or marked complete
- final failure state is truthful and does not accidentally retry transport/publish
- retry instructions do not leak rejected text or internal data
- guard does not reject legitimate concrete diary posts merely because the factual seed itself contains a generic phrase
- opening-pattern detection does not create excessive false positives

4. Cross-brand isolation
- `extraInstructions` omitted/empty leaves non-AI-Lab generator behavior unchanged
- new guard is only imported/used from AI Lab paths
- no Kabumori/Mio/neutral social-mobile hashtag/voice/generation behavior changes
- no scheduler count, post frequency, Cron, X API, OAuth, Auth, Vault, DB schema/RPC/migration changes

5. Tests
- inspect the new 24 tests for behavior-level assertions, not only source-string checks
- rerun focused new test file
- rerun relevant AI Lab diary/snapshot/sanitizer/voice/generator/scheduled dispatch tests
- run `deno check` on changed runtime modules
- full function suite may be relied on if practical; distinguish baseline environment-only failures from candidate failures
- `git diff --check`

6. Known limitation
- recent post body is not persisted, so true semantic comparison is not implemented. Confirm the PR does not claim otherwise and that the stopgap rotation/cooldown is internally consistent.

## Safety

- Source review only.
- No merge.
- No deploy.
- No real X post.
- No DB write or production mutation.
- Do not change schema/RPC/Cron/OAuth/Auth/Vault.
- If a source defect is small and unquestionably within PR scope, you may fix it on the PR branch and report exact delta; otherwise report finding and STOP.
- Use an independent H2 worktree/checkout. Do not share G3/G4/H1 working directories.

## Completion / C2

Report:
- PASS / PASS-WITH-FIX / FAIL
- exact reviewed head and final head if changed
- findings by severity
- test evidence
- cross-brand regression result
- whether PR #66 is safe to merge
- whether only `x-test-post` needs controlled production redeploy
- production mutation = 0
- real X posts = 0
- remaining limitations

Then status -> review_required, next_owner -> chatgpt and STOP.

---

## Previous completed H2 task preserved

# Codex Task 2

- task_id: x-ai-salaryman-dev-diary-pr61-final-acceptance-20260930
- owner: codex
- slot: codex-2
- status: done
- next_owner: none
- priority: high
- recommended_model: Luna（中）
- target: PR #61 head `67ee04b41e37553885d43f4630628d135061cbf8`

## Purpose

Final acceptance review of PR #61 after all previously identified blockers were corrected.

## Verify

1. Strict calendar-date validation
- impossible dates are rejected
- valid leap-day and month-end dates are accepted
- impossible dates cannot pass freshness or current-progress selection
- invalid dates fall back to evergreen

2. Previously accepted fixes remain intact
- runtime diary uses imported generated snapshot through module graph
- Markdown/snapshot parity guard remains
- AI Lab-only hashtag voice control remains scoped
- neutral social-mobile no-hashtag behavior unchanged
- fixed-hashtag brands unchanged

3. Regression / safety
- AI Lab topicSeed wiring remains correct
- no fabricated "today" activity without fresh trusted diary context
- sanitizer/public-safe curation rules remain
- no G3/Auth/account-deletion or DB/RLS/RPC changes
- no secret leakage
- current-head relevant tests are coherent with reported counts

## Production

No deploy and no real X post.
production_mutation=0.

## Completion / C2

Report PASS/FAIL, exact reviewed head, disposition of all prior blockers, test evidence, cross-brand safety, and whether PR #61 is safe to merge and deploy.



## Final C2 — PR #66 AI Lab topic dedup

- verdict: **PASS**
- accepted reviewed head: `4f692e4d805ccd3ee628058bb20ee6c1f62cdd6d`
- PR #66 remains open and mergeable; H2 made no source changes.
- review findings: no blocking issue in topic rotation/cooldown, bounded regeneration, PostgREST count fallback, or cross-brand isolation.
- tests accepted: focused 24/24, related 55/55, full functions 2337/2337; changed shared runtime deno check PASS; x-test-post check has the same six pre-existing diagnostics as PR base and no new AI Lab diagnostic; diff check PASS.
- known limitation accepted for this emergency fix: actual recent post bodies are not persisted, so this is rotation + bounded theme/opener guard rather than true semantic-history comparison.
- merge disposition: **safe to merge** at the exact reviewed head after a fresh no-race check.
- production disposition: merge does not itself activate the fix in production; only `x-test-post` needs a separately controlled redeploy and post-deploy source/read-back verification. No DB/RPC/migration/Cron/OAuth/Vault changes are required.
- production mutation during review: 0. Real X posts/API calls: 0.
- H2 closed; reuse only after fresh allocation.
