# Consumer mobile account lifecycle (Phase 1)

Audit and source candidate for the release blockers in
`kabumori-release-mobile-blockers-phase1-auth-account-settings-20260924`.
Production mutation in this work: **0**. Nothing here has been deployed, applied or configured.

---

## 1. Auth / profile lifecycle before this change

Traced from source, not assumed.

| Step | What actually happened |
| --- | --- |
| Signup | `signUpWithEmail` → `supabase.auth.signUp`. A profile was created **only if** the response already carried a session. With email confirmation on, it does not, so no profile was created at signup. |
| Email confirmation | Handled entirely by Supabase's own hosted link. The app has no route for it and does not observe it. |
| First login | `signInWithEmail` → `prepareSession` → `ensureProfile`. This was the first point at which a profile row actually appeared. |
| Session restore | `AuthProvider` calls `getSession()`, then `prepareSession` on whatever it gets, so a restored session also ensured the profile. |
| Auth state change | `onAuthStateChange` runs the same path, deferred one task so no Data API call happens inside Supabase's own lock. |
| Missing profile | `ensureProfile` threw → the provider **dropped the session** and rendered the login form with the error attached. |
| Logout | `signOut` removes this device's push token first (while RLS still authorises it), then signs out. Reachable only from the 銘柄 (explore) screen header. |
| Deleted user | No in-app path existed at all. |

### Which tables depend on `profiles`

`profiles.id` references `auth.users(id) on delete cascade`. Every user-owned table references
`public.profiles(id) on delete cascade`:

- `tracked_stocks`
- `alert_settings`
- `alert_category_settings`
- `notifications`
- `device_push_tokens`
- `personalized_reports`

Referencing `auth.users` directly, outside the consumer app's own data:

- `admin_users` (cascade)
- `brand_memberships` (cascade) — social-mobile workstream
- `social_account_oauth_states.initiated_by_user_id` (cascade) — short-lived state rows

So the *deletion* side of the lifecycle was already complete at the schema level. Only the
*creation* side was defined in client code.

### Root cause of "2 auth users, 1 profile"

Profile creation was client-driven and only ran on a session the client accepted. Any confirmed —
or unconfirmed — auth user that never completed a first login in the app therefore has no profile
row. Nothing is corrupt; the invariant simply was not owned by the server. A second, narrower
cause is possible for the same symptom: `ensureProfile` did a `select` then an `insert`, so a
failure between the two (offline, transient error) left the user with a session and no profile, and
the app then showed them the login screen.

This is a source-level determination. Confirming *which* of the two produced the specific
production pair would need a read-only production query, which this task did not run.

## 2. Chosen remediation, and what was rejected

**Chosen: `public.ensure_my_profile()`**, one idempotent `security invoker` RPC, called where
`ensureProfile` used to do select-then-insert.

- The id comes from `auth.uid()`, never from an argument, so a caller can only ever create their own
  row.
- `security invoker`, not `definer`: the existing `profiles_insert_own` policy already restricts the
  write, so no elevated privilege is needed and none is granted.
- `insert … on conflict (id) do nothing` — one statement, no TOCTOU window, safe to repeat.
- Executable by `authenticated` only; revoked from `public`, `anon` and `service_role`.

**Rejected: a trigger on `auth.users`.** It would run inside Supabase's signup transaction, so any
failure turns every new signup into a 500, and the repository has a known migration-history
inconsistency that makes broad auth-schema changes riskier than they appear. The gap being closed
is the creation path the client already runs, not a missing database invariant.

**Rejected: backfilling the existing profile-less auth user.** That is a production data mutation
and is out of scope for this task. It is not needed for correctness either: that user gets a profile
the first time they sign in with this build.

**Also changed:** a failed profile preparation no longer drops the session. The provider keeps it
and exposes `profileError`, and the app shows a recovery screen with 「もう一度試す」 and
「ログアウトする」. The old behaviour told the user their login had failed when it had not.

## 3. Password recovery architecture

```
login screen 「パスワードをお忘れの方」
  → auth.resetPasswordForEmail(email, { redirectTo: Linking.createURL('reset-password') })
  → Supabase sends the mail
  → user taps the link → kabumori://reset-password…
  → useRecoveryLink() (Linking.useURL) → parseRecoveryLink()
  → PasswordResetScreen, rendered above the auth gate
  → startRecoverySession() → applyNewPassword() → auth.updateUser({ password })
```

`parseRecoveryLink` accepts all three shapes Supabase can send, because the client cannot choose
which one arrives:

| Shape | Delivered as | Handled with |
| --- | --- | --- |
| implicit | `#access_token=…&refresh_token=…&type=recovery` | `setSession` |
| PKCE | `?code=…` | `exchangeCodeForSession` |
| token hash template | `?token_hash=…&type=recovery` | `verifyOtp` |
| expired / denied | `?error=…&error_code=otp_expired` | shown as a plain Japanese message |

