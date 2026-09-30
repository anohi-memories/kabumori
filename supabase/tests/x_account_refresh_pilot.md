# Stage 3B — second-account pilot preparation (source + plan only)

Status: **source-only**. Production mutation 0 (read-only inspection only). Nothing below §6 has been executed.

Revision 2 (after H1/C1 FAIL on `cd7adf5`): an explicit **publish authority** now gates every generic X create (P1), and the generic completion RPC refuses AI Lab explicitly (P2). See §2a.

## 1. Candidate assessment (read-only, 2026-09-27)

Exactly one second Vault-backed X account exists:

| field | value |
| --- | --- |
| social_account_id | `sa_bfdab0e0696ec8e56ed2dd83` |
| handle | `yumeyoasobi` |
| brand | `u_ae343f5caedb67d4af33fc7a` (profile `social_mobile_user_v1`, social-mobile user workspace) |
| ownership | `brand_memberships`: exactly 1 member, role `owner` |
| connection | `identity_verified`, platform user id set, verified 2026-09-23 17:09 JST, no connection error |
| credentials | own access + refresh refs present, distinct, not shared (shared refs across all accounts = 0); last written 2026-09-23 17:09 JST |
| refresh state | none (never refreshed); rollout row none (= off) |
| publishing | `publish_enabled = false`; brand `is_active = false`, `publish_mode = 'disabled'`; no `brand_settings` row; no posting windows; no scheduled posts |
| not | Kabumori (`kabumori_x`, legacy) / AI Lab (`ai_salaryman_lab_x`) |

Verdict: **technically eligible, operator/user-gated.** Not ready to activate because:
1. The owner must confirm this account is intended for the pilot and consent to automatic posting.
2. The user-consent store (`social_mobile_content_settings`, candidate migration `20260922045046`) is **not deployed in production**; without it the new path always refuses (`SOCIAL_MOBILE_AUTO_POST_NOT_CONSENTED`).
3. Brand/account/windows are intentionally disabled today (admin-owned).

## 2. Architecture used for the second account

No parallel auth path: the existing exact-account machinery is reused end to end.

```
claim_due_post (legacy, brand-scoped row)          ← unchanged
 └─ x-test-post: brand ≠ kabumori → VaultAccountXAuth.load(post, brand's account)   ← Stage 1/3A (DB re-derives + checks the exact account)
     └─ brand_post:
         ├─ brand = ai_salaryman_lab → dispatchAiLabScheduledBrandPost            ← unchanged
         └─ otherwise → dispatchVaultAccountScheduledBrandPost (NEW, _shared/brand/vault_account_brand_post.ts)
               gates (all before generation/X): approved profile (social_mobile_user_v1 only; profile key must match brand)
                 → exact account (context account id = the port's account, same brand, platform x)
                 → brand_post enabled in brand_settings + brand live + account publish_enabled
                 → user consent: brand's own content settings approvalMode = 'auto_post_preference'
               → generate with the user's settings, publish length policy 140 code points (fits X's weighted limit)
               → NG words, cross-brand duplicate → one X create via the exact-account port (rollout authority in DB)
               → complete_vault_account_brand_post(post, account, x id, sha)   ← NEW migration 20260927101423
```

- Refresh/rollout authority stays in the database (Stage 3A predicate before any Vault read). The global env gate is only a kill switch.
- **Publish authority (separate, §2a)** is checked by `check_x_account_publish_authority` before generation and again immediately before the one X create.

## 2a. Publish authority (P1 fix) — `20260927124300_x_account_publish_authority.sql`

Stage 3A rollout (`off`/`pilot`/`enabled`) only decides whether a token may be **refreshed**; a still-valid token could otherwise keep posting. The generic path therefore has its own gate:

