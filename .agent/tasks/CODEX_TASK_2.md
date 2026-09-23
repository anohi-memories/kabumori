# Codex Task 2

- task_id: x-autopost-foundation-audit-multibrand-netlify-roadmap-20260923
- owner: codex
- slot: codex-2
- status: ready
- next_owner: codex
- priority: high
- recommended_model: GPT-6 Luna
- purpose: social-mobile history-learning Phase23完了後、現在のX自動投稿基盤を壊さずに棚卸しし、複数ブランド/複数Xアカウント対応の完成、Supabase中核化、Netlify Free管理画面移行までの安全な実装ロードマップを確定する。今回は原則read-only調査と設計のみ。Production mutation/deploy/migrationはしない。

## Product direction

今後の基本構成:
- 管理画面: Netlify Freeを本番候補
- DB: Supabase
- Cron / scheduler: Supabase
- Edge Functions: Supabase
- X posting core: Supabase Edge Functions / RPC
- X API: existing paid contract
- Vercel Pro移行は前提にしない

Architecture target:

Netlify admin UI
↓
Supabase Auth / RLS / RPC / Edge Functions
↓
Supabase DB / Cron
↓
X API

Netlify should be a thin authenticated control UI, not the home for heavy/background processing.

## Mandatory fresh start

1. `git fetch origin main`
2. fresh `origin/main`
3. read `.agent/ORCHESTRATION.md`
4. read `.agent/CURRENT_STATE.md`
5. read this TASK
6. read latest `.agent/CODEX_REPORT_2.md`
7. inspect other slot scopes for overlap
8. inspect production metadata read-only where needed

If another slot is modifying the same X publisher/Cron/schema/admin files, do not edit them. Continue read-only analysis only, or STOP if safe separation cannot be established.

## Scope A — current X platform inventory

Map the live and source architecture for:
- `x-test-post`
- X OAuth connect paths
- token/Vault handling and refresh
- `brands`
- `social_accounts`
- `brand_settings`
- `brand_memberships`
- `posting_windows`
- `scheduled_posts`
- `post_execution_logs`
- `publish_claims`
- `published_content_fingerprints`
- `daily_content_plans`
- relevant Cron jobs
- important-news publish path where it intersects X
- shared brand generator/context/publish guard/dedupe modules
- current admin app

Identify:
- what is already genuinely multibrand
- what is still Kabumori-specific
- what is partially generalized
- what still assumes one brand/account
- what production objects are active today

Do not read secret values.

## Scope B — multibrand blockers

Pay special attention to DB and scheduler constraints that may prevent multiple brands from independently using the same post_type/slot/date.

Audit at minimum:
- UNIQUE constraints on `posting_windows`
- UNIQUE constraints on `scheduled_posts`
- claim/dedupe key scope
- logs and retry scope
- account selection rules
- one-X-account-per-brand assumptions
- cross-brand duplicate protection wiring
- scheduler/Cron dispatch assumptions
- status/retry/failure semantics

Produce a concrete blocker list with severity and exact affected objects/files.

## Scope C — common publisher target architecture

Design the minimum safe path from the current `x-test-post` monolith toward a common publisher.

Target conceptual flow:
1. resolve due scheduled row
2. resolve brand
3. resolve verified X account
4. resolve server-side token
5. resolve brand/profile/settings
6. generate content
7. enforce duplicate/publish guards
8. publish to X
9. persist success/failure/logs
10. retry only under bounded rules

Requirements:
- Kabumori-specific generators may remain specialized where necessary
- other brands should not duplicate whole systems
- adding a brand should primarily be DB/config/profile driven
- publish core must not trust client-supplied account/token ids
- no secret in browser
- no service-role in browser

This task is design/audit only; do not refactor production code yet unless a tiny documentation-only helper is unavoidable.

## Scope D — admin / Netlify readiness audit

Inspect `apps/admin` and classify every server-side dependency:
- Next.js Server Components
- Server Actions
- cookie/session handling
- proxy/middleware behavior
- `next/cache` / revalidation
- any server-only Supabase operations
- whether any privileged credentials are required

Determine:
- what can deploy unchanged on Netlify's current Next runtime
- what would consume Netlify Function/Edge compute
- what should instead move to Supabase RPC/Edge Function
- whether admin can be made thin enough to avoid Netlify Functions entirely or nearly entirely
- required env vars
- Supabase Auth compatibility
- security implications

Do not create Netlify project or change Vercel.

## Scope E — production safety baseline

Read-only establish current baseline for:
- active relevant Functions and versions
- active relevant Cron jobs
- existing brands/accounts counts
- publish-enabled states in aggregate/safe form
- current scheduler/log row counts
- current admin app source shape
- current Vercel presence only if visible from repository/config; do not change it

No raw tokens, no secret values, no personal identifiers.

## Scope F — deliverable

Produce a structured report in `.agent/CODEX_REPORT_2.md` containing:

1. executive summary
2. already-complete pieces
3. incomplete pieces
4. multibrand blockers
5. Netlify migration/readiness findings
6. pieces that should move to Supabase
7. pieces that should stay in Netlify/admin
8. release-to-stable-operations remaining tasks
9. recommended phased roadmap
10. recommended task decomposition across H1/H2/G1/G2, with overlap-safe boundaries
11. specific next implementation task recommendation
12. no-change safety proof

## Roadmap constraints

Must preserve:
- current working auto-posting
- current Cron
- existing accounts
- current Vercel Production until full migration proven
- no automatic paid upgrades
- no Netlify paid plan assumptions
- no direct production rewrite

Target order should generally respect:
1. posting stability
2. complete multibrand support
3. scheduler/retry/dedupe/failure handling
4. secure admin control
5. Netlify Free production viability
6. ops/log/retry/stop controls
7. long-run test

But refine based on actual repo/live findings.

## Forbidden

- production schema/RPC/RLS mutation
- migration apply
- Function deploy
- Cron changes
- OAuth changes
- token refresh changes
- X posting
- Netlify project creation
- Vercel change/delete
- secret rotation
- publish_enabled change
- unrelated file edits

## Completion

When complete:
- status -> `review_required`
- next_owner -> `chatgpt`
- prepend/update `.agent/CODEX_REPORT_2.md`
- control-file sync only if no source changes were necessary
- fresh-check `origin/main`
- STOP for C2

