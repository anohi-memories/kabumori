# Claude Task 4

- task_id: x-ai-salaryman-dev-diary-pr61-runtime-fix-20260930
- owner: claude
- slot: claude-4
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（高）
- target: PR #61
- purpose: H2で見つかった2点だけを修正し、会社員AIラボの開発日記生成をproduction-readyなsource状態にする。

## Mandatory startup

1. Read ORCHESTRATION / CURRENT_STATE / this TASK / latest H2 report.
2. Independent G4 worktree; fresh origin/main.
3. Update/rebase the PR branch safely because PR #61 is behind main.
4. Read the current Supabase skill/changelog/docs before changing Edge Function packaging.
5. Do not touch G3/Auth/account-deletion work.

## Fix 1 — runtime diary asset

Current blocker:
- the implementation reads adjacent Markdown at runtime
- current deploy packaging does not prove that the Markdown is included
- read failure silently falls back to evergreen

Required:
- keep the human/ChatGPT-readable Markdown as the canonical diary source
- make the production Edge runtime consume a representation that is guaranteed to be bundled by the actual deploy path
- prefer the smallest reliable approach
- a generated/importable TypeScript snapshot derived from the canonical Markdown is acceptable and preferred if it avoids unsupported static-asset packaging
- if a Supabase static_files solution is used instead, prove it is supported by this repository's real deployment path and current official docs
- add a sync/parity check so canonical Markdown and bundled runtime representation cannot silently diverge
- do not silently treat a missing/unreadable required runtime asset as fresh diary context
- verify the actual Edge-runtime-compatible loader path, not only a local checkout file read

Current known limitation remains acceptable:
- changing diary content may still require commit + x-test-post redeploy
- periodic automatic progress aggregation is NOT part of this task

## Fix 2 — cross-brand hashtag scope

H2 found the shared no-fixed-hashtag prompt change also affects neutral profiles such as social_mobile_user_v1.

Required:
- preserve the prior no-hashtag behavior for other no-fixed-hashtag profiles
- allow the AI Lab-specific voice policy to control its own optional #個人開発 usage
- scope the exception explicitly to AI Lab or otherwise prove exact behavioral equivalence for every other profile
- add a regression test for the neutral social-mobile profile and fixed-hashtag brands

## Preserve

- AI Lab development-diary identity and 70/30 direction
- no-fabrication rule for fresh vs evergreen content
- sanitizer and public-safe diary curation model
- other brands' behavior
- existing scheduler/posting safety
- no DB/RLS/RPC/Auth changes

## Tests / evidence

Must include:
- canonical Markdown <-> runtime bundled representation parity
- fresh diary selection in Edge-compatible runtime path
- missing/stale/unsafe context fallback behavior
- AI Lab optional hashtag behavior
- neutral social-mobile no-hashtag behavior unchanged
- fixed-hashtag brand behavior unchanged
- existing AI Lab/scheduled generator suites
- full relevant shared-brand suite
- deno check for changed files
- git diff --check
- secret scan

No production deploy and no real X post.

## Completion / K4

Report:
- exact runtime packaging approach
- why it is valid for the actual Supabase deploy path
- changed_files
- hashtag scoping behavior
- tests
- PR/head
- production_mutation=0
- whether PR #61 is ready for focused H2 re-review

Then status -> review_required, next_owner -> chatgpt, STOP for K4.
