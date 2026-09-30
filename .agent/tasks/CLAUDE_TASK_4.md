# Claude Task 4

- task_id: x-ai-salaryman-dev-diary-pr61-merge-prod-rollout-20260930
- owner: claude
- slot: claude-4
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Opus5.5（高）
- accepted_pr: PR #61
- accepted_head: 67ee04b41e37553885d43f4630628d135061cbf8
- purpose: H2 final acceptance PASSを受け、PR #61を安全にmergeし、会社員AIラボの開発日記生成変更をx-test-post単一Functionへ本番反映する。

## Mandatory startup

1. Read ORCHESTRATION / CURRENT_STATE / this TASK / latest H2 final acceptance report.
2. Independent G4 worktree/checkout.
3. Fresh fetch origin/main and PR #61.
4. Confirm PR #61 exact head remains `67ee04b41e37553885d43f4630628d135061cbf8`, mergeable, and no newer unreviewed source commit exists.
5. Read current Supabase skill/changelog/docs before any deploy.
6. Confirm H1/G3 PR #63 work does not overlap the PR #61 source paths or x-test-post deploy ownership.
7. If exact head or source scope changed, STOP before merge/deploy.

## Phase A — final source preflight

Re-run from exact accepted head/current merged candidate:
- AI Lab diary context tests
- profile/generator/scheduled AI Lab tests
- full relevant shared-brand suite
- deno check for changed runtime files
- git diff/check
- secret scan
- Markdown/snapshot parity

Confirm:
- impossible calendar dates rejected
- snapshot import/module-graph path intact
- neutral social-mobile no-hashtag behavior unchanged
- fixed-hashtag behavior unchanged
- no raw .agent/private/security context enters the runtime diary

## Phase B — merge PR #61

If Phase A passes and PR head remains exact:
- merge PR #61 into main using repository's normal accepted merge method
- record merge SHA
- fresh-read main and confirm accepted source is present
- do not merge unrelated PRs

## Phase C — controlled production deploy

Deploy exactly:
- Supabase Edge Function `x-test-post`

Rules:
- explicit project ref
- preserve current verify_jwt setting
- no broad function deploy
- no DB push / migration / RPC / RLS / Auth / Vault / Cron mutation
- no secret changes
- no manual real X post
- no manual scheduled-post execution
- do not alter other brands/configuration
- capture pre-deploy function metadata/source identity sufficient for rollback/read-back

## Phase D — post-deploy verification

Immediately verify:
- x-test-post new version/updated_at and verify_jwt
- deployed source contains the accepted AI Lab diary generator changes
- accepted snapshot/import/date-validation/hashtag-scope source matches merged main
- no other Edge Function changed by this task
- no DB/Auth/Vault/Cron/settings changes
- no X post was manually triggered
- production scheduler remains in its existing state

Do not force an immediate real post. Let normal scheduling exercise the new content path.

## Completion / K4

Report:
- PASS/FAIL/STOP
- exact preflight head
- merge SHA
- production x-test-post before/after version
- verify_jwt before/after
- source read-back identity
- tests
- other-function metadata check
- production mutations
- manual X posts = 0
- remaining issue: automatic periodic progress aggregation is still not implemented; diary updates currently require Markdown + snapshot regeneration + commit + redeploy
- next recommendation

Then status -> review_required, next_owner -> chatgpt, STOP for K4.


## Operator authorization after merge guard stop

- ChatGPT independently verified on GitHub that PR #61 is **merged**.
- merged_at: 2026-09-30T10:12:45Z
- merge_commit: `f0ea0a964797524022f0b8aa51a670a78806dd26`
- reviewed/accepted PR head remains `67ee04b41e37553885d43f4630628d135061cbf8`.
- The prior merge command does not need to be retried.

### Explicit permission to continue

You are explicitly authorized to continue this existing G4 TASK from the post-merge point and perform the previously approved **single-function production deploy of `x-test-post` only**, followed by the exact read-back/verification already defined in Phase D.

This authorization covers:
- confirm fresh `origin/main` contains merge commit `f0ea0a964797524022f0b8aa51a670a78806dd26`
- deploy exactly `x-test-post` to the existing production Supabase project
- preserve current `verify_jwt=false`
- perform read-only post-deploy source/version/metadata verification
- write the G4 Report

This authorization does NOT cover:
- any other Edge Function
- DB/RLS/RPC/migration changes
- Auth/Vault/Cron/settings/secret changes
- manual scheduled-post execution
- manual/forced X post
- unrelated PR merge/deploy
- broader rollback or architecture changes

If the deploy safety tool still refuses despite this explicit authorization, STOP and report the exact blocker without attempting broader workarounds.


## Manual production deploy completed by user

- User manually executed the approved isolated deploy procedure from merge commit `f0ea0a964797524022f0b8aa51a670a78806dd26`.
- Terminal log shows `x-test-post` deployment completed successfully twice using the same isolated source and the same `--no-verify-jwt` option.
- Read-only Supabase metadata check after the manual operation shows:
  - `x-test-post` status: ACTIVE
  - version: 129
  - verify_jwt: false
- The duplicate deploy means the function version incremented twice from the prior v127 baseline; do NOT deploy again.
- Continue from Phase D only: read-only verification and final Report.
- Required remaining checks:
  1. compare deployed source against merge commit `f0ea0a964797524022f0b8aa51a670a78806dd26`
  2. confirm expected AI Lab snapshot/import/date-validation/hashtag-scope files are exact
  3. compare against the pre-deploy all-function metadata snapshot and verify no other Edge Function changed during this operation
  4. confirm no manual X post/manual scheduled invocation
  5. write final Report
- No further production mutation is authorized.
