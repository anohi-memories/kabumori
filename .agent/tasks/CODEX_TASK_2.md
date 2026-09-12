# Codex Task 2

- task_id: push-delivery-deduplication-hardening-20260912
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: user
- priority: high
- recommended_model: Sol High
- purpose: 重要ニュース・市場Critical・個別朝刊/大引けで共有するPush通知経路について、二重enqueue・二重claim・retry・Cron重複・Expo再送などの重複通知リスクを監査し、既存機能を壊さず必要最小限のhardeningを行う。

## C2 Review — 2026-09-12

### Review result

- architecture audit: approved
- producer dedupe audit: approved
- P0 concurrent dispatcher risk identification: approved
- proposed atomic claim / SKIP LOCKED design: approved in principle
- settings re-check policy: approved in principle
- dispatcher retry/fail-safe design: approved in principle
- tests: approved for source/pure/contract level
  - combined relevant suite: 83/83 PASS
  - deno check: PASS
  - git diff --check: PASS
- implementation commit: `b83d73a25089a4a7b99bf1dc14985a6a8206fe59`
- push: confirmed on origin/main
- production changes: correctly none

### Blocking issue before production

The proposed migration and claim path have NOT yet been proven in a disposable real PostgreSQL/Supabase database.

Still required before production approval:
- apply migration in disposable DB
- rollback-contained migration proof
- two-session concurrent claim test proving one notification row is claimed at most once
- sent row cannot be reclaimed
- stale processing reclaim bounded
- retry state transitions verified against actual SQL behavior
- service-role-only RPC permissions verified
- settings opt-out claim behavior verified in DB

Current Supabase production project has no development branches (`list_branches` returned 0). Do NOT use production as the disposable test environment without a separate explicit user decision.

### Production remains prohibited

Do not perform any of the following until a later C2 approval:
- apply `20260912100000_harden_push_notification_claims.sql` to production
- `supabase db push`
- deploy `send-push-notifications`
- deploy `important-news-monitor`
- modify Cron
- send a real/test Push
- insert synthetic production notifications

### Next decision

User must choose a safe proof environment before continuing:
1. create a temporary Supabase development branch (may incur cost), or
2. provide/use a disposable local PostgreSQL/Supabase environment.

Do not resume H2 automatically until that environment is selected.

### Remaining design notes

- Residual setting TOCTOU between atomic claim commit and external Expo request remains small but real; acceptable only after DB proof and final C2 review.
- Provider-accepted-but-client-timeout remains fundamentally ambiguous; current proposal intentionally fails terminally rather than risk duplicate resend.
- Migration history is divergent; `supabase db push` remains prohibited.

## Completion state

- implementation/review stage: approved
- production rollout: blocked pending disposable-DB proof
- status: review_required
- next_owner: user
