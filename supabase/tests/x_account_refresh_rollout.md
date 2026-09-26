# Stage 3A — per-account rollout authority for the universal X OAuth refresh

Status: **source-only**. Nothing applied or deployed. Production mutation: 0 (read-only `supabase migration list --linked` only).

## 1. Architecture

```
X publish path (legacy x-test-post today, v2 dispatcher later)
  └─ begin_x_account_refresh_legacy_post / begin_x_account_refresh_v2   (exact account, locks held)
        └─ public.x_account_refresh_authority(account)   ← the one eligibility predicate, before any Vault read
              account health + publishability + exact refs + refresh state + rollout row
        └─ Vault read → lease → one token request (unchanged core/Phase1I semantics)
```

- New migration `20260926032054_x_account_refresh_rollout_authority.sql` (created with `supabase migration new`):
  - table `x_account_refresh_rollout` — one row per X account; **no row = off**
  - `x_account_refresh_authority(text)` — returns NULL (allowed) or a fixed refusal code; never reads Vault; only the exact account's own rows
  - `create or replace` of the live `begin_x_account_refresh_legacy_post` — byte-identical to the core body plus one authority check before the Vault read (pinned by a static test that rebuilds the expected body from the core file)
  - `set_x_account_refresh_rollout(...)` — the only mutation path (service_role)
  - `get_x_account_refresh_health(...)` — operator health contract (service_role)
  - `resolve_stale_x_account_refresh_lease(...)` — owner-only manual intervention
  - grandfathering of already-proven accounts (below)
- Phase1I (`20260925150000`, not live) — `begin_x_account_refresh_v2` calls the same predicate before its Vault read. It resolves at run time: until Stage 3A is applied the call fails and begin fails closed.
- Edge (`x-test-post/vault_account_auth.ts`) — the env gate `X_VAULT_ACCOUNT_REFRESH` stays as the global **kill switch**; it is never enough alone. Rollout refusals on a 401 record `X_ACCESS_TOKEN_UNAUTHORIZED` on the account and fail with the rollout code (zero token requests). A proactive refresh refused before any token request keeps the current token and does not consume the attempt's one refresh.
- Kabumori legacy path: untouched (no Vault refs; `x_legacy_post_account` refuses it; `oauth_token_store` code unchanged).

## 2. Rollout modes

| mode | meaning | refused with |
| --- | --- | --- |
| no row / `off` | never refresh | `X_REFRESH_ROLLOUT_OFF` |
| `pilot` | refresh only while `now() < pilot_expires_at` (≤ 30 days), `generation < pilot_max_generation` (set to current generation + budget 1..24), and the refresh state has no unresolved `last_error_code` | `X_REFRESH_PILOT_EXPIRED`, `X_REFRESH_PILOT_LIMIT_REACHED`, `X_REFRESH_PILOT_BLOCKED_BY_ERROR` |
| `enabled` | normal automatic refresh | — |

Before the rollout row is consulted the predicate requires, for the exact account: exists, `platform = 'x'`, `identity_verified` + platform user id, `publish_enabled`, non-blank `oauth_client_ref`, own access+refresh refs present/distinct/unshared, refresh state not `refreshing`/`uncertain`/`reauth_required`. Mode is never inferred from brand, handle, e-mail, row order or env.

Setter rules: `pilot`/`enabled` require the account's own distinct unshared refs and a client ref; `off` is always allowed; switching to `off`/`enabled` clears pilot fields; `reason_code` is a fixed code for audit. API roles (anon/authenticated) cannot read or change rollout.

Grandfathering (in the migration): accounts with a committed refresh (`generation > 0`), state `idle`, no error, `identity_verified` → `enabled` / `GRANDFATHERED_PROVEN_REFRESH`. In production today this is exactly the AI Lab account (generation 2), so applying the file does not stop the account that works now, without naming it.

## 3. Re-authorization contract (unchanged core semantics, now per rollout)

- `invalid_grant` / 401 after a fresh refresh → refresh state `reauth_required` → `social_accounts.connection_status = 'failed'` + fixed `last_connection_error_code` (core health mirror). The exact account only.
- Automatic refresh stops (predicate refuses); posting is refused before generation (`X_ACCOUNT_NOT_VERIFIED`); no fallback to other credentials.
- User-facing contract: members already read their own `social_accounts` row (existing RLS): `connection_status = 'failed'` + `last_connection_error_code` = "reconnect needed". No new authenticated surface was added (no new SECURITY DEFINER exposed to `authenticated`).
- Reconnect (OAuth completion stamps `verified_at`) resets `uncertain`/`reauth_required` (core trigger). Rollout mode is not changed by reconnect.

