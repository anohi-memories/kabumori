# Publish-permission boundary (per-account automatic publishing ON/OFF)

Status: **source-only**. Nothing applied or deployed. Production mutation: 0. Production read: 0.
Corrective for PR #76 after the H1 review (`x-social-mobile-pr76-publish-toggle-review-20261002`, findings R1–R5 on head `a59a89e9`).

## 1. What changed, in one picture

```
app (owner/admin) ── social-mobile-publish-setting (Edge) ─────────────────────────────┐
   request shape, bearer token check (Auth), ONE call, caller's own JWT, no service key  │
                                                                                         ▼
        public.set_social_account_publish_enabled(account, desired, expected)   ← one transaction
          auth.uid()  →  LOCK social_accounts (ROW EXCLUSIVE)
                      →  brand row FOR SHARE  →  caller's membership row FOR SHARE
                      →  account row FOR UPDATE
                      →  owner/admin?  expected state?  (ON only: brand live + readiness)
                      →  UPDATE social_accounts SET publish_enabled   (the only write)

x-test-post (Vault-backed account path) ── VaultAccountXAuth.send()
          immediately before EVERY X write (first request and the single 401 retry):
        public.assert_x_publish_permission_for_legacy_post(post, account, brand)
          x_legacy_post_account(...)   (existing exact-account contract)
          + ONE statement / one snapshot: post running, brand active+live, account ON,
            verified, credential refs, no account deletion, refresh state not blocked
```

Files:

| file | role |
| --- | --- |
| `supabase/migrations/20261003090000_social_mobile_publish_permission_boundary.sql` | the two functions; creates nothing else |
| `supabase/functions/social-mobile-publish-setting/{logic,http,index}.ts` | thin, unprivileged front for the switch |
| `supabase/functions/x-test-post/vault_account_auth.ts` | pre-send permission check on the Vault send path |
| `apps/social-mobile/src/{domain/publish-setting.ts,features/publish-setting/*}` | confirmation pinned to what was on screen |

## 2. H1 findings → disposition

| finding | reviewed head | now |
| --- | --- | --- |
| **R1** membership is a stale snapshot | HTTP read of the role, later a service-role PATCH | The caller's membership row is locked `FOR SHARE` in the same transaction as the write. A removal or demotion either committed before (and is what the function reads) or waits for the commit. The Edge function has no service key and no write of its own. |
| **R2** brand active/live TOCTOU | separate brand GET; cached brand context at send time | (a) The brand row is locked `FOR SHARE` from the check to the commit, so ON cannot be written for a brand that is no longer active+live. (b) Every X write of a Vault-backed account is preceded by a fresh single-snapshot permission check; a brand/account context cached earlier cannot authorize a send. |
| **R3** zero-row reread leaks foreign state | service-role reread of the account by id | No reread exists. Every answer comes from the one transaction, after the account's current brand and the caller's current membership were proven under lock. A moved, deleted or foreign account is `not_found` (same shape as a missing id), with no state. |
| **R4** read-side and write-side readiness differ | truthy check vs `not.is.null` filter | One predicate, evaluated on the locked rows that are then written: `nullif(btrim(platform_user_id),'')`, `identity_verified`, `verified_at`, both references present, distinct and unshared (same rule as `x_legacy_post_account`), no connection error, refresh state not `uncertain`/`reauth_required`. Parity with the runtime contract is tested case by case. |
| **R5** confirmation not pinned | request built from current props at submit | The action is pinned (account, expected state, signed-in user) when the person asks; it is dropped as soon as the screen no longer matches, and re-checked against the latest committed render at submit, so even a callback kept from an older render sends nothing. |

Lower-risk items: duplicate raw JSON keys and escapes are rejected (not last-wins); the body is capped in **bytes while it is read** (512), not by a character count after buffering; OFF copy no longer says "anytime" and states that an in-flight send cannot be recalled; the five `require-await` lint findings are gone (tests rewritten).

## 3. Authorization, lock order, isolation

