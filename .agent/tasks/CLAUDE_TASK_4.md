# Claude Task 4

- task_id: x-admin-password-recovery-invite-flow-20260925
- owner: claude
- slot: claude-4
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Opus5.5（高）
- purpose: X管理画面にWeb用の「パスワードを忘れた」「初回招待/パスワード設定」「リカバリ後の新パスワード設定」導線を実装し、Supabase Authのlocalhostフォールバック依存を解消する。まずsource/Netlify Previewまで。production Supabase URL Configuration変更はこのTASKでは行わない。

## Background

現在のSupabase Auth production設定:
- Site URL: `http://localhost:3000`
- Redirect URLs: `kabumori://reset-password` のみ
- `kabumori://reset-password` はモバイルアプリ用であり削除禁止
- Web Adminには現時点で `/login` と `/unauthorized` はあるが、`/forgot-password` / `/reset-password` の受け皿がない

Observed behavior:
- password recovery mail itself is delivered
- recovery link falls back to localhost when no valid Web redirect exists
- localhost destination currently reaches no valid Admin reset page
- new admin invite can also lack a usable Web password setup destination

PR #15 context:
- latest reviewed/fixed head: `de354e7ff9f647435a3c42a87629be1e735794eb`
- C2: PASS-WITH-FIX for source/Preview
- PR #15 remains unmerged because authenticated live QA is still outstanding
- this TASK may build on the current PR #15 branch only if doing so is clean and explicit; any auth-flow source change invalidates the old reviewed head and will require a fresh Codex review before merge

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read current G4/C2 PR #15 history
5. Fresh fetch origin/main and PR #15
6. Confirm dedicated independent G4 worktree
7. Confirm no overlap with:
   - G3 Phase1I files
   - H2 PR #32 personalized-reports review
   - G1/G2 mobile/report work
8. Inspect current Admin Supabase browser/server client helpers, proxy.ts, login flow, auth callback handling, env usage, tests and Netlify config
9. Do not mutate production Supabase Auth URL Configuration in this task

## Goal A — forgot-password entrypoint

Add `/forgot-password` to Admin.

Requirements:
- email input only
- use Supabase password recovery API
- construct the reset redirect from the current trusted Admin origin, not a hardcoded localhost
- target Web reset route: `/reset-password`
- never expose service_role
- never log email/token/session values
- success response must not reveal whether an account exists
- safe generic UI message after request
- sensible loading/error states
- login page should expose a visible “パスワードを忘れた” link

Do not weaken existing /login auth behavior.

## Goal B — reset-password receiver

Add `/reset-password`.

It must safely handle Supabase recovery/invite authentication material according to the current Supabase SSR/browser-client model used by this repo.

Required:
- establish/recognize the recovery session using the supported Supabase flow
- require a valid recovery/invite session before allowing password update
- new password + confirmation
- enforce at least the project-supported minimum and reasonable client-side validation without inventing a weaker policy
- call `updateUser({ password })` only after a valid session exists
- fixed/non-sensitive error messages
- no token/session/hash logging
- after success, sign out or otherwise prevent stale recovery state from being silently reused, then send user to `/login`
- direct unauthenticated visit to /reset-password without a valid recovery/invite context must fail closed and offer restart via /forgot-password

Do not expose password in URL/query/log/storage.

## Goal C — invite / first-password flow

Support Admin users created by Supabase invitation.

Preferred behavior:
- invite/recovery link can land on the same `/reset-password` page
- user sets an initial password there
- do not create a separate weaker authorization path
- do not auto-add anyone to `admin_users`
- password setup alone must never grant Admin authorization

The Admin app must continue to enforce `admin_users` after login.

## Goal D — proxy / public route boundary

Review `src/proxy.ts` and protected layout behavior.

Required:
- `/login`, `/forgot-password`, and the recovery receiver needed for `/reset-password` must be reachable without an already-valid normal Admin session
- protected Admin pages remain protected
- recovery route must not become a general bypass into protected content
- unauthorized/non-admin users must still fail closed after login
- no redirect loop on Netlify
- malformed/tampered auth material must fail closed

Add tests for route classification and redirect behavior.

## Goal E — trusted redirect origin

Do not hardcode a deploy-preview host if avoidable.

Implement a safe strategy:
- derive redirect origin only from trusted request/app origin or an explicit public Admin base URL configuration already present/approved
- HTTPS required outside localhost development
- reject malformed/external/untrusted redirect origin inputs
- no open redirect via query/header/cookie
- preview and future production origin should both be supportable without source edits

Document exact Supabase Redirect URL entries that will be required after review.

Do NOT change production Site URL or Redirect URLs in this task.

## Goal F — Netlify Preview validation

Create/update a PR or PR #15 branch as appropriate and obtain Netlify Deploy Preview.

Verify on exact candidate head:
- /login renders
- /forgot-password renders
- /reset-password direct visit fails safely when no recovery context exists
- protected / and /posts remain fail-closed
- no 404 / 5xx / redirect loop
- Next.js Runtime handles new routes
- no secret-bearing build output

Do not send a real password-recovery email unless explicitly authorized later.
Do not use or record user passwords/tokens.

## Goal G — tests

At minimum:
- forgot-password generic success/no-account-enumeration behavior
- trusted redirect origin builder
- rejects external/open-redirect attempts
- reset page requires recovery/invite session
- password mismatch/invalid length fails locally
- updateUser called only with valid recovery session
- success cleanup/redirect
- invite path uses same safe receiver
- non-admin password setup does not grant admin
- existing login/proxy/admin gate regressions
- selected-brand / brand-boundary regressions from PR #15 if working on that branch
- tsc --noEmit
- lint
- build
- git diff --check
- targeted secret scan

No real Auth mutation in automated tests; use mocks/fakes.

## Supabase configuration handoff — document only

Produce exact operator instructions for the later reviewed rollout.

Must distinguish:
1. Mobile redirect that must remain:
   - `kabumori://reset-password`
2. Web Admin Preview redirect:
   - exact Netlify preview reset URL for the final candidate
3. Future Web Admin production reset URL
4. Site URL migration away from `http://localhost:3000`

Do not apply any of them yet.

## Security requirements

- no service_role in browser/client bundle
- no token/password/session logging
- no account enumeration
- no open redirect
- no auto-admin grant
- no RLS/Auth policy weakening
- password setup does not imply authorization
- recovery links are single-purpose and fail closed outside their intended context
- preserve mobile reset redirect support

## Forbidden

- production Supabase Site URL change
- production Redirect URLs change
- Auth user password mutation
- adding/removing `admin_users` rows
- production DB/schema/RLS/RPC change
- service_role exposure
- merge PR #15 or any auth PR
- Vercel production deploy
- Netlify production config mutation
- DNS/custom-domain change
- X OAuth/Vault/token/post mutation
- G1/G2/G3 source changes

## Production mutation budget

0.

## Completion / K4

Set:
- status -> review_required
- next_owner -> chatgpt

Report:
- fresh main / base branch / PR
- exact candidate head
- auth-flow architecture
- changed files
- public/protected route behavior
- recovery/invite handling
- trusted redirect-origin model
- tests/counts
- Netlify Preview URL/status
- exact Supabase URL Configuration handoff, not applied
- production mutation=0
- remaining risks
- next recommendation

Because this is an Auth/security change, expect independent Codex review before any merge or Supabase URL Configuration mutation.

STOP for K4.