- `x_account_publish_authority(social_account_id PK, state enabled|off|revoked, starts_at, expires_at ≤ starts_at + 30 days, reason_code)` — **no row = no publishing**; RLS on; service_role SELECT only.
- `set_x_account_publish_authority(account, state, reason, starts_at, expires_at)` — the only mutation path (SECURITY DEFINER, service_role); `enabled` needs an unexpired window ≤ 30 days; `off`/`revoked` always allowed and keep the last window for audit; `kabumori` / `ai_salaryman_lab` accounts refused.
- `check_x_account_publish_authority(post, account, brand)` — SECURITY INVOKER (service_role), returns `allowed` or a fixed code: specialised brand → `VAULT_PUBLISH_BRAND_NOT_ELIGIBLE`; post not running/not brand_post/wrong brand → `VAULT_PUBLISH_POST_NOT_RUNNING`; not the brand's one account → `X_CLAIM_ACCOUNT_MISMATCH`; brand not active+live → `VAULT_PUBLISH_BRAND_DISABLED`; account unverified/publish off → `X_ACCOUNT_NOT_VERIFIED`/`X_ACCOUNT_PUBLISH_DISABLED`; brand_post not in brand_settings → `VAULT_PUBLISH_POST_TYPE_NOT_ENABLED`; authority missing/off/revoked/not started/expired → `VAULT_PUBLISH_AUTHORITY_*`; consent store absent, no row or not `auto_post_preference` → `SOCIAL_MOBILE_AUTO_POST_NOT_CONSENTED`. Never reads Vault or the refresh rollout.
- Edge: `dispatchVaultAccountScheduledBrandPost` calls it (1) before loading settings/generation and (2) right before the X create. Expiry, revocation, consent withdrawal or any admin disable committed before the second check stops the create even with a valid token.
- Atomicity (proven by `PUBLISH_RACE_PASS`): a revocation takes effect at its commit; a check running while the revocation is uncommitted sees the last committed state. With the pre-create re-check, only a create already past that check when the revocation commits can still happen — at most that single in-flight request per running post; no later post.
- Refresh ceiling vs publish: they are independent. With publish authority valid and the refresh ceiling exhausted, posting continues while the token is valid; when it expires the refresh is refused (`X_REFRESH_PILOT_LIMIT_REACHED`, zero token requests) and the post fails. Conversely refresh `enabled` never grants publishing.
- AI Lab and Kabumori never consult this table (their paths are unchanged); the generic dispatcher also refuses both brands by id before any work.
- Kabumori: unchanged (legacy branch has no Vault account; the generic path refuses the `kabumori_v1` profile; the completion RPC refuses `kabumori` rows).
- AI Lab: unchanged dispatcher and completion RPC; the generic path refuses the `ai_salaryman_lab_v1` profile.
- A confirmed X post whose completion is unconfirmed is never failed/replayed (same flag as AI Lab).

## 3. Schema change (source only)

`20260927101423_vault_account_brand_post_completion.sql` (via `supabase migration new`): `complete_vault_account_brand_post(p_scheduled_post_id, p_social_account_id, p_x_post_id, p_normalized_text_sha256)` — SECURITY DEFINER, `search_path=''`, service_role only. Completes only a running `brand_post` row whose brand's one X account is the named account (`X_CLAIM_ACCOUNT_MISMATCH` otherwise), never Kabumori, **never AI Lab (P2: even its own row + `ai_salaryman_lab_x` → `VAULT_BRAND_POST_NOT_FOUND`, nothing written)** or Phase1B-bound rows; fingerprint written for that brand/account only (unique `(social_account_id, x_post_id)`); idempotent re-report; pending/finished rows refused. Requires Stage 3A; refuses to run twice; creates nothing else.

## 4. Pilot policy (Stage 3A `pilot` mode, unchanged)

- `set_x_account_refresh_rollout('sa_bfdab0e0696ec8e56ed2dd83', 'pilot', 'PILOT_STAGE3B', now() + interval '7 days', 3)` — finite expiry (7 days ≤ 30), finite ceiling (generation 0 → max 3 committed refreshes), any unresolved refresh error blocks, missing row/off fails closed, only that account's row is written. AI Lab stays `enabled`.

## 5. Isolation proof (disposable PostgreSQL + TS)

`supabase/tests/x_account_refresh_pilot_run.sh` (production-shaped fixture + a second account `sa_pilot`, production-shaped fingerprint/log tables, copy of the live claim step): TASK items 1–14 —
1/3 AI Lab enabled + pilot off → only AI Lab leases; pilot account 0 Vault reads (sequence-counted), no state · 2 pilot + enabled → each leases only its own refresh token · 4 second account cannot complete AI Lab's row and vice versa · 5 wrong brand/account → refused · 6 missing refs → setter and begin refuse · 7 invalid_grant → only the pilot account `failed`; AI Lab state/health/rollout untouched · 8 uncertain → nothing committed · 9 ceiling (2) → `X_REFRESH_PILOT_LIMIT_REACHED` with 0 Vault reads · 10 concurrent: AI Lab and pilot lease in parallel, second pilot lease refused · 11/12 each lease cannot commit/release the other account · 13 Kabumori refused by begin and completion · 14 three concurrent claims of one due row → exactly one claim, one `started` log; completion idempotent, one fingerprint. Mutation-checked (account match, Kabumori exclusion, running-only, brand_post-only). TS: generic dispatcher 10 tests (consent, profiles, binding, admin gates, length/NG/duplicate, confirmed-completion, loaders) + routing pins 3.

## 6. Stage 3B production activation plan (NOT executed; needs its own TASK + approval)

### Gates before the TASK
- G-A (owner): confirm `@yumeyoasobi` / `sa_bfdab0e0696ec8e56ed2dd83` is the intended pilot account; consent to automatic posting for the pilot window; choose the daily slot.
- G-B (product): apply/review the content-settings migration `20260922045046` (or its successor) and let the owner set `approvalMode = 'auto_post_preference'` for brand `u_ae343f5caedb67d4af33fc7a`.
- G-C (source): PR for this Stage 3B merged; `20260927101423` applied alone (`supabase db query --linked -f`, no push/repair) with read-back (md5 vs disposable, ACL, advisors); x-test-post deployed from merged main with byte-verify, `--no-verify-jwt`.

