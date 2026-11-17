# G4-02 #19: G4's X send credential source for G3's send paths (local only)

Status: G4 SOURCE CANDIDATE. Nothing here is deployed. No real X OAuth, X post, token fetch, paid API, hosted or production read/write was made. PRODUCTION_NO_GO.
Issue #561 (G4-02, task 19). Base: PR #701 HEAD `1c2b239e86c5b7b56991bdb26105409b317291d2`. G3 source read (never changed): PR #699 HEAD `8ebf3a7b079a79817644a2317139c16cb7465ca4`.

## 1. What was missing

G3's manual send ("send now") and the reservation worker take one G4 credential source:
`credentialFor(socialAccountId) -> { token, generation } | null` (G3's `x_credential_generation.ts`).
G3 ships it as `X_GENERATION_CREDENTIALS_NOT_CONNECTED`, so no authenticated X send was possible (G3-02 #26 ACCEPT: G4_CREDENTIAL_NOT_CONNECTED).

## 2. What G4 delivers

| file | what |
|---|---|
| `supabase/candidates/postona_g4_credential_verdict/003_x_send_credential_read.sql` | `public.postona_x_send_credential_v1(p_social_account_id text) -> (code, credential_generation, access_token)`, one row always. SECURITY DEFINER, empty search_path, lock_timeout 3 s. **EXECUTE for service_role only** (anon / authenticated / authenticator: no). Installs only over the reviewed X verdict 002 (body md5 `46643d50a4a6c6a82867061328de05bf`). |
| `.../003_x_send_credential_read_rollback.sql` | drops only that function, only when its body is the installed one (md5 `e536472736d61bcaf2ffdb0196e98514`); 002 stays. |
| `.../x_send_credential_source.ts` | `createG4XSendCredentialSource({ read })` answers G3's raw shape `{ token, g4Generation }`; `createXSendCredentialRpcRead({ supabaseUrl, serviceRoleKey })` reads 003 over PostgREST (https, or http for a loopback host only; no redirect; 5 s). |

How 003 decides, in one transaction:

1. lock the account row `FOR SHARE` (G4's begin / complete / disconnect and the reconnect reset all update it: they wait for the read, or the read waits for them and sees only what committed);
2. owner = G5's single workspace owner of the account (`private.account_lifecycle_brand_owner`);
3. G4's X verdict 002 for (that owner, that account) must be `VERIFIED`: own personal workspace, x_autopost active, G4's lineage, no begin pending, identity verified, no connection error, both credentials set, refresh core not `refreshing` / `uncertain` / `reauth_required`;
4. the access token from Vault, printable ASCII, 16..4096 characters.

Otherwise `(code, null, null)`: no generation and no token. Codes: `INPUT_INVALID`, `NOT_CONNECTED`, `NOT_OWN_WORKSPACE`, the verdict's codes, `CREDENTIAL_UNREADABLE`.
The TS source answers `null` for anything but exactly one well-formed `VERIFIED` row, and for a throw or a bad account id. It caches nothing, and nothing it answers, throws or logs carries a token, an account id or a database body.

## 3. How G3 connects it (contract for G3; G3's code, G3 decides)

Both send paths use the same fence:

```ts
credentials = xGenerationSourceFromG4Raw(            // G3's adapter (credential_generation_derivation.ts)
  createG4XSendCredentialSource({
    read: createXSendCredentialRpcRead({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY }),
  }));
```

- The generation G3 compares is G3's own derivation of G4's `g4x1:<connection_epoch>`. A reconnect or disconnect moves the epoch and never moves it back. A token refresh keeps it.
- **Who is sending** (person, session (G5 S2-2 / T13), publish switch, lease) stays G3's begin / preflight. 003 takes only the account id, because G3's port passes only that. The owner is derived from the account and re-checked by 002, so a wrong owner can never be `VERIFIED`. A send for another person's account is refused by G3's begin before 003 is asked.
- Optional later (G3's call): pass the subject to the source as defence in depth. That would need a G3 port change, so G4 has not asked for it here.
- The service-role key is server-only (Edge). It must never reach an app bundle.

## 4. Boundary for G1

None of this is a G1 surface. G1 keeps G3's manual-send contract (`sent` / `failed` / `uncertain` / `pending`, the same `clientRequestId` when retrying).
G4's refusals reach G1 only through G3's answer codes, as follows:
- "not sent" when G3's begin refuses (403 / 404);
- `failed` with `X_CREDENTIALS_UNAVAILABLE` or `CREDENTIAL_GENERATION_CREDENTIAL_CHANGED` / `CREDENTIAL_GENERATION_CHANGED`;
- 401 when the session ended.

The publish switch control (`publish_enabled`) is still not built by G1 or G4 (G3 G11b).

## 5. Evidence (local only)

- Deno unit (`x_send_credential_source_test.ts`, deny-net / deny-env / deny-run): 5 tests.
- PG17 (`supabase/tests/postona_g4_x_send_credential_run.sh`, the G4-43 world lines md5-pinned). Results:
  - install refusals; ACL (service_role only);
  - behavior: 40 cases on the full profile and 40 on the personal profile (connect, other person, refresh = same generation with the new token, refreshing / uncertain / reauth, bad token, pending, reconnect = new generation, disconnect, ABA, connection error, service end, owner loss, no lineage, no leak);
  - two-session races R1 / R2;
  - G3's contract `generationSourceViolations` through G3's adapter: 0 violations (2 connected, 5 not);
  - mutants: verdict ignored, token shape ignored, row lock removed and an authenticated grant are all caught. Deriving the owner another way is an equivalent mutant (002 re-checks the owner);
  - rollback, including the drift refusal.
- Real local runtime (`supabase/tests/postona_g4_x_send_credential_e2e_run.sh`): G3 PR #699's own `local_stack/run.sh` in a throw-away composition (counted insertions: G4's 003, one twin using G4's real source, one step L47). Real GoTrue signed JWT → Kong → Edge → PostgREST/Postgres → G3's fake X. The run had 48 steps: G3's L0–L46 unchanged, all PASS, plus G4's L47 PASS. L47 results:
  - sent: G4's Vault token reached the fake X (the bearer's SHA-256 matched);
  - refreshing: 403 `POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED`, 0 sends;
  - after a refresh: sent with the NEW token, same generation;
  - after a reconnect: 403 `POSTONA_RESV_PUBLISH_DISABLED` (the switch goes OFF again), then sent with the reconnect's token;
  - another person: 404;
  - signed-out session: 401, while the person's other session still sent;
  - disconnected: 403 `POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED`;
  - service ended: 403 `POSTONA_RESV_SERVICE_NOT_ACTIVE`;
  - 4 sends in all.

  On this path G3's begin (014, which calls G4's verdict) refuses before G4's source is asked. G4's source's own refusals are measured on PG17 above. 003 installed on the real image with EXECUTE for service_role only.

## 6. Not solved / to confirm (kept separate)

- **Refresh between the read and the X call**: the generation does not move on a refresh, so the token read just before may be the previous one. X then refuses it (401), G3 records `failed` and never resends. No double post; the person retries. Closing it fully needs the refresh core's lease to be part of G3's preflight (G3 + main refresh core), or the generation to include the refresh counter. That would change G3's 014 definition and needs central approval.
- **Access token expiry**: this world's refresh state has no expiry column. The refresh core (main) owns renewal. An expired token gives X 401 → `failed`.
- **Scopes**: not stored per account. G4's connect asks `tweet.read users.read tweet.write media.write offline.access` (`x-oauth-connect-user/oauth_logic.ts`). G3's sheet read the official page on 2026-11-17: create needs `tweet.read tweet.write users.read`, plus `offline.access` for refresh. G4 did not re-read the official pages in this task: **to confirm** before release. `media.write` is not needed for text-only posts. Whether to drop it is a product decision.
- **X pricing / app permissions**: not re-verified here (G3's sheet G5/G6, read 2026-11-17; prices can change): **to confirm**.
- **New grant**: EXECUTE on 003 for service_role is new and returns plaintext token material to the server. **An independent H review is required** before any hosted use, as is the deploy order (002 → 003, then G3 wiring).
- The worker path uses the same source. Only the manual send was driven end to end in this task. The worker's twin is G3's.
