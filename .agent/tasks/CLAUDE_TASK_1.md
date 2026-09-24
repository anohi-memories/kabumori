# Claude Task 1

- task_id: kabumori-mobile-release-blockers-phase1-production-rollout-20260924
- owner: claude
- slot: claude-1
- status: done
- next_owner: chatgpt
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

## Report

- task_id: kabumori-mobile-release-blockers-phase1-production-rollout-20260924
- result: **Gate A PASS, Gate B PASS, Gate C STOPPED (manual Dashboard step), Gate D PASS (read-only / rollback-contained)**
- chat confirmation: this TASK records the user's authorization, and I confirmed it again in chat before the first production mutation. The user answered 「進めてOK」 to exactly ① the single migration and ② an `account-delete`-only deploy, with ③ reported as a manual step.

### 1. Fresh main

- at start: `0a73250`; my in_progress control commit is `fae7d8c`
- the reviewed source was unchanged on latest main: `git diff 8b78ecc2 origin/main` over the migration, `supabase/functions/account-delete`, `src`, `tests/app` and `docs/mobile-release` is empty
- sha256:
  - migration `65de26c8c1057194a0ba1615220fd23fc5eaab679ffedc47f350d500aa8c3679`
  - `index.ts` `4e3f3c3a…`
  - `delete_logic.ts` `eee8f3cf…`
- ownership: H1 (Important News caller-auth rollout), H2 (x-autopost queue foundation) and G2 (admin multibrand selector) own none of `ensure_my_profile`, migration `20260924100000`, `account-delete` or the Auth redirect allowlist

### 2. Production preflight (read-only)

- migration history: `20260924100000` was local-only with no remote entry. The only 2026-09-24 remote entry is `20260924001508`, which belongs to another workstream (unchanged since the last report).
- `pg_proc` had 0 rows for `public.ensure_my_profile`, so there was nothing unexpected to inspect
- `public.profiles` had 3 policies (`profiles_insert_own:INSERT`, `profiles_select_own:SELECT`, `profiles_update_own:UPDATE`) and 1 non-internal trigger, and `authenticated` had INSERT. This matches the assumptions the security-invoker design depends on.
- functions baseline: 16 functions with versions, `updated_at`, `verify_jwt` and `ezbr_sha256` recorded. No `account-delete`.
- Auth redirect config: not readable with the available tooling (see Gate C)
- production shape matched the reviewed assumptions, so I continued

### 3. Gate A — migration apply

- Applied exactly `supabase/migrations/20260924100000_ensure_my_profile.sql`, wrapped in `begin; … commit;`
- The embedded body's sha256 was asserted equal to the reviewed file's `65de26c8…` before the file was executed
- Ran `supabase db query --linked -f <wrapped file>`, which succeeded with empty rows
- **No `supabase db push`, no migration history write, no history repair/reconcile, and no other migration was run.** This matches repository practice: the earlier Phase 1/2 migrations also appear as local-only in the history.

### 4. RPC postflight

| Property | Result |
| --- | --- |
| signature | `ensure_my_profile()` returns `uuid`, 1 overload only |
| security | `prosecdef = false` → **security invoker** |
| volatility | `v` (volatile) |
| `search_path` | `{search_path=""}` |
| owner | `postgres` |
| ACL | `{postgres=X/postgres,authenticated=X/postgres}` |
| `anon` EXECUTE | **false** |
| `authenticated` EXECUTE | true |
| `service_role` EXECUTE | **false** |
| `profiles` policies after | unchanged: the same 3 |
| `profiles` triggers after | unchanged: 1 |
| `auth.users` user triggers | 0 (none added) |
| migration history | `20260924100000` still has no remote entry (no history write, as intended) |

### 5. Gate B — `account-delete` deploy

- `supabase functions deploy account-delete --project-ref wsmznyzcvmuitkglfeuj`, run from the latest main source in this worktree. The worktree has its own `supabase/config.toml` with no `account-delete` entry, so the CLI default `verify_jwt = true` applies. Deploy succeeded on the first attempt.
- read-back: **`account-delete` v1, ACTIVE, `verify_jwt = True`**, ezbr `0f1cc97736e3…`
- **Other functions:** a full before/after diff of all 16 functions (slug, version, `updated_at`, `verify_jwt`, ezbr sha) shows **no change**. The only difference is the added `account-delete` line.
- **Source read-back:** `supabase functions download` returns the eszip's stored module, which is type-stripped JavaScript, so byte equality with the TypeScript source is not possible. I compared structurally instead. Both sides were type-stripped with the TypeScript transpiler and walked as ASTs, recording every node kind plus every identifier, literal and template-part text.
  - `index.ts`: **AST-identical** (164 nodes)
  - `delete_logic.ts`: **AST-identical** (339 nodes)
- **Negative control for that comparator:**
  - Changing the admin URL in code, `DELETE`→`POST`, and `404`→`403` each produced `READBACK_MISMATCH`.
  - Restoring the file returned it to `MATCH`.
  - My first control mutated a comment by mistake. Comments are correctly ignored, so I redid the control on the code occurrences.

### 6. Gate C — Auth redirect allowlist: **STOPPED, manual step required**

The Supabase CLI has no read command for remote Auth config. Its only write path is `supabase config push`, which pushes the whole local `config.toml` and could overwrite unrelated remote Auth/API settings. It cannot add one entry while provably preserving the others. Reading or writing through the Management API would mean extracting the CLI access token, which I did not do. Per this TASK, I did not guess.

