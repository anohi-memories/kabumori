# Claude Task 4

- task_id: x-social-mobile-posting-backend-foundation-phase3-20260928
- owner: claude
- slot: claude-4
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Opus5.5（高）
- purpose: Phase 2で確認した投稿操作backendの欠落を、最小かつ安全な順序で解消する。まず「投稿本文の正本」「投稿詳細の安全な読み取り」「draft本文の編集保存」「失敗理由の安全な読み取り」をsource-onlyで実装し、再生成/承認/再試行は次段へ分離する。

## Accepted source

- PR #49 merged to main as `9eef82bf0729c25bf6aaf15951c138704b5b67b7`
- Phase 2 verdict: PASS
- no Codex review required for Phase 2
- Phase 2 UI truthfully disables edit/regenerate/approve/retry because no client-callable backend existed

## Mandatory startup

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - latest G4 Phase 2 report
2. Independent G4 worktree/checkout.
3. Fresh fetch `origin/main`; branch from latest main including PR #49 merge.
4. Read current Supabase skill/docs before DB/RLS/RPC/Edge changes.
5. Read-only inspect current production schema for:
   - `scheduled_posts`
   - `post_execution_logs`
   - relevant brand/workspace membership tables
   - existing posting/dispatcher RPCs
6. Confirm G3 file separation. G3 owns Auth/account/provider-readiness files.
7. If existing production schema differs materially from migration history, STOP before source changes and report the discrepancy.

## Goal

Unlock the first real posting interaction safely:

`post detail -> authoritative body -> edit draft -> persisted reload`

and expose a sanitized failure reason for failed posts where the user is authorized.

Do not implement AI regenerate, approval, schedule/post-now, or retry in this TASK.

## Security principle

Do NOT weaken existing dispatcher/service-role RPC grants merely to make the mobile app work.

Prefer a narrow authenticated command/read boundary that:
- derives the user from JWT/session
- checks exact workspace/brand membership server-side
- checks exact post ownership/scope
- constrains mutable statuses
- never accepts arbitrary brand authorization from client input
- does not expose service_role to the client
- does not expose raw provider/X tokens or internal stack traces

If an Edge Function is the safer boundary than direct authenticated RPC/DML, use it.

## Stage A — production schema read-only verification

Before implementation, confirm read-only:
- exact columns/types/constraints on `scheduled_posts`
- whether `post_execution_logs.brand_id` exists
- exact relationship between log rows and scheduled posts
- current RLS/grants for authenticated/service_role
- exact membership/brand authority source
- whether an existing body/content table already exists
- whether any existing safe user-facing API already covers this

Record exact findings in Report.

No production mutation.

## Stage B — authoritative post body model

If no existing authoritative body field/table exists, design the narrowest candidate schema.

Requirements:
- one authoritative user-visible body per scheduled/draft post
- clear nullable/backfill behavior for historical rows
- no fake body inferred from mock data
- do not overwrite published historical content unexpectedly
- define max length / validation consistent with posting contract
- preserve existing dispatcher behavior unless intentionally adapted in source candidate

Migration is candidate/source-only. Do not apply.

## Stage C — safe post-detail read contract

Implement source-only contract for an authenticated user to read only posts they are authorized to see.

Return only fields needed by the app:
- post id
- safe status
- authoritative body
- scheduled time
- approval/posting state if already authoritative
- sanitized failure summary if available
- reconnect-needed should continue to come from existing account state, not duplicated here

Do not expose:
- provider tokens
- service role data
- raw exception traces
- unrestricted execution log rows
- another brand/account's posts

## Stage D — draft edit contract

Implement edit only for states where mutation is safe.

At minimum:
- allow only authenticated authorized user
- exact post/brand scope check
- only mutable pre-publish states
- reject publishing/published
- reject stale/invalid post
- validate body length/content
- prevent cross-brand ID guessing
- return persisted canonical row/result
- safe idempotency/concurrency behavior where practical

No direct client access to dispatcher RPCs.

## Stage E — failure reason read

If `post_execution_logs` can safely support this:
- expose only a sanitized user-facing failure classification/message
- latest relevant attempt only or another explicitly defined rule
- never expose raw stack, request/response secrets, tokens, headers, provider payloads
- exact post/brand authorization

If schema cannot support this safely without larger redesign, leave it disabled and report why.

## Stage F — mobile integration

Update the Phase 2 post detail UI only after the backend/source contract exists.

Expected:
- real body shown from authoritative source
- edit action enabled only when contract says editable
- save waits for confirmed backend result
- reload reflects persisted value
- failure reason shown only from sanitized real contract
- regenerate/approve/retry remain disabled in this phase

No fake success.

## G3 separation

Do not modify:
- auth callback
- provider linking
- PKCE/recovery/session storage
- login methods
- provider readiness/config validation

If overlap is unavoidable, STOP and report exact file/reason.

## Tests

Add focused tests for:
- authenticated own-brand read
- cross-brand denial
- unauthenticated denial
- editable status allowlist
- publishing/published mutation denial
- invalid/too-long body
- concurrency/stale update behavior where applicable
- sanitized failure reason
- no raw secret/token/log leakage
- mobile truthfulness
- reload after save

Run:
- relevant disposable DB/migration tests
- Edge/RPC tests
- full social-mobile tests
- data-view tests
- typecheck
- lint
- Expo web + iOS export
- git diff --check
- secret scan

## Production constraints

Do NOT:
- apply migration
- deploy Edge Function
- change RLS/grants in production
- change dispatcher production behavior
- make real X post
- activate publish authority
- modify Auth provider/config/secrets

production_mutation=0.

## Review policy

This Phase 3 introduces a new DB/API authorization boundary, so independent review IS required before merge/apply.

Because Codex capacity is currently constrained:
- do not assign H1/H2 automatically
- at K4, recommend a separate-room Claude independent review
- recommended independent reviewer: **Opus5.5（高）**
- reviewer must use a separate worktree/read-only checkout from implementer

## Completion / K4

Report:
- production schema read-only findings
- chosen API/security boundary
- body storage design
- edit authorization/status rules
- failure reason sanitization
- changed_files
- migration/RPC/Edge changes
- tests
- production_mutation=0
- G3 overlap
- remaining disabled actions
- exact independent review scope
- recommended next step

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K4.
