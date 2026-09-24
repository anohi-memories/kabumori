# Claude Task 2

- task_id: x-admin-multibrand-selector-query-parameterization-phase2-20260924
- owner: claude
- slot: claude-2
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Opus 5.5
- purpose: K2 PASS済みPhase1 admin foundationを使い、apps/adminへ明示的なbrand selectorを配線し、現在Kabumori固定の4 query moduleを「server-sideで権限確認済みのselected brand_id」へ安全にparameterizeする。production mutationは0。

## Base

Phase1 merged on main:
- merge SHA: a9c0ef71954cdaa01e0ee7eb34bcd37dbcc6ec15
- admin-context.ts / tests / netlify.toml / design doc are on main
- current query modules still hardcode KABUMORI_BRAND_ID by design

## Mandatory fresh start

1. git fetch origin main
2. fresh origin/main
3. read ORCHESTRATION / CURRENT_STATE / this TASK
4. inspect H1/H2/G1 for overlap
5. inspect apps/admin/** drift since Phase1 merge
6. inspect current brand-boundary tests and all four target query modules

If another slot touches apps/admin/**, STOP.

## Scope A — selected-brand authority boundary

Implement a server-side helper that:
- derives user identity from supabase.auth.getUser()
- resolves AdminBrandAccess through the Phase1 resolver
- accepts a persisted/requested brand selector only as a selector, never as authority
- validates selected brand via canAccessBrand()
- fails closed on unauthorized/unknown selection
- preserves current Kabumori default for global admins unless an explicit valid selection is made
- for exactly-one scoped brand, defaults safely to that brand
- does not expose service-role or bypass RLS

Cookie/session/query storage may be used only if server-side revalidation occurs on every request.

## Scope B — brand selector UI

Add an explicit admin header selector that:
- shows only brands the current admin is authorized to access
- clearly displays active brand
- does not silently aggregate brands
- persists selection safely
- changing selection causes server-rendered data to reload
- unauthorized/tampered brand id cannot be honored
- no client-side direct DB authority is added

If brand display names require a DB read, use existing RLS-safe brands access only; do not add a new DB object in this task.

## Scope C — parameterize the four query modules

Safely replace hardcoded KABUMORI_BRAND_ID usage in:
- today-scheduled-posts.ts
- post-history.ts
- recent-failures.ts
- system-status.ts

Requirements:
- every function requires or receives an already-authorized brandId
- every relevant query keeps an explicit brand_id filter
- no unscoped fallback query
- no implicit global aggregate
- no query may accept an unvalidated raw client brandId
- types make the selected brand requirement obvious

## Scope D — system-toggle safety

Do NOT broaden generic mutation authority.

Audit whether existing system-toggle is safe to expose under selected brand context.
- If it is Kabumori-specific, keep it Kabumori-only and make UI state explicit.
- If safe parameterization can be done wholly inside apps/admin with existing RLS/allowlists and without shared backend changes, prepare a source candidate only with focused tests.
- If it would require new RPC/DB policy/shared backend, STOP at design/report for that part. Do not create the DB object.

## Scope E — tests

Update/replace brand-boundary tests so the invariant becomes:
- every operational query is explicitly brand-filtered
- selected brand must be server-authorized
- tampered selection fails closed
- global admin defaults to Kabumori unless selecting another valid brand
- scoped admin cannot select outside membership
- exactly-one scoped brand defaults correctly
- no cross-brand leakage in mocked query calls
- existing login/logout/auth denial behavior remains intact

Run:
- node tests
- tsc --noEmit
- lint
- Next build with public Supabase env only
- git diff --check
- secret scan

## Scope F — UX constraints

Keep the admin practical:
- selector in shared admin layout/header
- clear brand label on pages where data is scoped
- no duplicate selector per page
- preserve current routes and navigation
- mobile/basic responsive behavior should not regress

## Forbidden

- any production deploy
- Netlify site creation/configuration
- Vercel production change
- DB migration/RPC/view/Edge Function
- x-test-post/**
- Phase0/Phase1 queue work
- Cron/OAuth/Vault/token changes
- consumer mobile changes
- Important News changes
- cross-brand aggregate dashboard in this task

## Production mutation budget

0.

## Completion / K2

When complete:
- status -> review_required
- next_owner -> chatgpt
- append ## Report to this task

Report:
1. fresh source SHA
2. exact selected-brand authority flow
3. selector persistence method
4. changed files
5. query parameterization details
6. system-toggle decision
7. tests/build results
8. branch/commit/push/PR state
9. production mutation=0 proof
10. remaining backend contracts
11. next recommendation
12. fresh-origin verification

Then STOP for K2.
