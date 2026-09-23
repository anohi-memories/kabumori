# Claude Task 2

- task_id: x-admin-netlify-thin-control-plane-phase1-20260924
- owner: claude
- slot: claude-2
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Opus 5.5
- purpose: X自動投稿本番rollout(H2)と競合しない別系統として、apps/adminをNetlify Free向けのthin management UIへ安全に近づける設計・source candidateを進める。Supabaseをexecution/control planeの正本とし、Netlifyへsecretや重いbackground処理を持たせない。

## Scope boundary

Claude G2 owns only:
- apps/admin/**
- admin-specific tests/docs/helpers
- source-only admin-facing Supabase RPC/Edge API design documents/tests when actual DB object creation is not required

G2 must NOT touch:
- supabase/functions/x-test-post/**
- Phase0/Phase0b/Phase0c migrations
- posting_windows/scheduled_posts/publish_claims DDL
- Cron
- OAuth/Vault/token logic
- important-news caller-auth scope owned by H1
- consumer mobile Auth/settings scope owned by G1
- production Netlify/Vercel settings
- any production deploy/migration

If a required implementation would need a DB migration/RPC or shared Function that overlaps another slot, stop at design/source-candidate boundary and report the exact proposed object for later dedicated ownership.

## Goal

Prepare the admin app for this target:

Netlify admin UI
→ Supabase Auth / RLS / narrow admin RPC/Edge APIs
→ Supabase DB / Cron / Edge Functions
→ X API

Netlify should remain a thin authenticated UI. No X API secret, service-role key, OAuth token, or OpenAI key in browser or Netlify client bundle.

## Work

1. Inventory current apps/admin server dependencies:
   - Server Components
   - Server Actions
   - next/headers cookies
   - proxy.ts/session refresh
   - force-dynamic pages
   - revalidatePath
   - Supabase reads/writes
2. Classify each path:
   - can remain Netlify-supported SSR
   - can become RLS-safe browser read
   - should move to narrow authenticated Supabase RPC/Edge Function
   - must remain server-side
3. Design multibrand admin context:
   - explicit active brand/account selector
   - no cross-brand leakage
   - admin_users vs brand_memberships authority separation
   - safe aggregate operational views
4. Implement only non-conflicting apps/admin source candidates that improve:
   - brand/account context structure
   - route separation
   - typed admin data access boundary
   - confirmation UX for dangerous operations
   - no arbitrary table/column mutation from client
5. Netlify readiness:
   - verify Next.js 16/OpenNext compatibility from source
   - define required public env vars
   - identify runtime function consumption
   - prepare netlify config candidate only if safe and source-only
   - no Netlify project creation
6. Tests:
   - unauthenticated/admin denial
   - brand isolation in UI/data-access mocks
   - no service-role/X/OAuth secrets in client bundle/source
   - build/typecheck/lint where available
7. Report exact remaining backend RPC/Edge endpoints needed later, but do not create overlapping production DB objects.

## Product requirements

- management UI only on Netlify
- Supabase owns DB/Cron/Edge/X execution
- current Vercel Production remains untouched until later canary
- no automatic paid plan
- no production publish controls without explicit confirmation and server-side authorization
- preserve existing admin functionality unless intentionally isolated behind a source-only candidate

## Production mutation budget

0.

## Completion / K2

When complete:
- status -> review_required
- next_owner -> chatgpt
- append ## Report to this file
- include changed_files, tests, commit/push, exact admin architecture, Netlify readiness, remaining backend contracts, safety checks, and next recommendation
- STOP for K2
