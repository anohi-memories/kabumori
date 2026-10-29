# POSTONA — G4's read-only X / Threads publish-credential verdicts for G3's reservation consumers (G4-02 #4, 2026-10-30)

task_id: `postona-g4-gen2-04-x-threads-verified-credential-verdict-g3-consumer-unblock-20261030` (Issue #561).
Answers G3-47's "IF requested from G4" 1–5 (Issue #318, REPORT 6510569221).

**Status:** source only. Nothing is applied or deployed. No grant. PRODUCTION_NO_GO.

## 1. The functions (G3 binds by exact signature, owner and md5)

| | Threads | X |
| --- | --- | --- |
| File | `supabase/candidates/postona_g4_credential_verdict/001_threads_publish_credential_verdict.sql` | `.../002_x_publish_credential_verdict.sql` (on top of 001) |
| Signature | `postona_g4_credential.threads_publish_credential_verdict(p_user_id uuid, p_social_account_id text)` | `postona_g4_credential.x_publish_credential_verdict(p_user_id uuid, p_social_account_id text)` |
| Returns | `table (verified boolean, credential_generation text, code text)`, always exactly one row | same |
| Kind | plpgsql, `STABLE`, `SECURITY DEFINER`, `search_path ''`, read-only | same |
| `md5(prosrc)` (measured on PG17) | `fb93a0ad84c44c6781521eec4618fff4` | `46643d50a4a6c6a82867061328de05bf` |
| Generation | `g4t1:<binding.oauth_state_id>`: one fresh uuid per completed connect; reconnect → new; disconnect → rows gone | `g4x1:<connection_epoch>`: +1 on every completed connect **and** every disconnect, never back |
| Profiles | full and personal (g5pv): the same shape and the same answers | full only today. On personal the install refuses (`G4_X_VERDICT_PRECONDITION_LINEAGE`) until G4's X OAuth gets its g5pv variant |

Both generations are opaque: compare them for equality only. Neither value is ever reused, so an A→B→A of the connection never brings an old one back. A token refresh that keeps the person and the platform user leaves the generation unchanged:
- **Threads:** the same binding.
- **X:** main's refresh core is the only token writer (G4-40 002).

**No credential material.** By construction, the answer never contains a token, a Vault secret id or the platform user id. Measured: the answers were checked against the tokens and the secret ids.

## 2. When `verified = true` (code `VERIFIED`), read in one snapshot

All of the following must hold:
- The account exists, is the right platform, and is in the person's own workspace (`u_` + md5(user)[1:24]), whose single owner is the person. The owner check is G5's `private.account_lifecycle_brand_owner`, which exists in both profiles.
- The person's `x_autopost` service is `active` for that workspace (G5's `common_account_brand_service_state`).
- Platform-specific checks:
  - **Threads:** G4's binding has `bound_by` = the person, the same workspace, and the account's current Threads user.
  - **X:** the connection was made through G4's X lineage, and no begin is pending.
- `connection_status = 'identity_verified'`, and there is no connection error.
- The credential is usable:
  - **Threads:** G4's custody names the account's current access credential and has not expired.
  - **X:** both the access and the refresh credential are set, and main's refresh state is not `refreshing` / `uncertain` / `reauth_required`. An expired access token alone is fine, because the refresh core renews it.

**Codes (fixed):**

| Code | Generation in the answer |
| --- | --- |
| `VERIFIED` | yes |
| `INPUT_INVALID`, `NOT_CONNECTED` (never connected, or a Threads disconnect: the rows are gone), `NOT_OWN_WORKSPACE`, `NOT_BOUND` (Threads), `LINEAGE_UNKNOWN` (X) | null |
| `SERVICE_<G5 state>` (e.g. `SERVICE_NOT_ACTIVE`), `NOT_VERIFIED`, `CONNECTION_ERROR`, `CREDENTIAL_MISSING`, `CREDENTIAL_EXPIRED` (Threads), `CONNECT_PENDING` / `DISCONNECTED` / `REFRESH_IN_PROGRESS` / `REFRESH_UNCERTAIN` / `REAUTH_REQUIRED` (X) | carried for diagnosis only |

G3 must act on `verified` only. `REFRESH_IN_PROGRESS` for Threads is reserved and never answered: this stack has no Threads refresh lease.

## 3. Owner / ACL (G3's call path)