- Caller identity: `auth.uid()` from the caller's own JWT (role `authenticated`). The function has no user-id or brand-id argument. Not granted to `service_role` or `anon`.
- `SECURITY DEFINER` because `authenticated` has no `UPDATE` on `social_accounts` and must not get one. `search_path = ''`, every relation schema-qualified.
- Lock order (same direction as the account-deletion functions: brand → memberships → accounts):
  1. `LOCK TABLE public.social_accounts IN ROW EXCLUSIVE MODE` — before any row lock. The refresh commit functions take `SHARE ROW EXCLUSIVE` on this table and then the account row; a bare `UPDATE` after a row lock would be the opposite order and could deadlock with a commit that has already rotated a single-use token.
  2. brand row `FOR SHARE`
  3. the caller's membership row `FOR SHARE`
  4. account row `FOR UPDATE`
- A caller who is not a member of the account's brand is answered `not_found` by an unlocked pre-check and never waits on, or takes, a lock on another tenant's rows. Nothing is decided by that pre-check; everything is re-read under the locks.
- A member without the right (member/viewer) takes no write lock.
- Waiting is bounded: `lock_timeout = 3s` on the function. A timeout, a deadlock and the account-deletion guard are answered `busy`; nothing is written.
- `READ COMMITTED` is required (the Data API default); any other isolation level is refused.

## 4. ON / OFF semantics

**ON** = "permission enabled and structurally eligible", not "the next X request will succeed". No Vault material is read. Requires, atomically: current owner/admin membership of the account's current brand; `publish_enabled` = expected; platform `x`; brand `is_active` and `publish_mode = 'live'`; `connection_status = 'identity_verified'`; non-blank `platform_user_id`; `verified_at`; both credential references present, distinct, not shared with another account; no `last_connection_error_code`; refresh state not `uncertain`/`reauth_required` (`refreshing` → `busy`); no account deletion in progress.

**OFF** = fail-safe. Requires only: current owner/admin membership, exact account, expected state. Works with a failed connection, missing references, an inactive/disabled brand and a blocked refresh state. Changes nothing but `publish_enabled`: no revoke, no Vault, no posts, no logs, no history, no Auth. During an account deletion both directions answer `busy` (the deletion already requires that nothing is being posted, and its guard refuses every writer).

`updated_at` is deliberately not touched (it is the account-configuration stamp that refresh leases snapshot).

Known consequence, unchanged from the refresh core: `commit_x_account_refresh_*` treats `publish_enabled = false` as an account change. An OFF that lands in the ~1 s between a refresh `begin` and its `commit` leaves that account `uncertain` (blocked until re-connected). OFF is not made to wait for a refresh, because a stale lease would then block OFF.

## 5. Runtime pre-send check and in-flight semantics

- Path covered: every X write of a **Vault-backed exact-account** send (`VaultAccountXAuth.send`), which is the only account-scoped send path wired today (AI Lab `brand_post`), and the path any future Vault-backed account uses. The check is the statement directly before each `request()` call (source-pinned by a test).
- A send is **in flight** from the moment its permission check returns `authorized`. OFF or a brand disable **committed before** the check's snapshot stops the send; one committed after it does not recall a request already on its way to X. No later request of the same dispatch (the 401 retry, a second post) starts without a new check.
- Fail closed: a refusal keeps its fixed code; an unreachable check, a missing function (migration not applied) or any unexpected answer is `X_PUBLISH_PERMISSION_UNAVAILABLE` and nothing is sent.
- `refreshing` is not a permission refusal (the existing rule "a proactive refresh refused because another refresh is in progress keeps the current token" is preserved).

Not covered (stated, not claimed):

- **Kabumori legacy path** (env tokens / `oauth_token_store`, `postToX` without a Vault account) and `important-news-monitor`: not account-scoped; unchanged. The switch can turn the Kabumori-shaped account (no Vault references) OFF but cannot turn it back ON; on that path OFF is seen at the next dispatch's context load, not mid-dispatch, and `important-news-monitor` does not consult `publish_enabled` at all.
- **v2 dispatcher** (`v2_dispatcher.ts`, Phase1B–1I): unwired and its migrations are not applied; unchanged.
- PR #41 (generic Vault-backed `brand_post` path, open, not merged) has its own publish predicate; unchanged.

