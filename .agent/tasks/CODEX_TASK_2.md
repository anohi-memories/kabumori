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