- **Owner-only.** The ACL is exactly `<owner>=X/<owner>`, and anon / authenticated / service_role / authenticator have no EXECUTE (measured).
- The install refuses as a superuser, and refuses while any API role can become the owner.
- **G3's `SECURITY DEFINER` consumers** (`postona_x_resv.*` / `postona_threads_resv.*`) call it as their owner. That owner must be **the same non-superuser lifecycle owner** that owns G4's binding, X lineage, `social_accounts` and PR #124. This is the rollout used in every G4 and G3 PG17 world. If G3's schemas ever get a different owner, that needs its own reviewed `GRANT EXECUTE ... TO <that owner>`, which is **not** in this PR.
- **Not done:** no grant to authenticated (PR #124's authenticated EXECUTE stays NO_GO), and no G3 / G5 file changed.

## 4. Lifecycle answers (G3's item 3), measured on PG17

**Threads** — app e2e scenario 19, both profiles. Real app hooks, supabase-js, the local Edge, H5, the G4 bridge and SQL:

| Step | Answer |
| --- | --- |
| connected | `true / g4t1:<state> / VERIFIED` |
| another person | `NOT_OWN_WORKSPACE` |
| absent account | `NOT_CONNECTED` |
| a connect that never bound (the ABA person) | `NOT_BOUND` |
| reconnect | a new generation |
| re-bind to another Threads user | refused by PR #124 (`THREADS_IDENTITY_ACCOUNT_MISMATCH`, reconcile); the generation is unchanged |
| custody expired (SYNTHETIC) | `CREDENTIAL_EXPIRED` |
| connection error (SYNTHETIC) | `CONNECTION_ERROR` |
| disconnect through the app | `NOT_CONNECTED` |
| connect again | a generation never seen before |
| service end (SYNTHETIC) | `SERVICE_NOT_ACTIVE` |

Same-callback race (bridge flow 11, both profiles): exactly one connects. The other gets `CALLBACK_REFUSED` (`H5_STATE_NOT_USABLE`), before the code exchange.

**X** — `supabase/tests/postona_g4_credential_verdict_x_behavior.sql`, 26/26. It runs through G4's real X begin / complete / disconnect on the full world (real G5):

| Step | Answer |
| --- | --- |
| connected | `VERIFIED g4x1:<epoch>` |
| another person / absent / null | `NOT_OWN_WORKSPACE` / `NOT_CONNECTED` / `INPUT_INVALID` |
| refresh-core write (SYNTHETIC) | the same generation |
| `reauth_required` / `uncertain` / `refreshing` | `REAUTH_REQUIRED` / `REFRESH_UNCERTAIN` / `REFRESH_IN_PROGRESS` |
| back to idle | `VERIFIED` |
| a begin open | `CONNECT_PENDING` |
| its completion | a new generation |
| connection error | `CONNECTION_ERROR` |
| disconnect | `DISCONNECTED`, the generation moved again |
| service end | `SERVICE_NOT_ACTIVE` |
| no G4 lineage | `LINEAGE_UNKNOWN` |

**Mutant:** the X refresh-state read removed → the 3 refresh cases fail.

## 5. Install / rollback (`G4T_VERDICT=1 supabase/tests/postona_g4_threads_person_session_run.sh`)

- **001** refuses:
  - without G4's Threads binding;
  - as a superuser;
  - twice (`ALREADY_APPLIED`).

  It installs on the personal profile.
- **002** refuses on personal (`LINEAGE`).
- **Rollback:** 002 first (001's rollback refuses while 002 is installed). No CASCADE. Then install again.
- Postconditions: ACL, inventory and API-role reach are re-checked on every install.

## 6. What G3 can do with this (G3's own TASK and approval)

1. In G3's `013` / X `0xx`:
   - replace `g4_*_account_verified` with a call to the function above, checked by `to_regprocedure` of the exact signature, the owner and the `md5(prosrc)` in §1;
   - store `credential_generation` at claim, and compare it at send;
   - send only when `verified`.
2. G3's runners: install `postona_g4_credential_verdict/001` (+ `002` on full), read-only extraction from the G4 head, after G4's binding / X lineage and before G3's files.
3. On personal, X stays DENY (`LINEAGE`) until G4's X OAuth g5pv variant exists.

## 7. Review and open items

- **Review:** this is a new read-only `SECURITY DEFINER` gate whose answer lets G3 post.
  - Recommend **one** focused look together with G3's consumer change.
  - Scope: the two functions, their owner-only ACL, and the "verified" conditions.
  - The H1-29 / H4-15 scopes are not repeated. No review TASK was created.
- **Open:**
  - G4's X OAuth on the personal profile (g5pv variant of X 001–005): the next G4 piece.
  - G5's profile decision.
  - Managed Supabase, real X / Threads, the Edge deploy and the device are NOT_VERIFIED.