### Preflight (read-only)
- account row unchanged (identity_verified, refs present/distinct/unshared, no error), no refresh lease, rollout rows = AI Lab `enabled` only;
- AI Lab healthy (idle, no error); gate `X_VAULT_ACCOUNT_REFRESH` present;
- brand `u_ae343f5…` still inactive/disabled, 0 scheduled posts; content settings row exists with `auto_post_preference`;
- `complete_vault_account_brand_post` present and service_role-only.

### Enablement (exact, one account, in this order)
0. (both migrations `20260927101423` and `20260927124300` applied alone, read back)
1. `select public.set_x_account_refresh_rollout('sa_bfdab0e0696ec8e56ed2dd83', 'pilot', 'PILOT_STAGE3B', now() + interval '7 days', 3);`
2. `insert into public.brand_settings (brand_id, enabled_post_types) values ('u_ae343f5caedb67d4af33fc7a', '["brand_post"]'::jsonb);`
3. `insert into public.posting_windows (brand_id, post_type, slot_no, start_time, end_time, timezone, is_active) values ('u_ae343f5caedb67d4af33fc7a', 'brand_post', 1, '<start>', '<end>', 'Asia/Tokyo', true);` (one slot per day)
4. `update public.social_accounts set publish_enabled = true where id = 'sa_bfdab0e0696ec8e56ed2dd83';`
5. `update public.brands set is_active = true, publish_mode = 'live' where id = 'u_ae343f5caedb67d4af33fc7a';`
6. last — the publish window: `select public.set_x_account_publish_authority('sa_bfdab0e0696ec8e56ed2dd83', 'enabled', 'PILOT_STAGE3B', now(), now() + interval '7 days');` (no post can be created before this row exists)
Read back after each step: only these rows changed; AI Lab/Kabumori rows identical.

### Observation 1 — first natural post (also the first refresh)
The stored access token dates from 2026-09-23 and has no stored expiry, so the first create is expected to get 401 → one reactive refresh (generation 0 → 1) → one retry. Evidence: one claim, one `started`/`succeeded` log, `x_account_refresh_state_v2` for the pilot account idle gen 1 with `access_expires_at` ≈ +2h, the pilot account's two secret `updated_at` only, one fingerprint (brand `u_ae…`, account `sa_bfdab…`), AI Lab/Kabumori unchanged.

### Observation 2 — natural expiry cycle
Next day's slot (token expired): proactive refresh before create (generation 1 → 2), one create, success.

### Hard stops (→ rollback, no retry, no replay)
account mismatch · shared refs · unexpected eligible account · duplicate claim/post · second 401 · invalid_grant/reauth · uncertain token response · stuck lease · credential commit mismatch · cross-account mutation · consent/settings missing at run time (expected refusal code; stop and review).

### Rollback to OFF (exact)
0. **First and sufficient on its own**: `select public.set_x_account_publish_authority('sa_bfdab0e0696ec8e56ed2dd83', 'revoked', 'PILOT_STAGE3B_ROLLBACK');` — from its commit no new X create passes the pre-create check (a valid token no longer matters). Steps 1–5 are defence in depth and cleanup.
1. `select public.set_x_account_refresh_rollout('sa_bfdab0e0696ec8e56ed2dd83', 'off', 'PILOT_STAGE3B_ROLLBACK');`
2. `update public.brands set is_active = false, publish_mode = 'disabled' where id = 'u_ae343f5caedb67d4af33fc7a';`
3. `update public.posting_windows set is_active = false where brand_id = 'u_ae343f5caedb67d4af33fc7a';`
4. `update public.social_accounts set publish_enabled = false where id = 'sa_bfdab0e0696ec8e56ed2dd83';`
5. Pending rows of that brand: mark `failed` with a fixed message (never replay). Global gate and AI Lab untouched. A committed rotation cannot be undone; recovery is the owner re-connecting.

## 7. Migration-history implications

`20260927101423` joins the local-only set (history not normalized; `db push` still forbidden). It refuses to run twice and depends only on live objects (Stage 3A + production tables), so a mistaken re-run fails closed. The content-settings candidate `20260922045046` is also local-only/unapplied; applying it is a separate product decision (G-B).

## 8. Remaining risks

- User consent contract (`approvalMode = 'auto_post_preference'` + admin enablement) is a product decision to confirm; the content-settings table is not live.
- Consent withdrawal is read from `social_mobile_content_settings.settings.approvalMode`; that store's grants must give service_role SELECT when it is deployed (the check is SECURITY INVOKER).
- The 140-code-point publish limit is conservative (X weighted counting); AI Lab keeps its own 280 policy.
- The pilot account's refresh token is 4+ days old and unused; `invalid_grant` on the first refresh is possible → hard stop + owner reconnect.
- Generation cost per pilot post uses the shared OpenAI key.