**Exact Dashboard step:** Supabase Dashboard → project `wsmznyzcvmuitkglfeuj` → Authentication → URL Configuration → Redirect URLs → **Add URL** → `kabumori://reset-password` → Save. Do not remove or edit any existing entry. Leave the Site URL and providers unchanged.

**Dev redirect URL: not added, and not needed for the dev client.** This project uses `expo-dev-client`, where `Linking.createURL('reset-password')` resolves through the app scheme to the same `kabumori://reset-password`. An Expo Go URL (`exp://<LAN IP>:<port>/--/reset-password`) changes with the network, so it cannot be "exactly determined". I did not add one.

### 7. Explicitly untouched

- Important News caller-auth (H1)
- x-test-post / queue (H2)
- admin / Netlify (G2)
- market-report shared platform
- X OAuth / Vault
- Push production settings
- Auth providers, signup and email-confirmation settings
- App Store Connect / TestFlight
- Vercel / Netlify
- every other migration and every other Function

### 8. Exact production mutations performed

1. `public.ensure_my_profile()` created, together with its `revoke` / `grant` (one migration, one transaction)
2. Edge Function `account-delete` v1 deployed

Nothing else. The Gate D check below ran in a transaction that always rolled back.

### 9. Tests / checks / read-only runtime verification

- **Rollback-contained RPC contract check.** It ran as `authenticated` in a DO block that always ends in `raise`, so nothing it did can persist.
  - It chose an existing user who already has a profile. Only booleans and counts left the database.
  - Result: `returned_own_id=t profiles_before=1 profiles_after=1 no_jwt_guard=AUTHENTICATION_REQUIRED`.
- `account-delete` with no Authorization header: **401** (the platform JWT gate).
- `account-delete` with the public publishable key as the bearer (a non-user token): **401 `{"error":"ACCOUNT_DELETE_AUTH_REQUIRED"}`**. The request reached the function, and its own `/auth/v1/user` re-verification refused it. The key was never printed.
- Counts after rollout: `auth.users = 2`, `profiles = 1`, the same as the known inventory. **No account was deleted and no profile was created.**
- No real password-reset email was sent. No disposable test account is designated, so I did not create or delete any account.
- Source-side suite on merged main (previous report): 94 / 0.

### 10. Privacy / terms / support URLs: still unresolved (release blocker)

- There is no authoritative value on main: no page, no `eas.json` / env entry, and no public web source.
- `EXPO_PUBLIC_PRIVACY_POLICY_URL`, `EXPO_PUBLIC_TERMS_OF_SERVICE_URL` and `EXPO_PUBLIC_SUPPORT_URL` stay unset. The app shows 準備中 for them.
- They must be decided and published before App Store submission.

### 11. Remaining E2E work

1. Complete the Dashboard step in Gate C.
2. Designate a disposable test account, then run on a real device / dev client:
   - signup → confirmation → first login (profile created by the RPC)
   - password reset mail → deep link → new password
   - in-app deletion → confirm the rows are gone
3. Existing production user without a profile: their row will be created by `ensure_my_profile` at their next sign-in. That is expected behaviour, not a backfill.
4. Social-mobile follow-up (owned by that workstream): `brands` / `social_accounts` remain after a user is deleted.

### 12. Next recommended release phase

1. The user completes the Gate C Dashboard step. Then a short read-only G1 check.
2. Disposable-account E2E on the dev client and TestFlight (recovery and deletion).
3. Decide and publish the three legal/support URLs, and set them in the build config.
4. Then TestFlight / App Store metadata and the final security gate.

- production mutation total for this TASK: **2** (listed in §8). Both were approved and verified.


## Final K1 review — 2026-09-24

**PASS**

Verified and accepted:
- Gate A PASS: only `20260924100000_ensure_my_profile.sql` was applied; no `db push`, no history repair/reconcile.
- `public.ensure_my_profile()` exists with the reviewed contract:
  - security invoker
  - `search_path=""`
  - EXECUTE for postgres owner + authenticated
  - no anon/service_role EXECUTE
  - no new trigger/policy/auth-schema mutation
- Gate B PASS: only `account-delete` was deployed.
  - ACTIVE v1
  - `verify_jwt=true`
  - deployed source is structurally identical to reviewed main source
  - all other Functions remained unchanged
- Gate D PASS:
  - rollback-contained RPC contract check passed
  - unauthenticated and non-user-token requests fail closed with 401
  - auth.users / profiles counts remained unchanged
  - no account deletion or password-reset email was performed
- Production mutations were exactly the two approved changes above.
- Important News H1, x-test-post/H2, G2 admin/Netlify, market-report, X OAuth/Vault, Push, TestFlight/App Store and unrelated DB objects were untouched.

Gate C is an accepted manual blocker, not a K1 failure:
- Supabase Dashboard must add exactly `kabumori://reset-password` to Authentication → URL Configuration → Redirect URLs.
- Do not remove/replace existing entries or change Site URL/providers.
- No Expo Go wildcard/dev URL is required by this task.

Remaining release blockers:
1. manual recovery redirect allowlist entry
2. real recovery/deletion E2E using a designated disposable test account
3. real privacy / terms / support URLs
4. TestFlight / real-device E2E
5. final App Store/security gate

Claude slot 1 production rollout is complete and returns to `done`.
