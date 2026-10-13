# Codex Task

- task_id: kabumori-important-news-monitor-caller-auth-remediation-candidate-20260923
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: GPT-6 Sol Medium
- purpose: release-readiness auditで見つかった `important-news-monitor` のcaller-auth境界を、既存Cronを壊さずfail-closedにするsource-only remediation candidateを作る。production設定/Function deploy/auto_publish変更は禁止。

## C1 decision

Previous task `kabumori-release-readiness-audit-and-roadmap-20260923` is **PASS for audit content, merge held**.

Verified:
- PR #10 is open and mergeable.
- Audit document covers the requested release-readiness scope and gives a shortest-path roadmap.
- Production mutation = 0.
- PR #10 required Vercel check is currently **failure** due to the daily deployment/build-rate limit; do not bypass branch protection and do not merge until the required check succeeds.
- The audit's urgent finding is credible from source review:
  - production `important-news-monitor` has `verify_jwt=false`
  - the Deno.serve entry path checks POST, loads service-role credentials, parses caller-controlled JSON, then dispatches modes
  - no inbound Authorization/JWT or dedicated cron-secret validation appears before dispatch
  - `publish_ready` can reach auto-publish/X side effects when enabled
- Endpoint exploitability was not tested; no invocation is authorized by this task.

## Mandatory startup

1. Read `PROJECT_RULES.md`
2. Read `.agent/ORCHESTRATION.md`
3. Read `.agent/CURRENT_STATE.md`
4. Read this TASK
5. Read PR #10 audit document
6. Fresh fetch `origin/main`
7. Inspect all production callers of `important-news-monitor` (Cron/scheduler/manual/admin if any)
8. Confirm no H2/G1/G2 overlap with this Function or its caller-auth configuration

## Scope

Design and implement a **source-only** caller-auth remediation candidate for:
- `supabase/functions/important-news-monitor`

Requirements:
- preserve legitimate scheduled execution
- reject unauthenticated/untrusted external invocation before mode dispatch
- do not expose service-role or cron secrets in responses/logs
- fail closed on missing/malformed credentials
- keep dry-run/admin/manual paths protected as well
- preserve existing mode behavior after successful authentication
- do not change publish selection, GPT routing, source selection, Cron cadence, X OAuth, Push logic, or auto-publish business rules
- prefer one explicit, reviewable auth contract over mode-specific ad hoc checks

Evaluate the safest compatible option based on actual callers, for example:
- gateway JWT verification if all callers can present a valid JWT, or
- a dedicated shared secret/header validated before dispatch if Cron requires `verify_jwt=false`

Do not guess. Inspect existing caller construction first.

## Verification

Add targeted tests proving at minimum:
- missing auth rejected
- malformed/wrong auth rejected
- valid scheduled caller auth accepted
- privileged modes cannot execute before auth
- auth check occurs before any DB/OpenAI/X side-effect path
- response/logs do not reveal secret material
- existing mode dispatch still works behind valid auth

Run relevant Important News tests and changed-file checks.

## Production restrictions

Forbidden:
- Function deploy
- changing `verify_jwt` production setting
- Cron changes
- auto_publish setting changes
- DB writes/migrations
- secrets/Vault changes
- manual Function invocation
- X post / Push
- candidate injection
- PR #10 branch-protection bypass

## PR #10

Do not fold unrelated auth implementation into PR #10.
If the Vercel required check later becomes green, report that separately; PR #10 remains a docs/control PR.

## Handoff

Create a focused source PR for the auth remediation candidate and update `.agent/CODEX_REPORT.md` with:
- discovered production caller contract
- chosen auth design and why
- changed files
- tests/checks
- compatibility risks
- rollout requirements
- production mutation = 0
- PR link/head SHA

Then:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for C1

**推奨モデル：GPT-6 Sol Medium。**


## H1 stop finding — caller contract is unauthenticated (2026-09-23)

The production caller audit found no safe source-only authentication change that preserves existing scheduled execution. All four active pg_cron jobs invoke the same Function with Content-Type only; they send no Authorization, apikey, or dedicated secret. Any Function-side gate or verify_jwt=true would reject these current calls, including publish_ready. The task forbids the required Cron/secret changes, so stop before changing Function source. Re-scope as a coordinated caller credential + storage + Function enforcement rollout with explicit approval; do not weaken the gate to preserve unauthenticated calls.