## 6. Rollout order (when separately authorized; not part of this task)

1. Read-only preflight (below). Stop on any surprise.
2. Apply `20261003090000` alone (single transaction, not re-runnable). Read back: both functions exist, ACL exactly `authenticated` / `service_role`, `prosecdef`, `search_path=""`, `lock_timeout=3s`.
3. Only then deploy `x-test-post` (it now calls the permission check; before step 2 every Vault-backed post would fail closed with `X_PUBLISH_PERMISSION_UNAVAILABLE`). Kabumori posts are unaffected either way.
4. Deploy `social-mobile-publish-setting` with JWT verification ON. It needs `SUPABASE_URL` and `SUPABASE_ANON_KEY` only.

Read-only preflight (aggregate/catalog only, no row data):

```sql
-- a. what the migration builds on, and that it is not applied yet
select to_regclass('public.brand_memberships') is not null as memberships,
       to_regclass('public.social_mobile_account_deletions') is not null as deletions,
       to_regclass('public.x_account_refresh_state_v2') is not null as refresh_state,
       to_regprocedure('public.x_legacy_post_account(uuid,text,text,boolean)') is not null as exact_account_helper,
       to_regprocedure('public.set_social_account_publish_enabled(text,boolean,boolean)') is null as switch_absent,
       to_regprocedure('public.assert_x_publish_permission_for_legacy_post(uuid,text,text)') is null as check_absent;
-- b. every trigger on social_accounts (expected: the deletion guard, and the refresh reset on
--    UPDATE OF verified_at; a generic updated_at trigger would change the lease stamp on every toggle)
select t.tgname, pg_get_triggerdef(t.oid) from pg_trigger t
where t.tgrelid = 'public.social_accounts'::regclass and not t.tgisinternal order by 1;
-- c. authenticated must have no direct write on social_accounts
select privilege_type from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'social_accounts' and grantee = 'authenticated' order by 1;
-- d. how many accounts could be affected, by shape (no ids)
select (vault_access_token_secret_id is not null and vault_refresh_token_secret_id is not null) as vault_backed,
       publish_enabled, connection_status, count(*)
from public.social_accounts group by 1, 2, 3 order by 1, 2, 3;
```

## 7. Proofs

| proof | command | result |
| --- | --- | --- |
| SQL behavior + concurrency on a disposable PostgreSQL 17, stacked on the real onboarding / refresh core / rollout / deletion migrations | `PUB_PGHOST=… PUB_PGPORT=… PUB_PGSUPER=… supabase/tests/social_mobile_publish_permission_run.sh` | `APPLY / BEHAVIOR / RACE / CLEANUP PASS` |
| same, plus the real Edge handler, real brand-context loader + cached guard and real Vault send adapter over HTTP (only X is fake) | `PUB_E2E=1 … social_mobile_publish_permission_run.sh` | `E2E_PASS` (5 scenarios) |
| defect detection: 30 single-property mutations of the candidate, each must fail the runner at the named check | `… social_mobile_publish_permission_mutations.sh` | `30/30 DETECTED` |
| Edge function | `deno test supabase/functions/social-mobile-publish-setting` | logic 15, http 14, migration contract 10 |
| send adapter | `deno test supabase/functions/x-test-post/vault_account_auth_test.ts` | 29 (9 new; they fail when the checks are removed) |
| client | `npm test` in `apps/social-mobile` | 145 (32 in `publish-setting.test.mjs`) |

Concurrency cases in the runner: membership removed / demoted before the write (ON and OFF); permission-changing writers blocked while the switch holds its decision (membership delete, demotion, brand disable, publish_mode change, account move); brand disabled before ON; the H1 R2 schedule with the pre-send check; account moved to a foreign brand and to another brand of the same caller; duplicate ON and ON-vs-OFF; OFF vs an in-flight permission check; account deletion before and after the switch; lock order against a refresh-commit-shaped transaction; bounded waiting; a non-member never waits on another tenant's locks.

The runner requires an English-speaking server (`lc_messages=C`).
