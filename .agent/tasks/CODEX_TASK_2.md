# Codex Task 2

- task_id: x-admin-pr15-auth-crossbrand-final-review-20260925
- owner: codex
- slot: codex-2
- status: done
- next_owner: none
- priority: critical
- recommended_model: Sol（高）
- purpose: K4 PASS済みPR #15 multi-brand admin selectorを、認証・認可・cross-brand leakage・server-side brand scoping・Netlify Preview実挙動の観点で独立最終レビューする。merge/Vercel production/DB mutationは禁止。

## Target

PR #15:
- branch: `admin-multibrand-selector-phase2-20260924`
- current head: `a8f98444425c25796e9fef611445b0f574120669`
- previous semantic head: `b04442561d9e9c6d01b4a9fcf640c2cf731cd923`
- the new head is an empty retrigger commit; tree must be identical

Netlify Preview:
- site: `shiny-kheer-77a154`
- preview: `https://deploy-preview-15--shiny-kheer-77a154.netlify.app`
- K4 result: `PREVIEW_QA_PASS_AUTH_BLOCKED`

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read G4 TASK/Report and PR #15 description
5. Fresh fetch origin/main and PR #15
6. Confirm independent H2 worktree
7. Confirm H1 Phase1I review and G1/G2/G3/G4 do not overlap apps/admin scope
8. Verify `a8f9844` tree identity with `b044425`
9. Do not merge/deploy/apply anything

## Review A — authentication gate

Verify:
- unauthenticated access cannot render admin content
- `/login` is public only as intended
- protected layout requires current authenticated Supabase user
- admin authorization requires intended admin boundary
- unauthorized users land in fail-closed state
- no client-only check can bypass server auth
- server actions independently enforce auth/authorization
- invalid/tampered cookies cannot grant access
- redirect behavior does not loop

Use existing Netlify Preview for read-only HTTP checks where helpful.

## Review B — active brand authority

Verify:
- active brand cookie/input is only a request, never authority
- every request revalidates brand through server-authorized allowlist/access resolver
- unknown/unauthorized brand fails closed or safely defaults
- no raw query/cookie/header value can directly parameterize privileged data access
- no client-only selector state controls authorization
- default brand behavior is explicit and safe

## Review C — cross-brand read isolation

For all PR #15 data reads:
- scheduled posts
- post history
- recent failures
- system status
- report-run lookups
- morning_report_runs
- posting windows
- X profile links/handles

Verify every brand-scoped query uses the already-authorized brand id and that no nested/secondary query omits the brand predicate.

Adversarially inspect same-table and nested lookups for cross-brand leakage.

## Review D — Kabumori-only surfaces

Verify:
- Important News remains Kabumori-only
- singleton settings lacking brand_id are not exposed for AI Lab
- system-toggle remains pinned server-side to Kabumori
- AI Lab cannot trigger Kabumori-only write paths by tampering cookie/query/body
- read-only fallback for other brands cannot mutate shared settings

## Review E — mutations / Server Actions

Review all changed or affected Server Actions:
- active-brand change
- system toggles
- any mutation reachable from dashboard

Verify:
- authenticated
- authorized
- server-side brand allowlist
- no arbitrary brand id
- no CSRF-like cross-brand state confusion through cookie-only trust
- no widened Supabase policy reliance

## Review F — RLS / backend assumptions

PR #15 intentionally uses code-owned `ADMIN_BRANDS` because admins cannot read `brands/social_accounts` under current RLS.

Verify:
- code registry cannot accidentally include unsupported brands/users
- Mio remains excluded
- no service_role introduced
- existing RLS is not bypassed
- admin_users gate semantics remain unchanged
- no claim is made that code registry substitutes for DB policy where it does not

Document remaining backend contract limitations separately.

## Review G — Netlify Preview evidence

Independently verify read-only:
- Preview head is exact target
- /login renders
- /, /posts, /important-news fail closed unauthenticated
- invalid session cookie fails closed
- no 404/5xx/redirect loop
- Next.js Runtime handles protected routes

Authenticated live QA may remain unavailable if no authorized session exists; do not request passwords/tokens.

## Review H — tests

Rerun:
- all apps/admin lib tests
- selected-brand tests
- brand-boundary/no-leak tests
- tsc --noEmit
- lint
- build
- git diff --check
- targeted secret scan

Add adversarial tests if a concrete gap is found.

If a concrete issue is found:
- minimal PR #15 source fix allowed
- add regression
- push safely to PR branch
- no merge/deploy/DB mutation

## Forbidden

- merge PR #15
- Vercel production deploy
- Netlify production config mutation
- production DB/schema/RPC/RLS/Auth mutation
- service_role addition/exposure
- X API/post/media
- OAuth/Vault/token changes
- G1/G2/G3 work

## Production mutation budget

0.

## Completion / C2

Update `.agent/CODEX_REPORT_2.md` with:
- verdict PASS / PASS-WITH-FIX / FAIL
- findings by severity
- auth gate assessment
- brand authority assessment
- cross-brand read assessment
- Kabumori-only surface assessment
- Server Action/mutation assessment
- RLS/backend assumption assessment
- Netlify Preview evidence
- exact tests/counts
- changed files/fix commit if any
- production mutation=0
- merge recommendation
- authenticated-live-QA residual if still blocked

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for C2.


## Final C2 — PR #15

Verdict: **PASS-WITH-FIX for source/Preview review; merge held for authenticated live QA**.

Accepted reviewed/fixed head:
- `de354e7ff9f647435a3c42a87629be1e735794eb`

Accepted fixes:
- P1 independent page/action admin gate now requires global admin_users authorization.
- P1 Kabumori-only mutation now re-resolves active brand and denies mutation outside Kabumori context.
- cross-brand reads remain server-authorized and scoped.
- Important News / Kabumori singleton settings remain Kabumori-only.

Verification accepted:
- apps/admin tests 34/34 PASS
- focused selected-brand/boundary 20/20 PASS
- tsc/lint/build/diff PASS
- final Netlify Preview SUCCESS
- unauthenticated/tampered-session routes fail closed
- production mutation=0

Residual gate:
- authenticated live Preview QA is still unverified.
- PR #15 remains unmerged until an authorized admin session verifies selector switching, direct navigation, Kabumori-only controls, and no cross-brand leakage.
