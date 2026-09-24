# Claude Task 1

- task_id: kabumori-mobile-release-blockers-phase1-production-rollout-20260924
- owner: claude
- slot: claude-1
- status: in_progress
- next_owner: claude
- priority: critical
- recommended_model: Opus 5.5
- purpose: K1 PASS済みのconsumer mobile release-blockerを、本番へ最小安全範囲で反映する。ensure_my_profile migration適用、account-delete単独deploy、recovery redirect設定、postflight確認までを順序付きゲートで実施する。

## User authorization

2026-09-24、ユーザーは前K1で提示した次工程に対し「つづけて」と明示した。

このTASKで承認されるproduction mutationは以下に限定する。

1. `supabase/migrations/20260924100000_ensure_my_profile.sql` **1本だけ**の適用
2. `account-delete` Edge Function **だけ**のdeploy
3. Supabase Auth redirect allowlistへ `kabumori://reset-password` を追加
4. 開発検証に必要で、current Expo dev URLが安全に確定できる場合のみ、そのdev redirect URL追加
5. 上記のread-only preflight/postflight

以下はまだ承認しない:
- broad `supabase db push`
- migration history repair/reconcile
- 他migration apply
- 他Function deploy
- Auth provider変更
- user signup設定変更
- real user削除
- real production user/profile行の編集
- 実ユーザーへのpassword-resetメール送信
- TestFlight/App Store submission
- Vercel/Netlify変更
- Important News / x-test-post / market-report / admin workstream変更
- privacy/terms/support URLの推測値設定

## Approved source basis

PR #13:
- reviewed head: `8b78ecc22524b830c5e440e8f0b995fbb9a6f014`
- merged main: `f7ace17336c29edec49bb8daa0f95116a30d42fb`

K1 accepted:
- app tests 77/77 PASS
- account-delete tests 17/17 PASS
- combined 94/94 PASS
- disposable PostgreSQL proof PASS
- Expo web export PASS
- Vercel PASS
- 25 reviewed files byte-identical on merged main
- production mutation so far = 0

Important release ordering:
- the current app calls `ensure_my_profile()` on accepted sessions
- therefore migration must be applied before shipping any mobile build from this main

## Mandatory startup

Before any production mutation:

1. Read `PROJECT_RULES.md`
2. Read `.agent/ORCHESTRATION.md`
3. Read `.agent/CURRENT_STATE.md`
4. Read this TASK and previous G1/K1 Report
5. Fresh fetch `origin/main`
6. Confirm reviewed migration/function source still exists unchanged on latest main
7. Confirm H1/H2/G2 do not own:
   - `public.ensure_my_profile`
   - migration `20260924100000_ensure_my_profile.sql`
   - `account-delete`
   - Supabase Auth redirect allowlist
8. Read-only production preflight:
   - migration history
   - `pg_proc` existence/count for `public.ensure_my_profile`
   - grants/owner/security mode if already present unexpectedly
   - Functions list and current versions
   - Auth redirect configuration, if safely readable
   - do not expose secrets

If production shape materially differs from reviewed assumptions, STOP before mutation and return for K1.

## Gate A — exact ensure_my_profile migration

Apply only:
`supabase/migrations/20260924100000_ensure_my_profile.sql`

Do NOT run `supabase db push`.

Postflight must prove:
- `public.ensure_my_profile()` exists
- correct signature
- `security invoker`
- expected `search_path`
- EXECUTE granted only to the intended authenticated role(s)
- anon does not gain execute
- no table/policy/trigger/auth-schema change
- no unrelated migration/history repair

If any result differs, STOP. Do not deploy account-delete.

## Gate B — deploy only account-delete

Only after Gate A passes:

Deploy only:
`supabase/functions/account-delete`

Requirements:
- use latest reviewed main source
- platform JWT verification ON unless current project tooling requires an equivalent secure boundary; do not weaken auth
- Function must continue to re-verify caller token using `/auth/v1/user`
- service role used only server-side
- no caller-supplied user id
- no secret/token in response/logs
- no other Function deploy

Postflight:
- read back function version/status/verify_jwt/source metadata where available
- verify no unrelated Function version/updated_at moved
- do not invoke against a real user

If deploy fails:
- one careful diagnosis allowed
- no repeated retry loop
- no alternate deploy/config path without K1/user review

## Gate C — recovery redirect allowlist

After Gate A/B pass:

Add:
- `kabumori://reset-password`

Optional:
- current Expo dev redirect URL only if it can be derived exactly from current project/dev configuration and is clearly for development testing.

Do not:
- remove existing redirect URLs
- change auth provider configuration
- disable email confirmation
- weaken session/security settings
- add wildcard redirects unless already part of an explicitly reviewed project convention

Postflight:
- read back redirect allowlist without exposing unrelated sensitive values
- prove existing entries preserved and required entry added

If available tooling cannot safely mutate/read Auth redirect config, STOP and report the exact Dashboard manual step instead of guessing.

## Gate D — runtime/readiness verification

Do read-only verification after rollout:

- existing authenticated user session path can resolve `ensure_my_profile` contract without changing another user's data
- migration and Function are both present
- no production account is deleted
- no real reset email is sent unless there is an already-designated disposable test account and the task can prove it is non-user production data

If there is no clearly designated disposable test account:
- do **not** create/delete a real account in this TASK
- report real recovery/deletion E2E as the next manual/testflight gate

## Legal/support URL handling

Current source expects:
- `EXPO_PUBLIC_PRIVACY_POLICY_URL`
- `EXPO_PUBLIC_TERMS_OF_SERVICE_URL`
- `EXPO_PUBLIC_SUPPORT_URL`

Do not invent values.
Audit whether real production URLs now exist on main/current public web.

If exact URLs are confirmed from authoritative project source, report them for the next build configuration.
If not, leave unset and mark them as a release blocker for the next phase.

## Safety / untouched

Must remain untouched:
- Important News caller-auth H1 rollout
- x-test-post/H2 queue work
- G2 admin/Netlify work
- market-report shared platform
- X OAuth/Vault accounts
- Push production settings
- App Store Connect/TestFlight
- unrelated DB objects

No blind migration replay. No history repair.

## Handoff

Update this TASK `## Report` with:

1. fresh main SHA
2. production preflight findings
3. exact migration apply result
4. RPC postflight: signature/security/grants/search_path
5. account-delete deploy result + version/verify_jwt/source read-back
6. Auth redirect allowlist result or exact manual blocker
7. explicit untouched list
8. exact production mutations performed
9. tests/checks/read-only runtime verification
10. unresolved privacy/terms/support URLs
11. remaining real-device/recovery/deletion E2E work
12. next recommended release phase

Then:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for K1

**推奨モデル：Opus 5.5。**
