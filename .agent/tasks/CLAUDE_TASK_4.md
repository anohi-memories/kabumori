# Claude Task 4

- task_id: x-social-mobile-home-posting-settings-ux-phase1-20260928
- owner: claude
- slot: claude-4
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（高）
- purpose: `apps/social-mobile` のHome・投稿設定・投稿UXを棚卸しし、一般ユーザーが「何がいつ投稿されるか」「自動投稿がONか」「投稿内容をどう調整するか」を理解・操作できる実用画面へ近づける。

## Product direction

基盤ではなくユーザー価値を優先する。

このTASKの最重要ゴール:
- Home / schedule / settings / posts / history の現状を分類
- 既存backend契約を再利用
- 投稿予定・自動投稿状態・最近の投稿結果・主要設定がユーザーに見える
- 投稿内容や頻度の調整入口を整える

## Mandatory startup

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - relevant social-mobile Home/schedule/settings/posts/history files
2. Use independent G4 worktree/checkout.
3. Fresh fetch `origin/main`.
4. If any Supabase data contract is touched, read current Supabase skill first.
5. Inspect existing screen/data contracts before editing.
6. Do not touch G3-owned auth/X-connect/onboarding files unless unavoidable; stop on overlap.

## Scope

### Stage A — inventory

Classify:
- Home
- next scheduled post
- auto-post ON/OFF visibility
- connected X account summary
- recent post success/failure
- post history
- schedule controls
- content settings
- tone/style
- posting frequency
- posting time windows
- NG words
- manual approval vs auto-post
- post preview/edit/regenerate if present
- empty/loading/error states

For each:
- usable
- partial
- UI only
- missing
- blocked by backend/config

### Stage B — minimum Home contract

Home should make these clear without opening multiple screens:
- connected X account
- auto-post enabled/disabled
- next planned/scheduled post time if available
- latest post result
- one clear CTA to adjust posting settings
- one clear CTA to review posting/history area

Do not fake data. If backend field does not exist, show truthful unavailable/empty state.

### Stage C — posting settings UX

Use existing settings/data model where possible.

Prioritize:
- auto-post preference
- posting frequency/cadence
- permitted time windows
- tone/style
- NG words / prohibited terms
- content themes/categories if already supported
- manual review vs automatic posting if contract exists

Do NOT invent unsupported settings solely for UI completeness.

### Stage D — posting UX

Where already supported, improve:
- current draft/post preview
- regenerate
- edit
- approve/post
- failure reason
- retry/reconnect CTA

If these actions are not backed yet, provide navigation/disabled-state contracts rather than fake functionality.

## Visual/UX constraints

- mobile-first
- concise Japanese UI
- obvious status hierarchy
- no admin-only terminology
- no developer/debug jargon
- loading/error/empty states must be explicit
- avoid giant dashboard density
- preserve existing brand/design system unless clearly broken

## Safety / data constraints

- no real production X post
- no hidden auto-enable
- no account/brand fallback
- user must clearly see auto-post state before it can be changed
- do not expose tokens/secrets/internal IDs
- do not touch Admin invite/recovery work
- do not activate Stage 3B pilot

## Tests

At minimum:
- Home state rendering
- auto-post enabled/disabled
- no schedule/empty schedule
- recent success/failure states
- settings persistence contract mocks
- unavailable backend field behavior
- `npm run typecheck`
- `npm run lint`
- Expo export/build smoke if practical
- `git diff --check`

## Deliverable

Report:
- inventory table/summary
- implemented Home contract
- implemented posting settings UX
- posting UX changes
- changed_files
- tests
- screenshots/preview notes if available
- backend blockers
- G3 overlap check
- recommended next G4 step

## Production constraints

- no production post
- no production rollout activation
- no production DB migration
- no unrelated PR merge
- no Admin Auth changes

## Completion / K4

Set:
- status -> review_required
- next_owner -> chatgpt

STOP for K4.

## Report

- pending
