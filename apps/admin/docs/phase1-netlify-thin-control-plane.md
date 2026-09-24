# Phase 1 — `apps/admin` as a Netlify-ready thin control plane

Status: design + source candidate only. No Netlify site was created; current Vercel Production is
untouched; production mutation = 0. See the task Report for exact changed files/commit.

## 1. Server-dependency inventory (Work item 1)

Read directly from source, `apps/admin/src/**` (25 files total):

| Concern | Where | Notes |
|---|---|---|
| Server Components (default, RSC) | every `page.tsx`, `(admin)/layout.tsx` | All data-fetching happens here via an injected `SupabaseClient`, never in Client Components. |
| Client Components (`"use client"`) | `login/login-form.tsx`, `logout-button.tsx`, `system-status-list.tsx` | Exactly 3. Each is a small, self-contained interactive island; none does its own Supabase *table* reads — `login-form.tsx` calls `auth.signInWithPassword` via the browser client, `logout-button.tsx` calls `auth.signOut`, `system-status-list.tsx` calls the one Server Action below. |
| Server Actions (`"use server"`) | `lib/actions/system-toggle.ts` | Exactly 1 file, already following least-privilege design: a fixed allowlist (`SYSTEM_TOGGLE_KEYS`) maps each toggle key to exactly one table/column or `posting_windows` post_type — the client can never point a write at an arbitrary table/column, and there is no generic "run this SQL/RPC" escape hatch. Re-reads the current value before writing (avoids a no-op write on a redundant click) and re-checks `admin_users` membership itself (does not trust that the page that rendered the button already did). |
| `next/headers` (`cookies()`) | `(admin)/layout.tsx`, `lib/supabase/server.ts` | Standard `@supabase/ssr` App Router pattern: read the session cookie in Server Components, admin-check via `admin_users`, redirect otherwise. |
| Middleware / session refresh | `src/proxy.ts` (+ `lib/supabase/proxy.ts`) | Next.js 16 renamed `middleware.ts` → `proxy.ts`; the runtime primitive is otherwise identical (Next's own build output still labels it "ƒ Proxy (Middleware)"). Refreshes an expiring session cookie on every non-static request; **authorization is still enforced by `(admin)/layout.tsx`**, not here — this file only keeps sessions alive, it never gates access. |
| `force-dynamic` | `(admin)/page.tsx`, `(admin)/posts/page.tsx`, `(admin)/important-news/page.tsx` | All 3 data pages. Correct: each reads live, frequently-changing operational data (today's schedule, recent failures, news candidates) that must never be statically cached. |
| `revalidatePath` | `lib/actions/system-toggle.ts` | Called once, after a successful toggle write, to refresh the dashboard's server-rendered toggle state. |
| Supabase reads | every `lib/*.ts` data-fetch module | All take an injected `SupabaseClient` as a parameter (never construct their own) — this is what makes them independently unit-testable via source-inspection, as `brand-boundary.test.ts` already does. |
| Supabase writes | `lib/actions/system-toggle.ts` only | The only place `apps/admin` writes to the database at all. |
| Secrets | **none found** | `grep -rl "SERVICE_ROLE\|service_role" src/` returns zero matches. Every Supabase client construction (`lib/supabase/{client,server,proxy}.ts`) uses only `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — the same public, RLS-bound anon/publishable key used by a browser client. There is no `X_CLIENT_SECRET`, `OPENAI_API_KEY`, or service-role key anywhere in this app's source, so **the "no secrets in Netlify client bundle" requirement is already satisfied by the existing architecture**, not something this phase needed to newly enforce. |

## 2. Path classification (Work item 2)

- **Can remain Netlify-supported SSR as-is**: all 4 pages, the admin layout, and `proxy.ts`. Nothing here
  requires a Node API, filesystem access, or any capability outside what Netlify's Next.js Runtime already
  provides for standard App Router SSR + one middleware/proxy file.
- **Can become an RLS-safe browser read**: none identified as *needing* to move — every current read
  already goes through the same RLS-scoped, publishable-key client whether it runs server- or
  client-side, so there is no security reason to move any of them, only a possible latency/UX reason
  (not evaluated this phase; out of scope).
- **Should move to a narrow authenticated Supabase RPC/Edge Function**: none of `apps/admin`'s *existing*
  functionality needs this — `system-toggle.ts`'s allowlisted direct-table-write pattern already achieves
  the same safety property (minimum necessary write surface) that a narrow RPC would. This becomes
  relevant only for *new* admin capabilities this phase does not add (see §5, remaining backend
  contracts).
- **Must remain server-side**: nothing writes with elevated privilege today (no service-role use at all),
  so there is no "must stay server-only for a secret's sake" path to flag. `(admin)/layout.tsx`'s
  `admin_users` check must obviously keep running server-side (it already does, as a Server Component).

## 3. Multibrand admin context design (Work item 3)

### Current state: zero multibrand awareness, and it is intentionally, testedly locked that way

Every existing data-fetch module hardcodes `KABUMORI_BRAND_ID` (`lib/brand-boundary.ts`, literally one
constant) in its query filters, and `lib/brand-boundary.test.ts` asserts this at the source level for
every affected query (`scheduled_posts`, `post_execution_logs`, `posting_windows` across
`today-scheduled-posts.ts`, `post-history.ts`, `recent-failures.ts`, `system-status.ts`) — 5 tests, all
currently passing, all still passing after this phase's changes (nothing in this phase touches those
query files). This exists because a prior incident (AI Lab's schedule leaking into this same Kabumori
admin dashboard) was found and fixed elsewhere in this multibrand effort; this admin app's own
hard-filter is the last line of defense against that class of bug recurring here specifically.

**This phase does not relax that lock.** Introducing a brand selector safely means making the *filter
value* explicit and admin-authorized instead of a hardcoded constant — never removing the filter itself.

### Authority model

Two independent authority sources already exist in the database (both used elsewhere in this project);
this phase's `admin-context.ts` is the first place `apps/admin` itself reads both together:

- **`admin_users`** (already used by `(admin)/layout.tsx` to gate the whole app): global authority. A
  global admin may act on any brand — this mirrors how `admin_users` / `private.is_admin()` already work
  as a cross-brand override elsewhere in this system (e.g. the `admin_select_*` RLS policies that sit
  alongside the Phase 5 social-mobile `brand_memberships` tenant policies).
- **`brand_memberships`** with role `owner` or `admin` (`member`/`viewer` are read-only in the mobile app's
  own model and do not carry admin authority here): brand-scoped authority, limited to exactly the brands
  listed.

`resolveAdminBrandAccess(supabase, userId)` (new, `src/lib/admin-context.ts`) returns
`{ kind: "global", brandIds: null }` or `{ kind: "scoped", brandIds: string[] }`, always deriving `userId`
from the caller's own `auth.getUser()` result — never from a client-supplied value — and failing closed
(`{ kind: "scoped", brandIds: [] }`) on any read error, never defaulting to global. `canAccessBrand(access,
brandId)` is the one place that decides "may act on this brand" so no page needs to re-implement the
`kind === "global" || brandIds.includes(...)` check itself.

### What this phase deliberately does NOT do yet

- **Wire this resolver into any existing page.** Doing so is the natural next step, but it means changing
  `brand-boundary.test.ts`'s hardcoded-Kabumori assertions into "hardcoded to the selected/authorized
  brand" assertions across 4 files at once — a change worth its own focused review rather than bundling it
  into this already-large Phase 1, and the task's own scope boundary asks for a design-and-report stop
  whenever a further step would need review from a different angle. No DB migration or RPC is needed for
  this next step (both source tables already exist and are already RLS-readable by the signed-in admin),
  so it can proceed directly from this design once reviewed.
- **Build the actual brand selector UI.** Design for it: an explicit selector (not an auto-detected
  "current" brand) in the admin header, defaulting to the admin's only brand when `brandIds.length === 1`
  (or to `kabumori` for today's global admins, preserving current behavior exactly), persisted per-session
  (e.g. a cookie), and every data-fetch module's brand filter parameterized by the selected value instead
  of the `KABUMORI_BRAND_ID` constant — with `canAccessBrand` re-checked server-side before honoring any
  selection, so a manipulated cookie/query value can never select a brand the admin does not have
  authority over.
- **A "safe aggregate operational view"** (e.g. "how many posts across all brands failed today" for a
  global admin) is not designed in detail this phase beyond noting it is a `kind === "global"` -only
  capability that must still attribute each row to its real `brand_id` in the UI (never silently merge
  brands into one undifferentiated count) — deferred as a remaining backend/UX question, not blocking
  Phase 1.

## 4. Netlify readiness (Work items 1, 2, 5)

- **Verified from source, this phase**: `npm run build` (Next.js 16.3.4, Turbopack) succeeds cleanly with
  only public, non-secret env vars set (`NEXT_PUBLIC_SUPABASE_URL` /
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`) and produces the exact route shape Netlify's Next.js Runtime
  expects: 3 dynamic (`ƒ`) app pages, 2 static (`○`) pages, and one "ƒ Proxy (Middleware)" entry (Next 16's
  renamed `proxy.ts` is still built as the standard middleware primitive under the hood — nothing here is
  a new, unsupported concept for that runtime). `npx tsc --noEmit` and `npm run lint` both pass with zero
  errors/warnings.
- **Required public env vars**: exactly `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
  — both already meant to ship in a browser bundle (not secrets). No other environment variable is read
  anywhere in `apps/admin/src`.
- **Runtime function consumption**: 3 dynamic SSR routes + the Server Action + the proxy/middleware, all
  on ordinary Node-compatible APIs (`fetch`, `cookies()`, standard `@supabase/ssr`) — nothing uses a
  Node-only API that Netlify's Edge Functions runtime would reject, and nothing needs to run on the Edge
  runtime specifically (no low-latency/geo requirement here), so the default Netlify Next.js Runtime
  (Node-based Functions) should be the right fit without extra configuration.
- **The one real, must-verify-before-deploy risk**: Next.js 16.3.4 is very recent. This document does not
  claim Netlify's currently-published Next.js Runtime support matrix covers 16.x — that must be checked
  against Netlify's own current documentation immediately before any real deploy attempt (this task had no
  live external verification available and does not fabricate a specific compatibility claim here).
  Everything else evaluated from source is already compatible with how that runtime works in general.
- **`netlify.toml`** (new, this commit): a minimal, source-only candidate — build command, publish
  directory, `NODE_VERSION`, and an explicit comment listing exactly which public env vars belong in the
  Netlify UI and which secrets must never be added (there currently are none this app would even read).
  Creating this file does not create, configure, or deploy any Netlify site.

## 5. Remaining backend RPC/Edge contracts needed later (not created this phase)

Per the scope boundary, none of these were built — they are reported so a later, dedicated task can own
them without re-deriving this analysis:

1. **Brand-scoped query parameterization** across `today-scheduled-posts.ts`, `post-history.ts`,
   `recent-failures.ts`, `system-status.ts` (replace the `KABUMORI_BRAND_ID` constant with the selected,
   `canAccessBrand`-checked brand id) — a source-only app change, no new DB object needed, but touches the
   existing safety-tested query files and their tests, so it is its own reviewable step (see §3).
2. **A brand selector UI** in `(admin)/layout.tsx` plus a small server-side "read the selection cookie,
   validate with `canAccessBrand`, fall back safely" helper — no new DB object needed.
3. **A cross-brand aggregate view for global admins** (§3) — needs a decision on exact shape (per-brand
   breakdown vs. a new view/materialized query) before any implementation; likely a new read-only SQL view
   or RPC, which would need its own migration owned by whichever slot is assigned that work, per this
   task's scope boundary.
4. **Any future admin write beyond the existing `system-toggle` allowlist** (e.g. a brand-scoped
   equivalent of `system-toggle.ts` for non-Kabumori brands) should get a narrow, purpose-built RPC rather
   than widening the existing allowlist's table/column reach — flagged here as a principle for whoever
   builds it, not an immediate need.

## 6. Tests (Work item 6)

- `src/lib/admin-context.test.ts` (new, 7 tests): global access via `admin_users`; brand-scoped access via
  `brand_memberships` restricted to `owner`/`admin` roles (`viewer` explicitly excluded); role
  deduplication; no-membership-at-all fails closed to zero brands (not global); a `brand_memberships` read
  error fails closed to zero brands rather than throwing or defaulting to global; `canAccessBrand`'s
  global-permits-anything and scoped-permits-only-listed-ids behavior.
- `src/lib/brand-boundary.test.ts` (existing, unchanged, still 5/5 pass): proves this phase did not weaken
  the Kabumori-only hard filter on any existing query.
- No service-role/X/OAuth secret exists anywhere in `apps/admin/src` to test the absence of (verified by
  grep during Phase A inventory, §1) — this phase adds no code path that could introduce one.
- `npx tsc --noEmit`, `npm run lint`, `npm run build`: all pass (see §4).
