# Codex Task 2 — CURRENT TASK

- task_id: common-account-pr70-preproduction-gate-20261002
- owner: codex
- slot: codex-2
- status: ready
- next_owner: codex
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
