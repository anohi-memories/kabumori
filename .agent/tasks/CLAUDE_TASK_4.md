# Claude Task 4

- task_id: x-social-mobile-posting-interaction-phase2-20260928
- owner: claude
- slot: claude-4
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（高）
- purpose: accepted Phase 1 Home/posting/history基盤の次として、一般ユーザーが投稿内容を確認・編集・再生成・承認し、失敗時に理由と次の行動を理解できる投稿操作UXを実装する。既存backend契約を再利用し、存在しないbackend機能をfakeしない。

## Source / accepted state

- Phase 1 PR #44 accepted/fixed and integrated before current main
- G3 Auth Phase 2 accepted and merged to main as `fbddef2535b82bf4775c2e4fddb93eeefb8c638a`
- G4 queued Phase 2 scope from `.agent/CURRENT_STATE.md`:
  - draft/post preview
  - manual edit
  - AI regenerate
  - approve
  - schedule/post action only where backend exists
  - failure reason
  - retry
  - reconnect-to-X CTA
  - schedule/history -> detail -> edit/approve
  - manual approval vs auto-post distinction

## Mandatory startup

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - current social-mobile Home/schedule/history/post-detail/settings code
2. Use an independent G4 worktree/checkout.
3. Fresh fetch `origin/main`; branch from accepted current main.
4. Inventory backend/data contracts before adding UI actions.
5. G3 owns Auth/account/login-method/config-readiness files. Stop on overlap.
6. Do not invent a successful backend action where no contract exists.

## Product goal

A user should be able to move through a truthful posting flow:

`予定/下書き -> 内容確認 -> 必要なら編集/再生成 -> 承認 -> 予約/投稿状態確認 -> 失敗時は理由と次の行動`

while always understanding whether:
- this post requires manual approval
- auto-post is enabled
- the post is only a preview/draft
- the post is scheduled
- the X connection needs reconnect
- a backend action is unavailable

## Stage A — inventory / contract map

Classify current capabilities:
- real and writable
- real but read-only
- source-only/not production-applied
- unavailable
- mock-only

Cover:
- draft/body source
- edit persistence
- regenerate endpoint/action
- approval state
- schedule action
- post-now action
- retry action
- failure reason
- reconnect-required state
- history/detail data

Document blockers instead of faking them.

## Stage B — post preview/detail UX

Implement or improve a truthful post preview/detail surface.

Show where available:
- post body
- account
- scheduled time
- state/status
- manual approval / auto-post mode
- latest failure reason
- retryability
- X reconnect requirement

If the authoritative body is unavailable in real data, do not silently display mock text.

## Stage C — manual edit

If an existing safe persistence contract exists:
- allow editing draft text
- validate length/basic input
- save using existing backend/repository path
- reload and show persisted truth

If no real persistence contract exists:
- implement UI boundary/interface only if useful
- disable action truthfully
- report exact backend gap

Do not add a new production DB schema in this task unless explicitly required and authorized; STOP if that becomes necessary.

## Stage D — AI regenerate

Use an existing regenerate/generation action only if it already exists and has a safe contract.

Requirements:
- clear loading/error state
- no duplicate request on repeated tap
- regenerated content must remain pending approval if manual approval mode applies
- never auto-post merely because regeneration succeeded

If backend regenerate does not exist, do not mock success. Provide a disabled/coming-later state and report.

## Stage E — approve / schedule / post action

Wire only actions backed by existing contracts.

Preserve:
- manual approval != auto-post
- approval does not imply immediate X post unless contract explicitly says so
- auto-post state is shown clearly
- no production posting from tests/task execution

Prevent accidental double-submit.

## Stage F — failure / retry / reconnect

For failed items:
- expose human-readable failure reason where safely available
- distinguish retryable vs non-retryable if backend supports it
- show reconnect-to-X CTA when auth state indicates reconnect is required
- CTA may navigate to the existing X connection flow, but G4 must not modify G3 Auth implementation

Never expose raw secrets/provider tokens/server stack traces.

## Stage G — navigation flow

Make these paths coherent where supported:
- Home -> next post -> detail
- Schedule -> post detail
- History -> failed/sent post detail
- Detail -> edit/regenerate/approve/retry
- Detail -> reconnect to X when required

Back navigation must not lose persisted state or fabricate success.

## Truthfulness rules

Never:
- fall back from unavailable real data to mock data without an explicit dev/mock mode
- show “投稿済み” if only locally changed
- show “予約済み” before backend confirmation
- show “再生成完了” before real response
- show retry success before backend confirmation
- imply real posting in task tests

## G3 separation

Do not modify:
- Auth callback parsing
- provider linking
- PKCE/recovery/session storage
- login methods
- provider readiness/config validation

You may consume existing Auth/X reconnect status and navigate to an existing route.

If a G3 file must change, STOP and report.

## Tests

Add focused tests for:
- real vs mock truthfulness
- edit persistence or disabled state
- regenerate double-submit prevention
- approval/manual-auto distinction
- schedule/post confirmation truthfulness
- failed-post reason mapping
- reconnect CTA condition
- retry state
- navigation from schedule/history/detail

Run:
- full social-mobile tests
- data-view tests
- typecheck
- lint
- Expo web export
- Expo iOS export where current project supports it
- git diff --check
- secret scan

## Production constraints

Do NOT:
- make a real X post
- enable publish authority
- change Stage 3B rollout
- mutate production DB/schema/RLS/RPC
- deploy production backend
- alter Auth provider consoles/secrets

production_mutation=0.

## Review policy

Do not request Codex review automatically.
This is primarily user-facing app UX on existing contracts.

At K4, report any newly introduced DB/API/auth/publish boundary.
If none, normal ChatGPT completion review is enough.

## Completion / K4

Report:
- architecture/flow implemented
- real backend capabilities found
- disabled/unavailable capabilities
- changed_files
- tests
- screenshots/preview notes if practical
- backend blockers
- production_mutation=0
- G3 overlap=0 or exact overlap reason
- whether review is actually needed
- recommended next G4 step

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K4.