## 4. Observability contract — `get_x_account_refresh_health(p_social_account_id default null)` (service_role)

Columns: `social_account_id, brand_id, connection_status, publish_enabled, last_connection_error_code, credential_refs_configured, rollout_mode, pilot_expires_at, pilot_max_generation, refresh_status, generation, last_refreshed_at, access_expires_at, refresh_last_error_code, lease_age_seconds, stuck_refreshing (lease > 10 min), reauth_required, refresh_block_code` (= predicate result). No token, secret id, lease token or provider body. Implemented as a SECURITY DEFINER SQL function (not a view) because a `security_invoker` view would need direct table grants that expose lease tokens and secret ids.

## 5. Stuck / conflict safety

- Stale lease: detected by `stuck_refreshing`; `resolve_stale_x_account_refresh_lease(account, min_age ≥ 5 min)` (owner SQL only) turns it into `uncertain` / `X_REFRESH_LEASE_STALE` — never `idle` (X may have rotated the token); re-connect resolves it. A resolved lease can no longer commit.
- Reconnect vs commit: proven concurrently — whichever side PostgreSQL lets win (wait or deadlock victim), new tokens never land in a re-connected account (commit wins only if the reconnect aborted; otherwise `account_changed`/`X_REFRESH_PERSIST_FAILED` and the lease is blocked).
- Uncertain token result → no commit, blocked until re-connect; second 401 → no second refresh (unchanged, re-tested).

## 6. Migration history (read-only findings, 2026-09-26)

- `supabase migration list --linked` from this branch: 31 matched, **64 local-only**, **27 remote-only**. Local-only includes the live core `20260925140000` (applied with `db query`, never recorded — project convention), Phase1B–1I (not applied) and many older files applied under other version ids. Remote-only versions were applied from other tools (dashboard/MCP) with ids that do not exist as local files.
- Therefore **`supabase db push` must never be used** here: it would try to apply 64 files.
- Safety built into the files: the core refuses to run again (`CORE_PRECONDITION_ALREADY_APPLIED`); Stage 3A refuses without the core and refuses to run twice (`STAGE3A_PRECONDITION_*`), and never re-creates core objects.
- Normalization proposal (NOT executed, needs its own approval): after an exact read-back that the core objects equal `20260925140000`, record only that version with `supabase migration repair --status applied 20260925140000` (single version, never a blanket repair); same for `20260926032054` after its apply. The wider 64/27 drift is a separate project-wide task.

## 7. Deployment plan (not executed; needs a new TASK + review)

1. Stage 0 (read-only): core objects present; `x_account_refresh_rollout` absent; AI Lab refresh state `idle`, generation ≥ 1, no error; no lease `refreshing`; env gate state known.
2. Apply `20260926032054_x_account_refresh_rollout_authority.sql` alone via `supabase db query --linked -f` (no push/repair). Read back: rollout rows = grandfathered set (expect AI Lab only), `pg_get_functiondef` md5 of the 4 new functions + the replaced begin equal to a disposable apply of the same file, begin grants unchanged, advisors (no new findings attributable).
3. Deploy `x-test-post` from the reviewed commit (worktree with its own `config.toml`, `--no-verify-jwt`), download and byte-compare.
4. Keep `X_VAULT_ACCOUNT_REFRESH=enabled` (kill switch). Observe the next AI Lab expiry cycle (refresh generation +1, no error).
5. Rollback: `set_x_account_refresh_rollout('<account>', 'off', ...)` per account, or unset the env gate globally; to remove the predicate from the legacy begin, re-create it from the core file's definition (`create or replace`, identical to the live pre-3A body). The rollout table and new functions are inert without callers.

## 8. Remaining work

- **Stage 3B — controlled second-account pilot**: pick one real Vault-backed account (e.g. a social-mobile user who consents), `set_x_account_refresh_rollout(id, 'pilot', 'PILOT_STAGE3B', now() + interval '7 days', 3)`; needs that account's content dispatcher (today only AI Lab has one in x-test-post) and an operator runbook for the health RPC.
- **Stage 3C — multi-account pilot**: a small cohort in `pilot`; alerting on `stuck_refreshing`, `reauth_required`, `refresh_block_code` changes; admin UI (G4, service-side) calling the setter/health RPCs.
- **Stage 4 — general rollout**: default policy for newly connected accounts (still an explicit setter call per account, e.g. from the OAuth completion after identity verification), user-facing reconnect flow on `connection_status = 'failed'`, migration-history normalization, v2 dispatcher activation (Phase1B–1I) which already calls the same predicate.