The screen is rendered **above** the auth gate rather than as a route because the link arrives while
signed out (no route would be mounted) and because it establishes a session of its own, which would
otherwise drop the user into the app without ever setting a new password.

The request never reveals whether an address is registered: success and "no such user" produce the
same message.

## 4. Account deletion architecture

```
設定 → アカウントを削除
  → user retypes their registered address (typed confirmation, not a single tap)
  → POST /functions/v1/account-delete   Authorization: Bearer <user JWT>, no body
  → GET /auth/v1/user with that token          ← the only source of the user id
  → DELETE /auth/v1/admin/users/{verified id}  ← service role, hard delete
  → cascade removes every row listed in §1
  → client signs out (best effort; its failure cannot un-delete the account)
```

Security boundary:

- The function **never reads the request body**, so no client-supplied id exists to trust. A test
  pins this against the source.
- The service role key is used for exactly one call, is never returned, never logged, and never
  appears in an error. Every client-visible error is one of two fixed codes.
- Already deleted (`404`) counts as success — the requested end state holds.
- Every other non-2xx is a failure, so the UI can never show a "deleted" state the server did not
  confirm.
- The mobile client never receives the service role key.

Data removed for the deleted user: `profiles`, `tracked_stocks`, `alert_settings`,
`alert_category_settings`, `notifications`, `device_push_tokens`, `personalized_reports`, plus
`admin_users` / `brand_memberships` / `social_account_oauth_states` rows keyed to that auth user.

### Known limitation, deliberately not handled here

If a user ever connected X through the social-mobile flow, deleting their auth user removes their
`brand_memberships` row but leaves the `brands` / `social_accounts` rows that flow created. Those
tables belong to the social-mobile workstream, so this candidate does not touch them. It should be
owned as a follow-up by that workstream. Consumer Kabumori accounts do not go through that flow
today.

## 5. Settings / legal / support map

No legal, privacy or support page exists anywhere in the repository — mobile, admin, web or docs.
Nothing is duplicated by this work.

Entry point: 設定 button in the ホーム screen header → settings sheet.

| Entry | Behaviour |
| --- | --- |
| ログイン中のメールアドレス | information only |
| パスワードを変更 | sends the reset mail to the signed-in address |
| 通知の設定 | points at the existing 重要ニュース screen (not duplicated) |
| プライバシーポリシー | opens `<EXPO_PUBLIC_KABUMORI_WEB_URL>/privacy`, or says 準備中 |
| 利用規約 | opens `<EXPO_PUBLIC_KABUMORI_WEB_URL>/terms`, or says 準備中 |
| お問い合わせ・サポート | opens `<EXPO_PUBLIC_KABUMORI_WEB_URL>/support`, or says 準備中 |
| ログアウト | signs out |
| アカウントを削除 | deletion screen with typed confirmation |

Settings is presented as a sheet over the current tab, not as `app/settings`. The app's navigator is
expo-router's `NativeTabs`, where **every** top-level route becomes a visible tab and `hidden` tabs
cannot be navigated to at all, so a new route would have added a sixth tab to the bar. The web
export confirms the route count is unchanged at 10. The screens are self-contained and can move to
real routes unchanged once a stack is introduced above the tabs.

### Unresolved values (must be decided before submission)

Superseded: the three per-page variables were replaced by one origin,
`EXPO_PUBLIC_KABUMORI_WEB_URL`, and the pages now exist in `apps/kabumori-web`. See
[RELEASE_READINESS.md](RELEASE_READINESS.md) for what is still unset.

## 6. Manual steps this task did not perform

All of these are production configuration and were deliberately left undone:

1. Apply `supabase/migrations/20260924100000_ensure_my_profile.sql` (no `db push`; single-file apply
   after separate approval).
2. Deploy the `account-delete` function. It needs `SUPABASE_URL`, `SUPABASE_ANON_KEY` and
   `SUPABASE_SERVICE_ROLE_KEY`, and should keep platform JWT verification on — the function
   re-verifies the caller itself either way.
3. Add the recovery deep link to Supabase Auth's redirect allowlist (`kabumori://reset-password`,
   plus the Expo development URL while testing).
4. Confirm which auth flow the project uses. `exchangeCodeForSession` only succeeds on PKCE; on a
   non-PKCE project the PKCE branch reports an expired-link message instead. The other two shapes
   are unaffected.
5. Decide and set the three URLs above.
6. Send a real reset mail and run one real deletion against a disposable test account. Neither was
   done here: both are production mutations.

## 7. App Store implications

- Apple requires in-app account deletion whenever an app offers in-app account creation. The
  deletion path added here is the candidate for that requirement; it still needs the deploy in §6 to
  actually work.
- Working privacy and support URLs are required at submission. They are configuration, not code, and
  are still undecided.
- Deletion is a hard delete, so the same address can sign up again afterwards.
