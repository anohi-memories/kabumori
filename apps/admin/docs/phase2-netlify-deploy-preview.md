# apps/admin Netlify Deploy Preview — Phase 2 runbook

Builds on [Phase 1](./phase1-netlify-thin-control-plane.md) (server-dependency inventory, the
`admin-context.ts` candidate, and the original `netlify.toml` source candidate). Phase 1 confirmed
apps/admin's architecture already satisfies Netlify's requirements; this phase turns that candidate into
an actual, documented deploy-preview pipeline and closes out the one risk Phase 1 could not verify.

**Task scope**: prepare the repository completely; no live Netlify site was created (would require
interactive account authorization this task cannot perform). What follows is the exact remaining setup —
UI steps only, no source changes — plus what was verified without it.

## What changed in this phase

- `netlify.toml`: comments updated to Phase 2 status and to record the verified Next.js 16 support +
  the one still-open `proxy.ts` risk (see below). Build config itself (`command`, `publish`,
  `NODE_VERSION`) is unchanged from the Phase 1 candidate — nothing needed fixing.
- `.gitignore`: added `.netlify` (Netlify CLI's local site-link state directory), matching the existing
  `.vercel` entry.
- This doc.

No application source file changed. No DB migration/RPC/Edge Function/production config changed.
Production mutation = 0.

## Netlify readiness (Phase 2)

Phase 1 flagged one unverified risk: whether Netlify's Next.js Runtime supports this app's Next.js
16.3.4. This phase researched it (Netlify's own docs/changelog, checked 2026-09-24):

- Netlify's Next.js adapter documentation states it is "thoroughly tested with every Next.js release"
  and actively maintained "to support all Next.js versions starting from version 13.5," with no upper
  version cap documented.
  (<https://docs.netlify.com/frameworks/next-js/overview/>)
- Netlify's own changelog post "Next.js 16 is ready to deploy on Netlify" confirms Next.js 16 —
  including Turbopack and the App Router — deploys "with zero configuration."
  (<https://www.netlify.com/changelog/next-js-16-deploy-on-netlify/>)
- A 2026-08 Netlify security-advisory changelog recommends upgrading to `next@16.3.3` or later; this
  app is already on `16.3.4`.
  (<https://www.netlify.com/changelog/2026-08-25-nextjs-security-vulnerabilities/>)

**Conclusion: Next.js 16.3.4 itself is not a blocker.** The Phase 1 "confirm before deploying" risk is
resolved for the Next.js major version itself.

**One narrower risk remains, not resolved by documentation alone:** this app uses `src/proxy.ts`
(Next.js 16's rename of `middleware.ts`) rather than the older filename. Community reports researched
for this phase describe `proxy.ts` recognition depending on the exact Netlify adapter build a site has
picked up, and recommend confirming the request that runs through it fires correctly on a **real Netlify
Deploy Preview** rather than assuming it from `next build`/`next start` locally. In this app, the one
thing `proxy.ts` does is refresh the Supabase session cookie
(`src/lib/supabase/proxy.ts` → `updateSupabaseSession`) before every page renders — if that silently
did not run on Netlify, sessions would still generally work (auth is re-checked in
`(admin)/layout.tsx` and again inside the one Server Action) but would refresh less reliably, not fail
open. This is a UX/reliability risk, not an auth-bypass risk, but it must still be checked live before
trusting Netlify Previews for anything session-refresh-sensitive.

**Because `netlify.toml` intentionally does not pin `@netlify/plugin-nextjs`** (see the file's own
comment — Netlify recommends leaving it unpinned so each build gets the adapter's latest fixes), a real
site should already get whichever adapter build currently handles `proxy.ts` best. This cannot be
verified without an actual Deploy Preview, which is why it is listed as the one open item below rather
than closed out.

## Environment variable classification

Every `process.env.*` reference in `apps/admin/src` (verified by full-tree grep, this phase):

| Variable | Classification | Needed at | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Public/browser-safe | Build + runtime | Same single Supabase project used everywhere; no per-environment split needed. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Public/browser-safe | Build + runtime | Anon/publishable key, RLS-bound. Intentionally ships in the client bundle. |
| `NODE_ENV` | Framework built-in | Runtime | Set automatically by Next.js/Netlify; never configured manually. |

**Unavailable / not needed**: no server-only secret is read anywhere in this app's source today
(`grep -rniE "service_role|SERVICE_ROLE|x_client_secret|openai_api_key|vault|oauth"` across
`apps/admin/src` returns zero matches, re-verified this phase). `netlify.toml` documents this
explicitly and instructs never to add `SUPABASE_SERVICE_ROLE_KEY`, `X_CLIENT_SECRET`,
`OPENAI_API_KEY`, or any other server secret to this site's environment variables — there is no code
path that would read one, and keeping it that way is what keeps this a secret-free thin UI.

Because Preview and Production need the identical two public variables, `netlify.toml` does not need
any `[context.deploy-preview]` / `[context.branch-deploy]` override — one shared value works everywhere.
If a required variable were ever missing, `getSupabasePublicConfig()`
(`src/lib/supabase/env.ts`) already throws before any page renders — Preview fails closed by
existing design, not by anything added in this phase.

## Exact remaining UI steps (interactive account action — not performed by this task)

1. In the Netlify dashboard: **Add new site → Import an existing project** → connect the
   `anohi-memories/kabumori` GitHub repository.
2. Site build settings:
   - **Base directory**: `apps/admin`
   - Build command / publish directory: leave as detected from `netlify.toml` (`npm run build` /
     `.next`) — Netlify will read this file once Base directory points there.
3. Site → Environment variables, add exactly:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   (values are the same public ones already used for the Vercel Production deployment of this app —
   do not add any server-only variable; see classification table above.)
4. Deploy contexts: leave Netlify's defaults (Production = default branch, Deploy Previews = every PR,
   Branch deploys = off unless wanted). No custom context config is required per the env-var analysis
   above.
5. After the site exists, open any PR touching `apps/admin/**` (PR #15 is the first candidate — see
   below) and confirm:
   - the Deploy Preview build succeeds
   - `proxy.ts` actually runs (session cookie refreshes across a navigation) — the one open risk above
   - login/auth redirect, protected pages, and the Important-News/system-toggle pages render

Once that one Preview is confirmed, no further per-PR setup is needed — Deploy Previews are automatic
from here on for every future `apps/admin` PR.

## PR #15 compatibility (Scope E)

Re-diffed `origin/main` against PR #15's current head (`b04442561d9e9c6d01b4a9fcf640c2cf731cd923`),
scoped to `apps/admin`, this phase: all 18 changed files are under `apps/admin/src/**`
(the brand-selector Phase 2 UI/actions/tests). **`netlify.toml`, `next.config.ts`, `package.json`,
`package-lock.json`, and `tsconfig.json` are byte-identical to main** — PR #15 changes zero build
configuration and introduces zero new `process.env` reads (checked the three new/changed
non-test lib files directly: `active-brand.ts`, `admin-brands.ts`, `brand-selector.tsx`).

**Conclusion: once a Netlify site exists per the steps above, PR #15 can be Deploy-Previewed exactly
like any other PR, with the identical build/env configuration documented in this file — no changes to
PR #15's reviewed semantics are needed or implied.** The PR #15 production merge/Vercel-gate/QA sequence
itself remains deferred, per the current TASK's explicit instruction; this section only establishes that
Netlify Preview is compatible with it whenever that separate task resumes.

## Deployment workflow (new normal, once a site exists)

```
feature branch / PR (apps/admin/**)
  -> local: npm test (node --test), npx tsc --noEmit, npm run lint, npm run build
  -> Netlify Deploy Preview (automatic per PR)
  -> Claude implementation completion
  -> ChatGPT K review (using source + the Preview URL)
  -> Codex review when required
  -> fixes / regression, repeat Preview as needed
  -> final approval
  -> merge to main -> Vercel Production deploy (unchanged, still the only path to production)
```

Vercel's rate limit (the reason PR #15's own final gate is currently deferred) no longer blocks
ordinary implementation review once this pipeline exists — Netlify Preview and the local checks above
cover the same web-behavior verification without touching Vercel's quota at all.

## Verification performed this phase

All run against a clean `npm ci` on fresh `origin/main` (`08b8895`), apps/admin only:

- `node --experimental-strip-types --test src/lib/*.test.ts`: **12/12 pass** (unchanged from Phase 1 —
  no test file touched this phase).
- `npx tsc --noEmit`: PASS.
- `npm run lint`: PASS.
- `npm run build` (dummy public Supabase env only): PASS — output unchanged from Phase 1's inventory
  (3 dynamic routes + 2 static + 1 Proxy/Middleware).
- `git diff --check`: PASS.
- Secret scan (`service_role`/`SERVICE_ROLE`/`x_client_secret`/`openai_api_key`/`vault`/`oauth`,
  case-insensitive) across `apps/admin/src`, `netlify.toml`, and both docs files: **zero matches**
  (the only hits are the variable *names* inside comments explaining what must never be added, not
  values).
- Auto-regenerated `apps/admin/next-env.d.ts` (a `next build` side effect, marked
  "should not be edited" by Next.js itself) was reverted after the build; not part of this phase's
  actual diff.

## Remaining risks

1. **`proxy.ts` on Netlify — not locally verifiable.** The one concrete open item; needs a live Deploy
   Preview once the site above exists (step 5 of the UI steps).
2. **No live Deploy Preview exists yet.** Everything in this doc is prepared and, for the parts checkable
   without a live site, verified — but the actual Netlify site creation is an interactive account step
   outside this task's authorization.
3. PR #15's own production merge/QA continuation remains deferred by explicit prior instruction,
   unaffected by this phase.

## Next recommendation

1. A human (or a task explicitly authorized for interactive Netlify account setup) performs the 5 UI
   steps above.
2. On the first real Deploy Preview, specifically confirm the `proxy.ts` session-refresh risk before
   relying on Netlify Previews for anything auth-refresh-sensitive.
3. Once confirmed, resume the deferred PR #15 Vercel-gate → merge → post-merge QA task separately, as
   already scoped in that task.
